import test from "node:test";
import assert from "node:assert/strict";
import { createWorld, executeAction, inferAction, publicView, recordEvent, revealEvent, advanceTime, simulatePeople, GameError } from "../lib/engine.mjs";
import { RULES, PEOPLE } from "../config/rules.mjs";

const person = (world, id) => world.people.find((p) => p.id === id);
const shown = (world, id) => publicView(world).people.find((p) => p.id === id);
const act = (world, text, args = inferAction(text, world)) => executeAction(world, args, text);
function healthyWorld(seed = 42) {
  const world = createWorld({ name: "明景", opening: "founding", seed });
  for (const p of world.people) { p.health = 100; p.fatigue = 0; p.illness = null; p.loyalty = 98; p.ambition = 0; p.traits = ["正直", "务实"]; }
  return world;
}
function setClock(world, day, minute) {
  world.day = day; world.minute = minute;
  world.lastNpcTick = Math.floor(((day - 1) * RULES.calendar.minutesPerDay + minute) / RULES.npcInterval);
}

test("each new game's characters have program-generated innate values and personalities", () => {
  for (const template of PEOPLE) for (const key of ["intelligence", "force", "loyalty", "talent", "traits"]) assert.equal(Object.hasOwn(template, key), false);
  const worlds = Array.from({ length: 24 }, (_, i) => createWorld({ name: "明景", opening: "founding", seed: Math.imul(i + 1, 0x9e3779b9) >>> 0, intelligence: 100, traits: ["指定性格"] }));
  for (const p of worlds[0].people) {
    for (const [key, [min, max]] of Object.entries(RULES.innateRange)) {
      assert.ok(worlds.every((w) => Number.isInteger(person(w, p.id)[key]) && person(w, p.id)[key] >= min && person(w, p.id)[key] <= max));
      assert.ok(new Set(worlds.map((w) => person(w, p.id)[key])).size > 5, `${p.id} ${key} should vary across games`);
    }
    assert.ok(new Set(worlds.map((w) => person(w, p.id).traits.join("/"))).size > 5);
    assert.ok(worlds.every((w) => new Set(person(w, p.id).traits).size === 2));
  }
  assert.ok(new Set(worlds.map((w) => w.id)).size === worlds.length);
});

test("seeded opening eras change starting money and affair count, with the same people and world rules", () => {
  const worlds = Object.keys(RULES.openings).map((opening) => createWorld({ name: "明景", opening, seed: 123456789 }));
  for (const world of worlds) {
    assert.deepEqual(world.people, worlds[0].people);
    assert.deepEqual(world.relationships, worlds[0].relationships);
    assert.deepEqual(world.records, worlds[0].records);
    assert.equal(world.rng, worlds[0].rng);
    assert.equal(world.minute, worlds[0].minute);
    assert.equal(world.treasury, RULES.openings[world.opening].treasury);
    assert.equal(world.affairs.length, RULES.openings[world.opening].affairs);
    assert.deepEqual(world.affairs.slice(0, 1), worlds[0].affairs.slice(0, 1));
  }
});

test("public profiles and actor mentions expose observations, never hidden current state", () => {
  const world = healthyWorld(), official = person(world, "minister"), original = shown(world, official.id);
  Object.assign(official, { health: 1, alive: false, location: "秘密藏身处", role: "秘密身份", plot: 95 });
  recordEvent(world, { title: "私下商议", text: "未公开线索", actors: [official.id], visible: false });
  recordEvent(world, { title: "卷宗提及", text: "旧卷宗中提及顾廷章。", actors: [official.id] });
  assert.deepEqual(shown(world, official.id), original);
  const serialized = JSON.stringify(publicView(world));
  for (const secret of ["未公开线索", "秘密藏身处", "秘密身份", "intelligence", "force", "loyalty", "talent", "traits", "initialIntelligence", "fatigue", "pressure", "ambition", "plot", "rng", "illness", "fieldTimes"]) assert.equal(serialized.includes(secret), false, secret);
  assert.equal(original.age, official.baseAge);
});

