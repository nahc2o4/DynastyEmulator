import test from "node:test";
import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, writeFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { Store } from "../lib/store.mjs";
import { createWorld, executeAction } from "../lib/engine.mjs";
import { RULES } from "../config/rules.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const actionText = "赏赐顾廷章100两银";
const key = "server-test-key-never-save";
const deferred = () => { let resolve; const promise = new Promise((done) => { resolve = done; }); return { promise, resolve }; };
async function temporaryDirectory(t) {
  const directory = await mkdtemp(join(tmpdir(), "dynasty-server-test-"));
  t.after(async () => {
    const exact = resolve(directory);
    assert.equal(dirname(exact).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(exact).startsWith("dynasty-server-test-"));
    await rm(exact, { recursive: true, force: true });
  });
  return directory;
}
async function stopApp(app) {
  if (!app || app.child.exitCode !== null || app.child.signalCode !== null) return;
  const ended = once(app.child, "exit");
  app.child.kill();
  await ended;
}
async function launchApp(directory, environment = {}) {
  const child = spawn(process.execPath, [join(root, "server.mjs")], { cwd: root, env: { ...process.env, PORT: "0", DYNASTY_DATA_DIR: directory, DEEPSEEK_API_KEY: "", ...environment }, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const app = { child, get output() { return output; } };
  const ready = await new Promise((done, reject) => {
    const timer = setTimeout(() => { child.kill(); reject(new Error("Server startup timed out")); }, 10000);
    const finish = (value, error) => { clearTimeout(timer); error ? reject(error) : done(value); };
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/http:\/\/127\.0\.0\.1:(\d+)/);
      if (match) finish(`http://127.0.0.1:${match[1]}`);
    });
    child.stderr.on("data", (chunk) => { output += chunk; });
    child.once("error", (error) => finish(null, error));
    child.once("exit", () => finish(null, new Error(`Server exited: ${output}`)));
  });
  return { ...app, get output() { return output; }, url: ready };
}
async function api(app, path, data, headers = {}) {
  const response = await fetch(`${app.url}${path}`, { method: data === undefined ? "GET" : "POST", headers: { ...(data === undefined ? {} : { "Content-Type": "application/json" }), ...headers }, ...(data === undefined ? {} : { body: typeof data === "string" ? data : JSON.stringify(data) }) });
  return { status: response.status, data: await response.json() };
}
const action = (state, requestId, text = actionText) => ({ gameId: state.game.id, version: state.game.version, requestId, text });
async function rawGet(app, path, headers) {
  return new Promise((done, reject) => {
    const request = httpRequest(`${app.url}${path}`, { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => done({ status: response.statusCode, data: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
    });
    request.on("error", reject); request.end();
  });
}
async function mockProvider(t) {
  const state = { mode: "normal", calls: [], held: deferred(), release: deferred() };
  const json = (response, data, status = 200) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(data)); };
  const server = createServer(async (request, response) => {
    if (request.url === "/v1/models") { state.calls.push({ path: request.url, authorization: request.headers.authorization }); return json(response, { data: [{ id: "mock-model" }] }); }
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    state.calls.push({ path: request.url, authorization: request.headers.authorization, input });
    const settled = input.messages.some((message) => {
      if (message.role !== "tool") return false;
      try { return JSON.parse(message.content).kind === "reward"; } catch { return false; }
    });
    if (state.mode === "before-failure" || (state.mode === "after-failure" && settled)) return json(response, { error: `upstream-secret ${key}` }, state.mode === "before-failure" ? 401 : 500);
    if (!input.tools.some((entry) => entry.function.name === "execute_action")) return json(response, { choices: [{ message: { role: "assistant", content: "陈德：名册中记载陆衡负责监察与巡察。" } }] });
    if (!settled) return json(response, { choices: [{ message: { role: "assistant", content: null, tool_calls: [
      { id: "execute-1", type: "function", function: { name: "execute_action", arguments: JSON.stringify({ kind: "reward", targetId: "minister", subject: actionText }) } },
      { id: "execute-duplicate", type: "function", function: { name: "execute_action", arguments: JSON.stringify({ kind: "military", targetId: "general", subject: "ignored duplicate" }) } },
    ] } }] });
    if (state.mode === "hold-narration") { state.held.resolve(); await state.release.promise; }
    return json(response, { choices: [{ message: { role: "assistant", content: "顾廷章：臣领受赏银，谢陛下。\n旁白：御前文书归档。" } }] });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => { state.release.resolve(); server.closeAllConnections(); await new Promise((done) => server.close(done)); });
  state.url = `http://127.0.0.1:${server.address().port}/v1`;
  return state;
}

test("Store serializes atomic writes and never exposes partial JSON", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new Store(directory);
  await store.save("state", { revision: 0, payload: "initial" });
  let finished = false;
  let writeFailure;
  const writes = Promise.all(Array.from({ length: 16 }, (_, index) => store.save("state", { revision: index + 1, payload: "x".repeat(20000) }))).then(() => { finished = true; }, (error) => { writeFailure = error; finished = true; });
  let reads = 0;
  while (!finished) { const current = await store.read("state"); assert.ok(Number.isInteger(current.revision)); assert.ok(current.revision >= 0 && current.revision <= 16); reads++; }
  await writes;
  if (writeFailure) throw writeFailure;
  assert.ok(reads > 0);
  assert.equal((await store.read("state")).revision, 16);
  assert.deepEqual((await readdir(directory)).filter((name) => name.endsWith(".tmp")), []);
  await assert.rejects(store.save("../escape", {}));
});

