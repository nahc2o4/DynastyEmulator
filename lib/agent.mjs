import { RULES } from "../config/rules.mjs";
import { GameError, executeAction, inferAction, publicView, addMessage } from "./engine.mjs";
import { validateCompletionMessage } from "./model-core.mjs";

async function defaultComplete(...args) {
  const { complete } = await import("./model.mjs");
  return complete(...args);
}
async function defaultReadPrompt() {
  const { readFile } = await import("node:fs/promises");
  return readFile(new URL("../agent.md", import.meta.url), "utf8");
}

const objectSchema = (properties, required = []) => ({ type: "object", properties, required, additionalProperties: false });
const tool = (name, description, parameters) => ({ type: "function", function: { name, description, parameters } });
class SettlementSaveError extends Error {}
export const TOOLS = [
  tool("get_known_state", "查看皇帝已知状态，不推进时间。", objectSchema({})),
  tool("query_character", "查看已知人物介绍及公开事迹，不显示隐藏属性，不推进时间。", objectSchema({ personId: { type: "string" } }, ["personId"])),
  tool("query_records", "查看已知重大事件，不推进时间。", objectSchema({ personId: { type: "string" } })),
  tool("execute_action", "根据玩家输入执行一次行动，由程序计算耗时与结果。不能传入数值增减、概率或结果。", objectSchema({
    kind: { type: "string", enum: ["speak", "summon", "introduce", "inspect", "investigate", "relief", "reward", "punish", "military", "policy", "travel", "study", "rest", "heal", "sleep", "suicide", "other"] },
    targetId: { type: "string", description: "已知人物 ID，无明确目标时留空" },
    targetName: { type: "string", description: "添加或召见人物时可传玩家原文中的姓名；名册中不存在时由程序生成。不得编造姓名或属性。" },
    subject: { type: "string", description: "行动描述，最多240字" },
  }, ["kind", "targetId", "subject"])),
];
function queryTool(world, name, args) {
  const view = publicView(world);
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new GameError("工具参数必须是对象。");
  if (name === "get_known_state" && Object.keys(args).length === 0) return { date: view.date, time: view.time, treasury: view.treasury, affairs: view.affairs, people: view.people, relationships: view.relationships, ended: view.ended };
  if (["query_records", "query_character"].includes(name) && Object.keys(args).every((key) => key === "personId")) {
    if (args.personId !== undefined && typeof args.personId !== "string") throw new GameError("人物 ID 必须是字符串。");
    if (args.personId && !view.people.some((person) => person.id === args.personId)) throw new GameError("该人物不在已知名册中。");
    if (name === "query_records") return view.records.filter((event) => !args.personId || event.actors.includes(args.personId)).slice(-20);
    const person = view.people.find((p) => p.id === args.personId);
    if (!person) throw new GameError("该人物不在已知名册中。");
    return { ...person, deeds: view.records.filter((event) => event.actors.includes(person.id)).slice(-15), relationships: view.relationships.filter((relationship) => relationship.from === person.id || relationship.to === person.id) };
  }
  throw new GameError("未知工具或参数不合法。");
}
function narrationLines(content, world) {
  const allowed = new Set(["旁白", ...publicView(world).people.map((p) => p.name)]);
  return String(content || "").slice(0, 8000).split(/\n+/).map((line) => line.trim()).filter(Boolean).slice(0, 12).map((line) => {
    const match = line.match(/^([^：:]{1,20})[：:]\s*(.+)$/);
    return match && allowed.has(match[1].trim()) ? { speaker: match[1].trim(), text: match[2] } : { speaker: "旁白", text: line };
  });
}
function templateLines(result, world) {
  const speaker = ["speak", "summon", "heal"].includes(result.kind) ? result.targetName : "陈德";
  return [{ speaker, text: result.result }, ...result.reports, ...(world.ended ? [] : [{ speaker: "旁白", text: `窗外的光影缓缓移动，时间来到${result.time}。你可以继续安排接下来的事。` }])];
}
export function isArchiveQuery(text) {
  const value = text.trim();
  // Only an explicit request to browse existing information is free. New orders,
  // conversations, investigations, or combined requests remain normal actions.
  if (/[，,；;\n]|然后|随后|接着|并且|以及|同时|召见|召来|传唤|调查|查账|查明|查探|暗查|搜查|审问|赈灾|赈济|救济|赏银|赏赐|奖赏|奖励|赐银|惩罚|革职|罢免|逮捕|下狱|处死|斩首|赐死|出兵|出巡|出宫|巡视|视察|修建|颁布|改革|任命|就寝|睡觉|自杀|自尽|问问|交谈|询问/.test(value)) return false;
  return /^(?:(?:请|我要|我想|帮我|给我)\s*)?(?:查看|翻阅|查阅|浏览|读一下|看一下|看看|打开|调出|列出|显示|阅读)\s*[^。！？!?]*?(?:档案|名册|人物介绍|公开事迹|已有记录|已有史册|史册|历史记录|重大事件记录|人物关系|关系图|已知关系|已知状态)[。！？!?\s]*$/.test(value);
}
function archiveResult(world, text) {
  const view = publicView(world);
  const person = view.people.find((entry) => text.includes(entry.name));
  let result;
  if (/关系/.test(text)) {
    const relationships = view.relationships.filter((entry) => !person || entry.from === person.id || entry.to === person.id);
    const names = new Map(view.people.map((entry) => [entry.id, entry.name]));
    result = relationships.map((entry) => `${names.get(entry.from)}与${names.get(entry.to)}：${entry.label}`).join("；") || "名册中暂无相关已知关系。";
  } else if (/史册|记录|事迹/.test(text)) {
    const records = view.records.filter((entry) => !person || entry.actors.includes(person.id)).slice(-5);
    result = records.map((entry) => `${entry.date} · ${entry.title}：${entry.text}`).join("\n") || "史册中暂无相关已知重大记录。";
  } else if (/已知状态/.test(text)) {
    result = `${view.date} ${view.time}，御前账面国库${view.treasury.toLocaleString("zh-CN")}两。待议事务：${view.affairs.map((entry) => entry.title).join("、") || "暂无"}。`;
  } else if (person) {
    result = `${person.name}，${person.age}岁，${person.role}。${person.bio}\n已知近况：${person.health}，在${person.location}。消息来源：${person.source}。`;
  } else {
    result = view.people.map((entry) => `${entry.name}（${entry.role}）`).join("、");
  }
  return { kind: "read", targetName: "陈德", result, minutes: 0, treasuryChange: 0, reports: [], date: view.date, time: view.time, ended: view.ended };
}
export async function runTurn(world, text, settings, { completeImpl = defaultComplete, readPromptImpl = defaultReadPrompt, executeImpl = executeAction, onSettled } = {}) {
  if (typeof text !== "string" || !text.trim() || text.length > 2000) throw new GameError("请输入 1 至 2000 字的行动。");
  if (world.ended) throw new GameError("皇帝已驾崩，游戏已经结束。", 409);
  // A failed model request or tool attempt must not leave a partial turn behind.
  const draft = structuredClone(world);
  addMessage(draft, draft.name, text.trim(), "player");
  const readOnly = isArchiveQuery(text);
  let executed = readOnly ? archiveResult(draft, text) : null, notice = "", narrative = [];
  const settle = async (args) => {
    if (readOnly) throw new GameError("本次仅查阅已有资料，请使用查询工具。");
    if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !["kind", "targetId", "targetName", "subject"].includes(key)) || typeof args.kind !== "string" || typeof args.targetId !== "string" || typeof args.subject !== "string" || (args.targetName !== undefined && typeof args.targetName !== "string") || args.subject.length > 240 || !TOOLS[3].function.parameters.properties.kind.enum.includes(args.kind)) throw new GameError("行动工具参数不合法。");
    if (executed) return { alreadySettled: true, ...executed };
    const candidate = structuredClone(draft);
    const result = executeImpl(candidate, args, text);
    if (onSettled) {
      const checkpoint = structuredClone(candidate);
      for (const line of templateLines(result, checkpoint)) addMessage(checkpoint, line.speaker, line.text, line.speaker === "旁白" ? "narration" : "dialogue");
      checkpoint.version++;
      const outcome = { result: { minutes: result.minutes, treasuryChange: result.treasuryChange, kind: result.kind }, notice: "行动已保存；AI 叙事尚未完成，已展示程序记录。" };
      try { await onSettled(checkpoint, outcome); }
      catch { throw new SettlementSaveError("行动存档未完成，请重试。"); }
    }
    Object.assign(draft, candidate);
    executed = result;
    return { ...executed, ...(args.kind === "introduce" || ["introduce", "summon"].includes(result.kind) ? { person: publicView(draft).people.find((person) => person.name === result.targetName) } : {}) };
  };
  if (settings.provider === "offline") {
    if (!readOnly) await settle(inferAction(text, draft));
    narrative = readOnly ? [{ speaker: "陈德", text: executed.result }] : templateLines(executed, draft);
  } else {
    const prompt = await readPromptImpl();
    const view = publicView(draft);
    const messages = [
      { role: "system", content: prompt },
      { role: "user", content: `皇帝已知世界：${JSON.stringify({ name: view.name, date: view.date, time: view.time, treasury: view.treasury, people: view.people, relationships: view.relationships, affairs: view.affairs, recentRecords: view.records.slice(-12), ended: view.ended })}` },
      ...(readOnly ? [{ role: "user", content: "本次仅查阅皇帝已有的资料，可使用查询工具后直接回答；不执行新行动，不推进游戏时间。" }] : []),
      ...view.messages.slice(-10, -1).map((m) => ({ role: m.kind === "player" ? "user" : "assistant", content: `${m.speaker}：${m.text}` })),
      ...(settings.additionalInstructions?.trim() ? [{ role: "user", content: `用户补充指令：${settings.additionalInstructions}` }] : []),
      { role: "user", content: text.trim() },
    ];
    try {
      for (let round = 0; round < RULES.maxToolRounds; round++) {
        const response = validateCompletionMessage(await completeImpl(settings, messages, readOnly ? TOOLS.slice(0, 3) : TOOLS));
        const calls = response.tool_calls;
        if (Array.isArray(calls) && calls.length) {
          messages.push({ role: "assistant", content: response.content || null, tool_calls: calls, ...(response.reasoning_content ? { reasoning_content: response.reasoning_content } : {}) });
          for (const call of calls) {
            let result;
            try {
              const args = JSON.parse(call.function.arguments);
              result = call.function.name === "execute_action" ? await settle(args) : queryTool(draft, call.function.name, args);
            } catch (error) {
              if (error instanceof SettlementSaveError) throw error;
              result = { error: error instanceof GameError ? error.message : error instanceof SyntaxError ? "工具参数无法解析。" : "工具执行失败，未提交结果。" };
            }
            messages.push({ role: "tool", tool_call_id: call.id, content: JSON.stringify(result) });
          }
        } else if (executed) { narrative = narrationLines(response.content, draft); break; }
        else messages.push({ role: "user", content: "尚未结算。先调用 execute_action 执行玩家的主要行动，再依据程序结果叙述。" });
      }
      if (!executed) throw new GameError("模型没有完成合法的行动调用，本次未推进时间，请重试或切换本地引擎。", 502);
      if (!narrative.length) { narrative = readOnly ? [{ speaker: "陈德", text: executed.result }] : templateLines(executed, draft); notice = readOnly ? "AI 未完成资料答复，已展示已有资料。" : "行动已结算；AI 未完成叙事，已使用程序记录呈现。"; }
    } catch (error) {
      if (!executed) throw error;
      narrative = readOnly ? [{ speaker: "陈德", text: executed.result }] : templateLines(executed, draft);
      notice = readOnly ? "模型暂不可用，已展示已有资料。" : "行动已结算；模型叙事暂不可用，已使用程序记录呈现，无需重复执行。";
    }
    // Significant public reports must remain visible even if a model omits them.
    for (const report of executed.reports) if (!narrative.some((line) => line.text.includes(report.text))) narrative.push(report);
  }
  for (const line of narrative) addMessage(draft, line.speaker, line.text, line.speaker === "旁白" ? "narration" : "dialogue");
  draft.version++;
  Object.assign(world, draft);
  return { result: { minutes: executed.minutes, treasuryChange: executed.treasuryChange, kind: executed.kind }, notice };
}