test("browsing is free and returns detached public data", () => {
  const world = healthyWorld(), before = structuredClone(world);
  for (let i = 0; i < 20; i++) publicView(world);
  assert.deepEqual(world, before);
  const view = publicView(world);
  view.affairs[0].actors.push("hidden"); view.affairs[0].text = "tampered";
  view.records[0].actors.push("hidden"); view.messages[0].text = "tampered";
  view.people[0].name = "tampered"; view.relationships[0].label = "tampered";
  assert.deepEqual(world, before);
});

test("public archives retain early major deeds beyond 500 records", () => {
  const world = healthyWorld();
  for (let i = 0; i < 510; i++) recordEvent(world, { title: `公开事迹${i}`, text: "已经公开的御前记录", actors: ["minister"] });
  const view = publicView(world);
  assert.ok(view.records.some((record) => record.title === "新朝日记"));
  assert.ok(view.records.some((record) => record.title === "公开事迹0"));
  assert.equal(view.records.length, world.records.length);
});

test("a timed report reveals its captured facts and confirmed relationship at its due time", () => {
  const world = healthyWorld(); setClock(world, 1, 600);
  world.relationships.push({ id: "test-secret", from: "minister", to: "counsellor", label: "私下往来", known: false, day: 1 });
  const report = recordEvent(world, { title: "核验报告", text: "顾廷章与裴知远有私下往来，顾廷章当时身体欠安。", actors: ["minister", "counsellor"], visible: false, reportDay: 1, reportMinute: 680, relationshipIds: ["test-secret"], observations: [{ personId: "minister", day: 1, minute: 600, facts: { health: "身体欠安" } }] });
  person(world, "minister").health = 100; person(world, "minister").location = "此刻的秘密去处";
  advanceTime(world, 79);
  assert.equal(report.known, false);
  assert.equal(publicView(world).relationships.some((r) => r.label === "私下往来"), false);
  const reports = advanceTime(world, 1);
  assert.equal(report.known, true);
  assert.ok(reports.some((entry) => entry.text === report.text));
  assert.equal(shown(world, "minister").health, "身体欠安");
  assert.notEqual(shown(world, "minister").location, "此刻的秘密去处");
  assert.ok(publicView(world).relationships.some((r) => r.label === "私下往来"));
  assert.equal(publicView(world).records.find((r) => r.id === report.id).knownDay, 1);
});

test("an old delayed health report never overwrites a newer direct observation", () => {
  const world = healthyWorld(); setClock(world, 1, 600);
  const report = recordEvent(world, { title: "旧医案", text: "顾廷章此前曾抱病。", actors: ["minister"], visible: false, reportDay: 1, reportMinute: 660, observations: [{ personId: "minister", day: 1, minute: 500, facts: { health: "抱病休养" } }] });
  act(world, "召见顾廷章");
  assert.equal(shown(world, "minister").health, "康健");
  advanceTime(world, 15);
  assert.equal(report.known, true);
  assert.equal(shown(world, "minister").health, "康健");
});

test("hidden losses stay off the public balance until evidence arrives, and are counted once", () => {
  const world = healthyWorld(), starting = world.treasury;
  world.treasury -= 800;
  const theft = recordEvent(world, { title: "截留", text: "顾廷章截留八百两。", actors: ["minister"], visible: false, category: "财政", treasuryLoss: 800 });
  assert.equal(publicView(world).treasury, starting);
  const result = act(world, "问陈德国库还有多少");
  assert.equal(result.treasuryChange, 0);
  assert.ok(result.result.includes(starting.toLocaleString("zh-CN")));
  revealEvent(world, theft, "核验账册");
  assert.equal(publicView(world).treasury, starting - 800);
  revealEvent(world, theft, "重复核验");
  assert.equal(publicView(world).treasury, starting - 800);
});