test("Store preserves valid backups, rejects missing simulation fields, and recovers settings", async (t) => {
  const directory = await temporaryDirectory(t);
  const store = new Store(directory);
  const first = createWorld({ name: "萧景", opening: "founding", seed: 71349 });
  await store.save("world", first);
  const second = structuredClone(first);
  executeAction(second, { kind: "reward", targetId: "minister", subject: actionText }, actionText);
  second.version++;
  await store.save("world", second);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "world.previous.json"), "utf8")), first);
  for (const corrupt of ["{", JSON.stringify({ ...second, id: undefined }), JSON.stringify({ ...second, rng: undefined }), JSON.stringify({ ...second, reportedTreasury: null }), JSON.stringify({ ...second, people: second.people.map((person) => person.id === "minister" ? { ...person, intelligence: null } : person) }), JSON.stringify({ ...second, people: second.people.map((person) => person.id === "minister" ? { ...person, illness: { severity: null, startedDay: 1 } } : person) })]) {
    await writeFile(join(directory, "world.json"), corrupt);
    const recovered = new Store(directory);
    assert.deepEqual(await recovered.read("world"), first);
    assert.ok(recovered.recovered.has("world"));
  }
  await rm(join(directory, "world.json"));
  assert.deepEqual(await new Store(directory).read("world"), first);
  const initialSettings = { provider: "compatible", baseUrl: "http://localhost:1234/v1", model: "test-model", additionalInstructions: "", apiKey: key };
  await store.save("settings", initialSettings);
  await store.save("settings", { ...initialSettings, model: "new-model" });
  await writeFile(join(directory, "settings.json"), JSON.stringify({ ...initialSettings, baseUrl: "invalid" }));
  const recoveredSettings = new Store(directory);
  assert.equal((await recoveredSettings.read("settings")).model, "test-model");
  assert.ok(recoveredSettings.recovered.has("settings"));
  for (const name of await readdir(directory)) assert.ok(!(await readFile(join(directory, name), "utf8")).includes(key), name);
});

test("legacy schema1 worlds remain readable when new optional private fields are absent", async (t) => {
  const directory = await temporaryDirectory(t);
  const legacy = createWorld({ name: "萧景", opening: "founding", seed: 71349 });
  delete legacy.reportedTreasury; delete legacy.relationCounter;
  for (const person of legacy.people) {
    delete person.initialIntelligence; delete person.illness;
    delete person.observed.minute; delete person.observed.status; delete person.observed.fieldTimes;
  }
  for (const event of legacy.events) for (const field of ["reportMinute", "observations", "relationshipIds", "treasuryLoss", "ledgerKnown"]) delete event[field];
  for (const relation of legacy.relationships) delete relation.id;
  const store = new Store(directory);
  await store.save("world", legacy);
  assert.deepEqual(await store.read("world"), legacy);
});

