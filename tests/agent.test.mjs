import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createWorld, executeAction, GameError, recordEvent, publicView } from "../lib/engine.mjs";
import { runTurn, isArchiveQuery, TOOLS } from "../lib/agent.mjs";
import { RULES } from "../config/rules.mjs";

const makeWorld = () => createWorld({ name: "萧景", opening: "founding", seed: 71349 });
const settings = { provider: "compatible", baseUrl: "http://localhost:1234/v1", model: "test-model", apiKey: "agent-test-secret", additionalInstructions: "请用简短的中文答复。" };
const actionText = "赏赐顾廷章100两银";
const actionArgs = { kind: "reward", targetId: "minister", subject: actionText };
const call = (id, name, args, raw = false) => ({ id, type: "function", function: { name, arguments: raw ? args : JSON.stringify(args) } });
const toolResult = (messages, id) => JSON.parse(messages.find((message) => message.role === "tool" && message.tool_call_id === id).content);
function unchangedExceptConversation(before, after) {
  const withoutConversation = (value) => {
    const result = structuredClone(value);
    delete result.messages; delete result.messageCounter; delete result.version;
    return result;
  };
  assert.deepEqual(withoutConversation(after), withoutConversation(before));
  assert.equal(after.version, before.version + 1);
}

test("read tools expose only known facts, one program settlement feeds final model narration", async () => {
  const world = makeWorld();
  const original = structuredClone(world);
  world.people[1].traits = ["hidden-trait-sentinel"];
  recordEvent(world, { title: "secret-event-sentinel", text: "secret-log-sentinel", actors: ["minister"], visible: false });
  world.relationships.push({ from: "minister", to: "censor", label: "secret-relationship-sentinel", known: false, day: 1 });
  let round = 0, checkpoints = 0;
  const transcripts = [];
  const outcome = await runTurn(world, actionText, settings, {
    onSettled: async (checkpoint, result) => {
      checkpoints++;
      assert.equal(checkpoint.minute, original.minute + RULES.minutes.reward);
      assert.equal(checkpoint.treasury, original.treasury - 100);
      assert.equal(checkpoint.version, original.version + 1);
      assert.equal(result.result.kind, "reward");
      assert.ok(checkpoint.messages.some((message) => message.text.includes("100")));
    },
    completeImpl: async (config, messages, tools) => {
      assert.equal(config.apiKey, settings.apiKey);
      assert.deepEqual(tools, TOOLS);
      transcripts.push(structuredClone(messages));
      if (round++ === 0) return { content: null, tool_calls: [call("known", "get_known_state", {}), call("person", "query_character", { personId: "minister" }), call("records", "query_records", { personId: "minister" })] };
      if (round === 2) {
        const known = toolResult(messages, "known");
        assert.equal(known.time, publicView(original).time);
        assert.ok(known.relationships.some((entry) => entry.to === "minister"));
        assert.ok(toolResult(messages, "person").relationships.every((entry) => entry.from === "minister" || entry.to === "minister"));
        assert.ok(toolResult(messages, "person").relationships.length > 0);
        assert.deepEqual(toolResult(messages, "records"), []);
        assert.equal(checkpoints, 0);
        return { content: null, tool_calls: [call("execute", "execute_action", actionArgs), call("duplicate", "execute_action", { kind: "military", targetId: "general", subject: "再出兵" })] };
      }
      if (round === 3) {
        assert.equal(checkpoints, 1);
        const result = toolResult(messages, "execute");
        const duplicate = toolResult(messages, "duplicate");
        assert.equal(result.treasuryChange, -100);
        assert.equal(duplicate.alreadySettled, true);
        assert.equal(duplicate.kind, "reward");
        assert.equal(duplicate.minutes, result.minutes);
        return { content: null, tool_calls: [call("after", "get_known_state", {})] };
      }
      assert.equal(toolResult(messages, "after").time, "08:30");
      return { content: "顾廷章：臣领受赏银，谢陛下。\n旁白：文书随即归档。" };
    },
  });
  assert.deepEqual(outcome.result, { kind: "reward", minutes: RULES.minutes.reward, treasuryChange: -100 });
  assert.equal(world.minute, original.minute + RULES.minutes.reward);
  assert.equal(world.treasury, original.treasury - 100);
  assert.equal(world.tasks.length, original.tasks.length);
  assert.equal(world.version, original.version + 1);
  assert.equal(checkpoints, 1);
  assert.equal(world.messages.filter((message) => message.kind === "player").length, 1);
  assert.equal(world.messages.at(-2).speaker, "顾廷章");
  const initial = transcripts[0];
  assert.equal(initial[0].role, "system");
  assert.equal(initial[0].content, await readFile(new URL("../agent.md", import.meta.url), "utf8"));
  assert.equal(initial.filter((message) => message.role === "system").length, 1);
  assert.ok(initial.some((message) => message.role === "user" && message.content === `用户补充指令：${settings.additionalInstructions}`));
  assert.ok(initial[1].content.includes('"relationships":'));
  assert.equal(initial.at(-1).content, actionText);
  const sent = JSON.stringify(transcripts);
  for (const forbidden of ["hidden-trait-sentinel", "secret-log-sentinel", "secret-event-sentinel", "secret-relationship-sentinel", settings.apiKey, '\"loyalty\":', '\"intelligence\":', '\"plot\":', '\"rng\":', '\"receipts\":']) assert.ok(!sent.includes(forbidden), forbidden);
});

