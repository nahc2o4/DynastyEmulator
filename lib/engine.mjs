import { randomInt, randomUUID } from "./random.mjs";
import { RULES, PEOPLE, AFFAIRS } from "../config/rules.mjs";

export class GameError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const clamp = (n, min = 0, max = 100) => Math.min(max, Math.max(min, n));
const personById = (world, id) => world.people.find((p) => p.id === id);
const absoluteTime = (world) => (world.day - 1) * RULES.calendar.minutesPerDay + world.minute;
const available = (person) => person?.alive && !person.imprisoned;
const publicTreasury = (world) => world.reportedTreasury ?? world.treasury;
const ageOf = (world, person) => person.baseAge + Math.floor((world.day - 1) / RULES.calendar.daysPerYear);
const remote = (person) => /北境|江南|途中/.test(person.location);
const actionKinds = new Set([...Object.keys(RULES.minutes), "sleep", "suicide"]);
const observationFields = ["health", "location", "role", "alive", "status"];

function ensurePrivateDefaults(world) {
  world.reportedTreasury ??= world.treasury;
  const used = new Set(world.relationships.map((r) => r.id).filter(Boolean));
  world.relationCounter ??= Math.max(world.relationships.length, ...world.relationships.map((r) => Number(/^relation-(\d+)$/.exec(r.id || "")?.[1]) || 0));
  for (const relation of world.relationships) if (!relation.id) {
    do { relation.id = `relation-${++world.relationCounter}`; } while (used.has(relation.id));
    used.add(relation.id);
  }
  for (const person of world.people) { person.initialIntelligence ??= person.intelligence; person.illness ??= null; }
}

