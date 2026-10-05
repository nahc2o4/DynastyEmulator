import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createWorld, executeAction, inferAction, publicView, advanceTime } from "../lib/engine.mjs";
import { runTurn } from "../lib/agent.mjs";
import { Store } from "../lib/store.mjs";
import { RULES } from "../config/rules.mjs";

const makeWorld = (seed = 42) => createWorld({ name: "明景", opening: "founding", seed });
const act = (world, text, args = inferAction(text, world)) => executeAction(world, args, text);
const call = (id, args) => ({ id, type: "function", function: { name: "execute_action", arguments: JSON.stringify(args) } });
const settings = { provider: "deepseek", additionalInstructions: "" };

test("summoning an absent named person creates one complete, private character and a public encounter", () => {
  const world = makeWorld(), count = world.people.length, money = world.treasury;
  const result = act(world, "召见赵云");
  const person = world.people.find((p) => p.name === "赵云");
  assert.equal(world.people.length, count + 1);
  assert.equal(result.kind, "summon"); assert.equal(result.targetName, "赵云");
  assert.equal(result.minutes, RULES.minutes.summon); assert.equal(world.treasury, money);
  assert.equal(person.location, world.people[0].location);
  for (const [key, range] of Object.entries(RULES.innateRange)) assert.ok(person[key] >= range[0] && person[key] <= range[1] + (key === "loyalty" ? 1 : 0));
  assert.equal(person.initialIntelligence, person.intelligence);
  assert.equal(new Set(person.traits).size, 2);
  const view = publicView(world), profile = view.people.find((p) => p.id === person.id);
  for (const key of ["intelligence", "force", "loyalty", "talent", "traits", "plot", "rng"]) assert.equal(Object.hasOwn(profile, key), false);
  assert.ok(view.records.some((entry) => entry.actors.includes(person.id) && entry.title === "赵云入册"));
  assert.ok(view.relationships.some((entry) => entry.from === "emperor" && entry.to === person.id));
  const before = structuredClone(world); publicView(world); publicView(world);
  assert.deepEqual(world, before);
});

test("mid-game introduction accepts a public identity, keeps ages current and randomizes hidden attributes", () => {
  const worlds = Array.from({ length: 12 }, (_, i) => makeWorld(i + 1));
  for (const world of worlds) {
    world.day = RULES.calendar.daysPerYear * 3 + 1;
    world.lastNpcTick = Math.floor(((world.day - 1) * 1440 + world.minute) / RULES.npcInterval);
    const result = act(world, "添加人物李白，身份为书生");
    const profile = publicView(world).people.find((p) => p.name === "李白");
    assert.equal(result.kind, "introduce"); assert.equal(result.minutes, RULES.minutes.introduce);
    assert.equal(profile.role, "书生");
    assert.ok(profile.age >= RULES.newCharacterAge[0] && profile.age <= RULES.newCharacterAge[1]);
  }
  assert.ok(new Set(worlds.map((w) => w.people.find((p) => p.name === "李白").intelligence)).size > 3);
});

test("ordinary summons, titles and quoted names resolve the requested person instead of a model's substitute", () => {
  for (const text of ["我要召见赵云", "命陈德去召见赵云", "传赵云来见朕", "让赵云进宫", "召见“赵云”", "召见工部尚书赵云"]) {
    const world = makeWorld();
    const result = act(world, text, { kind: "policy", targetId: "steward", subject: "替代行动" });
    assert.equal(result.kind, "summon", text); assert.equal(result.targetName, "赵云", text);
    assert.equal(world.treasury, RULES.openings.founding.treasury);
  }
  const world = makeWorld(), before = world.people.length;
  assert.equal(act(world, "召见皇后").targetName, world.people.find((p) => p.id === "empress").name);
  assert.equal(world.people.length, before);
});

test("repeat registration and summons preserve identity, learned values, history and death", () => {
  const world = makeWorld(); act(world, "添加人物赵云");
  const person = world.people.find((p) => p.name === "赵云"), id = person.id;
  person.intelligence = person.initialIntelligence = 91; person.talent = 96;
  act(world, "召见赵云"); act(world, "新增人物赵云，身份为将军");
  assert.equal(world.people.filter((p) => p.name === "赵云").length, 1);
  assert.equal(person.id, id); assert.equal(person.intelligence, 91); assert.equal(person.role, "待任人士");
  assert.equal(world.records.filter((entry) => entry.title === "赵云入册").length, 1);
  person.alive = false; person.health = 0;
  const result = act(world, "召见赵云");
  assert.match(result.result, /已故/); assert.equal(person.alive, false);
  assert.equal(world.people.filter((p) => p.name === "赵云").length, 1);
});

