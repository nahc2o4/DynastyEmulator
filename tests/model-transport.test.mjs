import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { createModelFetch, directModelFetch, refusedLocalProxy, useSystemTrust, modelNetworkMessage } from "../lib/model-transport.mjs";

const url = "https://api.deepseek.com/models";
const environment = { HTTPS_PROXY: "http://127.0.0.1:10808" };
const refused = (overrides = {}) => new TypeError("fetch failed", { cause: Object.assign(new Error("connection failed"), { code: "ECONNREFUSED", syscall: "connect", address: "127.0.0.1", port: 10808, ...overrides }) });
async function localServer(t, handler) {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return `http://127.0.0.1:${server.address().port}`;
}

test("system trust extends bundled and extra roots without replacing them", () => {
  let actual;
  const certificates = useSystemTrust({
    getCACertificates: (source) => source === "default" ? ["bundled", "extra"] : ["extra", "system"],
    setDefaultCACertificates: (value) => { actual = value; },
  });
  assert.deepEqual(certificates, ["bundled", "extra", "system"]);
  assert.deepEqual(actual, certificates);
  assert.equal(useSystemTrust({}), undefined);
});

test("fallback identifies the configured loopback proxy and honors proxy exclusions", () => {
  assert.equal(refusedLocalProxy(refused(), url, environment), true);
  assert.equal(refusedLocalProxy(refused(), url, { HTTP_PROXY: environment.HTTPS_PROXY }), true);
  assert.equal(refusedLocalProxy(refused(), url, { HTTPS_PROXY: "", HTTP_PROXY: environment.HTTPS_PROXY }), true);
  for (const overrides of [{ address: "127.0.0.2" }, { port: 10809 }, { syscall: "write" }, { code: "ECONNRESET" }, { code: "SELF_SIGNED_CERT_IN_CHAIN" }]) {
    assert.equal(refusedLocalProxy(refused(overrides), url, environment), false);
  }
  assert.equal(refusedLocalProxy(refused(), url, { HTTPS_PROXY: "http://proxy.example.com:10808" }), false);
  for (const NO_PROXY of ["*", "api.deepseek.com", ".deepseek.com", "*.deepseek.com", "api.deepseek.com:443"]) assert.equal(refusedLocalProxy(refused(), url, { ...environment, NO_PROXY }), false);
  assert.equal(refusedLocalProxy(refused(), url, { ...environment, https_proxy: "" }), false);
  assert.equal(refusedLocalProxy(refused(), "http://127.0.0.1:10808/models", { HTTP_PROXY: environment.HTTPS_PROXY }), false);
  const mixed = new TypeError("fetch failed", { cause: new AggregateError([refused().cause, refused({ code: "ETIMEDOUT" }).cause]) });
  assert.equal(refusedLocalProxy(mixed, url, environment), false);
});

test("one refused-proxy fallback reaches a real local origin with the original POST and signal", async (t) => {
  let calls = 0;
  const origin = await localServer(t, async (request, response) => {
    calls++; const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    assert.equal(request.headers.authorization, "Bearer test-only");
    assert.equal(Buffer.concat(chunks).toString(), '{"action":"test"}');
    response.writeHead(200, { "Content-Type": "application/json" }); response.end('{"ok":true}');
  });
  const signal = AbortSignal.timeout(2000);
  const options = { method: "POST", headers: { Authorization: "Bearer test-only" }, body: '{"action":"test"}', redirect: "error", signal };
  const fetch = createModelFetch({ environment: { HTTP_PROXY: environment.HTTPS_PROXY }, fetchImpl: async () => { throw refused(); } });
  assert.deepEqual(await (await fetch(`${origin}/completion`, options)).json(), { ok: true });
  assert.equal(calls, 1); assert.equal(signal.aborted, false);
});

test("working connections and HTTP errors do not fall back; ambiguous failures never replay", async () => {
  let fallbacks = 0;
  const directFetch = async () => { fallbacks++; throw new Error("unexpected replay"); };
  for (const status of [200, 401, 429, 502]) {
    const fetch = createModelFetch({ environment, directFetch, fetchImpl: async () => new Response("{}", { status }) });
    assert.equal((await fetch(url, { method: "POST" })).status, status);
  }
  for (const error of [refused({ code: "ECONNRESET" }), refused({ code: "ETIMEDOUT" }), refused({ code: "ENOTFOUND" }), refused({ code: "SELF_SIGNED_CERT_IN_CHAIN" }), refused({ address: "203.0.113.1" })]) {
    const fetch = createModelFetch({ environment, directFetch, fetchImpl: async () => { throw error; } });
    await assert.rejects(fetch(url, { method: "POST" }), (actual) => actual === error);
  }
  const controller = new AbortController(); controller.abort();
  const fetch = createModelFetch({ environment, directFetch, fetchImpl: async () => { throw refused(); } });
  await assert.rejects(fetch(url, { signal: controller.signal }));
  assert.equal(fallbacks, 0);
});

test("direct connections never follow redirects and abort a stalled response", async (t) => {
  let followed = false; let started;
  const received = new Promise((resolve) => { started = resolve; });
  const origin = await localServer(t, (request, response) => {
    if (request.url === "/redirect") { response.writeHead(302, { Location: "/sensitive" }); response.end(); }
    else if (request.url === "/stall") { response.writeHead(200); response.write("{"); started(); }
    else { followed = true; response.end("{}"); }
  });
  assert.equal((await directModelFetch(`${origin}/redirect`, { method: "GET", headers: { Authorization: "Bearer test-only" }, signal: AbortSignal.timeout(2000) })).status, 302);
  assert.equal(followed, false);
  const controller = new AbortController();
  const assertion = assert.rejects(directModelFetch(`${origin}/stall`, { method: "GET", signal: controller.signal }), { name: "AbortError" });
  await received; controller.abort(); await assertion;
});

test("direct response limits and network hints produce controlled failures", async (t) => {
  const origin = await localServer(t, (_request, response) => response.end(Buffer.alloc(4 * 1024 * 1024 + 1)));
  await assert.rejects(directModelFetch(origin, { method: "GET", signal: AbortSignal.timeout(2000) }), { code: "MODEL_RESPONSE_TOO_LARGE" });
  assert.match(modelNetworkMessage(refused({ code: "SELF_SIGNED_CERT_IN_CHAIN" })), /证书/);
  assert.match(modelNetworkMessage(refused({ code: "ENOTFOUND" })), /DNS/);
  assert.match(modelNetworkMessage(refused()), /连接被拒绝/);
  assert.match(modelNetworkMessage(new DOMException("private details", "TimeoutError")), /超时/);
  assert.ok(!modelNetworkMessage(new Error("private details")).includes("private details"));
});