test("malformed tool parameters return controlled errors and can be repaired without extra effects", async () => {
  const world = makeWorld();
  const before = structuredClone(world);
  let round = 0;
  const outcome = await runTurn(world, actionText, settings, { completeImpl: async (_config, messages) => {
    if (round++ === 0) return { tool_calls: [
      call("bad-json", "execute_action", "{", true),
      call("forged-effect", "execute_action", { ...actionArgs, treasuryChange: 999999 }),
      call("extra-field", "get_known_state", { revealSecrets: true }),
      call("wrong-type", "query_records", { personId: [] }),
      call("missing-person", "query_character", {}),
      call("unknown", "dump_world", {}),
    ] };
    if (round === 2) {
      const errors = messages.filter((message) => message.role === "tool").map((message) => JSON.parse(message.content));
      assert.equal(errors.length, 6);
      assert.ok(errors.every((error) => typeof error.error === "string" && Object.keys(error).length === 1));
      return { tool_calls: [call("valid", "execute_action", actionArgs)] };
    }
    assert.equal(toolResult(messages, "valid").treasuryChange, -100);
    return { content: "旁白：赏赐已登记。" };
  } });
  assert.equal(outcome.result.treasuryChange, -100);
  assert.equal(world.minute, before.minute + RULES.minutes.reward);
  assert.equal(world.treasury, before.treasury - 100);
});

test("a tool that fails after changing its draft leaves no effects before a successful retry", async () => {
  const world = makeWorld();
  const before = structuredClone(world);
  let attempts = 0, round = 0;
  await runTurn(world, actionText, settings, {
    executeImpl: (candidate, args, text) => {
      if (++attempts === 1) { candidate.treasury -= 9000; candidate.minute += 250; candidate.rng = 0; throw new Error("internal-secret-sentinel"); }
      return executeAction(candidate, args, text);
    },
    completeImpl: async (_config, messages) => {
      if (round++ === 0) return { tool_calls: [call("failed", "execute_action", actionArgs)] };
      if (round === 2) {
        assert.deepEqual(toolResult(messages, "failed"), { error: "工具执行失败，未提交结果。" });
        return { tool_calls: [call("before-retry", "get_known_state", {}), call("retry", "execute_action", actionArgs)] };
      }
      assert.equal(toolResult(messages, "before-retry").time, publicView(before).time);
      assert.equal(toolResult(messages, "before-retry").treasury, publicView(before).treasury);
      return { content: "旁白：赏赐已登记。" };
    },
  });
  assert.equal(attempts, 2);
  assert.equal(world.minute, before.minute + RULES.minutes.reward);
  assert.equal(world.treasury, before.treasury - 100);
});

test("model failure before settlement leaves the entire world unchanged", async () => {
  const world = makeWorld();
  const before = structuredClone(world);
  await assert.rejects(runTurn(world, actionText, settings, { completeImpl: async () => { throw new GameError("无法连接模型平台。", 502); } }), { status: 502 });
  assert.deepEqual(world, before);
});

