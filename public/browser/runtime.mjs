import { createWorld, GameError, publicView } from "../../lib/engine.mjs";
import { runTurn } from "../../lib/agent.mjs";
import { complete, listModels, validateModelConfig } from "../../lib/model-core.mjs";
import { validateSave, InvalidSaveError } from "../../lib/save-validation.mjs";
import { BrowserStore } from "./store.mjs";

const lockName = "dynasty-emulator-save-write-v1";
async function writeLock(operation) {
  if (!globalThis.navigator?.locks?.request) throw new GameError("此浏览器不支持安全的存档写锁，请使用支持 Web Locks 的新版浏览器。", 503);
  return navigator.locks.request(lockName, { ifAvailable: true }, async (lock) => {
    if (!lock) throw new GameError("另一个游戏页面正在处理行动，请稍候。", 409);
    return operation();
  });
}
const promptUrl = new URL("../agent.md", import.meta.url);
let fixedPrompt;
async function readPrompt() {
  if (fixedPrompt === undefined) {
    const response = await fetch(promptUrl, { credentials: "same-origin", cache: "no-cache", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new GameError("无法读取固定游戏设定，请刷新页面重试。", 503);
    fixedPrompt = await response.text();
  }
  return fixedPrompt;
}
async function textHash(text) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text.trim()));
  return [...new Uint8Array(hash)].map((value) => value.toString(16).padStart(2, "0")).join("");
}

