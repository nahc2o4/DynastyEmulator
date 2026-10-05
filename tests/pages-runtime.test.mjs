import test from "node:test";
import assert from "node:assert/strict";
import { BrowserRuntime } from "../public/browser/runtime.mjs";
import { createWorld, GameError, publicView } from "../lib/engine.mjs";
import { runTurn } from "../lib/agent.mjs";
import { InvalidSaveError, validateSave } from "../lib/save-validation.mjs";
import { RULES } from "../config/rules.mjs";

const fixture = (name = "萧景") => createWorld({ name, opening: "founding", seed: 71349 });
const rewardText = "赏赐陆衡100两银";
const fakeKey = "pages-runtime-test-placeholder";
const modelSettings = { provider: "compatible", baseUrl: "https://example.test/v1", model: "test-model", additionalInstructions: "简短叙述" };
const cloneSave = (name, value) => {
  const clone = validateSave(name, structuredClone(value));
  if (name !== "settings") return clone;
  const { apiKey, ...metadata } = clone;
  return metadata;
};

// Model the store contract without opening IndexedDB or touching local files.
// Failed writes happen before commit; reads and writes never share references.
class MemoryStore {
  constructor(initial = {}) {
    this.records = new Map(Object.entries(initial).map(([name, value]) => [name, cloneSave(name, value)]));
    this.recovered = new Set();
    this.attempts = [];
    this.commits = [];
    this.failWrite = null;
  }
  async read(name) {
    if (!this.records.has(name)) return null;
    try { return cloneSave(name, this.records.get(name)); }
    catch (error) {
      if (!(error instanceof InvalidSaveError)) throw error;
      const backup = cloneSave(name, this.records.get(`${name}.previous`));
      this.records.set(name, structuredClone(backup));
      this.recovered.add(name);
      return structuredClone(backup);
    }
  }
  async save(name, value) { return this.commit({ [name]: value }, "save"); }
  async saveMany(values) { return this.commit(values, "saveMany"); }
  async commit(values, kind) {
    const snapshots = Object.entries(values).map(([name, value]) => [name, cloneSave(name, value)]);
    for (const [name, value] of snapshots) {
      const attempt = { name, kind, value: structuredClone(values[name]) };
      this.attempts.push(attempt);
      if (this.failWrite?.(attempt)) throw new Error("Injected storage failure");
    }
    const next = new Map(this.records);
    for (const [name, value] of snapshots) {
      if (this.records.has(name)) {
        try { next.set(`${name}.previous`, cloneSave(name, this.records.get(name))); }
        catch (error) { if (!(error instanceof InvalidSaveError)) throw error; }
      }
      next.set(name, structuredClone(value));
    }
    this.records = next;
    this.commits.push({ kind, values: Object.fromEntries(snapshots) });
  }
}

function exclusiveLock() {
  const lock = { held: false, entries: 0 };
  lock.run = async (operation) => {
    if (lock.held) throw new GameError("另一个游戏页面正在处理行动，请稍候。", 409);
    lock.held = true; lock.entries++;
    try { return await operation(); }
    finally { lock.held = false; }
  };
  return lock;
}
function harness({ store = new MemoryStore({ world: fixture() }), lock = exclusiveLock(), runTurnImpl = runTurn } = {}) {
  const runtime = new BrowserRuntime({ store, withWriteLock: lock.run, runTurnImpl, readPromptImpl: async () => "固定测试游戏设定" });
  return { runtime, store, lock };
}
const action = (state, requestId, text = rewardText) => ({ gameId: state.game.id, version: state.game.version, requestId, text });
const post = (runtime, path, body) => runtime.request(path, { method: "POST", body });
const executeCall = (id = "execute") => ({ id, type: "function", function: { name: "execute_action", arguments: JSON.stringify({ kind: "reward", targetId: "censor", subject: rewardText }) } });
const modelTurn = (completeImpl) => (world, text, settings, hooks) => runTurn(world, text, { ...settings, provider: "compatible" }, { ...hooks, completeImpl });
function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