test("failed atomic replacement preserves the old primary and a valid backup", async (t) => {
  const directory = await temporaryDirectory(t);
  class FailingStore extends Store {
    fail = false;
    async atomicWrite(name, data) { if (name === "world" && this.fail) throw new Error("simulated disk failure"); return super.atomicWrite(name, data); }
  }
  const store = new FailingStore(directory);
  const world = createWorld({ name: "萧景", opening: "founding", seed: 71349 });
  await store.save("world", world);
  store.fail = true;
  await assert.rejects(store.save("world", { ...world, version: world.version + 1 }), /disk failure/);
  assert.deepEqual(await store.read("world"), world);
  assert.deepEqual(JSON.parse(await readFile(join(directory, "world.previous.json"), "utf8")), world);
  store.fail = false;
  await store.save("world", { ...world, version: world.version + 1 });
  assert.equal((await store.read("world")).version, world.version + 1);
});

test("HTTP server enforces isolation, persists settlement before narration, and replays after restart", { timeout: 30000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const provider = await mockProvider(t);
  let app = await launchApp(directory);
  t.after(() => stopApp(app));
  let state = (await api(app, "/api/state")).data;
  assert.equal(state.game, null);
  assert.equal(state.busy, false);
  assert.equal(state.settings.hasKey, false);

  await t.test("host, origin, methods, body limits and static whitelist", async () => {
    for (const path of ["/data/world.json", "/config/rules.mjs", "/lib/engine.mjs", "/agent.md", "/.git/config", "/world.json"]) assert.equal((await api(app, path)).status, 404, path);
    assert.equal((await rawGet(app, "/api/state", { Host: "attacker.invalid" })).status, 403);
    assert.equal((await api(app, "/api/state", undefined, { Origin: "http://attacker.invalid" })).status, 403);
    assert.equal((await api(app, "/api/start")).status, 405);
    assert.equal((await api(app, "/api/settings", "{}", { "Content-Type": "application/jsonbad" })).status, 415);
    assert.equal((await api(app, "/api/settings", "{")).status, 400);
    assert.equal((await api(app, "/api/settings", JSON.stringify({ input: "x".repeat(70000) }))).status, 413);
    assert.equal((await api(app, "/api/settings", "[]")).status, 400);
    const response = await fetch(app.url);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("Content-Security-Policy"), /connect-src 'self'/);
  });

  const started = await api(app, "/api/start", { name: "萧景", opening: "founding", seed: 71349, treasury: 999999999, people: [] });
  assert.equal(started.status, 200);
  state = started.data;
  const originalStart = structuredClone(state);
  assert.equal(state.game.treasury, RULES.openings.founding.treasury);
  const diskStart = JSON.parse(await readFile(join(directory, "world.json"), "utf8"));
  const seeded = createWorld({ name: "萧景", opening: "founding", seed: 71349 });
  assert.notDeepEqual(diskStart.people.map((person) => [person.intelligence, person.force, person.loyalty, person.talent, person.traits]), seeded.people.map((person) => [person.intelligence, person.force, person.loyalty, person.talent, person.traits]));
  assert.ok(!JSON.stringify(state).includes('"traits":'));

  await t.test("settings preserve only metadata and test-model uses memory key", async () => {
    const saved = await api(app, "/api/settings", { provider: "compatible", baseUrl: provider.url, model: "mock-model", apiKey: key, additionalInstructions: "简短叙述", systemPrompt: "replace fixed prompt" });
    assert.equal(saved.status, 200);
    assert.equal(saved.data.settings.hasKey, true);
    assert.ok(!JSON.stringify(saved.data).includes(key));
    const disk = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
    assert.deepEqual(Object.keys(disk).sort(), ["additionalInstructions", "baseUrl", "model", "provider"]);
    assert.equal((await api(app, "/api/test-model", {})).status, 200);
    assert.equal(provider.calls.at(-1).authorization, `Bearer ${key}`);
  });

  await t.test("duplicate execute tools and duplicate requests settle exactly once", async () => {
    const input = action(state, "request-normal-001");
    const before = structuredClone(state);
    const response = await api(app, "/api/action", input);
    assert.equal(response.status, 200);
    state = response.data;
    assert.equal(state.game.minute, before.game.minute + RULES.minutes.reward);
    assert.equal(state.game.treasury, before.game.treasury - 100);
    assert.equal(state.game.version, before.game.version + 1);
    assert.deepEqual(state.result, { minutes: RULES.minutes.reward, treasuryChange: -100, kind: "reward" });
    const persisted = JSON.parse(await readFile(join(directory, "world.json"), "utf8"));
    const backup = JSON.parse(await readFile(join(directory, "world.previous.json"), "utf8"));
    assert.equal(persisted.receipts.filter((receipt) => receipt.id === input.requestId).length, 1);
    assert.equal(backup.version, persisted.version);
    assert.equal(backup.receipts.at(-1).id, input.requestId);
    assert.match(backup.receipts.at(-1).outcome.notice, /叙事尚未完成/);
    const count = provider.calls.length;
    const replay = await api(app, "/api/action", input);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.replayed, true);
    assert.equal(provider.calls.length, count);
    assert.equal((await api(app, "/api/action", { ...input, text: "改为休息" })).status, 409);
    assert.equal((await api(app, "/api/action", { ...input, requestId: "request-stale-001" })).status, 409);
    assert.equal((await api(app, "/api/action", { ...action(state, "request-no-gameid"), gameId: undefined })).status, 409);
  });

  await t.test("model errors before calculation roll back and after calculation preserve one action", async () => {
    const before = structuredClone(state);
    const disk = await readFile(join(directory, "world.json"), "utf8");
    provider.mode = "before-failure";
    const failed = await api(app, "/api/action", action(state, "request-before-fail"));
    assert.equal(failed.status, 502);
    assert.ok(!JSON.stringify(failed.data).includes(key));
    const unchanged = (await api(app, "/api/state")).data;
    assert.deepEqual(unchanged.game, before.game);
    assert.equal(unchanged.busy, false);
    assert.equal(await readFile(join(directory, "world.json"), "utf8"), disk);
    provider.mode = "after-failure";
    const settled = await api(app, "/api/action", action(state, "request-after-fail"));
    assert.equal(settled.status, 200);
    state = settled.data;
    assert.match(state.notice, /已结算/);
    assert.equal(state.game.minute, before.game.minute + RULES.minutes.reward);
    assert.equal(state.game.treasury, before.game.treasury - 100);
    assert.equal(state.game.version, before.game.version + 1);
  });

  await t.test("interrupted final narration restores a durable receipt and rejects competing mutations", async () => {
    provider.mode = "hold-narration";
    const input = action(state, "request-interrupted");
    const before = structuredClone(state);
    const pending = api(app, "/api/action", input).catch((error) => ({ networkError: error }));
    await provider.held.promise;
    const checkpoint = (await api(app, "/api/state")).data;
    assert.equal(checkpoint.busy, true);
    assert.equal(checkpoint.game.version, before.game.version + 1);
    assert.equal(checkpoint.game.minute, before.game.minute + RULES.minutes.reward);
    assert.equal(checkpoint.game.treasury, before.game.treasury - 100);
    assert.equal((await api(app, "/api/start", { name: "新帝", opening: "prosperous" })).status, 409);
    assert.equal((await api(app, "/api/settings", { provider: "offline" })).status, 409);
    assert.equal((await api(app, "/api/action", action(checkpoint, "request-competing"))).status, 409);
    const earlyReplay = await api(app, "/api/action", input);
    assert.equal(earlyReplay.status, 200);
    assert.equal(earlyReplay.data.replayed, true);
    assert.match(earlyReplay.data.notice, /已保存/);
    const completions = provider.calls.length;
    await stopApp(app);
    assert.ok((await pending).networkError);
    provider.release.resolve(); provider.mode = "normal";
    app = await launchApp(directory);
    state = (await api(app, "/api/state")).data;
    assert.equal(state.busy, false);
    assert.equal(state.settings.hasKey, false);
    assert.deepEqual(state.game, checkpoint.game);
    const replay = await api(app, "/api/action", input);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.replayed, true);
    assert.equal(provider.calls.length, completions);
    assert.equal(replay.data.game.version, checkpoint.game.version);
  });

  await t.test("new worlds reject stale tabs even when their versions match", async () => {
    state = (await api(app, "/api/start", { name: "周晟", opening: "founding" })).data;
    assert.equal(state.game.version, originalStart.game.version);
    assert.notEqual(state.game.id, originalStart.game.id);
    assert.equal((await api(app, "/api/action", action(originalStart, "request-old-world"))).status, 409);
    assert.deepEqual((await api(app, "/api/state")).data.game, state.game);
  });

  await t.test("settings and new-game writes share one mutation lock", async () => {
    const responses = await Promise.all(Array.from({ length: 20 }, (_, index) => index % 2 ? api(app, "/api/start", { name: `测试${index}`, opening: "founding" }) : api(app, "/api/settings", { provider: "compatible", baseUrl: provider.url, model: "mock-model", additionalInstructions: `batch-${index}` })));
    assert.ok(responses.some((response) => response.status === 200));
    assert.ok(responses.some((response) => response.status === 409));
    assert.ok(responses.every((response) => [200, 409].includes(response.status)));
    state = (await api(app, "/api/state")).data;
    const diskWorld = JSON.parse(await readFile(join(directory, "world.json"), "utf8"));
    const diskSettings = JSON.parse(await readFile(join(directory, "settings.json"), "utf8"));
    assert.equal(state.game.id, diskWorld.id);
    assert.equal(state.game.name, diskWorld.name);
    assert.equal(state.settings.additionalInstructions, diskSettings.additionalInstructions);
    assert.equal(state.busy, false);
  });

  await t.test("corrupt primary restores the last valid backup including its receipt", async () => {
    const input = action(state, "request-before-recovery");
    state = (await api(app, "/api/action", input)).data;
    const backup = JSON.parse(await readFile(join(directory, "world.previous.json"), "utf8"));
    assert.equal(backup.version, state.game.version);
    const count = provider.calls.length;
    await stopApp(app);
    await writeFile(join(directory, "world.json"), "{");
    app = await launchApp(directory);
    state = (await api(app, "/api/state")).data;
    assert.match(state.recoveryNotice, /已恢复/);
    assert.equal(state.game.id, backup.id);
    assert.equal(state.game.minute, backup.minute);
    assert.equal(state.game.version, backup.version);
    const replay = await api(app, "/api/action", input);
    assert.equal(replay.status, 200);
    assert.equal(replay.data.replayed, true);
    assert.equal(provider.calls.length, count);
    assert.equal(replay.data.game.minute, backup.minute);
  });
  assert.ok(!app.output.includes(key));
  for (const name of await readdir(directory)) if (name.endsWith(".json")) assert.ok(!(await readFile(join(directory, name), "utf8")).includes(key), name);
});

