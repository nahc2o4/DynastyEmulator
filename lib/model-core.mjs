import { GameError } from "./engine.mjs";

export function validateModelConfig(config, { requireKey = true } = {}) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw new GameError("模型配置缺失。");
  if (!["offline", "deepseek", "compatible"].includes(config.provider)) throw new GameError("模型平台不支持。");
  const additionalInstructions = config.additionalInstructions ?? "";
  if (typeof additionalInstructions !== "string" || additionalInstructions.length > 8000) throw new GameError("补充指令最多 8000 字。");
  if (config.provider === "offline") return { provider: "offline", baseUrl: "https://api.deepseek.com", model: "deepseek-flash", apiKey: "", additionalInstructions };
  let url;
  try { if (typeof config.baseUrl !== "string") throw new Error(); url = new URL(config.baseUrl); } catch { throw new GameError("请填写有效的模型接口地址。"); }
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if (url.protocol !== "https:" && !(local && url.protocol === "http:")) throw new GameError("远程接口使用 HTTPS，本地接口可使用 HTTP。");
  if (url.username || url.password || config.baseUrl.includes("?") || config.baseUrl.includes("#")) throw new GameError("接口地址请勿包含账号、查询参数或片段。");
  if (config.apiKey !== undefined && typeof config.apiKey !== "string") throw new GameError("API Key 格式不正确。");
  const apiKey = typeof config.apiKey === "string" ? config.apiKey.trim() : "";
  if (requireKey && !local && !apiKey) throw new GameError("请填写 API Key。");
  if (apiKey.length > 2048 || /[\u0000-\u001f\u007f]/.test(apiKey)) throw new GameError("API Key 格式不正确。");
  if (typeof config.model !== "string" || !config.model.trim() || config.model.length > 200) throw new GameError("请填写模型名称。");
  return { provider: config.provider, baseUrl: url.href.replace(/\/+$/, ""), model: config.model.trim(), apiKey, additionalInstructions };
}
function browserNetworkMessage(error, signal) {
  if (signal?.aborted || ["TimeoutError", "AbortError"].includes(error?.name)) return "模型请求超时，请重试。";
  return "无法连接模型平台，请检查接口地址和网络，或确认平台已允许浏览器跨域访问。";
}
async function request(config, path, body, fetchImpl, networkMessageImpl) {
  const signal = AbortSignal.timeout(35000);
  let response;
  try {
    response = await fetchImpl(`${config.baseUrl}/${path}`, {
      method: body ? "POST" : "GET", redirect: "error",
      headers: { ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}), ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}), signal,
    });
  } catch (error) {
    throw new GameError(networkMessageImpl(error, signal), 502);
  }
  if (!response || typeof response.ok !== "boolean" || typeof response.json !== "function") throw new GameError("模型响应格式不正确。", 502);
  if (!response.ok) {
    const errors = { 401: "API Key 无效。", 402: "模型账户额度不足。", 403: "模型访问权限不足。", 404: "接口或模型不存在。", 429: "平台限流或额度不足。" };
    throw new GameError(errors[response.status] || `模型平台返回错误（${response.status}）。`, 502);
  }
  try {
    const data = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Invalid response");
    return data;
  } catch (error) {
    throw new GameError(signal.aborted || ["TimeoutError", "AbortError"].includes(error?.name) ? "模型请求超时，请重试。" : "模型响应格式不正确。", 502);
  }
}
export async function listModels(rawConfig, fetchImpl = globalThis.fetch, networkMessageImpl = browserNetworkMessage) {
  const config = validateModelConfig(rawConfig);
  if (config.provider === "offline") return { models: [], offline: true };
  const data = await request(config, "models", null, fetchImpl, networkMessageImpl);
  if (!Array.isArray(data.data)) throw new GameError("平台未返回兼容的模型列表。", 502);
  return { models: [...new Set(data.data.map((item) => item?.id).filter((id) => typeof id === "string" && id.trim() && id.length <= 200))] };
}
export function validateCompletionMessage(message) {
  if (!message || typeof message !== "object" || Array.isArray(message) || (message.role !== undefined && message.role !== "assistant")) throw new GameError("模型没有返回可用消息。", 502);
  if (message.content !== undefined && message.content !== null && typeof message.content !== "string") throw new GameError("模型消息格式不正确。", 502);
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) throw new GameError("模型工具调用格式不正确。", 502);
  const calls = message.tool_calls || [];
  if (calls.length > 6) throw new GameError("模型单次工具调用过多，请重试。", 502);
  const ids = new Set();
  for (const call of calls) {
    if (!call || typeof call !== "object" || call.type !== "function" || typeof call.id !== "string" || !call.id.trim() || call.id.length > 200 || ids.has(call.id) || !call.function || typeof call.function.name !== "string" || !call.function.name || typeof call.function.arguments !== "string" || call.function.arguments.length > 8000) throw new GameError("模型工具调用格式不正确。", 502);
    ids.add(call.id);
  }
  if (typeof message.content !== "string" && !calls.length) throw new GameError("模型没有返回可用消息。", 502);
  return {
    content: message.content ?? null,
    ...(calls.length ? { tool_calls: calls.map((call) => ({ id: call.id, type: "function", function: { name: call.function.name, arguments: call.function.arguments } })) } : {}),
    ...(typeof message.reasoning_content === "string" ? { reasoning_content: message.reasoning_content } : {}),
  };
}
export async function complete(config, messages, tools, fetchImpl = globalThis.fetch, networkMessageImpl = browserNetworkMessage) {
  const valid = validateModelConfig(config);
  const data = await request(valid, "chat/completions", {
    model: valid.model, messages, tools, tool_choice: "auto", max_tokens: 1400, stream: false,
    ...(valid.provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
  }, fetchImpl, networkMessageImpl);
  return validateCompletionMessage(data.choices?.[0]?.message);
}