test("browser start builds a valid private world and rejects caller-supplied game values", async () => {
  const { runtime, store } = harness({ store: new MemoryStore() });
  assert.equal((await runtime.request("/api/state")).game, null);
  const state = await post(runtime, "/api/start", { name: "萧景", opening: "founding", treasury: 999999999, people: [], version: 900 });
  const world = await store.read("world");
  assert.equal(state.busy, false);
  assert.equal(state.game.version, 1);
  assert.equal(state.game.treasury, RULES.openings.founding.treasury);
  assert.ok(state.game.people.length > 6);
  assert.equal(validateSave("world", world), world);
  for (const person of state.game.people) {
    for (const key of ["intelligence", "force", "loyalty", "talent", "traits", "plot"]) assert.equal(Object.hasOwn(person, key), false);
  }
  assert.equal(Object.hasOwn(state.game, "rng"), false);
  assert.equal(Object.hasOwn(state.game, "receipts"), false);
  const before = structuredClone(store.records);
  await assert.rejects(post(runtime, "/api/start", { name: "", opening: "founding" }), { status: 400 });
  assert.deepEqual(store.records, before);
});

test("a real offline turn saves program settlement before narration and reloads exactly once", async () => {
  let turns = 0;
  const { runtime, store } = harness({ runTurnImpl: (...args) => { turns++; return runTurn(...args); } });
  const before = await runtime.request("/api/state");
  const input = action(before, "offline-reward-001");
  const state = await post(runtime, "/api/action", input);
  assert.deepEqual(state.result, { minutes: RULES.minutes.reward, treasuryChange: -100, kind: "reward" });
  assert.equal(state.game.minute, before.game.minute + RULES.minutes.reward);
  assert.equal(state.game.treasury, before.game.treasury - 100);
  assert.equal(state.game.version, before.game.version + 1);
  assert.equal(store.commits.length, 2);
  const checkpoint = store.commits[0].values.world;
  const final = await store.read("world");
  assert.equal(checkpoint.version, final.version);
  assert.equal(checkpoint.receipts.length, 1);
  assert.match(checkpoint.receipts[0].outcome.notice, /叙事尚未完成/);
  assert.match(final.receipts[0].textHash, /^[a-f0-9]{64}$/);
  assert.equal(final.receipts[0].outcome.notice, "");
  assert.deepEqual(store.records.get("world.previous"), checkpoint);
  assert.equal(final.messages.filter((message) => message.kind === "player" && message.text === rewardText).length, 1);
  const reloaded = harness({ store, runTurnImpl: (...args) => { turns++; return runTurn(...args); } }).runtime;
  assert.deepEqual((await reloaded.request("/api/state")).game, state.game);
  const replay = await post(reloaded, "/api/action", { ...input, text: `  ${rewardText}  ` });
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.result, state.result);
  assert.deepEqual(replay.game, state.game);
  assert.equal(turns, 1);
  assert.equal(store.commits.length, 2);
  await assert.rejects(post(reloaded, "/api/action", { ...input, text: "改为休息" }), { status: 409 });
  await assert.rejects(post(reloaded, "/api/action", { ...input, requestId: "offline-stale-002" }), { status: 409 });
  assert.equal(turns, 1);
});