export function random(world) {
  world.rng = (Math.imul(world.rng, 1664525) + 1013904223) >>> 0;
  return world.rng / 4294967296;
}
function draw(world, [min, max]) { return Math.floor(min + random(world) * (max - min + 1)); }
export function dateLabel(day) {
  const { daysPerMonth, daysPerYear } = RULES.calendar;
  return `建元${Math.floor((day - 1) / daysPerYear) + 1}年 · ${Math.floor(((day - 1) % daysPerYear) / daysPerMonth) + 1}月${((day - 1) % daysPerMonth) + 1}日`;
}
export function clockLabel(minute) { return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`; }
function healthLabel(p) { return !p.alive ? "已故" : p.health >= RULES.body.healthy ? p.illness ? "轻症调养" : "康健" : p.health >= RULES.body.unwell ? "身体欠安" : p.health >= RULES.body.critical ? "抱病休养" : "病势危急"; }
function statusLabel(p) { return !p.alive ? "已故" : p.imprisoned ? "拘押待审" : p.illness ? "正在休养" : "在职起居"; }
function snapshotObservation(world, person, fields = observationFields) {
  const facts = { health: healthLabel(person), location: person.location, role: person.role, alive: person.alive, status: statusLabel(person) };
  return { personId: person.id, day: world.day, minute: world.minute, facts: Object.fromEntries(fields.map((field) => [field, facts[field]])) };
}
function applyObservation(world, snapshot, source) {
  const p = personById(world, snapshot.personId);
  if (!p) return;
  const at = (snapshot.day - 1) * RULES.calendar.minutesPerDay + snapshot.minute;
  const observed = p.observed || { health: "暂无近况", location: "尚未核实", role: "身份待核", alive: true, status: "暂无近况", day: snapshot.day, minute: snapshot.minute, source, fieldTimes: {} };
  observed.fieldTimes ||= Object.fromEntries(observationFields.map((field) => [field, (observed.day - 1) * RULES.calendar.minutesPerDay + (observed.minute ?? RULES.startMinute)]));
  let changed = false;
  for (const field of observationFields) {
    if (Object.hasOwn(snapshot.facts, field) && at >= (observed.fieldTimes[field] ?? -1)) {
      observed[field] = snapshot.facts[field]; observed.fieldTimes[field] = at; changed = true;
    }
  }
  if (changed && at >= (observed.day - 1) * RULES.calendar.minutesPerDay + (observed.minute ?? 0)) {
    observed.day = snapshot.day; observed.minute = snapshot.minute; observed.source = source;
  }
  p.observed = observed;
}
function observe(world, person, source = "当面见闻", fields = observationFields) {
  applyObservation(world, snapshotObservation(world, person, fields), source);
}
export function recordEvent(world, { title, text, actors = [], category = "朝政", visible = true, source = "御前记录", significant = true, reportDay = null, reportMinute = RULES.startMinute, observations = [], relationshipIds = [], treasuryLoss = 0 }) {
  const event = { id: `event-${++world.eventCounter}`, day: world.day, minute: world.minute, title, text, actors: [...new Set(actors)], category, source, significant, known: false, reportDay, reportMinute, observations: structuredClone(observations), relationshipIds: [...relationshipIds], treasuryLoss, ledgerKnown: false };
  world.events.push(event);
  if (visible) revealEvent(world, event, source);
  return event;
}
export function revealEvent(world, event, source) {
  if (event.known) return false;
  event.known = true; event.knownDay = world.day; event.source = source || event.source;
  if (event.significant) world.records.push({ id: event.id, day: event.day, knownDay: world.day, minute: event.minute, title: event.title, text: event.text, actors: event.actors.filter((id) => personById(world, id)?.observed), category: event.category, source: event.source });
  // Mentioning someone in a document does not reveal their current body or whereabouts.
  for (const fact of event.observations || []) applyObservation(world, fact, event.source);
  for (const relation of world.relationships) {
    if ((event.relationshipIds || []).includes(relation.id)) { relation.known = true; relation.knownDay = world.day; }
  }
  if (event.treasuryLoss && !event.ledgerKnown) {
    world.reportedTreasury = Math.max(0, publicTreasury(world) - event.treasuryLoss); event.ledgerKnown = true;
  }
  return true;
}
function addRelation(world, from, to, label) {
  let relation = world.relationships.find((r) => r.label === label && ((r.from === from && r.to === to) || (r.from === to && r.to === from)));
  if (!relation) {
    relation = { id: `relation-${++world.relationCounter}`, from, to, label, known: false, day: world.day };
    world.relationships.push(relation);
  }
  return relation;
}
function generatePerson(world, template) {
  const innate = Object.fromEntries(Object.entries(RULES.innateRange).map(([key, range]) => [key, draw(world, range)]));
  const pool = [...RULES.traits];
  const first = pool.splice(Math.floor(random(world) * pool.length), 1)[0];
  const second = pool[Math.floor(random(world) * pool.length)];
  return { ...template, ...innate, initialIntelligence: innate.intelligence, traits: [first, second], baseAge: template.age - Math.floor((world.day - 1) / RULES.calendar.daysPerYear), location: template.place, health: draw(world, RULES.initial.health), fatigue: draw(world, RULES.initial.fatigue), pressure: draw(world, RULES.initial.pressure), ambition: draw(world, [first, second].includes("野心") ? RULES.initial.ambitious : RULES.initial.ambition), wealth: draw(world, RULES.initial.wealth), plot: 0, illness: null, alive: true, imprisoned: false, observed: null };
}
const normalizePersonName = (name) => name.normalize("NFKC").trim().replace(/\s+/g, " ");
const personNameValid = (name) => name.length > 0 && name.length <= 20 && !/[\u0000-\u001f\u007f<>：:，,。！？!?；;、]/.test(name) && !["旁白", "此人", "那人", "某人", "他", "她", "他们", "她们", "我", "朕", "大家", "所有人"].includes(name);
const rolePrefixes = [...new Set([...PEOPLE.map((p) => p.role), "工部尚书", "礼部尚书", "吏部尚书", "刑部尚书", "兵部尚书", "丞相", "宰相", "将军", "侍卫", "太医", "宫女", "知府", "知县", "书生", "商人"])].sort((a, b) => b.length - a.length);

function characterOrder(text, world) {
  for (const clause of text.normalize("NFKC").split(/[，,。！？!?；;\n]/)) {
    const match = /(?:召见|召来|传唤|传召|添加(?:一个)?人物|新增(?:一个)?人物|加入(?:一个)?人物|(?:传|叫|让)(?=.+(?:来见|进宫|前来|过来|来$)))[：:]?\s*(.+)/.exec(clause);
    if (!match) continue;
    const before = clause.slice(0, match.index);
    if (/(?:不|勿|莫|别|禁止|阻止|是否|能否|如何|怎么|如果|假如|假设|曾经|已经|听说|据说|讨论|建议)[^，。！？；]{0,20}$/.test(before) || /[“「『"]/.test(before)) continue;
    if (!/^\s*(?:(?:我|朕)(?:现在|今日)?(?:要|想要|想|决定|准备)?\s*)?(?:(?:请|立刻|马上|现在|先|再|下令|安排|去|把|将|给我|命令|命|吩咐|陈德)\s*)*$/.test(before)) continue;
    let token = match[1].trim();
    const quoted = /^(?:[“「『"])([^”」』"]+)[”」』"]/.exec(token);
    if (quoted) token = quoted[1];
    else token = token.split(/来见(?:我|朕)|来御书房|到御书房|进宫|前来|过来|来一下|来吧|并且|然后|随后|问问|谈谈|聊聊|和他|与他|和她|与她|[（(]/)[0].replace(/来$|吧$/, "").trim();
    token = token.replace(/^(?:新任的?|名叫|叫做|那位|一位|一个)\s*/, "");
    // A known office can be summoned by title; exact names take precedence.
    const existing = world.people.find((p) => normalizePersonName(p.name) === token) || world.people.find((p) => p.id !== "emperor" && p.role === token);
    if (existing) return { kind: /添加|新增|加入/.test(match[0]) ? "introduce" : "summon", name: existing.name, role: existing.role };
    const prefix = rolePrefixes.find((role) => token.startsWith(role) && token.length > role.length);
    const name = normalizePersonName(prefix ? token.slice(prefix.length).replace(/^\s*(?:的|名叫|叫做)\s*/, "") : token);
    if (!personNameValid(name)) continue;
    const explicitRole = /(?:身份(?:是|为)?|担任|职务(?:是|为)?)\s*[：:]?\s*([^，,。！？!?；;\n]{1,20})/.exec(text)?.[1]?.trim();
    return { kind: /添加|新增|加入/.test(match[0]) ? "introduce" : "summon", name, role: prefix || explicitRole || "待任人士" };
  }
  return null;
}

function registerPerson(world, order) {
  const existing = world.people.find((p) => normalizePersonName(p.name) === normalizePersonName(order.name));
  if (existing) return { person: existing, created: false };
  const role = order.role;
  const group = /将军|武将|侍卫|统领/.test(role) ? "军伍" : /宫女|侍女|太医|总管/.test(role) ? "内廷" : /知府|知县|商人/.test(role) ? "地方" : /皇后|妃|皇子|公主/.test(role) ? "皇室" : "朝廷";
  const person = generatePerson(world, { id: `person-${randomUUID()}`, name: order.name, age: draw(world, RULES.newCharacterAge), role, group, place: "京城", bio: `${order.name}于${dateLabel(world.day)}奉旨登记入册，身份为${role}。此前的经历尚待了解。` });
  world.people.push(person);
  observe(world, person, "奉旨登记");
  recordEvent(world, { title: `${person.name}入册`, text: `${person.name}奉旨加入人物名册，身份为${role}。`, actors: ["emperor", person.id], category: "人物", source: "奉旨登记" });
  return { person, created: true };
}
export function createWorld({ name, opening, seed = randomInt(1, 0xffffffff) }) {
  if (typeof name !== "string" || !name.trim() || name.trim().length > 20 || /[\r\n<>]/.test(name)) throw new GameError("请填写 1 至 20 字的姓名。");
  if (!Object.hasOwn(RULES.openings, opening)) throw new GameError("请选择有效的开局。");
  if (!Number.isInteger(seed) || seed < 0 || seed > 0xffffffff) throw new GameError("测试种子必须是有效整数。");
  const world = { schema: 1, id: `dynasty-${randomUUID()}`, name: name.trim(), dynasty: "大晟", opening, version: 1, day: 1, minute: RULES.startMinute, rng: seed >>> 0, treasury: RULES.openings[opening].treasury, reportedTreasury: RULES.openings[opening].treasury, people: [], relationships: [], events: [], records: [], tasks: [], affairs: structuredClone(AFFAIRS.slice(0, RULES.openings[opening].affairs)), messages: [], eventCounter: 0, relationCounter: 0, messageCounter: 0, lastNpcTick: Math.floor(RULES.startMinute / RULES.npcInterval), ended: false, receipts: [] };
  world.people = [{ id: "emperor", name: world.name, age: 27, role: "皇帝", group: "皇室", place: "御书房", bio: "大晟天子，今日开始亲自主持朝政。你的言行将改变人物与王朝的命运。" }, ...PEOPLE].map((template) => generatePerson(world, template));
  world.people.forEach((p) => observe(world, p, "宫中名册"));
  world.relationships = [
    ["emperor", "empress", "夫妻"], ["emperor", "heir", "父子"], ["empress", "heir", "母子"],
    ["emperor", "minister", "君臣"], ["emperor", "counsellor", "君臣"], ["emperor", "general", "君臣"],
    ["emperor", "steward", "御前侍奉"], ["emperor", "guard", "护卫"], ["emperor", "physician", "诊治"],
    ["emperor", "censor", "君臣"], ["emperor", "envoy", "君臣"],
    ["minister", "governor", "公务往来"], ["empress", "maid", "侍奉"], ["general", "guard", "旧识"],
  ].map(([from, to, label]) => ({ id: `relation-${++world.relationCounter}`, from, to, label, known: true, day: 1 }));
  recordEvent(world, { title: "新朝日记", text: `${world.name}开始亲自主持朝政，宫中起居与朝廷奏报汇入御前。`, actors: ["emperor", "steward"], category: "皇室" });
  addMessage(world, "陈德", `陛下，今日已有${world.affairs.length}件事务候议。百官的名册已送至案前，您有何吩咐？`);
  addMessage(world, "旁白", "晨光越过窗棂，御书房里还留着淡淡的墨香。你可以直接说出想做的事。", "narration");
  return world;
}
export function addMessage(world, speaker, text, kind = "dialogue", meta = {}) {
  world.messages.push({ ...meta, id: `message-${++world.messageCounter}`, speaker, text: String(text).slice(0, 8000), kind, day: world.day, minute: world.minute });
  if (world.messages.length > RULES.limits.messages) world.messages = world.messages.slice(-RULES.limits.messages);
}
export function publicView(world) {
  if (!world) return null;
  const people = world.people.filter((p) => p.observed).map((p) => ({ id: p.id, name: p.name, age: ageOf(world, p), role: p.observed.role, group: p.group, bio: p.bio, health: p.observed.health, status: p.observed.status || "暂无近况", location: p.observed.location, alive: p.observed.alive, observedDay: p.observed.day, source: p.observed.source }));
  const knownIds = new Set(people.map((p) => p.id));
  return {
    id: world.id, name: world.name, dynasty: world.dynasty, opening: RULES.openings[world.opening].label,
    version: world.version, day: world.day, minute: world.minute, date: dateLabel(world.day), time: clockLabel(world.minute), remainingMinutes: Math.max(0, RULES.endMinute - world.minute), treasury: publicTreasury(world), ended: world.ended, people,
    relationships: world.relationships.filter((r) => r.known && knownIds.has(r.from) && knownIds.has(r.to)).map(({ from, to, label, day }) => ({ from, to, label, day })),
    affairs: world.affairs.map(({ title, text, actors, kind }) => ({ title, text, actors: actors.filter((id) => knownIds.has(id)), kind })),
    records: world.records.map(({ id, day, knownDay, minute, title, text, actors, category, source }) => ({ id, day, knownDay, minute, title, text, actors: actors.filter((actor) => knownIds.has(actor)), category, source, date: dateLabel(day), knownDate: dateLabel(knownDay) })),
    messages: world.messages.slice(-RULES.limits.visibleMessages).map(({ id, speaker, text, kind, day, minute }) => ({ id, speaker, text, kind, day, minute })),
  };
}

function explicitSelfDeath(text) {
  return text.split(/[，。！？；\n]/).some((clause) => /^\s*(?:(?:我|朕)(?:现在|今日)?(?:要|想|决定|选择|准备)?\s*)?(?:服毒自尽|上吊自尽|自杀|自尽|结束自己的生命)\s*(?:吧|了)?\s*$/.test(clause));
}
function explicitSleep(text) {
  return text.split(/[，。！？；\n]/).some((clause) => /^\s*(?:我|朕)?(?:现在|今日|今晚)?(?:要|想|决定|准备)?(?:早点|先|去)?(?:就寝|睡觉|睡了|歇息到明(?:日|天)?|结束今[天日](?:事务)?)\s*(?:吧|了)?\s*$/.test(clause));
}
function punishmentFromText(text) {
  for (const clause of text.split(/[，。！？；\n]/)) {
    for (const match of clause.matchAll(/处死|斩首|赐死|下狱|逮捕|惩罚|革职|罢免|拘押|免职/g)) {
      const before = clause.slice(0, match.index).split(/但是|而是|改为|然后/).at(-1);
      if (/建议|提议|讨论|解释|假如|如果|假设|考虑|传闻|记载|后果|想听|听听/.test(clause)) continue;
      if (/(?:不|不会|绝不|不要|不许|不能|切勿|勿|莫|别|禁止|阻止|防止|为什么|为何|是否|能否|如何|怎么|该不该|已经|曾经|早已|被|听说|据说|没有|未曾)[^，。！？；\n]{0,20}$/.test(before)) continue;
      if (before.trim() && !/^\s*(?:(?:我|朕)(?:现在|今日)?(?:要|想|决定)?\s*)?(?:决定|下令|命令|吩咐|要求|让|请|先|把|将|立刻|立即|给我|命|令)/.test(before)) continue;
      return /处死|斩首|赐死/.test(match[0]) ? "execute" : /革职|罢免|免职/.test(match[0]) ? "dismiss" : "detain";
    }
  }
  return null;
}
export function inferAction(text, world) {
  const order = characterOrder(text, world);
  const target = world.people.filter((p) => p.id !== "emperor" && p.observed && text.includes(p.name)).sort((a, b) => text.indexOf(a.name) - text.indexOf(b.name))[0];
  let kind = "other";
  if (explicitSelfDeath(text)) kind = "suicide";
  else if (punishmentFromText(text)) kind = "punish";
  else if (explicitSleep(text)) kind = "sleep";
  else if (order) kind = order.kind;
  else {
    const patterns = [
      ["reward", /赏赐|奖赏|奖励|赐银|赏银/],
      ["heal", /诊治|看病|太医.*诊|检查身体|医治/], ["investigate", /调查|查账|搜查|审问|查明|暗查|查探/],
      ["relief", /赈灾|赈济|救济|开仓|修堤|拨银.*江南/], ["military", /出兵|领兵|攻打|征讨|增援|军粮|粮饷/],
      ["summon", /召见|召来|传.*来|让.*来见/], ["travel", /出宫|出巡|前往|去.*宫|去.*城|去.*江南/],
      ["inspect", /巡视|视察|巡查/], ["study", /读书|学习|练武|训练|研读/], ["rest", /休息|散步|小憩/],
      ["policy", /颁布|改革|减税|赋税|任命|修建|下诏/], ["speak", /问|谈|聊|说|奏报|情况|多少|如何|怎么样/],
    ];
    for (const [candidate, pattern] of patterns) { if (pattern.test(text)) { kind = candidate; break; } }
  }
  return { kind, targetId: order ? world.people.find((p) => normalizePersonName(p.name) === normalizePersonName(order.name))?.id || "" : target?.id || "", ...(order ? { targetName: order.name } : {}), subject: text.slice(0, 160) };
}
function parseChineseAmount(text) {
  const digits = { 零: 0, 〇: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
  if (text.includes("点")) return NaN;
  for (const [unit, multiplier] of [["亿", 100000000], ["万", 10000]]) {
    if (text.includes(unit)) {
      const parts = text.split(unit);
      if (parts.length !== 2) return NaN;
      const high = parts[0] ? parseChineseAmount(parts[0]) : 1;
      const low = parts[1] ? parseChineseAmount(parts[1]) : 0;
      if (low >= multiplier) return NaN;
      return high * multiplier + low;
    }
  }
  let total = 0, digit = null, previousUnit = Infinity;
  for (const char of text) {
    if (Object.hasOwn(digits, char)) {
      if (digit !== null && digit !== 0) return NaN;
      digit = digits[char];
    } else {
      const unit = { 十: 10, 百: 100, 千: 1000 }[char];
      if (!unit || unit >= previousUnit) return NaN;
      total += (digit ?? 1) * unit; digit = null; previousUnit = unit;
    }
  }
  return total + (digit ?? 0);
}
function amountFromText(text) {
  const normalized = text.normalize("NFKC");
  const token = /([+\-−负]?\s*(?:\d[\d,._eE+\-−]*|Infinity|NaN|无限|[零〇一二三四五六七八九十百千万亿点]+|两[零〇一二三四五六七八九十百千万亿点]*))\s*(万|亿)?\s*(?:两|(?:白)?银(?:子)?)/iu;
  let match = token.exec(normalized);
  if (!match) match = /(?:拨款|拨银|赏赐|赐银|赏银|投入|花费)[^\d零〇一二两三四五六七八九十百千万亿\n]{0,10}([+\-−负]?\s*(?:\d[\d,._eE+\-−]*|Infinity|NaN|无限|[零〇一二两三四五六七八九十百千万亿点]+))\s*$/iu.exec(normalized);
  if (!match) {
    if (/(?:\d|NaN|Infinity|无限|负|零|〇)[^，。；\n]{0,16}(?:两|银)/iu.test(normalized)) throw new GameError("银两数额格式不正确，请使用正整数两数。");
    return null;
  }
  const raw = match[1].trim();
  if (/^[+\-−负]/u.test(raw) || /[\d.+\-eE,/负]\s*$/.test(normalized.slice(0, match.index))) throw new GameError("拨款数额必须为正数，不能传入增减表达式。");
  let amount;
  if (/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw)) amount = Number(raw.replaceAll(",", ""));
  else if (/^[零〇一二两三四五六七八九十百千万亿]+$/.test(raw)) amount = parseChineseAmount(raw);
  else throw new GameError("银两数额格式不正确，请使用正整数两数。");
  amount *= match[2] === "万" ? 10000 : match[2] === "亿" ? 100000000 : 1;
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new GameError("拨款数额不在可执行范围内。");
  return amount;
}
function spend(world, amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new GameError("拨款数额不在可执行范围内。");
  if (amount > world.treasury) {
    if (publicTreasury(world) !== world.treasury) {
      const shortage = publicTreasury(world) - world.treasury;
      world.reportedTreasury = world.treasury;
      for (const event of world.events) if (event.treasuryLoss) event.ledgerKnown = true;
      recordEvent(world, { title: "出库核验", text: `户部实际清点时发现，现银比御前账面少${shortage.toLocaleString("zh-CN")}两，原因仍待调查。`, actors: ["minister"], category: "财政", source: "出库查验" });
    }
    return false;
  }
  world.reportedTreasury = publicTreasury(world) - amount; world.treasury -= amount;
  return true;
}
function killEmperor(world, reason) {
  if (world.ended) return;
  const emperor = personById(world, "emperor");
  emperor.alive = false; emperor.health = 0; world.ended = true;
  observe(world, emperor, "起居终报");
  recordEvent(world, { title: "帝王终章", text: `${world.name}${reason}，这一段王朝人生至此落幕。`, actors: ["emperor"], category: "皇室" });
}
function nextMorningDay(world) { return world.minute < RULES.startMinute ? world.day : world.day + 1; }
function markNpcDeath(world, p, reason) {
  if (!p.alive) return;
  p.alive = false; p.health = 0;
  recordEvent(world, { title: `${p.name}离世`, text: `${p.name}${reason}，其所属衙署已整理文书，将消息递呈御前。`, actors: [p.id], category: "人物", visible: false, reportDay: nextMorningDay(world), observations: [snapshotObservation(world, p, ["alive", "health", "status"])], source: "衙署讣报" });
}
function checkDeaths(world) {
  for (const p of world.people) if (p.alive && p.health <= 0) {
    if (p.id === "emperor") killEmperor(world, "因伤病驾崩");
    else markNpcDeath(world, p, "因伤病离世");
  }
}
function affectBody(world, p, sleeping) {
  if (!p.alive) return;
  const rule = RULES.body;
  p.fatigue = clamp(p.fatigue + (sleeping ? -rule.overnightFatigueRecovery : rule.awakeFatigue));
  if (p.illness) {
    p.health = clamp(p.health - p.illness.severity * rule.illnessDamageFactor);
    if (sleeping && random(world) < rule.illnessRecoveryChance) p.illness.severity -= rule.illnessRecovery;
    if (p.illness.severity <= 0) p.illness = null;
  } else if (random(world) < rule.illnessChance + p.fatigue * rule.illnessFatigueFactor + Math.max(0, ageOf(world, p) - rule.agingStartsAt) * rule.illnessAgeFactor) {
    p.illness = { severity: draw(world, rule.illnessSeverity), startedDay: world.day };
    p.health = clamp(p.health - p.illness.severity);
    recordEvent(world, { title: "身体不适", text: `${p.name}出现病症，已请医者照看，需减少劳累。`, actors: [p.id], category: "人物", visible: p.id === "emperor", reportDay: p.id === "emperor" ? null : nextMorningDay(world), observations: [snapshotObservation(world, p, ["health", "status"])], source: "医者诊报" });
  }
  if (sleeping && p.health >= rule.unwell && !p.illness) p.health = clamp(p.health + rule.overnightHealthRecovery);
  if (!sleeping && p.fatigue > rule.fatigueDamageThreshold) p.health = clamp(p.health - rule.fatigueDamagePerTick);
  p.health = clamp(p.health - Math.max(0, ageOf(world, p) - rule.agingStartsAt) * rule.agingDamageFactor);
  if (p.health < rule.mortalityThreshold && random(world) < (rule.mortalityThreshold - p.health) / rule.mortalityDivisor) p.health = 0;
}
function emergeCaution(world, person) {
  if (!person.traits.includes("谨慎") && random(world) < RULES.behavior.injuryTraitChance) person.traits[Math.floor(random(world) * person.traits.length)] = "谨慎";
}
function attemptPlot(world, p) {
  const rule = RULES.plots;
  p.plot += Math.round(p.intelligence / rule.intelligenceGainDivisor + p.talent / rule.talentGainDivisor + random(world) * rule.gainRandom);
  const candidates = world.people.filter((other) => available(other) && other.id !== p.id && other.id !== "emperor" && ageOf(world, other) >= RULES.behavior.adultAge && other.loyalty < RULES.embezzlement.maximumLoyalty);
  const ally = candidates[Math.floor(random(world) * candidates.length)];
  const relation = ally ? addRelation(world, p.id, ally.id, "秘密往来") : null;
  const concealment = clamp(p.intelligence * rule.concealIntelligence + p.talent * rule.concealTalent + (p.traits.includes("谨慎") ? rule.cautiousConcealBonus : 0));
  const reported = random(world) < (1 - concealment / 100) * Math.min(1, p.plot / RULES.plotThreshold) * rule.matureReportChance;
  recordEvent(world, { title: "私下密会", text: `${p.name}私下约见${ally?.name || "旧部"}，商议绕过御前的安排。`, actors: [p.id, ...(ally ? [ally.id] : [])], visible: false, category: "阴谋", reportDay: reported ? nextMorningDay(world) : null, relationshipIds: relation ? [relation.id] : [] });
  if (p.plot < RULES.plotThreshold) return;
  p.plot = 0;
  const guard = personById(world, "guard"), emperor = personById(world, "emperor");
  const defense = available(guard) ? guard.force * rule.defenseForce + guard.loyalty * rule.defenseLoyalty + guard.intelligence * rule.defenseIntelligence + rule.defenseBase - guard.fatigue * rule.defenseFatiguePenalty : 0;
  const attack = p.intelligence * rule.attackIntelligence + p.talent * rule.attackTalent + p.force * rule.attackForce + random(world) * rule.attackRandom;
  const defeated = attack < defense;
  if (available(guard)) { guard.health = clamp(guard.health - draw(world, rule.guardInjury)); guard.pressure = clamp(guard.pressure + rule.pressure); emergeCaution(world, guard); }
  p.pressure = clamp(p.pressure + rule.pressure);
  if (defeated) { p.imprisoned = true; p.role = "待审官员"; p.location = "刑部牢狱"; p.health = clamp(p.health - draw(world, rule.plotterInjury)); emergeCaution(world, p); }
  else emperor.health = clamp(emperor.health - rule.emperorDamage);
  recordEvent(world, { title: "皇城惊变", text: `${p.name}纠集人手试图夺取宫门。${defeated ? "禁军封锁通道，首谋已经拘押，守卫与参与者均有伤势。" : "宫门防线被突破，皇帝与守卫在混乱中受伤，首谋尚未拘获。"}`, actors: [p.id, "guard", "emperor"], category: "安全", source: "禁军急报", observations: [snapshotObservation(world, p), snapshotObservation(world, guard), snapshotObservation(world, emperor)], relationshipIds: relation ? [relation.id] : [] });
}
function socialAction(world, p) {
  const others = world.people.filter((other) => available(other) && other.id !== p.id && other.id !== "emperor" && (other.group === p.group || other.place === p.place));
  if (!others.length) return false;
  const other = others[Math.floor(random(world) * others.length)], rule = RULES.behavior;
  const dispute = p.traits.includes("固执") || (p.traits.includes("多疑") && !other.traits.includes("仁厚"));
  const support = !dispute && (p.traits.includes("仁厚") || other.health < RULES.behavior.ill);
  const label = dispute ? "意见不合" : support ? "互相扶助" : "公务合作";
  const relation = addRelation(world, p.id, other.id, label);
  for (const participant of [p, other]) {
    participant.pressure = clamp(participant.pressure + (dispute ? rule.disputePressure : -rule.supportPressureRelief));
    participant.loyalty = clamp(participant.loyalty + (dispute ? -rule.disputeLoyaltyLoss : rule.cooperationGain));
  }
  const text = dispute ? `${p.name}与${other.name}因办事安排发生争执，双方暂未达成一致。` : support ? `${p.name}探望${other.name}，协助分担眼前事务。` : `${p.name}与${other.name}共同核对文书，商定分工。`;
  recordEvent(world, { title: label, text, actors: [p.id, other.id], category: "人物", visible: false, relationshipIds: [relation.id] });
  return true;
}
export function simulatePeople(world, { sleeping = false, sleepingEmperor = sleeping } = {}) {
  if (world.ended) return;
  ensurePrivateDefaults(world);
  checkDeaths(world);
  if (world.ended) return;
  for (const p of world.people) {
    affectBody(world, p, p.id === "emperor" ? sleepingEmperor : sleeping);
    if (p.health <= 0) { if (p.id === "emperor") killEmperor(world, "因伤病驾崩"); else markNpcDeath(world, p, "因伤病离世"); }
    if (world.ended) break;
    if (p.id === "emperor" || !available(p) || random(world) >= RULES.npcEventChance) continue;
    const rule = RULES.behavior;
    if (sleeping || p.health < rule.ill || p.fatigue > rule.exhausted) {
      p.health = clamp(p.health + RULES.body.npcRestHealthRecovery); p.fatigue = clamp(p.fatigue - RULES.body.npcRestFatigueRecovery);
      recordEvent(world, { title: "休养", text: `${p.name}暂缓事务，在安静处休养。`, actors: [p.id], visible: false, significant: false, category: "人物" });
    } else if (ageOf(world, p) >= rule.adultAge && p.loyalty < rule.disloyal && p.ambition > rule.ambitious && random(world) < rule.plotActionChance) {
      attemptPlot(world, p);
    } else if (ageOf(world, p) >= rule.adultAge && p.traits.includes("贪婪") && p.loyalty < RULES.embezzlement.maximumLoyalty && world.treasury > RULES.embezzlement.minimumTreasury && random(world) < rule.greedyActionChance) {
      const stolen = Math.min(world.treasury, draw(world, RULES.embezzlement.amount));
      world.treasury -= stolen; p.wealth += stolen;
      recordEvent(world, { title: "钱粮截留", text: `${p.name}授意经办人截留${stolen.toLocaleString("zh-CN")}两钱粮，账册暂未如实呈报。`, actors: [p.id], visible: false, category: "财政", treasuryLoss: stolen });
    } else if (p.traits.includes("好奇") || random(world) < rule.learningChance) {
      const martial = p.group === "军伍" || p.traits.includes("勇敢");
      const gain = (martial ? rule.npcTrainingGain : rule.npcStudyGain) * (1 + p.intelligence / 100 * rule.studyPersonalFactor);
      p[martial ? "force" : "talent"] = clamp(p[martial ? "force" : "talent"] + gain);
      recordEvent(world, { title: martial ? "演练骑射" : "读书求教", text: `${p.name}在日常事务之余${martial ? "练习骑射" : "研读典籍"}。`, actors: [p.id], visible: false, significant: false, category: "人物" });
    } else if (random(world) < rule.socialChance && socialAction(world, p)) {
      // The observed relationship changes only when this event is discovered.
    } else {
      p.pressure = clamp(p.pressure - rule.supportPressureRelief);
      recordEvent(world, { title: "日常事务", text: `${p.name}处理日常事务。`, actors: [p.id], visible: false, significant: false });
    }
    checkDeaths(world);
    if (world.ended) break;
  }
  if (!world.ended) observe(world, personById(world, "emperor"), "御前起居");
}
function revealDeathReport(world, person, source) {
  const death = world.events.findLast((event) => !event.known && event.actors.includes(person.id) && event.observations?.some((fact) => fact.personId === person.id && fact.facts.alive === false));
  if (death) revealEvent(world, death, source);
  observe(world, person, source, ["alive", "health", "status"]);
}
function processReports(world, visible) {
  if (world.ended) return;
  const now = absoluteTime(world);
  for (const event of world.events) {
    if (!event.known && event.reportDay !== null && (event.reportDay - 1) * RULES.calendar.minutesPerDay + (event.reportMinute ?? RULES.startMinute) <= now) {
      revealEvent(world, event, event.source === "御前记录" ? "递呈御前的报告" : event.source);
      visible.push({ speaker: "陈德", text: event.text });
    }
  }
  for (const task of world.tasks) {
    if (task.done || (task.dueDay - 1) * RULES.calendar.minutesPerDay + (task.dueMinute ?? RULES.startMinute) > now) continue;
    task.done = true;
    const leader = personById(world, task.targetId);
    let text, title, observations = [];
    if (!available(leader)) {
      text = `${leader?.name || "原承办人"}${leader?.alive === false ? "已故" : "无法履职"}，此前${task.kind === "summon" ? "召见" : "军务"}尚未完成，需要重新安排承办人。`;
      title = "承办回报";
      if (leader) { if (!leader.alive) revealDeathReport(world, leader, "承办回报"); observations = [snapshotObservation(world, leader, ["alive", "status", "role"])]; }
    } else if (task.kind === "summon") {
      leader.location = "御书房"; observe(world, leader, "当面应召");
      text = `${leader.name}已依旨抵京，来到御书房候见。`; title = "应召抵京";
    } else {
      const rule = RULES.tasks;
      const score = leader.intelligence * rule.militaryIntelligence + leader.force * rule.militaryForce + leader.talent * rule.militaryTalent + leader.loyalty * rule.militaryLoyalty - leader.fatigue * rule.fatiguePenalty - (100 - leader.health) * rule.healthPenalty;
      const success = random(world) * 100 < clamp(score);
      leader.talent = clamp(leader.talent + (success ? rule.talentSuccess : rule.talentFailure));
      leader.pressure = clamp(leader.pressure + (success ? rule.pressureSuccess : rule.pressureFailure));
      leader.fatigue = clamp(leader.fatigue + rule.fatigueCost);
      if (!success) { leader.health = clamp(leader.health - draw(world, rule.failureInjury)); emergeCaution(world, leader); }
      leader.location = leader.place;
      text = success ? `${leader.name}所率部队完成任务，补给路线已经打通。` : `${leader.name}来报，行军遇阻，部队正在整顿；主将亦有伤势，需要休养与新的指示。`;
      title = "边军回报"; observations = [snapshotObservation(world, leader, success ? ["location", "role"] : observationFields)];
    }
    recordEvent(world, { title, text, actors: leader ? [leader.id] : [], category: task.kind === "summon" ? "人物" : "军事", source: task.kind === "summon" ? "应召回报" : "边军军报", observations });
    visible.push({ speaker: "陈德", text });
    checkDeaths(world);
    if (world.ended) break;
  }
}
function setTime(world, absolute) {
  world.day = Math.floor(absolute / RULES.calendar.minutesPerDay) + 1;
  world.minute = absolute % RULES.calendar.minutesPerDay;
}
function advanceSegment(world, destination, visible, sleeping = false, sleepingEmperor = sleeping) {
  while (!world.ended && (world.lastNpcTick + 1) * RULES.npcInterval <= destination) {
    world.lastNpcTick++;
    setTime(world, world.lastNpcTick * RULES.npcInterval);
    simulatePeople(world, { sleeping, sleepingEmperor }); processReports(world, visible);
  }
  if (!world.ended) { setTime(world, destination); processReports(world, visible); }
}
function addAffair(world, affair) {
  if (world.affairs.length < RULES.daily.affairsLimit && !world.affairs.some((a) => a.title === affair.title)) world.affairs.push(structuredClone(affair));
}
function delayMilitaryTasks(world) {
  for (const task of world.tasks) if (!task.done && task.kind !== "summon" && (task.weatherDelay ?? 0) < RULES.tasks.maximumWeatherDelayDays) { task.dueDay++; task.weatherDelay = (task.weatherDelay ?? 0) + 1; }
}
function dailyEvent(world, visible) {
  const events = ["驿使抵京", "京郊风雨", "使节递书", "禁军演练", "北境遇袭", "宫中失火", "江南疫讯"];
  const title = events[Math.floor(random(world) * events.length)];
  const governor = personById(world, "governor"), general = personById(world, "general"), guard = personById(world, "guard"), maid = personById(world, "maid"), envoy = personById(world, "envoy");
  let text, actors = [], category = "朝政", observations = [];
  if (title === "京郊风雨") {
    if (available(governor)) governor.pressure = clamp(governor.pressure + RULES.daily.stormPressure);
    delayMilitaryTasks(world); text = "一夜风雨使道路受阻，地方请求修整，尚在途中的军务回报可能推迟一日。"; actors = ["governor"]; category = "民生"; addAffair(world, AFFAIRS[0]);
  } else if (title === "北境遇袭" && available(general)) {
    general.health = clamp(general.health - draw(world, RULES.daily.borderInjury)); general.pressure = clamp(general.pressure + RULES.daily.crisisPressure); emergeCaution(world, general);
    delayMilitaryTasks(world); text = `${general.name}急报，边地巡队遇袭，主将与军士有伤，需补给与整顿。`; actors = [general.id]; category = "军事"; observations = [snapshotObservation(world, general, ["health", "status"])]; addAffair(world, AFFAIRS[1]);
  } else if (title === "宫中失火" && available(guard)) {
    const injured = [guard, maid].filter(available);
    for (const p of injured) { p.health = clamp(p.health - draw(world, RULES.daily.fireInjury)); p.pressure = clamp(p.pressure + RULES.daily.crisisPressure); emergeCaution(world, p); }
    text = `宫中偏殿失火，${guard.name}组织救援，火势已止。${injured.map((p) => p.name).join("、")}有伤，太医院已接手诊治，修缮仍待安排。`; actors = injured.map((p) => p.id); category = "安全"; observations = injured.map((p) => snapshotObservation(world, p));
    addAffair(world, { title: "偏殿修缮", text: "偏殿失火后需要修缮，并照看伤者。", actors, kind: "民生" });
  } else if (title === "江南疫讯" && available(governor)) {
    governor.illness = { severity: draw(world, RULES.body.illnessSeverity), startedDay: world.day }; governor.health = clamp(governor.health - governor.illness.severity); governor.pressure = clamp(governor.pressure + RULES.daily.crisisPressure);
    text = `${governor.name}呈报，江南出现疫病，知府本人也出现症状，请求药材与赈济。`; actors = [governor.id]; category = "民生"; observations = [snapshotObservation(world, governor, ["health", "status"])]; addAffair(world, AFFAIRS[0]);
  } else if (title === "使节递书" && available(envoy)) {
    envoy.pressure = clamp(envoy.pressure - RULES.daily.diplomacyPressureRelief); text = `${envoy.name}递呈邻国国书，请求商议互市安排。`; actors = [envoy.id]; category = "外交"; addAffair(world, AFFAIRS[3]);
  } else if (title === "禁军演练" && available(guard)) {
    guard.force = clamp(guard.force + RULES.behavior.npcTrainingGain); text = `${guard.name}呈递禁军演练与值守调整文书，等待御前批示。`; actors = [guard.id]; category = "军事";
  } else {
    text = "驿使送来地方文书，御史台正在核验民生报告。"; actors = ["censor"];
  }
  recordEvent(world, { title, text, actors, category, observations, source: "晨间奏报" }); visible.push({ speaker: "陈德", text }); checkDeaths(world);
}
function nextDay(world, visible) {
  const nextMorning = world.day * RULES.calendar.minutesPerDay + RULES.startMinute;
  advanceSegment(world, nextMorning, visible, true);
  if (world.ended) return;
  world.reportedTreasury = Math.max(0, publicTreasury(world) + RULES.income - RULES.upkeep);
  world.treasury = Math.max(0, world.treasury + RULES.income - RULES.upkeep);
  observe(world, personById(world, "emperor"), "起居诊报");
  addAffair(world, AFFAIRS[Math.floor(random(world) * AFFAIRS.length)]);
  visible.push({ speaker: "陈德", text: `陛下，已是新的一日。昨夜的起居与文书已经整理，今日有${world.affairs.length}件事务候议。` });
  if (random(world) < RULES.daily.eventChance) dailyEvent(world, visible);
  processReports(world, visible);
}
function collectReports(world, from, reports, skipId) {
  for (const event of world.records.slice(from)) if (event.id !== skipId && !reports.some((report) => report.text === event.text)) reports.push({ speaker: event.title === "帝王终章" ? "旁白" : "陈德", text: event.text });
}
export function advanceTime(world, minutes, { sleepingEmperor = false } = {}) {
  if (!Number.isSafeInteger(minutes) || minutes < 0 || minutes > RULES.limits.maximumAdvanceMinutes) throw new GameError("耗时必须是程序允许的非负整数。");
  ensurePrivateDefaults(world);
  const visible = [], recordStart = world.records.length;
  checkDeaths(world);
  let remaining = minutes;
  while (remaining > 0 && !world.ended) {
    if (world.minute >= RULES.endMinute) { nextDay(world, visible); continue; }
    const step = Math.min(remaining, RULES.endMinute - world.minute);
    advanceSegment(world, absoluteTime(world) + step, visible, false, sleepingEmperor);
    remaining -= step;
    if (world.minute >= RULES.endMinute && !world.ended) nextDay(world, visible);
  }
  processReports(world, visible); collectReports(world, recordStart, visible);
  return visible;
}
function reportingText(actor, affair) {
  const clarity = (actor.intelligence + actor.talent) / 2;
  if (clarity >= RULES.behavior.reportClarityHigh) return `臣已将收到的文书分项核对：${affair.text}具体落实仍需后续核查。`;
  if (clarity >= RULES.behavior.reportClarityLow) return `据现有呈报，${affair.text}臣尚未核实当地全部情况。`;
  return `臣手边文书尚未齐备。目前只知：${affair.text}细节仍不能确认，宜再遣人核查。`;
}
function investigationChance(world, investigator, suspect, event) {
  const rule = RULES.investigation;
  const ability = investigator.intelligence * rule.intelligence + investigator.talent * rule.talent + investigator.loyalty * rule.loyalty - investigator.fatigue * rule.fatiguePenalty;
  const difficulty = suspect ? suspect.intelligence * rule.suspectIntelligence + suspect.talent * rule.suspectTalent + (suspect.traits.includes("谨慎") ? rule.cautiousBonus : 0) : 0;
  const evidence = event.category === "阴谋" && suspect ? Math.min(1, suspect.plot / RULES.plotThreshold) * rule.maturityEvidence : 0;
  return clamp(rule.baseChance + (ability - difficulty + evidence) / 100, rule.minChance, rule.maxChance);
}

export function executeAction(world, args, originalText) {
  if (world.ended) throw new GameError("皇帝已经驾崩，这段王朝人生已经结束。", 409);
  if (typeof originalText !== "string" || !originalText.trim() || originalText.length > RULES.limits.inputLength) throw new GameError("请输入有效的行动文字。");
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !["kind", "targetId", "targetName", "subject"].includes(key))) throw new GameError("行动工具参数不合法。");
  if (!actionKinds.has(args.kind)) throw new GameError("行动类型不在程序允许的范围内。");
  if (typeof args.targetId !== "string" || typeof args.subject !== "string" || args.subject.length > RULES.limits.subjectLength) throw new GameError("行动目标或描述格式不正确。");
  if (args.targetName !== undefined && (typeof args.targetName !== "string" || (args.targetName && !personNameValid(normalizePersonName(args.targetName))))) throw new GameError("人物姓名须为1至20字，且不能包含控制符或标点。");
  const inferred = inferAction(originalText, world);
  if (args.kind === "suicide" && inferred.kind !== "suicide") throw new GameError("玩家原文没有明确要求自尽，不能执行此行动。");
  if (args.kind === "sleep" && !explicitSleep(originalText)) throw new GameError("玩家原文没有明确要求就寝，不能结束今日。");
  const punishment = punishmentFromText(originalText);
  if (args.kind === "punish" && !punishment) throw new GameError("玩家原文没有明确要求处置人物，不能执行此行动。");
  const order = characterOrder(originalText, world);
  let kind = ["sleep", "suicide"].includes(inferred.kind) ? inferred.kind : order ? order.kind : args.kind;
  if (args.targetName && (!order || normalizePersonName(args.targetName) !== normalizePersonName(order.name))) throw new GameError("人物姓名与玩家的添加或召见要求不一致。");
  if (kind === "introduce" && !order) throw new GameError("请在原文中明确要添加的人物姓名。");
  const named = world.people.filter((p) => p.observed && p.id !== "emperor" && originalText.includes(p.name));
  if (!order && named.length === 1 && args.targetId && args.targetId !== named[0].id && !(kind === "heal" && named[0].id === "physician" && args.targetId === "emperor")) throw new GameError("行动目标与玩家原文明确指定的人物不一致。");
  const targetId = order ? world.people.find((p) => normalizePersonName(p.name) === normalizePersonName(order.name))?.id || "" : args.targetId || (named.length === 1 ? named[0].id : "");
  let target = targetId ? personById(world, targetId) : null;
  if (!order && targetId && !target?.observed) throw new GameError("该人物尚未进入你的已知名册。");
  // Money comes only from the original request, never the model's action summary.
  const amount = Object.hasOwn(RULES.costs, kind) ? amountFromText(originalText) ?? RULES.costs[kind] : null;
  ensurePrivateDefaults(world);
  const emperor = personById(world, "emperor");
  if (!emperor.alive || emperor.health <= 0) { killEmperor(world, "因伤病驾崩"); throw new GameError("皇帝已经驾崩，这段王朝人生已经结束。", 409); }
  const initialRecordCount = world.records.length;
  const registration = order ? registerPerson(world, order) : null;
  if (registration) { target = registration.person; if (!target.observed) observe(world, target, "奉旨核验名册", ["role"]); }
  const martial = /练武|训练|骑射/.test(originalText);
  const patient = kind === "heal" ? (target && target.id !== "physician" ? target : emperor) : null;
  let actor = kind === "heal" ? personById(world, "physician") : kind === "study" ? target || personById(world, martial ? "guard" : "counsellor") : target || personById(world, kind === "military" ? "general" : "steward");
  const start = { day: world.day, minute: world.minute, treasury: publicTreasury(world) };
  let minutes = RULES.minutes[kind] ?? RULES.minutes.other, text = "", title = "御前安排", category = "朝政", significant = false;
  let actionEvent = null;
  const recipient = kind === "heal" ? patient : actor;
  if (["speak", "summon", "reward", "military", "heal", "study"].includes(kind) && !available(recipient)) {
    text = recipient.alive ? `${recipient.name}正在拘押中，需要先安排审问或处置。` : `${recipient.name}已故，无法执行这项安排。`;
    if (!recipient.alive) revealDeathReport(world, recipient, "奉旨核查回报"); else observe(world, recipient, "奉旨核查回报", ["role", "status", "alive"]);
    minutes = RULES.failedActionMinutes;
  } else if (kind === "sleep") {
    minutes = Math.max(1, RULES.endMinute - world.minute);
    text = "你吩咐结束今日事务，宫人收起案上的文书。"; category = "起居";
  } else if (kind === "suicide") {
    text = "御前骤然陷入慌乱，太医与禁军赶来时，已无法挽回。"; minutes = RULES.suicideMinutes;
  } else if (kind === "introduce") {
    text = registration.created ? `${actor.name}已奉旨加入名册，身份为${actor.role}。其后会自行活动，新的见闻与公开事迹将陆续记入档案。` : `${actor.name}已在名册中，继续沿用原有身份与经历。`;
    title = `登记${actor.name}`; category = "人物";
  } else if (kind === "speak" || kind === "summon") {
    if (remote(actor)) {
      if (kind === "summon") {
        if (!world.tasks.some((task) => !task.done && task.targetId === actor.id && task.kind === "summon")) world.tasks.push({ id: `task-${world.tasks.length + 1}`, kind: "summon", targetId: actor.id, dueDay: world.day + RULES.tasks.remoteSummonDelayDays, dueMinute: RULES.startMinute, done: false });
        text = `已遣使向${actor.name}传旨。其人在外地，抵京还需时日，预计${RULES.tasks.remoteSummonDelayDays}日后回报。`;
      } else {
        const affair = world.affairs.find((a) => a.actors.includes(actor.id));
        text = affair ? `陈德转呈${actor.name}此前递来的文书：${reportingText(actor, affair)}` : `${actor.name}尚在外地，御前暂无新的来信，不能当面询问。`;
      }
    } else {
      if (kind === "summon") {
        actor.location = emperor.location; actor.loyalty = clamp(actor.loyalty + RULES.behavior.summonLoyaltyGain);
        addRelation(world, "emperor", actor.id, "御前召见").known = true;
      }
      observe(world, actor, kind === "summon" ? "当面召见" : "御前交谈");
      const affair = world.affairs.find((a) => a.actors.includes(actor.id));
      text = registration?.created ? `${actor.name}已奉旨入册，现已来到${emperor.location}候见。其身份为${actor.role}，此前的经历尚待了解。` : /国库|钱|银|财政/.test(originalText) ? `据御前账簿，国库现有${publicTreasury(world).toLocaleString("zh-CN")}两。地方钱粮与账面是否相符，仍需查账核实。` : affair ? reportingText(actor, affair) : `陛下，${actor.location}的日常事务正在办理。若需新的情况，臣可按旨意核查。`;
    }
    title = kind === "summon" ? `召见${actor.name}` : `与${actor.name}交谈`;
  } else if (Object.hasOwn(RULES.costs, kind)) {
    if (kind === "military" && (ageOf(world, actor) < RULES.behavior.adultAge || world.tasks.some((task) => !task.done && task.targetId === actor.id))) {
      text = ageOf(world, actor) < RULES.behavior.adultAge ? `${actor.name}尚未成年，不能独自领军。` : `${actor.name}已有待办差事，需要先等回报或另派承办人。`; minutes = RULES.failedActionMinutes;
    } else if (!spend(world, amount)) text = `所需银两超过已核验的现银，这项安排尚未执行。现有${publicTreasury(world).toLocaleString("zh-CN")}两。`;
    else {
      significant = true;
      if (kind === "relief") {
        text = `已拨银${amount.toLocaleString("zh-CN")}两，命地方安排救济与修整，后续进展仍需核查。`; title = "拨银赈济"; category = "民生";
        world.affairs = world.affairs.filter((a) => a.kind !== "民生");
        for (const p of world.people) if (available(p) && p.group === "地方") p.loyalty = clamp(p.loyalty + RULES.behavior.reliefLoyaltyGain);
      } else if (kind === "reward") {
        actor.loyalty = clamp(actor.loyalty + Math.min(RULES.behavior.rewardLoyaltyLimit, RULES.behavior.rewardBaseLoyalty + amount / RULES.behavior.rewardLoyaltyDivisor)); actor.wealth += amount;
        text = `${actor.name}领受赏银${amount.toLocaleString("zh-CN")}两，已回报谢恩。`; title = `赏赐${actor.name}`; category = "人物";
      } else if (kind === "military") {
        world.tasks.push({ id: `task-${world.tasks.length + 1}`, kind: "military", targetId: actor.id, dueDay: world.day + RULES.tasks.militaryDelayDays, dueMinute: RULES.startMinute, done: false });
        actor.location = "前线军营";
        text = `已支出军需${amount.toLocaleString("zh-CN")}两，由${actor.name}安排部队。军报预计${RULES.tasks.militaryDelayDays}日后抵达。`; title = "安排军务"; category = "军事";
        world.affairs = world.affairs.filter((a) => a.kind !== "军事");
      } else { text = `中书省已登记诏令「${originalText.slice(0, 70)}」，拨银${amount.toLocaleString("zh-CN")}两用于执行。`; title = "颁行政令"; }
    }
  } else if (kind === "punish") {
    if (!target || target.id === "emperor") text = "尚未指定可处置的人物，需要明确姓名与处置方式。";
    else if (!target.alive) { text = `${target.name}已故，这项处置无法再执行。`; revealDeathReport(world, target, "奉旨核查回报"); }
    else {
      significant = true; category = "人物"; title = `处置${target.name}`;
      if (punishment === "execute") { target.health = 0; markNpcDeath(world, target, "依诏被处决"); revealDeathReport(world, target, "行刑回报"); text = `${target.name}已依诏处决，行刑文书递呈御前。`; }
      else if (punishment === "dismiss") { target.role = "免职官员"; target.ambition = clamp(target.ambition + RULES.behavior.punishAmbitionGain); text = `${target.name}被免职，原有职务暂待重新安排。`; }
      else { target.imprisoned = true; target.role = "待审官员"; target.location = "刑部牢狱"; text = `${target.name}已被拘押，案件仍待审问。`; }
      target.loyalty = clamp(target.loyalty - RULES.behavior.punishLoyaltyLoss); observe(world, target, "御前诏令", ["role", "location", "alive", "status"]);
      for (const r of world.relationships.filter((r) => [r.from, r.to].includes(target.id))) { const other = personById(world, r.from === target.id ? r.to : r.from); if (available(other) && other.id !== "emperor") other.loyalty = clamp(other.loyalty - RULES.behavior.relativesLoyaltyLoss); }
    }
  } else if (kind === "investigate" || kind === "inspect") {
    const investigator = personById(world, kind === "inspect" ? "guard" : "censor");
    const candidates = world.events.filter((event) => !event.known && event.significant && (!target || event.actors.includes(target.id)));
    const event = candidates[candidates.length - 1];
    const suspects = event ? event.actors.map((id) => personById(world, id)).filter((p) => p && p.id !== "emperor") : [];
    const suspect = target || suspects.sort((a, b) => b.intelligence - a.intelligence)[0];
    if (!available(investigator)) text = `${investigator.name}目前无法承办查访，需要先重新安排人手。`;
    else if (event && random(world) < investigationChance(world, investigator, suspect, event)) {
      revealEvent(world, event, kind === "inspect" ? "巡视见闻" : "御史调查");
      text = `查得一项可核实的线索：${event.text}`; title = "调查取得线索"; significant = true;
    } else text = "此次查访尚未取得可核实的重大线索。没有发现，仍不足以证明所有事情都已查清。";
    if (target && available(investigator)) {
      if (!target.alive) { revealDeathReport(world, target, "查访讣报"); text += `${target.name}离世一事已由衙署核实。`; }
      else { observe(world, target, "查访身份报告", ["role", "location", "alive"]); text += `查访人员另核实，${target.name}现为${target.role}，所在为${target.location}。`; }
    }
    category = "调查";
  } else if (kind === "study") {
    const teacherSkill = available(actor) ? actor[martial ? "force" : "talent"] : 0;
    const gain = RULES.behavior.studyBaseGain * (1 + emperor.intelligence / 100 * RULES.behavior.studyPersonalFactor + teacherSkill / 100 * RULES.behavior.studyTeacherFactor);
    emperor[martial ? "force" : "talent"] = clamp(emperor[martial ? "force" : "talent"] + gain);
    text = martial ? "你在演武场练习骑射，教头逐一纠正动作。" : "你静心研读典籍，与侍讲讨论治政得失。"; title = "修习"; category = "起居";
  } else if (kind === "heal") {
    if (!available(actor)) text = `${actor.name}暂时无法诊治，需另行安排医者。`;
    else if (remote(patient)) text = `${patient.name}尚在外地，太医院需要先取得当地医案，现时不能完成当面诊治。`;
    else {
      patient.health = clamp(patient.health + Math.max(1, Math.round(actor.talent / RULES.body.healingTalentDivisor)));
      if (patient.illness) { patient.illness.severity -= RULES.body.healingIllnessReduction; if (patient.illness.severity <= 0) patient.illness = null; }
      observe(world, patient, "太医诊报");
      text = `太医诊视后，认为${patient.id === "emperor" ? "你" : patient.name}目前${healthLabel(patient)}，已安排调养，并嘱咐按时休息。`;
    }
    category = "起居";
  } else if (kind === "rest") {
    emperor.fatigue = clamp(emperor.fatigue - RULES.body.restFatigueRecovery); emperor.health = clamp(emperor.health + RULES.body.restHealthRecovery);
    text = "你暂放公务，在安静处休息。宫中事务由值守之人继续照看。"; category = "起居";
  } else if (kind === "travel") {
    emperor.location = /江南/.test(originalText) ? "赴江南途中" : /长宁宫/.test(originalText) ? "长宁宫" : "京城";
    text = `护卫依旨安排出行，你来到${emperor.location}。沿途情况将通过你的见闻继续展开。`; title = "御驾出行"; category = "皇室"; significant = true;
    for (const p of world.people) if (p.id !== "emperor" && p.location === emperor.location) observe(world, p, "沿途见闻");
  } else text = `陈德记下了你的吩咐「${originalText.slice(0, 100)}」。具体执行条件与后续安排仍需进一步说明。`;
  let reports;
  if (kind === "suicide") {
    reports = []; advanceSegment(world, absoluteTime(world) + minutes, reports); killEmperor(world, "依自己的决定驾崩");
  } else {
    actionEvent = recordEvent(world, { title, text, actors: ["emperor", actor.id, ...(patient ? [patient.id] : [])], category, significant });
    if (!["sleep", "rest", "heal"].includes(kind)) emperor.fatigue = clamp(emperor.fatigue + Math.round(minutes / RULES.body.actionFatigueMinutes));
    reports = advanceTime(world, minutes, { sleepingEmperor: kind === "sleep" });
  }
  observe(world, emperor, "御前起居");
  collectReports(world, initialRecordCount, reports, actionEvent?.id);
  return { kind, targetName: actor.name, result: text, minutes, fromDate: dateLabel(start.day), fromTime: clockLabel(start.minute), date: dateLabel(world.day), time: clockLabel(world.minute), treasuryChange: publicTreasury(world) - start.treasury, reports, ended: world.ended };
}
