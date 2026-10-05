"use strict";

(() => {
  const browserMode = document.documentElement.dataset.runtime === "browser";
  const browserRuntime = browserMode ? import("./browser/runtime.mjs") : null;
  const $ = (id) => document.getElementById(id);
  const ui = {
    loading: $("loading"), onboarding: $("onboarding"), shell: $("game-shell"),
    startForm: $("start-form"), name: $("emperor-name"), startButton: $("start-button"),
    cancelNew: $("cancel-new-game"), newDialog: $("new-game-dialog"),
    actionForm: $("action-form"), actionInput: $("action-input"), send: $("send-action"),
    sleep: $("sleep-button"), chat: $("chat-messages"), feedback: $("turn-feedback"),
    mobileName: $("mobile-name"), mobileSaveStatus: $("mobile-save-status"), composerHint: $("composer-hint"),
    end: $("end-banner"), graph: $("relationship-graph"), graphContainer: $("graph-container"),
    graphGroup: $("graph-group"), graphDetail: $("graph-detail"),
    people: $("people-list"), peopleSearch: $("people-search"), peopleDetail: $("people-detail"),
    records: $("records-list"), recordCategory: $("record-category"),
    settingsForm: $("settings-form"), provider: $("model-provider"), model: $("model-name"),
    baseUrl: $("model-base-url"), key: $("model-key"), instructions: $("additional-instructions"),
    saveSettings: $("save-settings"), testModel: $("test-model"), fixedAgent: $("fixed-agent"),
  };
  const views = {
    study: ["THE IMPERIAL STUDY", "御书房", "听见众人的声音，写下你的诏令。"],
    graph: ["PEOPLE & CONNECTIONS", "人物图谱", "已知的关系，织成一朝的人间。"],
    people: ["THE PEOPLE OF YOUR REIGN", "人物档案", "从见闻与奏报中，认识他们的生平。"],
    records: ["CHRONICLES OF THE REALM", "重要事件纪", "所见所闻，留作后来回望的史册。"],
    settings: ["THE VOICE OF YOUR WORLD", "模型设置", "选择叙事模型，补充你的故事偏好。"],
  };
  const state = {
    game: null, settings: null, serverBusy: false, operation: "", mode: "loading", view: "study",
    previousView: "study", selectedPerson: "emperor", recordPerson: "", highlightedRecord: "",
    pendingAction: null, uncertainStart: null, feedback: null, settingsDirty: false, chatSignature: "", graphWidth: 0,
    recoveryNoticeShown: false,
  };
  let pollTimer = null;
  let toastTimer = null;
  let graphFrame = null;
  let agentPromise = null;
  let agentLoaded = false;
  const mobileViewport = window.matchMedia("(max-width: 700px)");
  const touchComposer = window.matchMedia("(max-width: 700px) and (pointer: coarse)");
  const visualViewport = window.visualViewport;
  let restingViewport = null;
  let keyboardFrame = null;

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function button(text, className, handler) {
    const node = element("button", className, text);
    node.type = "button";
    node.addEventListener("click", handler);
    return node;
  }
  function svgElement(tag, attributes = {}, text) {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, String(value));
    if (text !== undefined) node.textContent = String(text);
    return node;
  }
  function dateFor(day) {
    return `建元${Math.floor((day - 1) / 360) + 1}年 · ${Math.floor(((day - 1) % 360) / 30) + 1}月${((day - 1) % 30) + 1}日`;
  }
  function clockFor(minute) {
    return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
  }
  const number = (value) => Number(value).toLocaleString("zh-CN");
  const personById = (id) => state.game?.people.find((person) => person.id === id);
  const actionLocked = () => Boolean(state.operation || state.serverBusy || state.pendingAction || state.uncertainStart || !state.game || state.game.ended);

  const startMessage = element("p", "connection-message");
  startMessage.id = "start-message";
  startMessage.setAttribute("role", "status");
  ui.startForm.append(startMessage);
  const settingsBack = button("← 回到开局", "quiet-button pregame-back", () => showOnboarding(false));
  settingsBack.hidden = true;
  $("settings-view").prepend(settingsBack);
  const mobileNewGame = button("新王朝 ↗", "quiet-button mobile-new-game", openNewGame);
  $("game-shell").querySelector(".topbar-actions").prepend(mobileNewGame);
  const recordScope = element("div", "panel-heading");
  recordScope.hidden = true;
  ui.records.before(recordScope);
  const endNewGame = button("开启新的王朝 →", "secondary-button", openNewGame);
  ui.end.append(endNewGame);
  let exportSave, importSave;
  if (browserMode) {
    const storagePanel = element("section", "settings-card browser-storage");
    const heading = element("div", "section-heading");
    heading.append(element("h2", "", "王朝存档"), element("span", "subtle", "自动保存 · 查阅不耗时"));
    const note = element("p", "settings-copy", "进度自动保存在当前浏览器，刷新或重新打开可续玩。导出文件可备份或迁移；清除网站数据会删除本机进度。");
    const actions = element("div", "storage-actions");
    const file = element("input");
    file.type = "file"; file.accept = ".json,application/json"; file.hidden = true;
    exportSave = button("导出存档 ↗", "secondary-button", async () => {
      if (state.operation || state.serverBusy || !state.game) return;
      setOperation("export");
      try {
        const data = await request("/api/export");
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }));
        const link = element("a"); link.href = url;
        link.download = `王朝-${state.game.name.replace(/[<>:"/\\|?*\x00-\x1f]/g, "_")}-第${state.game.day}天.json`;
        document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        notify("存档已导出，不含 API Key。");
      } catch (error) { notify(error.message); }
      finally { setOperation(""); }
    });
    importSave = button("导入存档", "secondary-button", () => file.click());
    file.addEventListener("change", async () => {
      const selected = file.files[0]; file.value = "";
      if (!selected || state.operation || state.serverBusy || state.pendingAction || state.uncertainStart) return;
      if (selected.size > 20 * 1024 * 1024) { notify("存档文件超过 20 MB，请选择较小的存档。"); return; }
      let data;
      try { data = JSON.parse(await selected.text()); }
      catch { notify("无法读取此 JSON 存档，当前进度已保留。"); return; }
      if (state.game && !window.confirm("导入将替换当前王朝。建议先导出当前进度。继续导入？")) return;
      setOperation("import");
      try {
        const snapshot = await request("/api/import", { method: "POST", body: data });
        state.mode = "game"; state.view = "study"; state.feedback = null; state.settingsDirty = false;
        ui.actionInput.value = ""; ui.peopleSearch.value = "";
        ui.graphGroup.value = "all"; ui.recordCategory.value = "all";
        applySnapshot(snapshot); notify("存档已导入，可以继续这一朝。");
      } catch (error) { notify(error.message); }
      finally { setOperation(""); }
    });
    const protect = button("保护自动存档", "quiet-button", async () => {
      try {
        const granted = await navigator.storage?.persist?.();
        notify(granted ? "已启用持久存储，浏览器将优先保留自动存档。" : "浏览器仍会自动存档，建议定期导出文件备份。");
      } catch { notify("自动存档仍可使用，建议定期导出文件备份。"); }
    });
    actions.append(exportSave, importSave, protect);
    storagePanel.append(heading, note, actions, file);
    $("settings-view").append(storagePanel);
  }

  class ApiError extends Error {
    constructor(message, status = 0, ambiguous = false) {
      super(message);
      this.name = "ApiError";
      this.status = status;
      this.ambiguous = ambiguous;
    }
  }
  async function request(path, { method = "GET", body, timeout = 15000 } = {}) {
    if (browserRuntime) {
      try { return await (await browserRuntime).request(path, { method, body }); }
      catch (error) { throw new ApiError(error.message || "浏览器存档暂时不可用。", error.status || 503, Boolean(error.ambiguous)); }
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      let response;
      try {
        response = await fetch(path, {
          method, cache: "no-store", credentials: "same-origin", signal: controller.signal,
          ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
        });
      } catch (error) {
        throw new ApiError(error.name === "AbortError" ? "等待本地服务响应超时，请确认服务仍在运行。" : "无法连接本地服务，请确认服务仍在运行。", 0, true);
      }
      let data;
      try { data = await response.json(); }
      catch { throw new ApiError("未能读取服务响应，请重新获取当前记录。", response.status, true); }
      if (!data || typeof data !== "object" || Array.isArray(data)) throw new ApiError("服务响应格式不正确。", response.status, true);
      if (!response.ok) throw new ApiError(typeof data.error === "string" ? data.error : `本地服务返回错误（${response.status}）。`, response.status);
      return data;
    } finally { clearTimeout(timer); }
  }

  function notify(text) {
    clearTimeout(toastTimer);
    $("toast").textContent = text;
    $("toast").hidden = false;
    toastTimer = setTimeout(() => { $("toast").hidden = true; }, 5000);
  }
  function status(node, text, error = false) {
    node.textContent = text;
    node.classList.toggle("error", error);
  }
  function setOperation(operation) {
    state.operation = operation;
    updateControls();
    renderMessages();
    renderFeedback();
  }
  function updateComposerHint() {
    if (ui.composerHint) ui.composerHint.textContent = mobileViewport.matches ? "写下诏令，轻点箭头发送" : "Enter 发送 · Shift + Enter 换行";
    ui.actionInput.setAttribute("enterkeyhint", touchComposer.matches ? "enter" : "send");
  }
  function updateMobileLayout() {
    updateComposerHint();
    if (!visualViewport || keyboardFrame !== null) return;
    keyboardFrame = requestAnimationFrame(() => {
      keyboardFrame = null;
      const width = window.innerWidth;
      const orientation = window.screen.orientation?.type || "";
      const editing = Boolean(document.activeElement?.matches("input, textarea"));
      if (restingViewport && (Math.abs(width - restingViewport.width) > 40 || orientation !== restingViewport.orientation)) restingViewport = null;
      if (!editing) {
        const height = Math.max(window.innerHeight, visualViewport.height);
        if (!restingViewport) restingViewport = { width, height, orientation };
        else restingViewport.height = Math.max(restingViewport.height, height);
      }
      const keyboardOpen = touchComposer.matches && editing && restingViewport && Math.abs(visualViewport.scale - 1) < 0.05 && restingViewport.height - visualViewport.height > 150;
      document.body.classList.toggle("keyboard-open", Boolean(keyboardOpen));
    });
  }
  function updateControls() {
    updateComposerHint();
    const busy = Boolean(state.operation || state.serverBusy);
    const locked = actionLocked();
    ui.send.disabled = locked;
    ui.sleep.disabled = locked;
    ui.actionInput.disabled = locked;
    ui.actionForm.setAttribute("aria-busy", String(state.operation === "action" || state.serverBusy));
    ui.actionInput.placeholder = state.game?.ended ? "这一段王朝人生已经结束。" : state.pendingAction && state.operation !== "action" ? "请先确认上一行动的结果。" : "直接说出你想做的事，例如：召见赵云…";
    ui.startButton.disabled = busy || Boolean(state.pendingAction || state.uncertainStart);
    ui.cancelNew.disabled = busy || Boolean(state.uncertainStart);
    ui.startButton.textContent = state.operation === "start" ? "正在启封…" : "启封这一朝 →";
    $("new-game").disabled = busy || Boolean(state.pendingAction || state.uncertainStart);
    mobileNewGame.disabled = $("new-game").disabled;
    endNewGame.disabled = $("new-game").disabled;
    $("start-settings").disabled = busy;
    ui.saveSettings.disabled = busy;
    ui.testModel.disabled = busy;
    ui.saveSettings.textContent = state.operation === "settings" ? "正在保存…" : "保存设置 →";
    ui.testModel.textContent = state.operation === "test" ? "正在测试…" : "测试连接 ↗";
    const changingSettings = ["settings", "test"].includes(state.operation);
    ui.provider.disabled = changingSettings;
    ui.instructions.disabled = changingSettings;
    $("clear-instructions").disabled = changingSettings;
    const offline = ui.provider.value === "offline";
    for (const input of [ui.model, ui.baseUrl, ui.key]) input.disabled = offline || changingSettings;
    ui.model.required = !offline;
    ui.baseUrl.required = !offline;
    if (exportSave) exportSave.disabled = busy || !state.game || Boolean(state.pendingAction || state.uncertainStart);
    if (importSave) importSave.disabled = busy || Boolean(state.pendingAction || state.uncertainStart);
    const saveText = state.pendingAction && state.operation !== "action" ? "上项行动待确认" : busy ? "正在处理，请稍候…" : browserMode ? "已保存至浏览器" : "已自动保存";
    const saveIndicator = element("i");
    saveIndicator.setAttribute("aria-hidden", "true");
    $("save-status").replaceChildren(saveIndicator, document.createTextNode(saveText));
    if (ui.mobileSaveStatus) {
      ui.mobileSaveStatus.textContent = state.pendingAction && state.operation !== "action" ? "待确认" : busy ? "处理中" : "已保存";
      ui.mobileSaveStatus.title = saveText;
    }
  }

  function populateSettings() {
    if (!state.settings || state.settingsDirty) return;
    ui.provider.value = state.settings.provider;
    ui.baseUrl.value = state.settings.baseUrl || "https://api.deepseek.com";
    ui.model.value = state.settings.model || "deepseek-flash";
    ui.instructions.value = state.settings.additionalInstructions || "";
    ui.key.value = "";
    $("key-note").textContent = browserMode ? state.settings.hasKey ? "当前页面已配置密钥，同一接口留空可保留。密钥仅保留在页面内存，刷新后需重新填写。" : "密钥仅保留在当前页面内存，不写入存档；刷新后需重新填写。" : state.settings.hasKey ? "本次服务已配置密钥；同一接口留空可保留。密钥仅保留在服务内存，不写入存档。" : "密钥仅保留在本次本地服务内存，不写入存档。";
    updateControls();
  }
  function applySnapshot(data) {
    if (!Object.hasOwn(data, "game") || !data.settings || typeof data.busy !== "boolean") throw new ApiError("未能取得完整的游戏状态。", 200, true);
    if (data.game && (!Array.isArray(data.game.people) || !Array.isArray(data.game.messages) || !Array.isArray(data.game.records) || !Array.isArray(data.game.relationships) || !Array.isArray(data.game.affairs) || !Number.isInteger(data.game.version))) throw new ApiError("游戏记录格式不正确，请重新获取。", 200, true);
    if (data.game?.id === state.game?.id && data.game && data.game.version < state.game.version) return;
    const changedWorld = state.game?.id !== data.game?.id;
    state.game = data.game;
    state.settings = data.settings;
    state.serverBusy = data.busy;
    if (typeof data.recoveryNotice === "string" && data.recoveryNotice && !state.recoveryNoticeShown) {
      state.recoveryNoticeShown = true;
      if (!state.feedback) state.feedback = { text: data.recoveryNotice, error: false };
      if (!state.game) status(startMessage, data.recoveryNotice);
      notify(data.recoveryNotice);
    }
    if (changedWorld) {
      state.selectedPerson = "emperor";
      state.recordPerson = "";
      state.highlightedRecord = "";
      state.chatSignature = "";
    }
    if (state.mode === "loading") state.mode = state.game ? "game" : "onboarding";
    if (state.mode === "game" && !state.game) state.mode = "onboarding";
    populateSettings();
    renderGame();
    renderLayout();
    scheduleBusyPoll();
  }
  async function refreshState() {
    const requestedWorld = state.game?.id;
    const data = await request("/api/state");
    if (requestedWorld !== state.game?.id && data.game?.id === requestedWorld) return data;
    applySnapshot(data);
    return data;
  }
  function scheduleBusyPoll(delay = 1500) {
    clearTimeout(pollTimer);
    pollTimer = null;
    if (!state.serverBusy) return;
    pollTimer = setTimeout(async () => {
      try { await refreshState(); }
      catch (error) {
        if (!state.operation) {
          state.feedback = { text: `${error.message} 当前行动的处理状态尚待确认。`, error: true, resync: true };
          renderFeedback();
        }
        scheduleBusyPoll(3500);
      }
    }, delay);
  }

  function renderLayout() {
    ui.loading.hidden = state.mode !== "loading";
    ui.onboarding.hidden = state.mode !== "onboarding";
    ui.shell.hidden = !["game", "pregame"].includes(state.mode);
    const pregame = state.mode === "pregame";
    ui.shell.classList.toggle("pregame", pregame);
    ui.shell.querySelector(".sidebar").hidden = pregame;
    ui.shell.querySelector(".game-topbar").hidden = pregame;
    settingsBack.hidden = !pregame;
    mobileNewGame.hidden = state.mode !== "game";
    ui.cancelNew.hidden = !state.game;
    const view = pregame ? "settings" : state.view;
    for (const [name, copy] of Object.entries(views)) {
      $(`${name}-view`).hidden = name !== view;
      if (name === view) {
        $("view-eyebrow").textContent = copy[0];
        $("view-title").textContent = copy[1];
        $("view-description").textContent = copy[2];
      }
    }
    for (const nav of document.querySelectorAll(".nav-item")) {
      const active = nav.dataset.view === view;
      nav.classList.toggle("active", active);
      if (active) nav.setAttribute("aria-current", "page");
      else nav.removeAttribute("aria-current");
    }
    $("read-only-badge").hidden = view === "study" || pregame;
    $("read-only-badge").textContent = view === "settings" ? "模型配置 · 不消耗时间" : "查阅记录 · 不消耗时间";
    if (view === "graph" && state.mode === "game") scheduleGraphRender();
    if (view === "settings" && !ui.shell.hidden) loadAgent();
    updateControls();
  }
  function navigate(view, { focus = true } = {}) {
    if (!Object.hasOwn(views, view) || state.mode !== "game") return;
    state.view = view;
    renderLayout();
    if (view === "people") renderPeople();
    if (view === "records") renderRecords();
    if (focus) {
      $("view-title").setAttribute("tabindex", "-1");
      $("view-title").focus({ preventScroll: true });
      if (mobileViewport.matches) $("view-title").scrollIntoView({ block: "start", behavior: "auto" });
    }
  }
  function showOnboarding(reset) {
    if (reset) {
      state.previousView = state.view;
      ui.startForm.reset();
      startMessage.textContent = "";
    }
    state.mode = "onboarding";
    renderLayout();
    if (mobileViewport.matches) ui.onboarding.scrollIntoView({ block: "start", behavior: "auto" });
    if (!touchComposer.matches) ui.name.focus({ preventScroll: true });
  }
  function openNewGame() {
    if (!state.game || state.operation || state.serverBusy || state.pendingAction || state.uncertainStart) return;
    ui.newDialog.returnValue = "";
    ui.newDialog.showModal();
  }

  function renderStartRecovery(message) {
    status(startMessage, `${message} 开局结果尚待确认，请先重新获取当前记录。`, true);
    const recover = button("重新获取当前开局", "secondary-button", async () => {
      recover.disabled = true;
      const attempted = state.uncertainStart;
      try {
        await refreshState();
        if (state.serverBusy) {
          renderStartRecovery("本地服务仍在处理，请稍候。");
          return;
        }
        state.uncertainStart = null;
        if (state.game && state.game.id !== attempted?.priorId) {
          state.mode = "game";
          state.view = "study";
          state.feedback = { text: "已取回当前王朝的记录，可以继续。", error: false };
          renderLayout();
          renderGame();
        } else status(startMessage, "已获取最新记录，本次开局尚未建立。可以再次启封。", true);
        updateControls();
      } catch (error) { renderStartRecovery(error.message); }
    });
    const controls = element("div", "error-actions");
    controls.append(recover);
    startMessage.append(controls);
    updateControls();
  }

  function renderGame() {
    if (!state.game) { updateControls(); return; }
    const game = state.game;
    const emperor = personById("emperor");
    $("sidebar-name").textContent = game.name;
    if (ui.mobileName) { ui.mobileName.textContent = game.name; ui.mobileName.title = game.name; }
    $("sidebar-monogram").textContent = [...game.name][0] || "帝";
    ui.shell.querySelector(".reign-identity small").textContent = `${game.dynasty} · ${game.ended ? "本朝纪念" : "当朝天子"}`;
    $("game-date").textContent = game.date;
    $("game-clock").textContent = game.time;
    const hours = Math.floor(game.remainingMinutes / 60);
    const minutes = game.remainingMinutes % 60;
    $("remaining-time").textContent = game.ended ? "此生终章" : `今日尚余 ${hours ? `${hours}小时` : ""}${minutes ? `${minutes}分钟` : ""}`;
    $("conversation-date").textContent = `${game.date} · ${game.time}`;
    $("treasury-value").textContent = number(game.treasury);
    $("emperor-location").textContent = emperor?.location || "尚未获知";
    $("emperor-health").textContent = emperor?.health || "尚未获知";
    $("opening-label").textContent = game.opening;
    ui.end.hidden = !game.ended;
    const offline = state.settings?.provider === "offline";
    const provider = state.settings?.provider === "deepseek" ? "DeepSeek" : "兼容接口";
    $("model-badge").textContent = offline ? "本地规则引擎" : `${provider} · ${state.settings.model}`;
    $("local-mode-note").textContent = offline ? "本地规则引擎仅识别部分行动关键词，使用预设回复。接入叙事模型后，可用更自然的语言自由对话。" : `当前通过${provider}调用 ${state.settings.model} 生成对话。行动耗时与数值由游戏程序结算。`;
    renderMessages();
    renderAffairs();
    renderRecentRecords();
    renderPeople();
    renderRecords();
    renderFeedback();
    if (state.view === "graph") scheduleGraphRender();
    updateControls();
  }

  function messageNode(message, pending = false) {
    const article = element("article", `message ${message.kind === "player" ? "player" : message.kind === "narration" ? "narration" : "dialogue"}`);
    const header = element("div", "message-header");
    const avatar = element("span", "message-avatar", [...String(message.speaker)][0] || "言");
    avatar.setAttribute("aria-hidden", "true");
    header.append(avatar, element("span", "message-time", `${dateFor(message.day)} ${clockFor(message.minute)}${pending ? " · 待确认" : ""}`));
    const body = element("p", "message-body");
    body.append(element("span", "message-speaker", `${message.speaker}：`), document.createTextNode(message.text));
    article.append(header, body);
    return article;
  }
  function renderMessages() {
    if (!state.game) return;
    const pending = state.pendingAction;
    const signature = `${state.game.id}:${state.game.version}:${state.game.messages.map((message) => message.id).join(",")}:${pending?.requestId || ""}:${pending?.status || ""}:${state.serverBusy}`;
    if (signature === state.chatSignature) return;
    const nearBottom = ui.chat.scrollHeight - ui.chat.scrollTop - ui.chat.clientHeight < 80;
    const firstRender = !state.chatSignature;
    const oldScroll = ui.chat.scrollTop;
    state.chatSignature = signature;
    const fragment = document.createDocumentFragment();
    for (const message of state.game.messages) fragment.append(messageNode(message));
    if (pending && pending.gameId === state.game.id && pending.version === state.game.version) fragment.append(messageNode({ speaker: state.game.name, text: pending.text, kind: "player", day: pending.day, minute: pending.minute }, true));
    if (pending || state.serverBusy) {
      const waiting = element("div", "pending-message");
      const dot = element("i");
      dot.setAttribute("aria-hidden", "true");
      waiting.append(dot, element("span", "", pending?.status === "uncertain" && !state.serverBusy ? "上一行动结果待确认。" : "御前正在传达消息，请稍候…"));
      fragment.append(waiting);
    }
    ui.chat.replaceChildren(fragment);
    requestAnimationFrame(() => {
      if (firstRender || nearBottom || state.operation === "action") ui.chat.scrollTop = ui.chat.scrollHeight;
      else ui.chat.scrollTop = oldScroll;
    });
  }
  function renderFeedback() {
    ui.feedback.replaceChildren();
    ui.feedback.classList.toggle("error", Boolean(state.feedback?.error));
    if (state.feedback) ui.feedback.append(element("p", "", state.feedback.text));
    if (state.pendingAction?.status === "uncertain" || state.feedback?.resync) {
      const controls = element("div", "error-actions");
      if (state.pendingAction?.status === "uncertain") {
        const retry = button("确认上一行动", "secondary-button", () => performAction(state.pendingAction));
        retry.disabled = Boolean(state.operation || state.serverBusy);
        controls.append(retry);
      }
      const resync = button("刷新当前记录", "text-link", async () => {
        resync.disabled = true;
        try {
          await refreshState();
          if (state.pendingAction && state.pendingAction.gameId !== state.game?.id) {
            state.pendingAction = null;
            state.feedback = { text: "当前王朝已改变，已取回最新记录。请重新输入行动。", error: false };
          } else if (!state.pendingAction && !state.serverBusy) state.feedback = { text: "已取回最新记录，可以继续。", error: false };
          renderFeedback();
          renderMessages();
          updateControls();
        } catch (error) { notify(error.message); resync.disabled = false; }
      });
      controls.append(resync);
      ui.feedback.append(controls);
    }
    if (!state.feedback && state.serverBusy) ui.feedback.append(element("p", "", "当前行动正在处理中。查阅人物与记录不消耗时间。"));
  }

  function personLink(id, targetView = "people") {
    const person = personById(id);
    if (!person) return null;
    const link = button(person.name, "person-link", () => openPerson(id, targetView));
    link.setAttribute("aria-label", `查看${person.name}的人物档案`);
    return link;
  }
  function renderAffairs() {
    $("affair-count").textContent = `${state.game.affairs.length} 件`;
    const fragment = document.createDocumentFragment();
    for (const affair of state.game.affairs) {
      const card = element("article", "affair");
      const heading = element("div", "affair-head");
      heading.append(element("span", "", affair.title), element("span", "", affair.kind));
      card.append(heading, element("p", "", affair.text));
      const actors = element("div", "record-actors");
      for (const id of affair.actors || []) {
        const link = personLink(id);
        if (link) actors.append(link);
      }
      card.append(actors);
      fragment.append(card);
    }
    if (!state.game.affairs.length) fragment.append(element("p", "empty-state", "暂没有待议事务。你可以直接安排想做的事。"));
    $("affairs-list").replaceChildren(fragment);
  }
  function renderRecentRecords() {
    const fragment = document.createDocumentFragment();
    for (const record of state.game.records.slice(-3).reverse()) {
      const item = element("div", "recent-item");
      const title = element("p");
      title.append(button(record.title, "text-link", () => jumpToRecord(record.id)));
      item.append(element("small", "", record.date), title);
      fragment.append(item);
    }
    if (!state.game.records.length) fragment.append(element("p", "empty-state", "尚无已知的重要事件。"));
    $("recent-records").replaceChildren(fragment);
  }

  function openPerson(id, targetView = state.view) {
    if (!personById(id)) return;
    state.selectedPerson = id;
    if (targetView === "graph") {
      const person = personById(id);
      if (ui.graphGroup.value !== "all" && person.group !== ui.graphGroup.value) ui.graphGroup.value = "all";
      navigate("graph", { focus: false });
      renderGraph();
    } else {
      ui.peopleSearch.value = "";
      navigate("people", { focus: false });
      renderPeople();
    }
    const detail = targetView === "graph" ? ui.graphDetail : ui.peopleDetail;
    focusProfile(detail);
    if (!mobileViewport.matches && window.matchMedia("(max-width: 950px)").matches) detail.scrollIntoView({ block: "nearest", behavior: "auto" });
  }
  function focusProfile(detail) {
    const heading = detail.querySelector("h2");
    if (heading) { heading.setAttribute("tabindex", "-1"); heading.focus({ preventScroll: true }); }
    if (mobileViewport.matches) detail.scrollIntoView({ block: "start", behavior: "auto" });
  }
  function renderProfile(container, id, context) {
    const person = personById(id);
    if (!person) { container.replaceChildren(element("p", "empty-state", "选择一位人物，查看已知档案。")); return; }
    const top = element("div", "profile-top");
    const avatar = element("span", "profile-avatar", [...person.name][0]);
    avatar.setAttribute("aria-hidden", "true");
    const identity = element("div");
    identity.append(element("h2", "", person.name), element("p", "", `${person.group} · ${person.role}`));
    top.append(avatar, identity);
    const facts = element("dl", "profile-facts");
    const factValues = [["年龄", `${person.age} 岁`], ["身体", person.health], ["身份", person.role], ["所在", person.location]];
    if (typeof person.status === "string" && person.status.trim()) factValues.push(["近况", person.status.trim()]);
    for (const [label, value] of factValues) {
      const pair = element("div");
      pair.append(element("dt", "", label), element("dd", "", value));
      facts.append(pair);
    }
    const relations = element("section", "profile-section");
    relations.append(element("h3", "", "已知关系"));
    let relationCount = 0;
    for (const relation of state.game.relationships) {
      const otherId = relation.from === id ? relation.to : relation.to === id ? relation.from : null;
      const other = otherId && personById(otherId);
      if (!other) continue;
      relationCount++;
      const row = element("p", "profile-relationship");
      row.append(button(other.name, "", () => openPerson(otherId, context)), document.createTextNode(` · ${relation.label}`));
      relations.append(row);
    }
    if (!relationCount) relations.append(element("p", "empty-state", "名册中尚无已确认的关系。"));
    const deeds = element("section", "profile-section");
    deeds.append(element("h3", "", "公开与已知事迹"));
    const knownDeeds = state.game.records.filter((record) => record.actors.includes(id)).reverse();
    for (const deed of knownDeeds.slice(0, 6)) {
      const link = button("", "profile-deed", () => jumpToRecord(deed.id));
      link.append(element("small", "", `${deed.date} · ${deed.category}`), element("strong", "", deed.title));
      deeds.append(link);
    }
    if (!knownDeeds.length) deeds.append(element("p", "empty-state", "尚无记入事件纪的已知事迹。"));
    else deeds.append(button(`查看相关事件（${knownDeeds.length}） ↗`, "text-link", () => {
      state.recordPerson = id;
      state.highlightedRecord = "";
      ui.recordCategory.value = "all";
      navigate("records");
    }));
    const observation = element("p", "profile-observation", `${dateFor(person.observedDay)} · ${person.source}。档案保留最近一次已知见闻。`);
    container.replaceChildren(top, facts, element("p", "profile-bio", person.bio), relations, deeds, observation);
  }
  function renderPeople() {
    if (!state.game) return;
    const query = ui.peopleSearch.value.trim().toLocaleLowerCase();
    const people = state.game.people.filter((person) => [person.name, person.role, person.location, person.group].some((value) => String(value).toLocaleLowerCase().includes(query)));
    $("people-count").textContent = query ? `找到 ${people.length} 位人物 · 共 ${state.game.people.length} 位已知人物` : `${state.game.people.length} 位已知人物 · 身体与所在以最近见闻为准`;
    if (!people.some((person) => person.id === state.selectedPerson) && people.length) state.selectedPerson = people[0].id;
    const fragment = document.createDocumentFragment();
    for (const person of people) {
      const selected = state.selectedPerson === person.id;
      const card = button("", `person-card${selected ? " selected" : ""}`, () => {
        state.selectedPerson = person.id;
        renderPeople();
        focusProfile(ui.peopleDetail);
      });
      card.setAttribute("aria-pressed", String(selected));
      card.setAttribute("aria-label", `${person.name}，${person.role}，查看已知档案`);
      const avatar = element("span", "profile-avatar", [...person.name][0]);
      avatar.setAttribute("aria-hidden", "true");
      const description = element("div");
      description.append(element("h3", "", person.name), element("p", "", `${person.role} · ${person.location}`));
      card.append(avatar, description, element("span", "health-label", person.health));
      fragment.append(card);
    }
    if (!people.length) fragment.append(element("p", "empty-state", "没有找到符合条件的人物。换一个姓名、身份或地点试试。"));
    ui.people.replaceChildren(fragment);
    renderProfile(ui.peopleDetail, people.length ? state.selectedPerson : "", "people");
  }

  function scheduleGraphRender() {
    if (graphFrame !== null) cancelAnimationFrame(graphFrame);
    graphFrame = requestAnimationFrame(() => { graphFrame = null; renderGraph(); });
  }
  function renderGraph() {
    if (!state.game || state.mode !== "game" || state.view !== "graph") return;
    const width = Math.max(580, Math.round(ui.graphContainer.clientWidth));
    state.graphWidth = width;
    const height = 500;
    const people = state.game.people.filter((person) => ui.graphGroup.value === "all" || person.group === ui.graphGroup.value);
    if (!people.some((person) => person.id === state.selectedPerson) && people.length) state.selectedPerson = people[0].id;
    const knownIds = new Set(people.map((person) => person.id));
    const selectedDegree = state.game.relationships.filter((relation) => knownIds.has(relation.from) && knownIds.has(relation.to) && (relation.from === state.selectedPerson || relation.to === state.selectedPerson)).length;
    const positions = new Map();
    const outerPeople = state.game.people.filter((person) => person.id !== "emperor");
    const radiusX = width / 2 - 67;
    const radiusY = 175;
    positions.set("emperor", { x: width / 2, y: 233 });
    outerPeople.forEach((person, index) => {
      const angle = -Math.PI / 2 + index * 2 * Math.PI / outerPeople.length;
      positions.set(person.id, { x: width / 2 + Math.cos(angle) * radiusX, y: 233 + Math.sin(angle) * radiusY });
    });
    const fragment = document.createDocumentFragment();
    const edgeGroup = svgElement("g", { "aria-hidden": "true" });
    for (const relation of state.game.relationships) {
      if (!knownIds.has(relation.from) || !knownIds.has(relation.to)) continue;
      const from = positions.get(relation.from);
      const to = positions.get(relation.to);
      const length = Math.hypot(to.x - from.x, to.y - from.y) || 1;
      const ux = (to.x - from.x) / length;
      const uy = (to.y - from.y) / length;
      const x1 = from.x + ux * 25;
      const y1 = from.y + uy * 25;
      const x2 = to.x - ux * 25;
      const y2 = to.y - uy * 25;
      const midX = (x1 + x2) / 2 - uy * 7;
      const midY = (y1 + y2) / 2 + ux * 7;
      const selected = relation.from === state.selectedPerson || relation.to === state.selectedPerson;
      const edge = svgElement("path", { class: `graph-edge${selected ? " highlight" : ""}`, d: `M${x1},${y1} Q${midX},${midY} ${x2},${y2}` });
      edge.append(svgElement("title", {}, `${personById(relation.from).name}与${personById(relation.to).name}：${relation.label}`));
      edgeGroup.append(edge);
      if (selected && selectedDegree <= 5) edgeGroup.append(svgElement("text", { class: "edge-label", x: midX, y: midY - 5 }, relation.label));
    }
    fragment.append(edgeGroup);
    for (const person of people) {
      const position = positions.get(person.id);
      const selected = person.id === state.selectedPerson;
      const node = svgElement("g", { class: `graph-node${selected ? " selected" : ""}`, transform: `translate(${position.x},${position.y})`, role: "button", tabindex: "0", "aria-label": `查看${person.name}，${person.role}的已知档案`, "aria-pressed": String(selected), "data-person-id": person.id });
      node.append(svgElement("circle", { class: "node-circle", cx: 0, cy: 0, r: 24 }), svgElement("text", { class: "node-initial", x: 0, y: 0 }, [...person.name][0]), svgElement("text", { class: "node-name", x: 0, y: 46 }, person.name), svgElement("text", { class: "node-role", x: 0, y: 64 }, person.role));
      const choose = (keyboard) => {
        state.selectedPerson = person.id;
        renderGraph();
        if (!keyboard && mobileViewport.matches) focusProfile(ui.graphDetail);
        if (keyboard) Array.from(ui.graph.querySelectorAll("[data-person-id]")).find((item) => item.getAttribute("data-person-id") === person.id)?.focus();
      };
      node.addEventListener("click", () => choose(false));
      node.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); choose(true); }
      });
      fragment.append(node);
    }
    ui.graph.setAttribute("viewBox", `0 0 ${width} ${height}`);
    ui.graph.setAttribute("role", "group");
    ui.graph.setAttribute("aria-label", `已知人物关系图谱，${people.length}位人物；使用 Tab 选择人物，按 Enter 查看档案`);
    ui.graph.replaceChildren(fragment);
    renderProfile(ui.graphDetail, people.length ? state.selectedPerson : "", "graph");
  }

  function renderRecords() {
    if (!state.game) return;
    const currentCategory = ui.recordCategory.value;
    for (const category of new Set(state.game.records.map((record) => record.category))) {
      if (!Array.from(ui.recordCategory.options).some((option) => option.value === category)) ui.recordCategory.append(element("option", "", category));
    }
    ui.recordCategory.value = currentCategory || "all";
    const person = personById(state.recordPerson);
    recordScope.hidden = !person;
    recordScope.replaceChildren();
    if (person) recordScope.append(element("p", "subtle", `${person.name}的相关事件`), button("查看全部事件 ×", "text-link", () => {
      state.recordPerson = "";
      state.highlightedRecord = "";
      renderRecords();
    }));
    const records = state.game.records.filter((record) => (ui.recordCategory.value === "all" || record.category === ui.recordCategory.value) && (!person || record.actors.includes(person.id))).reverse();
    const fragment = document.createDocumentFragment();
    for (const record of records) {
      const article = element("article", `record-entry${record.id === state.highlightedRecord ? " highlighted" : ""}`);
      article.id = `record-${record.id}`;
      article.setAttribute("tabindex", "-1");
      const top = element("div", "record-top");
      top.append(element("span", "", record.date), element("span", "", clockFor(record.minute)), element("span", "", record.category));
      if (record.knownDay !== record.day) top.append(element("span", "", `获知于 ${record.knownDate}`));
      top.append(element("span", "record-id", record.id.replace("event-", "#")));
      const bottom = element("div", "record-bottom");
      const actors = element("div", "record-actors");
      for (const id of record.actors) { const link = personLink(id); if (link) actors.append(link); }
      bottom.append(actors, element("span", "record-source", `来源 · ${record.source}`));
      article.append(top, element("h2", "", record.title), element("p", "", record.text), bottom);
      fragment.append(article);
    }
    if (!records.length) fragment.append(element("p", "empty-state", "当前筛选下，尚无已知的重要事件。"));
    ui.records.replaceChildren(fragment);
  }
  function jumpToRecord(id) {
    if (!state.game?.records.some((record) => record.id === id)) return;
    state.recordPerson = "";
    state.highlightedRecord = id;
    ui.recordCategory.value = "all";
    navigate("records", { focus: false });
    requestAnimationFrame(() => {
      const record = $(`record-${id}`);
      if (record) { record.focus({ preventScroll: true }); record.scrollIntoView({ block: "center", behavior: "auto" }); }
    });
  }

  async function loadAgent() {
    if (agentLoaded || agentPromise) return;
    ui.fixedAgent.textContent = "正在读取…";
    agentPromise = request("/api/agent").then((data) => {
      if (typeof data.prompt !== "string") throw new ApiError("固定 Agent 响应格式不正确。");
      ui.fixedAgent.textContent = data.prompt;
      agentLoaded = true;
    }).catch((error) => {
      ui.fixedAgent.textContent = `${error.message}\n重新进入模型设置或展开此处可重试。`;
    }).finally(() => { agentPromise = null; });
    await agentPromise;
  }
  function settingsPayload() {
    return { provider: ui.provider.value, baseUrl: ui.baseUrl.value.trim(), model: ui.model.value.trim(), apiKey: ui.key.value.trim(), additionalInstructions: ui.instructions.value };
  }
  async function saveSettingsRequest() {
    const data = await request("/api/settings", { method: "POST", body: settingsPayload() });
    if (!data.settings) throw new ApiError("未能确认设置是否保存，请重新获取当前状态。", 200, true);
    state.settings = data.settings;
    state.settingsDirty = false;
    ui.key.value = "";
    populateSettings();
    if (state.game) renderGame();
    return data;
  }
  async function handleSettings(test) {
    if (state.operation || state.serverBusy || !ui.settingsForm.reportValidity()) return;
    setOperation(test ? "test" : "settings");
    status($("settings-message"), test ? "正在保存当前配置…" : "正在保存设置…");
    if (test) { status($("connection-message"), "正在读取平台模型列表…"); $("connection-status").textContent = "连接中…"; }
    try {
      await saveSettingsRequest();
      status($("settings-message"), "设置已保存。补充指令会与固定 Agent 一同传入模型。");
      if (test) {
        const data = await request("/api/test-model", { method: "POST", body: {}, timeout: 45000 });
        if (!Array.isArray(data.models)) throw new ApiError("平台模型列表格式不正确。");
        $("model-list").replaceChildren(...data.models.map((model) => {
          const option = element("option");
          option.value = String(model);
          return option;
        }));
        $("connection-status").textContent = data.offline ? "本地模式" : "连接成功";
        status($("connection-message"), data.offline ? "本地规则引擎无需网络连接，仅支持部分行动关键词与预设回复。" : `连接成功，读取到 ${data.models.length} 个模型。可在模型名称中选择或输入平台支持的名称。`);
      } else notify("模型设置已保存。");
    } catch (error) {
      status(test ? $("connection-message") : $("settings-message"), error.message, true);
      if (test) $("connection-status").textContent = "连接失败";
      if (error.status === 409 || error.ambiguous) {
        try { await refreshState(); } catch { /* The form keeps its draft while the service is unavailable. */ }
      }
    } finally { setOperation(""); }
  }

  async function performAction(action) {
    if (!action || state.operation || state.serverBusy) return;
    if (action.gameId !== state.game?.id) {
      state.pendingAction = null;
      state.feedback = { text: "当前王朝已改变，请重新输入行动。", error: true };
      renderFeedback();
      updateControls();
      return;
    }
    state.pendingAction = action;
    action.status = "sending";
    state.feedback = { text: "正在处理这项行动…", error: false };
    setOperation("action");
    try {
      const data = await request("/api/action", {
        method: "POST", body: { text: action.text, requestId: action.requestId, version: action.version, gameId: action.gameId }, timeout: 300000,
      });
      applySnapshot(data);
      state.pendingAction = null;
      if (action.source === "composer" && ui.actionInput.value.trim() === action.text) ui.actionInput.value = "";
      const result = data.result;
      const change = result?.treasuryChange;
      const summary = result?.kind === "read" ? `${data.replayed ? "上一项查阅已确认" : "已查阅已有记录"} · 不消耗时间` : result ? `${data.replayed ? "上一行动已确认" : "行动已保存"} · ${result.minutes} 分钟${change ? ` · 国库 ${change > 0 ? "+" : "−"}${number(Math.abs(change))} 两` : ""}` : "行动已保存。";
      state.feedback = { text: `${summary}${data.notice ? `。${data.notice}` : ""}`, error: false };
      if (data.notice) notify(data.notice);
    } catch (error) {
      if (error.status === 409) {
        action.status = "uncertain";
        try {
          await refreshState();
          if (state.serverBusy && state.game?.id === action.gameId) {
            state.feedback = { text: "上一项行动仍在处理中。完成后请确认上一行动。", error: false, resync: true };
          } else if (state.game?.id === action.gameId && state.game.version === action.version && !state.game.ended) {
            state.feedback = { text: `${error.message} 已获取当前记录，可以确认上一行动。`, error: true, resync: true };
          } else {
            state.pendingAction = null;
            state.feedback = { text: `${error.message} 已同步最新记录，请根据当前情况重新输入。`, error: true };
          }
        } catch (refreshError) {
          state.feedback = { text: `${error.message} ${refreshError.message} 请先确认上一行动。`, error: true, resync: true };
        }
      } else if (error.ambiguous || error.status === 500 || error.status === 503 || error.status === 504) {
        action.status = "uncertain";
        state.feedback = { text: `${error.message} 上一行动结果待确认；确认后才能继续。`, error: true, resync: true };
        try {
          await refreshState();
          if (state.game?.id !== action.gameId) {
            state.pendingAction = null;
            state.feedback = { text: "当前王朝已改变，已取回最新记录。请重新输入行动。", error: true };
          }
        } catch { /* Retain the exact request ID until the player can reconnect. */ }
      } else {
        state.pendingAction = null;
        state.feedback = { text: `${error.message} 本次未推进时间，原输入已保留。`, error: true };
      }
    } finally {
      setOperation("");
      renderMessages();
      renderFeedback();
      if (!touchComposer.matches && !actionLocked() && state.mode === "game" && state.view === "study") ui.actionInput.focus({ preventScroll: true });
    }
  }
  function submitAction(text, source) {
    if (actionLocked()) return;
    const value = text.trim();
    if (!value || value.length > 2000) {
      state.feedback = { text: "请输入 1 至 2000 字的行动。", error: true };
      renderFeedback();
      return;
    }
    performAction({ text: value, source, requestId: crypto.randomUUID(), version: state.game.version, gameId: state.game.id, day: state.game.day, minute: state.game.minute, status: "sending" });
  }

  ui.startForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (state.operation || state.serverBusy || state.pendingAction || state.uncertainStart || !ui.startForm.reportValidity()) return;
    const name = ui.name.value.trim();
    if (!name || name.length > 20 || /[\r\n<>]/.test(name)) { status(startMessage, "请填写 1 至 20 字的姓名，不包含换行或尖括号。", true); return; }
    const opening = new FormData(ui.startForm).get("opening");
    setOperation("start");
    status(startMessage, "正在建立王朝并保存开局…");
    try {
      const data = await request("/api/start", { method: "POST", body: { name, opening }, timeout: 20000 });
      state.mode = "game";
      state.view = "study";
      state.feedback = null;
      state.pendingAction = null;
      ui.actionInput.value = "";
      ui.peopleSearch.value = "";
      ui.graphGroup.value = "all";
      ui.recordCategory.value = "all";
      applySnapshot(data);
      status(startMessage, "");
    } catch (error) {
      status(startMessage, error.message, true);
      if (error.ambiguous || error.status === 409 || error.status === 500) {
        const priorId = state.game?.id;
        const uncertain = error.ambiguous || error.status === 500;
        if (uncertain) state.uncertainStart = { name, priorId };
        try {
          await refreshState();
          if (state.game && state.game.id !== priorId && state.game.name === name && state.game.day === 1) {
            state.uncertainStart = null;
            state.mode = "game";
            state.view = "study";
            state.feedback = null;
            renderLayout();
            status(startMessage, "");
          } else if (uncertain && state.serverBusy) renderStartRecovery("本地服务仍在保存开局，请稍候。");
          else {
            state.uncertainStart = null;
            status(startMessage, `${error.message} 已获取当前记录，请确认开局信息后再试。`, true);
          }
        } catch {
          if (uncertain) renderStartRecovery(error.message);
          else status(startMessage, `${error.message} 请重新连接本地服务后再试。`, true);
        }
      }
    } finally {
      setOperation("");
      if (mobileViewport.matches && state.mode === "game") ui.shell.scrollIntoView({ block: "start", behavior: "auto" });
      if (!touchComposer.matches && state.mode === "game") ui.actionInput.focus({ preventScroll: true });
    }
  });
  ui.actionForm.addEventListener("submit", (event) => { event.preventDefault(); submitAction(ui.actionInput.value, "composer"); });
  ui.actionInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !touchComposer.matches && !event.shiftKey && !event.isComposing && event.keyCode !== 229) {
      event.preventDefault();
      if (!actionLocked()) ui.actionForm.requestSubmit();
    }
  });
  ui.sleep.addEventListener("click", () => submitAction("就寝", "sleep"));
  for (const nav of document.querySelectorAll("[data-view]")) nav.addEventListener("click", () => navigate(nav.dataset.view));
  ui.shell.querySelector(".brand").addEventListener("click", (event) => { event.preventDefault(); navigate("study"); });
  $("new-game").addEventListener("click", openNewGame);
  ui.newDialog.addEventListener("close", () => { if (ui.newDialog.returnValue === "confirm") showOnboarding(true); });
  ui.cancelNew.addEventListener("click", () => {
    if (!state.game || state.operation) return;
    state.mode = "game";
    state.view = state.previousView;
    renderGame();
    renderLayout();
    if (mobileViewport.matches) $("view-title").scrollIntoView({ block: "start", behavior: "auto" });
  });
  $("start-settings").addEventListener("click", () => {
    state.mode = "pregame";
    renderLayout();
    $("view-title").setAttribute("tabindex", "-1");
    $("view-title").focus({ preventScroll: true });
    if (mobileViewport.matches) $("view-title").scrollIntoView({ block: "start", behavior: "auto" });
  });
  ui.peopleSearch.addEventListener("input", renderPeople);
  ui.graphGroup.addEventListener("change", renderGraph);
  ui.recordCategory.addEventListener("change", () => { state.highlightedRecord = ""; renderRecords(); });
  ui.settingsForm.addEventListener("input", () => { state.settingsDirty = true; status($("settings-message"), "有未保存的修改。"); });
  ui.provider.addEventListener("change", () => {
    if (ui.provider.value === "deepseek") { ui.baseUrl.value = "https://api.deepseek.com"; ui.model.value = "deepseek-flash"; }
    state.settingsDirty = true;
    $("connection-status").textContent = "尚未测试";
    status($("connection-message"), "");
    updateControls();
  });
  ui.settingsForm.addEventListener("submit", (event) => { event.preventDefault(); handleSettings(false); });
  ui.testModel.addEventListener("click", () => handleSettings(true));
  $("clear-instructions").addEventListener("click", () => {
    ui.instructions.value = "";
    state.settingsDirty = true;
    status($("settings-message"), "补充指令已清空，保存后生效。");
    ui.instructions.focus();
  });
  ui.fixedAgent.closest("details").addEventListener("toggle", (event) => { if (event.currentTarget.open) loadAgent(); });
  window.addEventListener("pagehide", () => { ui.key.value = ""; });
  window.addEventListener("resize", updateMobileLayout);
  touchComposer.addEventListener("change", updateMobileLayout);
  if (visualViewport) {
    visualViewport.addEventListener("resize", updateMobileLayout);
    document.addEventListener("focusin", updateMobileLayout);
    document.addEventListener("focusout", updateMobileLayout);
    window.addEventListener("orientationchange", () => {
      restingViewport = null;
      document.body.classList.remove("keyboard-open");
      updateMobileLayout();
    });
  }
  updateMobileLayout();
  if (typeof ResizeObserver === "function") {
    const observer = new ResizeObserver(() => {
      if (state.mode === "game" && state.view === "graph" && Math.max(580, Math.round(ui.graphContainer.clientWidth)) !== state.graphWidth) scheduleGraphRender();
    });
    observer.observe(ui.graphContainer);
  } else window.addEventListener("resize", scheduleGraphRender);

  async function bootstrap() {
    try { await refreshState(); }
    catch (error) {
      state.mode = "loading";
      const retry = button("重新连接", "secondary-button", () => { retry.disabled = true; bootstrap(); });
      const seal = element("span", "seal", "王");
      ui.loading.replaceChildren(seal, element("p", "", error.message), retry);
      ui.loading.hidden = false;
    }
  }
  bootstrap();
})();