test("offline summoning creates an absent named character and preserves identity through reload", async () => {
  const { runtime, store } = harness();
  const before = await runtime.request("/api/state");
  assert.equal(before.game.people.some((person) => person.name === "赵云"), false);
  const first = await post(runtime, "/api/action", action(before, "summon-new-person-001", "召见赵云"));
  assert.equal(first.result.kind, "summon");
  assert.equal(first.result.minutes, RULES.minutes.summon);
  assert.equal(first.game.minute, before.game.minute + RULES.minutes.summon);
  assert.equal(first.game.treasury, before.game.treasury);
  assert.equal(first.game.people.length, before.game.people.length + 1);
  const person = first.game.people.find((entry) => entry.name === "赵云");
  assert.ok(person);
  assert.ok(first.game.records.some((entry) => entry.title === "赵云入册" && entry.actors.includes(person.id)));
  assert.ok(first.game.relationships.some((entry) => entry.from === "emperor" && entry.to === person.id));
  assert.equal(Object.hasOwn(person, "traits"), false);
  const saved = await store.read("world");
  const generated = saved.people.find((entry) => entry.id === person.id);
  assert.ok(Number.isFinite(generated.intelligence));
  assert.equal(generated.traits.length, 2);
  const reloaded = harness({ store }).runtime;
  const state = await reloaded.request("/api/state");
  assert.deepEqual(state.game.people.find((entry) => entry.id === person.id), person);
  const second = await post(reloaded, "/api/action", action(state, "summon-same-person-002", "召见赵云"));
  assert.equal(second.game.people.filter((entry) => entry.name === "赵云").length, 1);
  assert.equal(second.game.people.find((entry) => entry.name === "赵云").id, person.id);
  assert.equal(second.game.records.filter((entry) => entry.title === "赵云入册").length, 1);
});

test("invalid or stale action envelopes leave the existing world and receipts unchanged", async () => {
  let turns = 0;
  const { runtime, store } = harness({ runTurnImpl: (...args) => { turns++; return runTurn(...args); } });
  const state = await runtime.request("/api/state");
  const input = action(state, "valid-envelope-001");
  const before = structuredClone(store.records);
  for (const [body, status] of [
    [{ ...input, gameId: "previous-dynasty" }, 409],
    [{ ...input, gameId: undefined }, 409],
    [{ ...input, version: state.game.version + 1 }, 409],
    [{ ...input, requestId: "bad" }, 400],
    [{ ...input, requestId: "invalid identifier" }, 400],
    [{ ...input, text: "   " }, 400],
    [{ ...input, text: "字".repeat(2001) }, 400],
    [[], 400],
  ]) await assert.rejects(post(runtime, "/api/action", body), { status });
  assert.equal(turns, 0);
  assert.equal(store.commits.length, 0);
  assert.deepEqual(store.records, before);
  assert.equal((await runtime.request("/api/state")).busy, false);
});

test("archive browsing persists its conversation without advancing the simulation clock", async () => {
  const { runtime, store } = harness();
  const state = await runtime.request("/api/state");
  const before = await store.read("world");
  const result = await post(runtime, "/api/action", action(state, "archive-read-001", "查看陆衡的档案"));
  assert.deepEqual(result.result, { minutes: 0, treasuryChange: 0, kind: "read" });
  const after = await store.read("world");
  for (const key of ["messages", "messageCounter", "version", "receipts"]) delete before[key];
  const simulation = structuredClone(after);
  for (const key of ["messages", "messageCounter", "version", "receipts"]) delete simulation[key];
  assert.deepEqual(simulation, before);
  assert.equal(store.commits.length, 1);
  assert.match(after.messages.at(-1).text, /陆衡/);
});

test("failure before settlement discards a changed draft and allows the same request to retry", async () => {
  let fail = true;
  const { runtime, store, lock } = harness({ runTurnImpl: async (draft, ...args) => {
    if (fail) { draft.treasury -= 500; draft.minute += 60; throw new GameError("测试模型暂不可用。", 502); }
    return runTurn(draft, ...args);
  } });
  const state = await runtime.request("/api/state");
  const input = action(state, "before-settlement-001");
  const before = await store.read("world");
  await assert.rejects(post(runtime, "/api/action", input), { status: 502 });
  assert.deepEqual(await store.read("world"), before);
  assert.deepEqual(runtime.world, before);
  assert.equal(store.commits.length, 0);
  assert.equal(runtime.busy, false);
  assert.equal(lock.held, false);
  fail = false;
  const retried = await post(runtime, "/api/action", input);
  assert.equal(retried.game.minute, state.game.minute + RULES.minutes.reward);
  assert.equal(retried.game.treasury, state.game.treasury - 100);
  assert.equal((await store.read("world")).receipts.length, 1);
});