test("program rejects model numeric settlement fields and unknown or mismatched targets without effects", () => {
  const attempts = [
    [{ kind: "reward", targetId: "minister", subject: "赏赐", amount: 1 }, "赏赐顾廷章"],
    [{ kind: "reward", targetId: "minister", subject: "赏赐", minutes: 0 }, "赏赐顾廷章"],
    [{ kind: "reward", targetId: "minister", subject: "赏赐", chance: 1 }, "赏赐顾廷章"],
    [{ kind: "reward", targetId: "minister", subject: "赏赐", treasuryChange: 100000 }, "赏赐顾廷章"],
    [{ kind: "summon", targetId: "missing", subject: "召见" }, "召见此人"],
    [{ kind: "punish", targetId: "counsellor", subject: "处死" }, "处死顾廷章"],
  ];
  for (const [args, text] of attempts) {
    const world = healthyWorld(), before = structuredClone(world);
    assert.throws(() => executeAction(world, args, text), GameError);
    assert.deepEqual(world, before);
  }
  const hiddenWorld = healthyWorld(); person(hiddenWorld, "maid").observed = null;
  assert.throws(() => act(hiddenWorld, "赏赐阿绫", { kind: "reward", targetId: "maid", subject: "赏赐" }), GameError);
});

test("innocent, negated and third-party self-death text cannot authorize the model to kill the emperor", () => {
  for (const text of ["散步", "我不自杀", "我不会自尽", "听说顾廷章想自杀，调查他", "问太医如何预防自尽", "我想问陈德为什么有人自尽"]) {
    const world = healthyWorld(), before = structuredClone(world);
    assert.notEqual(inferAction(text, world).kind, "suicide");
    assert.throws(() => act(world, text, { kind: "suicide", targetId: "", subject: "自尽" }), GameError);
    assert.deepEqual(world, before);
  }
});

test("punishment uses the authorized clause, so negated executions cannot kill a detainee", () => {
  for (const text of ["不要处死顾廷章", "我不处死顾廷章", "我绝不处死顾廷章", "顾廷章是否该被处死", "问陈德为什么处死顾廷章", "讨论处死顾廷章的后果", "如果处死顾廷章会怎样", "顾廷章建议处死陆衡，我想听他的解释"]) {
    const world = healthyWorld(), before = structuredClone(world);
    assert.throws(() => act(world, text, { kind: "punish", targetId: "minister", subject: "处死" }), GameError);
    assert.deepEqual(world, before);
  }
  const world = healthyWorld(), result = act(world, "不要处死顾廷章，先把他下狱");
  assert.equal(person(world, "minister").alive, true);
  assert.equal(person(world, "minister").imprisoned, true);
  assert.ok(result.minutes > 0);
});

test("money parsing honors valid explicit amounts and ignores numbers invented in the model summary", () => {
  for (const [input, expected] of [["1,000两", 1000], ["1.5万两", 15000], ["二万零三百两", 20300], ["两千两", 2000], ["十二两", 12], ["１，０００两", 1000]]) {
    const world = healthyWorld(), start = world.treasury;
    const result = act(world, `赏赐顾廷章${input}`, { kind: "reward", targetId: "minister", subject: "赏赐999999两" });
    assert.equal(world.treasury, start - expected, input);
    assert.equal(result.treasuryChange, -expected, input);
  }
  const world = healthyWorld(), starting = world.treasury;
  act(world, "赏赐顾廷章", { kind: "reward", targetId: "minister", subject: "赏赐一两" });
  assert.equal(world.treasury, starting - RULES.costs.reward);
});