test("unrecoverable saves stop startup and preserve the damaged files", { timeout: 15000 }, async (t) => {
  const directory = await temporaryDirectory(t);
  const primary = '{"secret-corrupt-sentinel":';
  await writeFile(join(directory, "world.json"), primary);
  await writeFile(join(directory, "world.previous.json"), "{}");
  await assert.rejects(launchApp(directory), (error) => { assert.match(error.message, /主存档.*备用存档均无法读取/); assert.ok(!error.message.includes("secret-corrupt-sentinel")); return true; });
  assert.equal(await readFile(join(directory, "world.json"), "utf8"), primary);
  assert.equal(await readFile(join(directory, "world.previous.json"), "utf8"), "{}");
});

test("DeepSeek environment credentials never go to a saved compatible endpoint", async (t) => {
  const directory = await temporaryDirectory(t);
  const provider = await mockProvider(t);
  const store = new Store(directory);
  await store.save("settings", { provider: "compatible", baseUrl: provider.url, model: "mock-model", additionalInstructions: "" });
  const app = await launchApp(directory, { DEEPSEEK_API_KEY: key });
  t.after(() => stopApp(app));
  assert.equal((await api(app, "/api/state")).data.settings.hasKey, false);
  assert.equal((await api(app, "/api/test-model", {})).status, 200);
  assert.equal(provider.calls.at(-1).authorization, undefined);
  const selected = await api(app, "/api/settings", { provider: "deepseek", baseUrl: "https://api.deepseek.com", model: "deepseek-flash" });
  assert.equal(selected.status, 200);
  assert.equal(selected.data.settings.hasKey, true);
  assert.ok(!JSON.stringify(selected.data).includes(key));
  for (const name of await readdir(directory)) assert.ok(!(await readFile(join(directory, name), "utf8")).includes(key));
});