export class BrowserRuntime {
  constructor({ store = new BrowserStore(), withWriteLock = writeLock, runTurnImpl = runTurn, readPromptImpl = readPrompt } = {}) {
    this.store = store; this.withWriteLock = withWriteLock; this.runTurnImpl = runTurnImpl; this.readPromptImpl = readPromptImpl;
    this.busy = false; this.world = null; this.settings = validateModelConfig({ provider: "offline" });
    this.ready = this.reload();
  }
  async reload() {
    this.world = await this.store.read("world");
    const saved = await this.store.read("settings");
    if (saved) {
      const current = this.settings;
      const next = validateModelConfig({ ...saved, apiKey: "" }, { requireKey: false });
      if (current.provider === next.provider && current.baseUrl === next.baseUrl) next.apiKey = current.apiKey;
      this.settings = next;
    }
  }
  snapshot() {
    const { apiKey, ...settings } = this.settings;
    return { game: publicView(this.world), settings: { ...settings, hasKey: Boolean(apiKey) }, busy: this.busy,
      ...(this.store.recovered.has("world") ? { recoveryNotice: "主存档无法读取，已恢复最近一次有效备用存档。" } : {}) };
  }
  async mutate(operation) {
    if (this.busy) throw new GameError("上一项行动仍在处理中，请稍候。", 409);
    return this.withWriteLock(async () => {
      this.busy = true;
      try { await this.reload(); return await operation(); }
      finally { this.busy = false; }
    });
  }
  async request(path, { method = "GET", body = {} } = {}) {
    await this.ready;
    if (path === "/api/state" && method === "GET") {
      if (!this.busy) await this.reload();
      const snapshot = this.snapshot();
      if (!snapshot.busy && globalThis.navigator?.locks?.query) snapshot.busy = (await navigator.locks.query()).held.some((lock) => lock.name === lockName);
      return snapshot;
    }
    if (path === "/api/agent" && method === "GET") return { prompt: await this.readPromptImpl() };
    if (path === "/api/export" && method === "GET") {
      if (this.busy) throw new GameError("请等待当前行动保存完成，再导出存档。", 409);
      await this.reload();
      if (!this.world) throw new GameError("暂无可导出的王朝。");
      const { apiKey, ...settings } = this.settings;
      return { format: "dynasty-emulator", schema: 1, world: structuredClone(this.world), settings };
    }
    if (method !== "POST" || !body || typeof body !== "object" || Array.isArray(body)) throw new GameError("请求格式不正确。");
    if (path === "/api/settings") {
      await this.mutate(async () => {
        const next = validateModelConfig(body, { requireKey: false });
        if (next.provider !== "offline" && !next.apiKey && next.provider === this.settings.provider && next.baseUrl === this.settings.baseUrl) next.apiKey = this.settings.apiKey;
        await this.store.save("settings", { ...next, apiKey: undefined }); this.settings = next;
      });
      return { settings: this.snapshot().settings };
    }
    if (path === "/api/test-model") return listModels({ ...this.settings });
    if (path === "/api/start") {
      await this.mutate(async () => { const world = createWorld({ name: body.name, opening: body.opening }); await this.store.save("world", world); this.world = world; });
      return this.snapshot();
    }
    if (path === "/api/import") {
      await this.mutate(async () => {
        let world;
        try { world = validateSave("world", structuredClone(body.world || body)); }
        catch (error) {
          if (error instanceof InvalidSaveError) throw new GameError("存档格式不正确，当前王朝未被替换。");
          throw error;
        }
        // Never import credentials, including from files created by other tools.
        const settings = body.settings ? validateModelConfig({ ...body.settings, apiKey: "" }, { requireKey: false }) : this.settings;
        await this.store.saveMany({ world, settings: { ...settings, apiKey: undefined } });
        this.world = world; this.settings = settings;
      });
      return this.snapshot();
    }
    if (path !== "/api/action") throw new GameError("接口不存在。", 404);
    const outcome = await this.mutate(async () => {
      if (!this.world) throw new GameError("请先建立你的王朝。", 409);
      if (typeof body.gameId !== "string" || body.gameId !== this.world.id) throw new GameError("当前王朝已改变，请刷新后再行动。", 409);
      if (typeof body.requestId !== "string" || !/^[\w-]{8,80}$/.test(body.requestId)) throw new GameError("行动标识无效。");
      if (typeof body.text !== "string" || !body.text.trim() || body.text.length > 2000) throw new GameError("请输入1至2000字的行动。");
      const hash = await textHash(body.text);
      const existing = (this.world.receipts || []).find((receipt) => receipt.id === body.requestId);
      if (existing) {
        if (existing.textHash && existing.textHash !== hash) throw new GameError("该行动标识已用于其他输入，请重新提交。", 409);
        return { ...existing.outcome, replayed: true };
      }
      if (body.version !== this.world.version) throw new GameError("状态已更新，请刷新后再行动。", 409);
      const draft = structuredClone(this.world);
      let durableOutcome;
      const saveReceipt = (target, result) => {
        target.receipts ||= [];
        const receipt = { id: body.requestId, textHash: hash, outcome: result };
        const index = target.receipts.findIndex((item) => item.id === body.requestId);
        if (index < 0) target.receipts.push(receipt); else target.receipts[index] = receipt;
      };
      const outcome = await this.runTurnImpl(draft, body.text, { ...this.settings }, {
        completeImpl: complete, readPromptImpl: this.readPromptImpl,
        onSettled: async (checkpoint, result) => {
          saveReceipt(checkpoint, result); await this.store.save("world", checkpoint);
          this.world = checkpoint; durableOutcome = result;
        },
      });
      saveReceipt(draft, outcome);
      try { await this.store.save("world", draft); this.world = draft; }
      catch (error) {
        if (!durableOutcome) throw error;
        return { ...durableOutcome, notice: "行动已保存；补充叙事未能保存，程序记录已保留，无需重复执行。" };
      }
      return outcome;
    });
    return { ...this.snapshot(), ...outcome };
  }
}

let runtime;
export async function request(path, options) {
  runtime ||= new BrowserRuntime();
  try { return await runtime.request(path, options); }
  catch (error) {
    if (error instanceof GameError || typeof error.status === "number") throw error;
    throw new GameError(error?.message || "无法读写浏览器存档，请检查浏览器存储是否可用。", 503);
  }
}