test("failed checkpoint never commits a turn or a receipt and remains retryable", async () => {
  const { runtime, store, lock } = harness();
  const state = await runtime.request("/api/state");
  const input = action(state, "failed-checkpoint-001");
  const before = await store.read("world");
  store.failWrite = ({ name }) => name === "world";
  await assert.rejects(post(runtime, "/api/action", input), /行动存档未完成/);
  assert.deepEqual(await store.read("world"), before);
  assert.deepEqual(runtime.world, before);
  assert.equal(store.attempts.length, 1);
  assert.equal(store.commits.length, 0);
  assert.equal(runtime.busy, false);
  assert.equal(lock.held, false);
  store.failWrite = null;
  const retried = await post(runtime, "/api/action", input);
  assert.equal(retried.game.minute, state.game.minute + RULES.minutes.reward);
  assert.equal(retried.game.treasury, state.game.treasury - 100);
  assert.equal((await store.read("world")).receipts.filter((receipt) => receipt.id === input.requestId).length, 1);
});

test("model narration failure retains one durable program action and idempotent receipt", async () => {
  let completions = 0;
  const { runtime, store } = harness({ runTurnImpl: modelTurn(async () => {
    if (++completions === 1) return { tool_calls: [executeCall()] };
    throw new GameError("测试叙事超时。", 502);
  }) });
  const state = await runtime.request("/api/state");
  const input = action(state, "failed-narration-001");
  const outcome = await post(runtime, "/api/action", input);
  assert.match(outcome.notice, /已结算.*无需重复执行/);
  assert.equal(completions, 2);
  assert.equal(outcome.game.minute, state.game.minute + RULES.minutes.reward);
  assert.equal(outcome.game.treasury, state.game.treasury - 100);
  assert.equal(outcome.game.version, state.game.version + 1);
  assert.ok(outcome.game.messages.some((message) => message.text.includes("赏银100")));
  assert.equal(store.commits.length, 2);
  const replay = await post(runtime, "/api/action", input);
  assert.equal(replay.replayed, true);
  assert.equal(replay.notice, outcome.notice);
  assert.equal(completions, 2);
  assert.equal(store.commits.length, 2);
});

test("failed final narration storage retains the checkpoint and replays after browser reload", async () => {
  let completions = 0;
  const { runtime, store } = harness({ runTurnImpl: modelTurn(async () => ++completions === 1
    ? { tool_calls: [executeCall()] }
    : { content: "旁白：测试补充叙事已经完成。" }) });
  const state = await runtime.request("/api/state");
  const input = action(state, "failed-final-save-001");
  let worldWrites = 0;
  store.failWrite = ({ name }) => name === "world" && ++worldWrites === 2;
  const outcome = await post(runtime, "/api/action", input);
  assert.match(outcome.notice, /补充叙事未能保存.*无需重复执行/);
  const checkpoint = await store.read("world");
  assert.deepEqual(runtime.world, checkpoint);
  assert.equal(outcome.game.minute, state.game.minute + RULES.minutes.reward);
  assert.equal(outcome.game.treasury, state.game.treasury - 100);
  assert.equal(checkpoint.version, state.game.version + 1);
  assert.equal(checkpoint.receipts.length, 1);
  assert.match(checkpoint.receipts[0].outcome.notice, /叙事尚未完成/);
  assert.equal(checkpoint.messages.some((message) => message.text.includes("测试补充叙事")), false);
  assert.equal(store.commits.length, 1);
  assert.equal(runtime.busy, false);
  const reloaded = harness({ store, runTurnImpl: async () => { assert.fail("a durable receipt must replay without executing"); } }).runtime;
  const replay = await post(reloaded, "/api/action", input);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.game, publicView(checkpoint));
  assert.equal(completions, 2);
  assert.equal(store.commits.length, 1);
});