test("invalid explicit amounts fail atomically instead of spending a default amount", () => {
  for (const amount of ["-100两", "+100两", "负一百两", "零两", "0两", "NaN两", "Infinity两", "1e6两", "1.5两", "1.2.3两", "一百百两", "三三两", "1/2两", "10,00两", "999999999999999999999两"]) {
    const world = healthyWorld(), before = structuredClone(world);
    assert.throws(() => act(world, `赏赐顾廷章${amount}`), GameError, amount);
    assert.deepEqual(world, before, amount);
  }
});

test("failed funding consumes time without granting money, loyalty or completion", () => {
  const world = healthyWorld(), official = person(world, "minister"), start = { money: world.treasury, loyalty: official.loyalty, wealth: official.wealth, minute: world.minute };
  const result = act(world, "赏赐顾廷章一亿两");
  assert.equal(world.treasury, start.money);
  assert.equal(official.loyalty, start.loyalty);
  assert.equal(official.wealth, start.wealth);
  assert.ok(world.minute > start.minute && result.minutes > 0);
  assert.match(result.result, /尚未执行/);
});

test("elapsed actions cross the day boundary without lost or negative time", () => {
  const world = healthyWorld(); setClock(world, 1, RULES.endMinute - 10);
  const result = act(world, "学习治国典籍");
  assert.equal(result.minutes, RULES.minutes.study);
  assert.equal(world.day, 2);
  assert.equal(world.minute, RULES.startMinute + RULES.minutes.study - 10);
  assert.ok(publicView(world).remainingMinutes >= 0);
  assert.ok(result.reports.some((r) => r.text.includes("新的一日")));
});

test("sleep reaches the next morning, recovers the emperor and advances NPCs overnight", () => {
  const world = healthyWorld(1); setClock(world, 1, RULES.endMinute - 5);
  person(world, "emperor").fatigue = 95;
  const priorTick = world.lastNpcTick, result = act(world, "就寝");
  assert.equal(world.day, 2);
  assert.equal(world.minute, RULES.startMinute);
  assert.ok(result.minutes > 0);
  assert.ok(person(world, "emperor").fatigue < 95);
  assert.ok(world.lastNpcTick > priorTick + 1);
  assert.ok(world.events.some((event) => event.day === 2 && event.minute < RULES.startMinute));
  assert.ok(world.events.some((event) => !event.known));
});

test("negated sleep, questions, and actions before bedtime cannot skip the day", () => {
  for (const text of ["不要就寝，继续召见顾廷章", "就寝前先召见顾廷章", "我问就寝是否太早", "不要结束今日，先调查顾廷章"]) {
    const world = healthyWorld(), before = structuredClone(world);
    assert.notEqual(inferAction(text, world).kind, "sleep");
    assert.throws(() => act(world, text, { kind: "sleep", targetId: "", subject: "就寝" }), GameError);
    assert.deepEqual(world, before);
    act(world, text);
    assert.equal(world.day, 1);
    assert.ok(world.minute > RULES.startMinute);
  }
  for (const text of ["就寝", "我决定就寝", "现在睡觉", "结束今日事务"]) {
    const world = healthyWorld();
    assert.equal(inferAction(text, world).kind, "sleep");
    act(world, text);
    assert.equal(world.day, 2);
    assert.equal(world.minute, RULES.startMinute);
  }
});

test("scheduled military reports complete once, at the due morning, and respect unavailable commanders", () => {
  const world = healthyWorld();
  act(world, "命卫长宁领兵增援，拨银两万五千两");
  const task = world.tasks[0];
  assert.equal(task.targetId, "general");
  assert.equal(task.done, false);
  setClock(world, task.dueDay, RULES.startMinute - 1);
  advanceTime(world, 0); assert.equal(task.done, false);
  person(world, "general").health = 0;
  const reports = advanceTime(world, 1);
  assert.equal(task.done, true);
  assert.ok(reports.some((r) => /已故.*尚未完成/.test(r.text)));
  assert.equal(shown(world, "general").alive, false);
  const count = world.records.length;
  advanceTime(world, 0); assert.equal(world.records.length, count);
  assert.equal(world.ended, false);
});

