import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { complete, listModels, validateCompletionMessage, validateModelConfig } from "../lib/model-core.mjs";
import { complete as nodeComplete, validateCompletionMessage as nodeValidateMessage, validateModelConfig as nodeValidateConfig } from "../lib/model.mjs";
import { randomInt, randomUUID } from "../lib/random.mjs";

const config = { provider: "compatible", baseUrl: "https://model.example/v1", model: "browser-model", apiKey: "pages-model-test-secret" };
const jsonResponse = (data, status = 200) => new Response(JSON.stringify(data), { status });

test("browser model core uses global fetch for listing and completion with the same validators", async (t) => {
  let requests = 0;
  t.mock.method(globalThis, "fetch", async (url, options) => {
    requests++;
    assert.equal(options.redirect, "error");
    assert.equal(options.headers.Authorization, `Bearer ${config.apiKey}`);
    if (url.endsWith("/models")) {
      assert.equal(options.method, "GET");
      return jsonResponse({ data: [{ id: "browser-model" }, { id: "browser-model" }, { id: "" }] });
    }
    assert.equal(url, "https://model.example/v1/chat/completions");
    assert.equal(options.method, "POST");
    const body = JSON.parse(options.body);
    assert.equal(body.thinking, undefined);
    assert.equal(body.stream, false);
    assert.equal(body.model, config.model);
    return jsonResponse({ choices: [{ message: { role: "assistant", content: "旁白：收到。" } }] });
  });
  assert.equal(nodeValidateMessage, validateCompletionMessage);
  assert.equal(nodeValidateConfig, validateModelConfig);
  assert.deepEqual(await listModels(config), { models: ["browser-model"] });
  assert.deepEqual(await complete(config, [], []), { content: "旁白：收到。" });
  assert.deepEqual(await listModels({ provider: "offline" }), { models: [], offline: true });
  assert.equal(requests, 2);
});

test("browser failures mention CORS and keep network details, upstream bodies and keys private", async () => {
  for (const operation of [() => listModels(config, async () => { throw new TypeError(config.apiKey); }), () => complete(config, [], [], async () => { throw new TypeError(config.apiKey); })]) {
    await assert.rejects(operation(), (error) => {
      assert.equal(error.status, 502);
      assert.match(error.message, /接口地址和网络/);
      assert.match(error.message, /跨域访问/);
      assert.ok(!error.message.includes(config.apiKey));
      return true;
    });
  }
  await assert.rejects(complete(config, [], [], async () => { throw new DOMException(config.apiKey, "TimeoutError"); }), /超时/);
  await assert.rejects(complete(config, [], [], async () => jsonResponse({ error: `private upstream body ${config.apiKey}` }, 403)), (error) => error.status === 502 && error.message === "模型访问权限不足。");
  await assert.rejects(complete(config, [], [], async () => new Response(config.apiKey)), (error) => error.status === 502 && error.message === "模型响应格式不正确。");
  await assert.rejects(nodeComplete(config, [], [], async () => { throw new TypeError(config.apiKey, { cause: { code: "SELF_SIGNED_CERT_IN_CHAIN" } }); }), /证书验证失败/);
});

test("Web Crypto randomInt rejects biased samples and keeps inclusive/exclusive bounds", (t) => {
  let samples = [0xffffffff, 0];
  let draws = 0;
  t.mock.method(globalThis.crypto, "getRandomValues", (words) => {
    draws++;
    if (words.length === 1) words[0] = samples.shift();
    else { words[0] = 0xffff; words[1] = samples.shift(); }
    return words;
  });
  assert.equal(randomInt(1, 0xffffffff), 1);
  assert.equal(draws, 2);
  samples = [0xfffffffd];
  assert.equal(randomInt(1, 0xffffffff), 0xfffffffe);
  samples = [0xffffffff, 0];
  assert.equal(randomInt(-10, 2 ** 48 - 11), 2 ** 48 - 2 ** 32 - 10);
  assert.equal(draws, 5);
  for (const bounds of [[1, 1], [10, 1], [0, 2 ** 48]]) assert.throws(() => randomInt(...bounds), RangeError);
  for (const bounds of [[0.5, 2], [0, Infinity]]) assert.throws(() => randomInt(...bounds), TypeError);
  t.mock.method(globalThis.crypto, "randomUUID", () => "browser-generated-uuid");
  assert.equal(randomUUID(), "browser-generated-uuid");
});