test("final-only archive storage failure preserves the complete previous world", async () => {
  const { runtime, store } = harness();
  const state = await runtime.request("/api/state");
  const before = await store.read("world");
  store.failWrite = ({ name }) => name === "world";
  await assert.rejects(post(runtime, "/api/action", action(state, "archive-save-fail-001", "查看已有史册")), /Injected storage failure/);
  assert.deepEqual(await store.read("world"), before);
  assert.deepEqual(runtime.world, before);
  assert.equal(runtime.busy, false);
  assert.equal(store.commits.length, 0);
});

test("a recovered backup exposes its notice and durable receipt without repeating settlement", async () => {
  const { runtime, store } = harness();
  const state = await runtime.request("/api/state");
  const input = action(state, "recovered-receipt-001");
  await post(runtime, "/api/action", input);
  const backup = structuredClone(store.records.get("world.previous"));
  store.records.set("world", { schema: 1, damaged: true });
  const recovered = harness({ store, runTurnImpl: async () => { assert.fail("recovered receipts must not execute again"); } }).runtime;
  const recoveredState = await recovered.request("/api/state");
  assert.match(recoveredState.recoveryNotice, /已恢复.*备用存档/);
  assert.deepEqual(recoveredState.game, publicView(backup));
  assert.equal(recoveredState.busy, false);
  const replay = await post(recovered, "/api/action", input);
  assert.equal(replay.replayed, true);
  assert.match(replay.notice, /叙事尚未完成/);
  assert.deepEqual(await store.read("world"), backup);
  assert.equal(store.commits.length, 2);
});

test("one shared write lock rejects same-page and competing-page mutations during narration", async () => {
  const entered = deferred(), release = deferred();
  let completions = 0;
  const { runtime, store, lock } = harness({ runTurnImpl: modelTurn(async () => {
    if (++completions === 1) return { tool_calls: [executeCall()] };
    entered.resolve(); await release.promise;
    return { content: "旁白：赏赐已登记。" };
  }) });
  const observer = harness({ store, lock }).runtime;
  const state = await runtime.request("/api/state");
  const input = action(state, "locked-action-001");
  const pending = post(runtime, "/api/action", input);
  try {
    await entered.promise;
    const checkpoint = await runtime.request("/api/state");
    assert.equal(checkpoint.busy, true);
    assert.equal(checkpoint.game.version, state.game.version + 1);
    assert.equal(checkpoint.game.minute, state.game.minute + RULES.minutes.reward);
    for (const [path, body] of [
      ["/api/start", { name: "新帝", opening: "prosperous" }],
      ["/api/settings", { provider: "offline" }],
      ["/api/import", { world: fixture("新帝") }],
      ["/api/action", action(checkpoint, "competing-action-002")],
    ]) {
      await assert.rejects(post(runtime, path, body), { status: 409 });
      await assert.rejects(post(observer, path, body), { status: 409 });
    }
    await assert.rejects(runtime.request("/api/export"), { status: 409 });
    assert.equal(store.commits.length, 1);
  } finally { release.resolve(); await pending; }
  assert.equal(runtime.busy, false);
  assert.equal(lock.held, false);
  assert.equal(store.commits.length, 2);
  const replay = await post(observer, "/api/action", input);
  assert.equal(replay.replayed, true);
  assert.equal(completions, 2);
});

test("invalid imported worlds or settings cannot replace existing progress or metadata", async () => {
  const { runtime, store } = harness();
  await post(runtime, "/api/settings", { ...modelSettings, apiKey: fakeKey });
  const before = structuredClone(store.records);
  const oldWorld = structuredClone(runtime.world);
  const badReceipt = fixture("外来帝王");
  badReceipt.receipts.push({ id: "imported-invalid", textHash: "not-a-hash", outcome: { result: { kind: "reward", minutes: 5, treasuryChange: -100 } } });
  const missingCore = fixture("外来帝王");
  missingCore.people = missingCore.people.filter((person) => person.id !== "emperor");
  for (const body of [
    { world: { schema: 1 } },
    { world: badReceipt },
    { world: missingCore },
    { world: fixture("外来帝王"), settings: { ...modelSettings, baseUrl: "invalid" } },
  ]) {
    await assert.rejects(post(runtime, "/api/import", body), { status: 400 });
    assert.deepEqual(store.records, before);
    assert.deepEqual(runtime.world, oldWorld);
    assert.equal(runtime.settings.apiKey, fakeKey);
    assert.equal(runtime.busy, false);
  }
});