test("model failure after settlement keeps one action and program narration", async () => {
  const world = makeWorld();
  const before = structuredClone(world);
  let round = 0, checkpoints = 0;
  const outcome = await runTurn(world, actionText, settings, {
    onSettled: async () => { checkpoints++; },
    completeImpl: async () => {
      if (round++ === 0) return { tool_calls: [call("execute", "execute_action", actionArgs)] };
      throw new GameError("模型请求超时，请重试。", 502);
    },
  });
  assert.match(outcome.notice, /已结算/);
  assert.equal(checkpoints, 1);
  assert.equal(world.minute, before.minute + RULES.minutes.reward);
  assert.equal(world.treasury, before.treasury - 100);
  assert.equal(world.version, before.version + 1);
  assert.ok(world.messages.some((message) => message.text.includes("赏银100")));
});

test("checkpoint is awaited before narration and failed checkpoint aborts the turn", async () => {
  const world = makeWorld();
  const before = structuredClone(world);
  let completions = 0, checkpointEntered;
  const entered = new Promise((resolve) => { checkpointEntered = resolve; });
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const pending = runTurn(world, actionText, settings, {
    onSettled: async () => { checkpointEntered(); await gate; },
    completeImpl: async () => ++completions === 1 ? { tool_calls: [call("execute", "execute_action", actionArgs)] } : { content: "旁白：赏赐已登记。" },
  });
  await entered;
  assert.equal(completions, 1);
  assert.deepEqual(world, before);
  release();
  await pending;
  assert.equal(completions, 2);

  const failed = makeWorld();
  const failedBefore = structuredClone(failed);
  let requests = 0;
  await assert.rejects(runTurn(failed, actionText, settings, {
    onSettled: async () => { throw new Error("disk write failed"); },
    completeImpl: async () => { requests++; return { tool_calls: [call("execute", "execute_action", actionArgs)] }; },
  }), /行动存档未完成/);
  assert.equal(requests, 1);
  assert.deepEqual(failed, failedBefore);
});

test("exhausting tool rounds without legal execution never advances time", async () => {
  const world = makeWorld();
  const before = structuredClone(world);
  let requests = 0;
  await assert.rejects(runTurn(world, actionText, settings, { completeImpl: async () => { requests++; return { content: "旁白：此事已经办好。" }; } }), { status: 502 });
  assert.equal(requests, RULES.maxToolRounds);
  assert.deepEqual(world, before);
});

test("archive requests are free while new and combined actions are not", async () => {
  for (const text of ["查看陆衡的档案", "翻阅已有史册", "请查阅已知关系", "查看已知状态"]) assert.equal(isArchiveQuery(text), true, text);
  for (const text of ["问陆衡汛情", "召见陆衡查看档案", "查看陆衡的档案，然后调查他", "查看陆衡档案并赏赐100两银", "调查已有记录"]) assert.equal(isArchiveQuery(text), false, text);
  const world = makeWorld();
  const before = structuredClone(world);
  const outcome = await runTurn(world, "查看陆衡的档案", { provider: "offline" });
  assert.deepEqual(outcome.result, { kind: "read", minutes: 0, treasuryChange: 0 });
  unchangedExceptConversation(before, world);
  assert.match(world.messages.at(-1).text, /陆衡/);
});

test("model archive browsing receives only read tools and cannot execute an action", async () => {
  const world = makeWorld();
  const before = structuredClone(world);
  let round = 0;
  const outcome = await runTurn(world, "查看陆衡的档案", settings, { completeImpl: async (_config, messages, tools) => {
    assert.deepEqual(tools.map((entry) => entry.function.name), ["get_known_state", "query_character", "query_records"]);
    if (round++ === 0) return { tool_calls: [call("forbidden-action", "execute_action", actionArgs), call("archive", "query_character", { personId: "censor" })] };
    assert.match(toolResult(messages, "forbidden-action").error, /仅查阅/);
    assert.equal(toolResult(messages, "archive").name, "陆衡");
    return { content: "陈德：陆衡担任御史，名册中记载他负责监察和巡察。" };
  } });
  assert.equal(outcome.result.minutes, 0);
  unchangedExceptConversation(before, world);
});

test("invalid tool envelopes fail cleanly before settlement", async () => {
  for (const response of [null, { content: {} }, { tool_calls: "bad" }, { tool_calls: [{ id: "x", type: "function" }] }, { tool_calls: [call("duplicate", "get_known_state", {}), call("duplicate", "get_known_state", {})] }]) {
    const world = makeWorld();
    const before = structuredClone(world);
    await assert.rejects(runTurn(world, actionText, settings, { completeImpl: async () => response }), { status: 502 });
    assert.deepEqual(world, before);
  }
});