test("a named hidden existing character is reused; incidental or negated names cannot create people", () => {
  const world = makeWorld(), maid = world.people.find((p) => p.id === "maid"), count = world.people.length;
  maid.observed = null;
  assert.equal(act(world, "召见阿绫").targetName, "阿绫");
  assert.equal(world.people.length, count); assert.ok(maid.observed);
  for (const text of ["不要召见赵云", "能否召见赵云？", "我想阅读召见赵云的故事", "查阅记载中的召见赵云", "听说曾经召见赵云"]) {
    const fresh = makeWorld(); act(fresh, text);
    assert.equal(fresh.people.some((p) => p.name === "赵云"), false, text);
  }
  const fresh = makeWorld(), original = structuredClone(fresh);
  assert.throws(() => act(fresh, "召见赵云", { kind: "summon", targetId: "", targetName: "张飞", subject: "召见" }));
  assert.deepEqual(fresh, original);
  assert.throws(() => act(fresh, "添加人物赵云", { kind: "introduce", targetId: "", targetName: "赵云", subject: "添加", intelligence: 100 }));
  assert.deepEqual(fresh, original);
});

test("new characters join autonomous simulation and persist through save reload", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "dynasty-characters-"));
  t.after(async () => {
    const exact = resolve(directory);
    assert.equal(dirname(exact).toLowerCase(), resolve(tmpdir()).toLowerCase());
    assert.ok(basename(exact).startsWith("dynasty-characters-"));
    await rm(exact, { recursive: true, force: true });
  });
  const world = makeWorld(); act(world, "添加人物李白，身份为书生");
  const person = world.people.find((p) => p.name === "李白");
  person.health = 0; advanceTime(world, 1);
  assert.equal(person.alive, false); assert.ok(world.events.some((event) => event.title === "李白离世"));
  const store = new Store(directory); await store.save("world", world);
  const restored = await new Store(directory).read("world");
  assert.deepEqual(restored, world);
  assert.equal(restored.people.find((p) => p.name === "李白").id, person.id);
});

test("LLM sees a program-created public profile; duplicate tools only create and charge once", async () => {
  const world = makeWorld(), before = world.minute;
  let round = 0, checkpoints = 0;
  await runTurn(world, "召见赵云", settings, {
    onSettled: async (checkpoint) => { checkpoints++; assert.equal(checkpoint.people.filter((p) => p.name === "赵云").length, 1); },
    completeImpl: async (_settings, messages) => {
      if (round++ === 0) return { tool_calls: [call("first", { kind: "summon", targetId: "", targetName: "赵云", subject: "召见赵云" }), call("repeat", { kind: "summon", targetId: "", targetName: "赵云", subject: "召见赵云" })] };
      const receipt = JSON.parse(messages.find((message) => message.tool_call_id === "first").content);
      assert.equal(receipt.person.name, "赵云"); assert.ok(receipt.person.id);
      assert.equal(Object.hasOwn(receipt.person, "intelligence"), false);
      return { content: "赵云：臣已到御前，听候陛下吩咐。" };
    },
  });
  assert.equal(checkpoints, 1); assert.equal(world.minute, before + RULES.minutes.summon);
  assert.equal(world.people.filter((p) => p.name === "赵云").length, 1);
  assert.ok(world.messages.some((message) => message.speaker === "赵云" && message.text === "臣已到御前，听候陛下吩咐。"));
});

test("a model failure before settlement creates nothing; after checkpoint it retains one saved character", async () => {
  const world = makeWorld(), before = structuredClone(world);
  await assert.rejects(runTurn(world, "召见赵云", settings, { completeImpl: async () => { throw new Error("unavailable"); } }));
  assert.deepEqual(world, before);
  let round = 0, checkpoint;
  await runTurn(world, "召见赵云", settings, {
    onSettled: async (draft) => { checkpoint = draft; },
    completeImpl: async () => { if (round++ === 0) return { tool_calls: [call("create", { kind: "summon", targetId: "", subject: "召见赵云" })] }; throw new Error("unavailable"); },
  });
  assert.equal(world.people.filter((p) => p.name === "赵云").length, 1);
  assert.equal(checkpoint.people.find((p) => p.name === "赵云").id, world.people.find((p) => p.name === "赵云").id);
});