test("remote summons require elapsed travel and report arrival instead of immediate teleportation", () => {
  const world = healthyWorld(), general = person(world, "general");
  const result = act(world, "召见卫长宁");
  assert.match(result.result, /抵京还需时日/);
  assert.equal(general.location, "北境");
  const task = world.tasks[0]; setClock(world, task.dueDay, RULES.startMinute - 1);
  advanceTime(world, 1);
  assert.equal(general.location, "御书房");
  assert.equal(shown(world, "general").location, "御书房");
});

test("NPC death stays unknown until seen or reported and never ends the game", () => {
  const world = healthyWorld(), official = person(world, "minister");
  official.health = 0;
  advanceTime(world, 1);
  assert.equal(official.alive, false);
  assert.equal(shown(world, official.id).alive, true);
  assert.equal(world.ended, false);
  const result = act(world, "召见顾廷章");
  assert.match(result.result, /已故/);
  assert.equal(shown(world, official.id).alive, false);
  assert.ok(publicView(world).records.some((r) => r.title.includes("顾廷章离世")));
  assert.equal(world.ended, false);
});

test("illness can become fatal immediately within elapsed time, and emperor death is terminal", () => {
  const world = healthyWorld(), emperor = person(world, "emperor");
  emperor.health = 2; emperor.illness = { severity: 100, startedDay: 1 };
  advanceTime(world, RULES.npcInterval);
  assert.equal(world.ended, true);
  assert.equal(shown(world, "emperor").alive, false);
  assert.equal(world.records.filter((r) => r.title === "帝王终章").length, 1);
  const after = structuredClone(world);
  assert.throws(() => act(world, "就寝"), (error) => error.status === 409);
  assert.deepEqual(world, after);
});

test("explicit player self-death and NPC execution consume time with different terminal outcomes", () => {
  const world = healthyWorld(), start = world.minute;
  const result = act(world, "我决定自尽", { kind: "rest", targetId: "", subject: "休息" });
  assert.equal(result.kind, "suicide");
  assert.ok(result.minutes > 0 && world.minute > start);
  assert.equal(world.ended, true);
  const other = healthyWorld(), oldMinute = other.minute;
  act(other, "处死顾廷章");
  assert.equal(person(other, "minister").alive, false);
  assert.equal(shown(other, "minister").alive, false);
  assert.ok(other.minute > oldMinute);
  assert.equal(other.ended, false);
});

test("learning changes trainable abilities while preserving everyone's innate intelligence", () => {
  const world = healthyWorld(), intelligence = world.people.map((p) => p.intelligence), emperor = person(world, "emperor"), before = { talent: emperor.talent, force: emperor.force };
  for (const action of ["研读典籍", "练武", "学习政务", "训练骑射"]) act(world, action);
  assert.ok(emperor.talent > before.talent);
  assert.ok(emperor.force > before.force);
  assert.deepEqual(world.people.map((p) => p.intelligence), intelligence);
});

test("NPCs with higher innate intelligence learn more from the same independent study", () => {
  const ordinary = healthyWorld(), gifted = healthyWorld();
  for (const [world, intelligence] of [[ordinary, 25], [gifted, 98]]) Object.assign(person(world, "minister"), { intelligence, initialIntelligence: intelligence, talent: 50, traits: ["好奇", "务实"] });
  for (let i = 0; i < 30 && person(ordinary, "minister").talent === 50; i++) { simulatePeople(ordinary); simulatePeople(gifted); }
  assert.ok(person(ordinary, "minister").talent > 50);
  assert.ok(person(gifted, "minister").talent > person(ordinary, "minister").talent);
  assert.equal(person(ordinary, "minister").intelligence, 25);
  assert.equal(person(gifted, "minister").intelligence, 98);
});

