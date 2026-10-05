import test from "node:test";
import assert from "node:assert/strict";
import { complete, listModels, validateModelConfig, validateCompletionMessage } from "../lib/model.mjs";

const config = { provider: "deepseek", baseUrl: "https://api.deepseek.com/", model: "deepseek-flash", apiKey: "model-test-secret", additionalInstructions: "" };
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });

test("DeepSeek completion uses bearer auth and non-thinking Chat Completions with tools", async () => {
  const messages = [{ role: "system", content: "fixed" }, { role: "user", content: "action" }];
  const tools = [{ type: "function", function: { name: "execute_action", parameters: { type: "object" } } }];
  const result = await complete(config, messages, tools, async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/chat/completions");
    assert.equal(options.method, "POST");
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
    assert.ok(options.signal instanceof AbortSignal);
    const body = JSON.parse(options.body);
    assert.equal(body.model, "deepseek-flash");
    assert.deepEqual(body.messages, messages);
    assert.deepEqual(body.tools, tools);
    assert.deepEqual(body.thinking, { type: "disabled" });
    assert.equal(body.tool_choice, "auto");
    assert.equal(body.stream, false);
    assert.ok(!options.body.includes(config.apiKey));
    return jsonResponse({ choices: [{ message: { role: "assistant", content: "旁白：收到。" } }] });
  });
  assert.equal(result.content, "旁白：收到。");
});

test("compatible provider omits DeepSeek-only fields and supports local keyless endpoints", async () => {
  await complete({ ...config, provider: "compatible", baseUrl: "http://127.0.0.1:8765/v1", apiKey: "" }, [], [], async (url, options) => {
    assert.equal(url, "http://127.0.0.1:8765/v1/chat/completions");
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(JSON.parse(options.body).thinking, undefined);
    return jsonResponse({ choices: [{ message: { content: "旁白：收到。" } }] });
  });
});

test("model listing uses GET auth, deduplicates IDs, and offline does no network request", async () => {
  const result = await listModels(config, async (url, options) => {
    assert.equal(url, "https://api.deepseek.com/models");
    assert.equal(options.method, "GET");
    assert.equal(options.body, undefined);
    assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
    return jsonResponse({ data: [{ id: "deepseek-flash" }, { id: "deepseek-flash" }, { id: "" }, { id: " " }, { id: 123 }, { id: "compatible-model" }] });
  });
  assert.deepEqual(result.models, ["deepseek-flash", "compatible-model"]);
  assert.deepEqual(await listModels({ provider: "offline" }, async () => { throw new Error("unexpected request"); }), { models: [], offline: true });
});

test("configuration rejects unsafe URLs, invalid keys and unsupported fields", () => {
  assert.equal(validateModelConfig(config).baseUrl, "https://api.deepseek.com");
  assert.equal(validateModelConfig({ provider: "offline" }).additionalInstructions, "");
  for (const baseUrl of ["http://example.com/v1", "https://user:pass@example.com", "https://example.com/v1?", "https://example.com/v1#", "file:///tmp/model", "invalid"]) assert.throws(() => validateModelConfig({ ...config, baseUrl }));
  for (const apiKey of ["part\nheader", "part\u0000header", "a".repeat(2049), 123]) assert.throws(() => validateModelConfig({ ...config, apiKey }));
  assert.throws(() => validateModelConfig({ ...config, apiKey: "" }), /API Key/);
  assert.throws(() => validateModelConfig({ ...config, additionalInstructions: "a".repeat(8001) }));
  assert.throws(() => validateModelConfig([]));
  assert.throws(() => validateModelConfig({ ...config, provider: "unsupported" }));
});

test("provider HTTP failures are controlled and never expose upstream bodies or keys", async () => {
  for (const status of [401, 402, 403, 404, 429, 500]) {
    await assert.rejects(complete(config, [], [], async () => jsonResponse({ error: `upstream secret ${config.apiKey}` }, status)), (error) => {
      assert.equal(error.status, 502);
      assert.ok(!error.message.includes(config.apiKey));
      assert.ok(!error.message.includes("upstream"));
      return true;
    });
  }
});

test("network, timeout and JSON failures map to useful sanitized messages", async () => {
  await assert.rejects(complete(config, [], [], async () => { throw new Error(config.apiKey); }), /无法连接/);
  await assert.rejects(complete(config, [], [], async () => { throw new DOMException(config.apiKey, "TimeoutError"); }), /超时/);
  await assert.rejects(complete(config, [], [], async () => ({ ok: true, json: async () => { throw new DOMException(config.apiKey, "AbortError"); } })), /超时/);
  await assert.rejects(complete(config, [], [], async () => new Response("not JSON")), /格式不正确/);
  await assert.rejects(complete(config, [], [], async () => jsonResponse([])), /格式不正确/);
  await assert.rejects(complete(config, [], [], async () => jsonResponse({ choices: [] })), /可用消息/);
  await assert.rejects(listModels(config, async () => jsonResponse({ models: [] })), /模型列表/);
});

test("completion schema rejects unusable tool envelopes", () => {
  const toolCall = { id: "call-1", type: "function", function: { name: "get_known_state", arguments: "{}" } };
  assert.deepEqual(validateCompletionMessage({ role: "assistant", content: null, tool_calls: [toolCall], arbitrary: "ignored" }), { content: null, tool_calls: [toolCall] });
  for (const message of [{ role: "system", content: "bad" }, { content: [] }, { tool_calls: {} }, { tool_calls: [{ ...toolCall, function: { name: "read", arguments: {} } }] }, { tool_calls: [toolCall, toolCall] }, { tool_calls: Array.from({ length: 7 }, (_, index) => ({ ...toolCall, id: `call-${index}` })) }]) assert.throws(() => validateCompletionMessage(message), { status: 502 });
});