test("shared engine and agent execute in a browser realm with no Node imports or globals", async () => {
  const script = `
    import assert from "node:assert/strict";
    import { readFile } from "node:fs/promises";
    import { webcrypto } from "node:crypto";
    import { createContext, SourceTextModule, runInContext } from "node:vm";
    const root = new URL(${JSON.stringify(new URL("../", import.meta.url).href)});
    const context = createContext({ URL, AbortSignal, crypto: webcrypto, structuredClone });
    assert.equal(runInContext("typeof process", context), "undefined");
    assert.equal(runInContext("typeof Buffer", context), "undefined");
    const modules = new Map();
    async function compile(url) {
      if (!modules.has(url.href)) {
        const source = await readFile(url, "utf8");
        const module = new SourceTextModule(source, {
          context, identifier: url.href,
          initializeImportMeta(meta) { meta.url = url.href; },
          importModuleDynamically() { throw new Error("Unexpected Node default dependency"); },
        });
        modules.set(url.href, module);
      }
      return modules.get(url.href);
    }
    const agent = await compile(new URL("lib/agent.mjs", root));
    await agent.link((specifier, referencing) => {
      assert.ok(specifier.startsWith("."), "Browser import must be relative: " + specifier);
      return compile(new URL(specifier, referencing.identifier));
    });
    await agent.evaluate();
    const engine = modules.get(new URL("lib/engine.mjs", root).href).namespace;
    const core = modules.get(new URL("lib/model-core.mjs", root).href).namespace;
    const offline = engine.createWorld({ name: "萧景", opening: "founding", seed: 71349 });
    const minute = offline.minute;
    const offlineResult = await agent.namespace.runTurn(offline, "赏赐顾廷章100两银", { provider: "offline" });
    assert.equal(offlineResult.result.kind, "reward");
    assert.ok(offline.minute > minute);
    const world = engine.createWorld({ name: "萧景", opening: "founding", seed: 71349 });
    const settings = ${JSON.stringify(config)};
    let requests = 0, prompts = 0;
    context.fetch = async (_url, options) => {
      const body = JSON.parse(options.body);
      assert.equal(body.messages[0].content, "fixed browser agent prompt");
      assert.equal(options.headers.Authorization, "Bearer " + settings.apiKey);
      assert.ok(!options.body.includes(settings.apiKey));
      requests++;
      const message = requests === 1
        ? { tool_calls: [{ id: "introduce", type: "function", function: { name: "execute_action", arguments: JSON.stringify({ kind: "introduce", targetId: "", targetName: "沈知远", subject: "添加人物沈知远" }) } }] }
        : { content: "陈德：沈知远已经登记入册。" };
      return { ok: true, json: async () => ({ choices: [{ message }] }) };
    };
    const result = await agent.namespace.runTurn(world, "添加人物沈知远", settings, {
      completeImpl: core.complete,
      readPromptImpl: async () => { prompts++; return "fixed browser agent prompt"; },
    });
    assert.equal(requests, 2);
    assert.equal(prompts, 1);
    assert.equal(result.result.kind, "introduce");
    assert.equal(world.people.filter((person) => person.name === "沈知远").length, 1);
    assert.ok(engine.publicView(world).people.some((person) => person.name === "沈知远"));
    assert.ok(!modules.has(new URL("lib/model.mjs", root).href));
    assert.ok(!modules.has(new URL("lib/model-transport.mjs", root).href));
  `;
  await promisify(execFile)(process.execPath, ["--experimental-vm-modules", "--input-type=module", "-e", script], { timeout: 10000 });
});