test("healing uses the physician's skill, and treats the named patient", () => {
  const world = healthyWorld(), emperor = person(world, "emperor"), empress = person(world, "empress"), doctor = person(world, "physician");
  emperor.health = 60; empress.health = 55; doctor.talent = 90;
  const own = act(world, "请温行舟给我诊治");
  assert.equal(own.targetName, doctor.name);
  assert.ok(emperor.health > 60);
  const emperorAfter = emperor.health;
  const other = act(world, "给沈令仪看病");
  assert.match(other.result, /沈令仪/);
  assert.ok(empress.health > 55);
  assert.equal(emperor.health, emperorAfter);
});

test("high intelligence and talent hide early plots more successfully from identical investigators", () => {
  let ordinaryFound = 0, skilledFound = 0;
  for (let i = 1; i <= 80; i++) {
    for (const skilled of [false, true]) {
      const world = healthyWorld(), investigator = person(world, "censor"), suspect = person(world, "minister");
      Object.assign(investigator, { intelligence: 70, talent: 70, loyalty: 70, fatigue: 0 });
      Object.assign(suspect, { intelligence: skilled ? 98 : 25, talent: skilled ? 92 : 20, loyalty: 10, plot: 20, traits: skilled ? ["谨慎", "务实"] : ["直率", "务实"] });
      const secret = recordEvent(world, { title: "密会证据", text: "查到一项密会证据。", actors: [suspect.id], category: "阴谋", visible: false });
      world.rng = Math.imul(i, 0x9e3779b9) >>> 0;
      act(world, "调查顾廷章");
      if (secret.known) { if (skilled) skilledFound++; else ordinaryFound++; }
    }
  }
  assert.ok(ordinaryFound > skilledFound + 10, `${ordinaryFound} ordinary, ${skilledFound} skilled discoveries`);
});

test("reports reflect official clarity qualitatively without exposing the hidden scores", () => {
  const clear = healthyWorld(), uncertain = healthyWorld();
  Object.assign(person(clear, "minister"), { intelligence: 90, talent: 90 });
  Object.assign(person(uncertain, "minister"), { intelligence: 25, talent: 20 });
  const strong = act(clear, "问顾廷章江南情况"), weak = act(uncertain, "问顾廷章江南情况");
  assert.match(strong.result, /分项核对/); assert.match(weak.result, /不能确认/);
  assert.equal(/intelligence|talent|智力|能力值/.test(strong.result + weak.result), false);
});

test("valid legacy saves gain private defaults before simulation without invalid relation IDs or leaking new losses", () => {
  const world = healthyWorld();
  delete world.reportedTreasury; delete world.relationCounter;
  for (const relationship of world.relationships) delete relationship.id;
  for (const p of world.people) { delete p.initialIntelligence; delete p.illness; delete p.observed.minute; delete p.observed.fieldTimes; }
  const starting = world.treasury;
  simulatePeople(world);
  assert.equal(world.reportedTreasury, starting);
  assert.ok(Number.isInteger(world.relationCounter));
  assert.ok(world.relationships.every((relation) => typeof relation.id === "string" && !relation.id.includes("NaN")));
  assert.equal(new Set(world.relationships.map((relation) => relation.id)).size, world.relationships.length);
  world.treasury -= 500;
  recordEvent(world, { title: "新截留", text: "尚未递报的钱粮截留。", actors: ["minister"], visible: false, treasuryLoss: 500 });
  assert.equal(publicView(world).treasury, starting);
  assert.ok(world.people.every((p) => p.initialIntelligence === p.intelligence));
});

test("invalid time inputs cannot mutate the game or create an unbounded simulation", () => {
  for (const minutes of [-1, Infinity, NaN, 0.5, "30", RULES.limits.maximumAdvanceMinutes + 1]) {
    const world = healthyWorld(), before = structuredClone(world);
    assert.throws(() => advanceTime(world, minutes), GameError);
    assert.deepEqual(world, before);
  }
});