test("import commits world and credential-free settings together or preserves both old values", async () => {
  const { runtime, store, lock } = harness();
  await post(runtime, "/api/settings", { ...modelSettings, apiKey: fakeKey });
  const before = structuredClone(store.records);
  const oldWorld = structuredClone(runtime.world);
  const oldSettings = structuredClone(runtime.settings);
  const incoming = { format: "dynasty-emulator", schema: 1, world: fixture("周晟"), settings: { ...modelSettings, model: "imported-model", apiKey: "import-test-placeholder" } };
  store.failWrite = ({ name }) => name === "settings";
  await assert.rejects(post(runtime, "/api/import", incoming), /Injected storage failure/);
  assert.deepEqual(store.records, before);
  assert.deepEqual(runtime.world, oldWorld);
  assert.deepEqual(runtime.settings, oldSettings);
  assert.equal(runtime.busy, false);
  assert.equal(lock.held, false);
  store.failWrite = null;
  const imported = await post(runtime, "/api/import", incoming);
  assert.equal(imported.game.id, incoming.world.id);
  assert.equal(imported.game.name, "周晟");
  assert.equal(imported.settings.model, "imported-model");
  assert.equal(imported.settings.hasKey, false);
  assert.equal(store.commits.at(-1).kind, "saveMany");
  assert.deepEqual(await store.read("world"), incoming.world);
  assert.equal((await store.read("settings")).model, "imported-model");
  incoming.world.name = "改动外部对象";
  incoming.settings.model = "改动外部对象";
  assert.equal((await store.read("world")).name, "周晟");
  assert.equal((await store.read("settings")).model, "imported-model");
  assert.ok(!JSON.stringify([...store.records]).includes("import-test-placeholder"));
});

test("session credentials survive local reload, stay out of exports, and vanish in a fresh runtime", async () => {
  const { runtime, store } = harness();
  const configured = await post(runtime, "/api/settings", { ...modelSettings, apiKey: fakeKey });
  assert.equal(configured.settings.hasKey, true);
  assert.equal(Object.hasOwn(configured.settings, "apiKey"), false);
  const state = await runtime.request("/api/state");
  assert.equal(state.settings.hasKey, true);
  assert.equal(runtime.settings.apiKey, fakeKey);
  const updated = await post(runtime, "/api/settings", { ...modelSettings, model: "updated-model" });
  assert.equal(updated.settings.hasKey, true);
  const exported = await runtime.request("/api/export");
  assert.equal(exported.format, "dynasty-emulator");
  assert.equal(exported.schema, 1);
  assert.equal(Object.hasOwn(exported.settings, "apiKey"), false);
  for (const record of store.records.values()) assert.equal(Object.hasOwn(record, "apiKey"), false);
  for (const attempt of store.attempts) assert.ok(!JSON.stringify(attempt).includes(fakeKey));
  for (const value of [state, configured, updated, exported, [...store.records], store.commits]) assert.ok(!JSON.stringify(value).includes(fakeKey));
  exported.world.name = "改动导出对象";
  assert.equal((await store.read("world")).name, "萧景");
  const fresh = harness({ store }).runtime;
  assert.equal((await fresh.request("/api/state")).settings.hasKey, false);
  assert.equal(fresh.settings.apiKey, "");
  const switched = await post(runtime, "/api/settings", { ...modelSettings, baseUrl: "https://second.example.test/v1" });
  assert.equal(switched.settings.hasKey, false);
});
