import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { GameError, createWorld, publicView } from "./lib/engine.mjs";
import { runTurn } from "./lib/agent.mjs";
import { validateModelConfig, listModels } from "./lib/model.mjs";
import { Store } from "./lib/store.mjs";

const store = new Store(process.env.DYNASTY_DATA_DIR || fileURLToPath(new URL("data/", import.meta.url)));
let world = await store.read("world");
const savedSettings = await store.read("settings");
const environmentKey = process.env.DEEPSEEK_API_KEY || "";
const deepSeekEnvironmentKey = (config) => {
  if (config.provider !== "deepseek") return "";
  const url = new URL(config.baseUrl);
  return url.protocol === "https:" && url.hostname === "api.deepseek.com" && !url.port ? environmentKey : "";
};
let settings = validateModelConfig({ provider: savedSettings?.provider || "offline", baseUrl: savedSettings?.baseUrl || "https://api.deepseek.com", model: savedSettings?.model || "deepseek-flash", additionalInstructions: savedSettings?.additionalInstructions || "", apiKey: "" }, { requireKey: false });
settings.apiKey = deepSeekEnvironmentKey(settings);
let recoveryNotice = store.recovered.has("world") ? "主存档无法读取，已恢复最近一次有效备用存档。" : "";
let busy = false;
const port = Number(process.env.PORT || 4173);
let boundPort = port;
const metadata = () => ({ provider: settings.provider, baseUrl: settings.baseUrl, model: settings.model, additionalInstructions: settings.additionalInstructions, hasKey: Boolean(settings.apiKey) });
const snapshot = () => ({ game: publicView(world), settings: metadata(), busy, ...(recoveryNotice ? { recoveryNotice } : {}) });
const staticFiles = new Map([["/", ["public/index.html", "text/html"]], ["/index.html", ["public/index.html", "text/html"]], ["/styles.css", ["public/styles.css", "text/css"]], ["/app.js", ["public/app.js", "text/javascript"]]]);
function send(response, status, data) { response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" }); response.end(JSON.stringify(data)); }
async function body(request) {
  if ((request.headers["content-type"] || "").split(";", 1)[0].trim().toLowerCase() !== "application/json") { request.resume(); throw new GameError("请求需要 JSON 格式。", 415); }
  const chunks = []; let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) { length += chunk.length; if (length > 65536) { request.resume(); throw new GameError("请求过长。", 413); } chunks.push(chunk); }
  try { const value = JSON.parse(Buffer.concat(chunks).toString("utf8")); if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(); return value; } catch { throw new GameError("请求格式不正确。"); }
}
async function mutate(message, operation) {
  if (busy) throw new GameError(message, 409);
  busy = true;
  try { return await operation(); }
  finally { busy = false; }
}
const server = createServer(async (request, response) => {
  try {
    if (![ `127.0.0.1:${boundPort}`, `localhost:${boundPort}` ].includes(request.headers.host)) return send(response, 403, { error: "请从本机地址访问。" });
    if (request.headers.origin && request.headers.origin !== `http://${request.headers.host}`) return send(response, 403, { error: "请求来源不匹配。" });
    const path = new URL(request.url, `http://127.0.0.1:${boundPort}`).pathname;
    if (request.method === "GET" && path === "/api/state") return send(response, 200, snapshot());
    if (request.method === "GET" && path === "/api/agent") return send(response, 200, { prompt: await readFile(new URL("agent.md", import.meta.url), "utf8") });
    if (path.startsWith("/api/")) {
      if (request.method !== "POST") return send(response, 405, { error: "该接口需要 POST 请求。" });
      const input = await body(request);
      if (path === "/api/settings") {
        await mutate("存档处理中，请稍后修改模型配置。", async () => {
          let config = validateModelConfig(input, { requireKey: false });
          const sameEndpoint = config.provider === settings.provider && config.baseUrl === settings.baseUrl;
          if (config.provider !== "offline" && sameEndpoint && !config.apiKey) config = { ...config, apiKey: settings.apiKey };
          if (!config.apiKey) config = { ...config, apiKey: deepSeekEnvironmentKey(config) };
          await store.save("settings", { ...config, apiKey: undefined }); settings = config;
        });
        return send(response, 200, { settings: metadata() });
      }
      if (path === "/api/test-model") return send(response, 200, await listModels({ ...settings }));
      if (path === "/api/start") {
        await mutate("当前存档仍在处理中。", async () => {
          const fresh = createWorld({ name: input.name, opening: input.opening });
          await store.save("world", fresh); world = fresh; recoveryNotice = "";
        });
        return send(response, 200, snapshot());
      }
      if (path === "/api/action") {
        if (!world) throw new GameError("请先建立你的王朝。", 409);
        if (typeof input.gameId !== "string" || input.gameId !== world.id) throw new GameError("当前王朝已改变，请刷新后再行动。", 409);
        if (typeof input.requestId !== "string" || !/^[\w-]{8,80}$/.test(input.requestId)) throw new GameError("行动标识无效。");
        if (typeof input.text !== "string" || !input.text.trim() || input.text.length > 2000) throw new GameError("请输入 1 至 2000 字的行动。");
        const textHash = createHash("sha256").update(input.text.trim()).digest("hex");
        const existing = (world.receipts || []).find((receipt) => receipt.id === input.requestId);
        if (existing) {
          if (existing.textHash && existing.textHash !== textHash) throw new GameError("该行动标识已用于其他输入，请重新提交。", 409);
          return send(response, 200, { ...snapshot(), ...existing.outcome, replayed: true });
        }
        if (busy) throw new GameError("上一项存档仍在处理中。", 409);
        if (input.version !== world.version) throw new GameError("状态已更新，请刷新后再行动。", 409);
        const outcome = await mutate("上一项存档仍在处理中。", async () => {
          const draft = structuredClone(world);
          let durableOutcome;
          const saveReceipt = (target, outcome) => {
            target.receipts ||= [];
            const receipt = { id: input.requestId, textHash, outcome };
            const index = target.receipts.findIndex((item) => item.id === input.requestId);
            if (index < 0) target.receipts.push(receipt); else target.receipts[index] = receipt;
          };
          const outcome = await runTurn(draft, input.text, { ...settings }, { onSettled: async (checkpoint, checkpointOutcome) => {
            saveReceipt(checkpoint, checkpointOutcome);
            await store.save("world", checkpoint);
            world = checkpoint; durableOutcome = checkpointOutcome;
          } });
          saveReceipt(draft, outcome);
          try { await store.save("world", draft); world = draft; }
          catch (error) {
            if (!durableOutcome) throw error;
            return { ...durableOutcome, notice: "行动已保存；补充叙事未能保存，程序记录已保留，无需重复执行。" };
          }
          return outcome;
        });
        return send(response, 200, { ...snapshot(), ...outcome });
      }
      return send(response, 404, { error: "接口不存在。" });
    }
    const file = staticFiles.get(path);
    if (!file) return send(response, 404, { error: "页面不存在。" });
    if (!["GET", "HEAD"].includes(request.method)) return send(response, 405, { error: "请求方法不支持。" });
    const content = await readFile(new URL(file[0], import.meta.url));
    response.writeHead(200, { "Content-Type": `${file[1]}; charset=utf-8`, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff", "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'" });
    response.end(request.method === "HEAD" ? undefined : content);
  } catch (error) { send(response, error instanceof GameError ? error.status : 500, { error: error instanceof GameError ? error.message : "本地服务暂时不可用，请查看存档文件与服务状态。" }); }
});
server.on("error", (error) => { console.error(error.code === "EADDRINUSE" ? `端口 ${port} 已被占用。` : "服务启动失败。"); process.exitCode = 1; });
if (!Number.isInteger(port) || port < 0 || port > 65535) { console.error("服务端口格式不正确。"); process.exitCode = 1; }
else server.listen(port, "127.0.0.1", () => { boundPort = server.address().port; console.log(`王朝模拟器已启动：http://127.0.0.1:${boundPort}`); });
