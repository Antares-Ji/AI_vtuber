const $ = selector => document.querySelector(selector);
const state = {
  busy: false,
  loopEnabled: null,
  loopSupported: false,
  status: null,
  loop: null,
  statusError: ""
};

function valueOrUnknown(value, suffix = "") {
  if (value === null || value === undefined || value === "") return "未知";
  if (typeof value === "number" && !Number.isFinite(value)) return "未知";
  return `${value}${suffix}`;
}

function setText(selector, value) {
  const node = $(selector);
  if (node) node.textContent = value;
}

async function api(path, options) {
  const response = await fetch(path, {
    headers: { "content-type": "application/json" },
    ...options
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}

function formatPosition(position) {
  if (!position || typeof position !== "object") return "未知";
  const axes = [position.x, position.y, position.z];
  if (axes.some(axis => axis === null || axis === undefined || !Number.isFinite(Number(axis)))) return "未知";
  return axes.map(axis => Number(axis).toFixed(1)).join("  ·  ");
}

function describeInventory(inventory) {
  if (!Array.isArray(inventory)) return { summary: "未知", detail: "接口尚未提供背包数据" };
  if (!inventory.length) return { summary: "0 件", detail: "背包为空" };
  const count = inventory.reduce((sum, item) => sum + (Number.isFinite(Number(item?.count)) ? Number(item.count) : 1), 0);
  const names = inventory.slice(0, 3).map(item => `${item?.name || "未知物品"}${item?.count > 1 ? ` ×${item.count}` : ""}`);
  return { summary: `${count} 件物品`, detail: `${names.join("、")}${inventory.length > 3 ? ` 等 ${inventory.length} 种` : ""}` };
}

function threatDescription(entities) {
  if (entities === null || entities === undefined) return { summary: "未知", detail: "接口尚未提供实体扫描" };
  const list = Array.isArray(entities)
    ? entities
    : Array.isArray(entities?.nearby) ? entities.nearby
      : Array.isArray(entities?.hostile) ? entities.hostile : null;
  if (!list) return { summary: "未知", detail: typeof entities === "string" ? entities : "实体数据格式未识别" };
  if (!list.length) return { summary: "未发现", detail: "当前扫描范围内没有报告实体" };
  const hostileNames = new Set(["blaze", "creeper", "drowned", "elder_guardian", "endermite", "ender_dragon", "enderman", "ghast", "guardian", "hoglin", "husk", "illusioner", "magma_cube", "phantom", "piglin_brute", "pillager", "ravager", "shulker", "silverfish", "skeleton", "slime", "spider", "stray", "vex", "vindicator", "warden", "witch", "wither", "zoglin", "zombie", "zombie_villager", "zombified_piglin"]);
  const benignNames = new Set(["allay", "axolotl", "bat", "bee", "camel", "cat", "chicken", "cod", "cow", "donkey", "fox", "frog", "glow_squid", "horse", "mooshroom", "mule", "ocelot", "panda", "parrot", "pig", "rabbit", "sheep", "skeleton_horse", "sniffer", "snow_golem", "squid", "strider", "tadpole", "trader_llama", "tropical_fish", "turtle", "villager", "wandering_trader", "wolf"]);
  const hostiles = list.filter(entity => {
    const name = String(entity?.name || entity?.type || entity?.kind || "").toLowerCase().replace(/^minecraft:/, "");
    return entity?.hostile === true || entity?.type === "hostile" || entity?.kind === "hostile" || hostileNames.has(name);
  });
  const selected = hostiles.length ? hostiles : list;
  const labels = selected.slice(0, 3).map(entity => {
    const name = entity?.name || entity?.type || entity?.kind || "未知实体";
    return entity?.count > 1 ? `${name} ×${entity.count}` : name;
  });
  if (hostiles.length) return { summary: `${hostiles.length} 个威胁`, detail: labels.join("、") };
  const hasClassifiedNonHostile = list.every(entity => benignNames.has(String(entity?.name || entity?.type || entity?.kind || "").toLowerCase().replace(/^minecraft:/, "")) || entity?.hostile === false);
  if (hasClassifiedNonHostile || list.some(entity => typeof entity?.hostile === "boolean" || entity?.type === "hostile" || entity?.kind === "hostile")) {
    return { summary: "未发现威胁", detail: `扫描到 ${list.length} 个其他实体：${labels.join("、")}` };
  }
  return { summary: "威胁未知", detail: `扫描到 ${list.length} 个实体：${labels.join("、")}` };
}

function renderStatus(status) {
  state.status = status;
  renderGameActivity();
  const connected = status.connected === true;
  const busy = status.busy === true;
  const dot = $("#connectionDot");
  dot.classList.toggle("down", !connected);
  setText("#connectionText", connected ? "游戏已连接" : "游戏未连接");
  setText("#modeLabel", valueOrUnknown(status.mode));
  const badge = $("#taskBadge");
  badge.textContent = busy ? "执行中" : connected ? "待命" : "离线";
  badge.classList.toggle("busy", busy);
  badge.classList.toggle("offline", !connected);
  const reactiveMode = ({ idle: "待命", flee: "正在撤离威胁", fight: "正在防卫" })[status.reactive?.mode] || valueOrUnknown(status.reactive?.mode);
  const reactiveEnabled = status.reactive?.enabled;
  setText("#reactiveStatusValue", reactiveEnabled === true ? `已启用 · ${reactiveMode}` : reactiveEnabled === false ? "未启用" : `启用状态未知 · ${reactiveMode}`);
  setText("#taskValue", busy ? "正在执行游戏任务" : reactiveMode);

  const health = Number(status.health);
  const food = Number(status.food);
  setText("#healthValue", Number.isFinite(health) ? `${Math.round(health * 10) / 10} / 20` : "未知");
  setText("#foodValue", Number.isFinite(food) ? `${Math.round(food * 10) / 10} / 20` : "未知");
  $("#healthMeter").style.width = Number.isFinite(health) ? `${Math.max(0, Math.min(100, health / 20 * 100))}%` : "0%";
  $("#foodMeter").style.width = Number.isFinite(food) ? `${Math.max(0, Math.min(100, food / 20 * 100))}%` : "0%";
  setText("#positionValue", formatPosition(status.position));
  setText("#dimensionValue", valueOrUnknown(status.dimension || status.position?.dimension || status.reactive?.dimension, ""));

  const inventory = describeInventory(status.inventory);
  setText("#inventorySummary", inventory.summary);
  setText("#inventoryDetail", inventory.detail);
  const threat = threatDescription(status.reactive?.entities);
  setText("#threatSummary", threat.summary);
  setText("#threatDetail", threat.detail);
  setText("#reactiveUpdated", valueOrUnknown(status.reactive?.updatedAt));
  setText("#logPath", valueOrUnknown(status.logPath));
  setText("#updatedAt", `更新 ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`);
  $("#diagnostic").textContent = JSON.stringify({
    connected: status.connected,
    busy: status.busy,
    mode: status.mode,
    health: status.health,
    food: status.food,
    position: status.position,
    reactive: status.reactive,
    inventory: status.inventory,
    error: status.error
  }, null, 2);
}

function renderLoop(loop) {
  state.loop = loop;
  renderGameActivity();
  setText('#longTermGoal', loop.goal || '尚未提交');
  setText('#currentStageGoal', loop.currentSubgoal || loop.goalReview?.subgoal || '等待模型根据现场情况规划');
  if (typeof loop.enabled === "boolean") {
    state.loopSupported = true;
    state.loopEnabled = loop.enabled;
    $("#loopToggle").disabled = false;
    $("#loopToggle").checked = loop.enabled;
    setText("#loopLabel", loop.enabled ? (loop.running ? "运行中" : "已启用") : "已关闭");
  }
  const latency = loop.latencyMs;
  setText("#latencyValue", typeof latency === "number" && Number.isFinite(latency) ? `${Math.round(latency)} ms` : "未知");
  setText("#latencyDetail", typeof latency === "number" ? "最近一次模型决策耗时" : "接口尚未提供推理延迟");

  const adapterLabel = loop.adapter ? String(loop.adapter).split(/[\\/]/).slice(-2).join(' / ') : null;
  const modelParts = [loop.model, loop.controllerModel, adapterLabel].filter(value => typeof value === "string" && value.trim());
  const modelVersion = modelParts.length ? modelParts.join(" · ") : "未知";
  setText("#modelVersion", modelVersion);
  if (modelParts.length) $("#modelVersion").title = modelVersion;
  else $("#modelVersion").removeAttribute("title");
  const known = modelParts.length > 0;
  const loadStates = [];
  if (['astra', 'deepseek'].includes(loop.provider)) {
    loadStates.push(loop.modelLoaded ? `${loop.provider === 'deepseek' ? 'DeepSeek' : 'Astra'} 调用已验证` : loop.keyConfigured ? '密钥已配置 · 尚未验证调用' : '等待配置 API 密钥');
  } else {
    if (typeof loop.modelLoaded === "boolean") loadStates.push(`本地模型${loop.modelLoaded ? "已加载" : "未加载"}`);
    if (typeof loop.adapterLoaded === "boolean") loadStates.push(`adapter${loop.adapterLoaded ? "已加载" : "未加载"}`);
  }
  setText("#modelDetail", loadStates.length ? loadStates.join(" · ") : known ? "已提供模型标识；加载状态未知" : "接口尚未提供模型版本");

  if (loop.goal) {
    const reactiveMode = ({ idle: "待命", flee: "正在撤离威胁", fight: "正在防卫" })[state.status?.reactive?.mode] || valueOrUnknown(state.status?.reactive?.mode);
    setText("#taskValue", loop.running ? `自主生存循环 · ${loop.goal}` : state.status?.busy ? "正在执行游戏任务" : reactiveMode);
  }
  setText("#loopStep", valueOrUnknown(loop.step));
  setText("#loopDeadline", !loop.enabled && !loop.step && Date.parse(loop.deadline) < Date.now() ? '尚未开始' : formatDeadline(loop.deadline));
  const recovery = loop.needsRecovery;
  const recoveryNode = $("#recoveryState");
  recoveryNode.classList.toggle("needs-recovery", recovery === true);
  setText("#recoveryState", recovery === true ? "等待纠偏 · 已检测重复失败" : recovery === false ? "无需纠偏" : "纠偏状态未知");
  const usedAdapter = loop.lastDecisionMetadata?.used_adapter;
  setText("#actionAdapterUse", usedAdapter === true ? "是 · 最近动作使用 adapter" : usedAdapter === false ? "否 · 最近动作未使用 adapter" : "未知");
  if (['astra', 'deepseek'].includes(loop.provider)) setText('#actionAdapterUse', loop.lastDecisionMetadata?.source === loop.provider ? `${loop.provider === 'deepseek' ? 'DeepSeek' : 'Astra'} 规划 / 程序核验` : '等待首次云端决策');
  if (loop.lastError || loop.lastResult) setText("#resultText", summarizeLoopResult(loop.lastResult, loop.lastError));
  const resultDetails = loop.lastResult || loop.lastError;
  setText("#loopResultDiagnostic", resultDetails ? JSON.stringify(resultDetails, null, 2) : "暂无自主循环结果");
  setText("#reactiveUpdated", valueOrUnknown(loop.updatedAt || state.status?.reactive?.updatedAt));
  const currentDiagnostic = JSON.parse($("#diagnostic").textContent || "{}");
  $("#diagnostic").textContent = JSON.stringify({ ...currentDiagnostic, loop }, null, 2);
}

function renderGameActivity() {
  const status = state.status;
  const loop = state.loop;
  let phase = 'waiting', text = '等待游戏状态';
  if (state.statusError) { phase = 'offline'; text = '游戏状态暂不可用'; }
  else if (status && !status.connected) { phase = 'offline'; text = '游戏未连接'; }
  else if (status) {
    if (status.reactive?.mode === 'flee' || status.reactive?.mode === 'fight' || status.reactive?.calming) {
      phase = 'safety'; text = status.reactive.mode === 'fight' ? '正在防卫' : '正在避险';
    } else if (status.busy) { phase = 'executing'; text = '正在执行动作'; }
    else if (loop?.enabled && loop.running) { phase = 'planning'; text = loop.provider === 'deepseek' ? 'DeepSeek 正在规划' : loop.provider === 'astra' ? 'Astra 正在规划' : '千问正在规划'; }
    else if (loop?.enabled) { text = '等待下一步'; }
    else { phase = 'stopped'; text = loop?.goalCompleted ? '目标已完成' : '自主任务已停止'; }
  }
  const badge = $('#gameActivity');
  badge.dataset.state = phase;
  badge.textContent = text;
}

function formatDeadline(deadline) {
  if (!deadline) return "未知";
  const parsed = typeof deadline === "number" ? new Date(deadline) : new Date(deadline);
  if (!Number.isFinite(parsed.getTime())) return String(deadline);
  return parsed.toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
}

function summarizeLoopResult(result, error) {
  if (error) return `失败：${shortText(error, 72)}`;
  if (!result) return "暂无结果";
  if (typeof result === "string") return shortText(result, 90);
  const evidence = result.result && typeof result.result === "object" ? result.result : result;
  const actionValue = result.action || evidence.action;
  const actionName = typeof actionValue === "string" ? actionValue : actionValue?.action;
  const actionLabels = {
    observe: "观察周围", eat: "进食", craft: "制作物品", mine: "采集矿物", gather_wood: "采集木材", collect: "拾取物品",
    move: "移动", explore: "探索新区域", flee: "撤离威胁", attack: "应对敌对生物",
    dig_staircase: "挖掘阶梯矿道", collect_water: "收集水", place_water: "放置水",
    smelt: "冶炼物品", equip: "装备物品", place: "放置方块", wait: "等待",
    hunt: "寻找食物"
  };
  const label = actionLabels[actionName] || (actionName ? `执行 ${actionName}` : "自主循环动作");
  const status = result.status || evidence.status;
  const failed = result.success === false || result.ok === false || status === "failed" || status === "cancelled" || status === "rejected" || Boolean(result.error);
  const reason = translateLoopReason(result.error || evidence.error || evidence.reason || evidence.message || evidence.summary);
  const gained = evidence.gained;
  if (failed && evidence.verifiedPartial === true && evidence.complete === false && Number.isFinite(gained) && gained > 0) {
    const verb = status === "cancelled" ? "已取消" : "失败";
    const confirmation = inventoryConfirmationLabel(evidence.inventoryConfirmation);
    const source = partialEvidenceSourceLabel(result.partialEvidenceSource || evidence.partialEvidenceSource);
    return `${label}${verb}，但已确认取得 ${gained} 个目标物品${confirmation ? `（${confirmation}）` : ""}${source ? ` · 证据：${source}` : ""}`;
  }
  if (failed) return `${label}${status === "cancelled" ? "已取消" : "失败"}${reason ? `：${shortText(reason, 64)}` : ""}`;
  if (status === "completed" && actionName === "eat" && evidence.alreadyFull === true) return "任务已完成（无需进食）：饱食度已满，本次未进食，未产生恢复";
  if (status === "completed" && evidence.verified === true && evidence.complete === false && Number.isFinite(gained) && gained > 0) {
    const requested = Number.isFinite(evidence.requested) ? evidence.requested : actionValue?.count;
    const amount = Number.isFinite(requested) && requested > 0 ? `${gained}/${requested}` : `${gained} 个目标物品`;
    return `${label}结束，取得 ${amount}，目标数量未完成`;
  }
  const verified = status === "completed" && evidence.verified === true && evidence.complete !== false;
  if (!verified) return `${label}已返回结果，完成验证未知${reason ? `：${shortText(reason, 48)}` : ""}`;
  return `${label}已完成并验证${reason ? ` · ${shortText(reason, 48)}` : ""}`;
}

function inventoryConfirmationLabel(value) {
  return ({
    native_crafting_table_sync: "原生工作台同步",
    server_window_sync: "服务器窗口同步",
    server_full_window_per_click: "服务器逐步库存确认",
    inventory_delta_only: "仅背包增量确认"
  })[value] || "";
}

function partialEvidenceSourceLabel(value) {
  return ({ "task-response": "技能响应", "correlated-skill-log": "关联技能日志" })[value] || "";
}

function translateLoopReason(reason) {
  if (typeof reason !== "string") return reason;
  const knownReasons = [
    [/no nearby passive animals; explore/i, "附近没有可狩猎动物，建议更换方向探索"],
    [/this operation was aborted/i, "动作已取消"],
    [/skill deadline exceeded/i, "动作执行超时"],
    [/five-hour window ended/i, "授权时间已结束"],
    [/no path|pathfinder.*(?:timeout|failed)/i, "当前路线不可达"],
    [/not enough (?:items|materials|food)/i, "所需物品不足"],
    [/no .* found|could not find/i, "附近未找到目标"],
    [/unsafe/i, "安全检查未通过"]
  ];
  return knownReasons.find(([pattern]) => pattern.test(reason))?.[1] || reason;
}

function shortText(value, maxLength) {
  const text = typeof value === "string" ? value : String(value ?? "");
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

async function refresh() {
  if (window.gameWorkbench?.game === 'sts2') return;
  const results = await Promise.allSettled([
    api("/api/minecraft/status"),
    api("/api/minecraft/loop"),
    api("/api/minecraft/live-context")
  ]);
  if (window.gameWorkbench?.game === 'sts2') return;
  if (results[2].status === 'fulfilled') {
    const shared = results[2].value;
    renderSuggestions(shared.suggestions || []);
    const game = shared.context;
    setText('#speakerProvider', game?.localOnly || shared.chatProvider === 'local' ? '本地千问 · 观众优先' : '按当前聊天配置');
    setText('#speakerFacts', game ? `${game.phase} · ${game.connected ? '生命 ' + game.health + ' / 饱食度 ' + game.food : '实时游戏数据不可用'} · 阶段：${game.subgoal || '等待规划'}` : '暂无游戏上下文');
    setText('#speakerHint', game?.speakingHint || '等待实测状态，不推测进度。');
    setText('#speakerContext', JSON.stringify(game, null, 2));
  } else {
    setText('#speakerFacts', '共享数据接口暂不可用');
    setText('#speakerHint', '当前面板信息不能作为实时口播依据。');
    setText('#speakerContext', '数据读取失败');
  }
  if (results[0].status === "fulfilled") {
    state.statusError = "";
    renderStatus(results[0].value);
  } else {
    state.statusError = results[0].reason.message;
    renderGameActivity();
    $("#connectionDot").classList.add("down");
    setText("#connectionText", "尚未连接 Java 世界");
    setText("#updatedAt", "等待游戏连接");
  }
  if (results[1].status === "fulfilled") {
    renderLoop(results[1].value);
  } else if (!state.loopSupported) {
    $("#loopToggle").disabled = true;
    setText("#loopLabel", "接口暂不可用");
    setText("#latencyDetail", "等待自主生存循环状态接口");
    setText("#modelDetail", "等待自主生存循环状态接口");
  }
}

async function changeLoop(enabled) {
  const toggle = $("#loopToggle");
  toggle.disabled = true;
  setText("#loopLabel", enabled ? "正在启用…" : "正在停止…");
  try {
    renderLoop(await api("/api/minecraft/loop", { method: "POST", body: JSON.stringify({ enabled, ...(enabled ? { durationMinutes: 15 } : {}) }) }));
    setText("#commandFeedback", enabled ? "自主生存循环已请求启用。" : "自主生存循环已请求停止。机器人保持连接。 ");
  } catch (error) {
    toggle.checked = !enabled;
    setText("#loopLabel", "更新失败");
    setText("#commandFeedback", `自主生存循环设置失败：${error.message}`);
    await refresh();
  } finally {
    toggle.disabled = !state.loopSupported;
  }
}

$("#loopToggle").addEventListener("change", event => void changeLoop(event.currentTarget.checked));
window.addEventListener('workbench-minecraft-refresh', () => void refresh());

$("#stopButton").addEventListener("click", async () => {
  if (window.gameWorkbench?.game === 'sts2') return window.gameWorkbench.stop();
  const button = $("#stopButton");
  button.disabled = true;
  button.textContent = "正在发送停止请求…";
  setText("#commandFeedback", "已发出立即停止请求。");
  try {
    await api("/api/minecraft/stop", { method: "POST", body: "{}" });
    setText("#resultText", "停止请求已送达。机器人保持连接。");
  } catch (error) {
    setText("#resultText", `停止请求失败：${error.message}`);
  } finally {
    button.disabled = false;
    button.innerHTML = '<span aria-hidden="true">■</span> 立即停止当前动作';
    await refresh();
  }
});

$("#commandForm").addEventListener("submit", async event => {
  event.preventDefault();
  const input = $("#commandInput");
  const button = $("#sendButton");
  const text = input.value.trim();
  if (!text || state.busy) return;
  const commandGame = window.gameWorkbench?.game || 'minecraft';
  button.disabled = true;
  state.busy = true;
  setText("#commandFeedback", "正在提交长期目标…可随时点击立即停止。");
  setText("#resultText", "模型正在规划，随后由游戏代理执行并核验。");
  try {
    if (commandGame === 'sts2') {
      await window.gameWorkbench.submitGoal(text);
      setText('#commandFeedback', '尖塔目标已接收，岁歌将按本轮步数继续游玩。');
      if (input.value.trim() === text) input.value = '';
      return;
    }
    const completionItem = /铁镐/.test(text) ? 'iron_pickaxe' : /工作台/.test(text) ? 'crafting_table' : undefined;
    const result = await api("/api/minecraft/demo", { method: "POST", body: JSON.stringify({ goal: text, completionItem }) });
    state.loop = result;
    if (!window.gameWorkbench || window.gameWorkbench.game === commandGame) renderLoop(result);
    setText("#resultText", `目标已接收：${result.goal}。尚未完成，请观察实际执行记录。`);
    setText("#commandFeedback", "当前方案将连续规划，最长15分钟；聊天区可随时提出建议。");
    if (input.value.trim() === text) input.value = "";
  } catch (error) {
    setText("#resultText", `请求中断：${error.message}`);
    setText("#commandFeedback", "目标提交失败，请检查当前游戏连接状态后重试。");
  } finally {
    state.busy = false;
    button.disabled = false;
    await refresh();
  }
});

async function loadPersona() {
  try {
    const data = await api("/api/personas");
    const runtime = data.runtime || data;
    const id = runtime.personaId || runtime.persona?.id || data.persona?.id;
    const names = { sui: "姬岁歌 · 岁", ge: "姬岁歌 · 歌" };
    if (id in names) {
      setText("#personaName", names[id]);
      setText("#personaMood", id === "sui" ? "听潮记岁 · 温柔、细致、好奇" : "守潮成歌 · 直接、可靠、守住边界");
    }
  } catch { /* Existing stage remains the source of the live persona. */ }
}

function mountSilentStage() {
  const frame = $("#streamStage");
  frame.addEventListener("load", () => {
    try {
      const doc = frame.contentDocument;
      const style = doc.createElement("style");
      style.textContent = `body,.stream-stage{background:transparent!important}.stream-topbar,.danmaku-composer,.model-error{display:none!important}.subtitles{left:14px;right:14px;bottom:12px;padding:8px 12px;border-left-width:3px;background:rgba(16,19,26,.75)}.subtitles p{font-size:14px;margin:3px 0 0}.subtitles:has(p:empty){display:none}`;
      doc.head.append(style);
      doc.body.style.background = "transparent";
    } catch { /* Cross-origin restrictions fall back to the normal stream layout. */ }
  }, { once: true });
  void fetch("/").then(response => {
    if (!response.ok) throw new Error(`直播舞台加载失败：HTTP ${response.status}`);
    return response.text();
  }).then(html => {
    // The embedded stream reads the parent's audio preference during boot. Give
    // this frame a storage view that reports audio off without changing the
    // shared preference or interrupting audio in another open stream tab.
    const shim = `<script>window.__workbenchGame=${JSON.stringify(window.gameWorkbench?.game || "minecraft")};(function(){const real=window.localStorage;const isolated=new Proxy(real,{get(target,key){if(key==="getItem")return name=>name==="streamer-audio-output"?"off":target.getItem(name);if(key==="setItem")return(name,value)=>{if(name!=="streamer-audio-output")target.setItem(name,value)};if(key==="removeItem")return name=>{if(name!=="streamer-audio-output")target.removeItem(name)};const value=Reflect.get(target,key,target);return typeof value==="function"?value.bind(target):value}});Object.defineProperty(window,"localStorage",{configurable:true,value:isolated})})()<\/script>`;
    const source = html.replace(/<head([^>]*)>/i, `<head$1><base href="${location.origin}/">${shim}`);
    if (source === html) throw new Error("直播台页面没有 head 标签");
    frame.srcdoc = source;
  }).catch(error => {
    frame.srcdoc = `<body style="margin:0;background:#151c21;color:#dbe7df;font:13px system-ui;padding:18px">${error.message}</body>`;
  });
}

let gameShareStream = null;
const gameVideo = $("#gameVideo");
const shareGameButton = $("#shareGameButton");
const stopShareButton = $("#stopShareButton");
const viewerFallback = $("#viewerFallback");
let videoFrameHandle = null, videoFrameGeneration = 0, videoFrameSample = null;
function stopVideoMeasurement() {
  videoFrameGeneration++;
  if (videoFrameHandle !== null && gameVideo.cancelVideoFrameCallback) gameVideo.cancelVideoFrameCallback(videoFrameHandle);
  videoFrameHandle = null;
  videoFrameSample = null;
}
function renderVideoMeasurement() {
  const track = gameShareStream?.getVideoTracks()[0];
  if (!track) { setText('#videoMetrics', '无视频输入'); return; }
  const settings = track.getSettings();
  const width = gameVideo.videoWidth || settings.width;
  const height = gameVideo.videoHeight || settings.height;
  const size = width && height ? `${width}×${height} · ` : '';
  if (track.readyState === 'ended' || gameVideo.ended) { setText('#videoMetrics', `${size}输入已结束`); return; }
  if (gameVideo.paused) { setText('#videoMetrics', `${size}播放已暂停`); return; }
  if (document.hidden) { setText('#videoMetrics', `${size}页面后台 · 暂不计帧`); return; }
  if (track.muted || gameVideo.readyState < 2) { setText('#videoMetrics', `${size}等待视频输入`); return; }
  if (!gameVideo.requestVideoFrameCallback) { setText('#videoMetrics', `${size}当前浏览器不支持测帧`); return; }
  const now = performance.now();
  if (!videoFrameSample?.lastAt || now - videoFrameSample.lastAt > 1800) { setText('#videoMetrics', `${size}等待新画面`); return; }
  setText('#videoMetrics', videoFrameSample.fps === null ? `${size}正在测帧…` : `${size}网页 ${videoFrameSample.fps.toFixed(0)} 帧/秒`);
}
function startVideoMeasurement() {
  stopVideoMeasurement();
  const generation = videoFrameGeneration;
  const receiveFrame = (now, metadata) => {
    if (generation !== videoFrameGeneration || !gameShareStream) return;
    if (!videoFrameSample || document.hidden || now - videoFrameSample.lastAt > 1800) {
      videoFrameSample = { startedAt: now, firstFrame: metadata.presentedFrames, lastAt: now, fps: null };
    } else {
      videoFrameSample.lastAt = now;
      const elapsed = now - videoFrameSample.startedAt;
      if (elapsed >= 2000) {
        videoFrameSample.fps = Math.max(0, (metadata.presentedFrames - videoFrameSample.firstFrame) * 1000 / elapsed);
        videoFrameSample.startedAt = now;
        videoFrameSample.firstFrame = metadata.presentedFrames;
      }
    }
    videoFrameHandle = gameVideo.requestVideoFrameCallback(receiveFrame);
  };
  if (gameVideo.requestVideoFrameCallback) videoFrameHandle = gameVideo.requestVideoFrameCallback(receiveFrame);
  renderVideoMeasurement();
}
setInterval(renderVideoMeasurement, 1000);
for (const event of ['pause', 'ended', 'waiting', 'playing', 'resize']) gameVideo.addEventListener(event, renderVideoMeasurement);
document.addEventListener('visibilitychange', () => { videoFrameSample = null; renderVideoMeasurement(); });
function stopGameShare() {
  stopVideoMeasurement();
  for (const track of gameShareStream?.getTracks() || []) track.stop();
  gameShareStream = null;
  gameVideo.srcObject = null;
  viewerFallback.hidden = false;
  shareGameButton.textContent = "选择 Minecraft 窗口";
  stopShareButton.hidden = true;
  setText("#viewerStatus", "未共享");
  setText("#shareStatus", "未请求屏幕权限");
  setText('#captureHint', '仅在点击后选择共享窗口');
  renderVideoMeasurement();
}

shareGameButton.addEventListener("click", async () => {
  if (gameShareStream) {
    stopGameShare();
    return;
  }
  if (!navigator.mediaDevices?.getDisplayMedia) {
    setText("#shareStatus", "当前浏览器不支持窗口共享");
    return;
  }
  shareGameButton.disabled = true;
  setText("#shareStatus", "请在系统窗口选择器中选择 Minecraft 窗口");
  try {
    gameShareStream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: false });
    gameVideo.srcObject = gameShareStream;
    await gameVideo.play();
    startVideoMeasurement();
    viewerFallback.hidden = true;
    stopShareButton.hidden = false;
    setText("#viewerStatus", "本机预览中");
    setText("#shareStatus", "画面仅在本页本机显示，音频未共享");
    setText('#captureHint', '切到其他窗口即可；请保持游戏窗口打开');
    gameShareStream.getVideoTracks()[0]?.addEventListener("ended", stopGameShare, { once: true });
  } catch (error) {
    setText("#shareStatus", error.name === "NotAllowedError" ? "未选择共享窗口" : `无法共享：${error.message}`);
  } finally {
    shareGameButton.disabled = false;
  }
});
stopShareButton.addEventListener("click", stopGameShare);
$('#obsCameraButton').addEventListener('click', async () => {
  const button = $('#obsCameraButton');
  button.disabled = true;
  let candidate;
  try {
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('浏览器不支持摄像头视频');
    let devices = await navigator.mediaDevices.enumerateDevices();
    let obs = devices.find(d => d.kind === 'videoinput' && /OBS.*Virtual|OBS.*虚拟/i.test(d.label));
    if (!obs) {
      // Device labels may remain hidden until the user grants camera permission.
      const permission = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
      permission.getTracks().forEach(track => track.stop());
      devices = await navigator.mediaDevices.enumerateDevices();
      obs = devices.find(d => d.kind === 'videoinput' && /OBS.*Virtual|OBS.*虚拟/i.test(d.label));
    }
    if (!obs) throw new Error('未发现 OBS Virtual Camera，请先在 OBS 启动虚拟摄像头');
    candidate = await navigator.mediaDevices.getUserMedia({ video: { deviceId: { exact: obs.deviceId }, width: { ideal: 1280, max: 1920 }, height: { ideal: 720, max: 1080 }, frameRate: { ideal: 30, max: 30 } }, audio: false });
    stopGameShare();
    gameShareStream = candidate;
    gameVideo.srcObject = candidate;
    await gameVideo.play();
    startVideoMeasurement();
    viewerFallback.hidden = true;
    stopShareButton.hidden = false;
    setText('#viewerStatus', 'OBS 画面');
    setText('#shareStatus', 'OBS 虚拟摄像头 · 本机视频');
    setText('#captureHint', '切到其他窗口即可；最小化游戏会中断画面');
    candidate.getVideoTracks()[0].addEventListener('ended', stopGameShare, { once: true });
  } catch (error) {
    candidate?.getTracks().forEach(track => track.stop());
    setText('#shareStatus', `OBS 接入失败：${error.message}`);
  } finally { button.disabled = false; }
});

const technicalDetails = $('#technicalDetails');
for (const selector of ['.world-card', '.metrics-grid', '#logsPanel']) {
  const section = $(selector); if (section) technicalDetails.append(section);
}
$('#visibleStop').addEventListener('click', () => $('#stopButton').click());
function stageControl(id) { return $('#streamStage').contentDocument?.getElementById(id); }
for (const [outer, inner] of [['panelVoiceCall', 'voiceCallButton'], ['panelVoiceMessage', 'voiceButton'], ['panelInterrupt', 'interruptSpeech']]) {
  $(`#${outer}`).addEventListener('click', () => {
    const control = stageControl(inner);
    if (!control || control.disabled) { setText('#panelVoiceStatus', '语音暂未就绪，请稍后重试。'); return; }
    control.click();
  });
}
for (const [outer, inner] of [['panelVoiceProvider', 'voiceProviderSelect'], ['panelPersona', 'personaSelect'], ['panelMicrophone', 'microphoneSelect'], ['panelSpeaker', 'speakerDeviceSelect']]) {
  $(`#${outer}`).addEventListener('change', event => {
    const control = stageControl(inner); if (!control) return;
    control.value = event.target.value;
    const frame = $('#streamStage');
    control.dispatchEvent(new frame.contentWindow.Event('change', { bubbles: true }));
  });
}
window.addEventListener('message', event => {
  if (event.source !== $('#streamStage').contentWindow || event.origin !== location.origin || event.data?.type !== 'suige-voice-transcript' || typeof event.data.text !== 'string') return;
  const text = event.data.text.slice(0, 500);
  addAudienceMessage(text, 'user');
  if (window.gameWorkbench?.game !== 'sts2' && $('#influenceGame').checked) void api('/api/minecraft/chat', { method: 'POST', body: JSON.stringify({ text, influence: true, suggestionOnly: true }) }).catch(error => addAudienceMessage(`游戏建议未送达：${error.message}`));
});
mountSilentStage();
$('#demoVoice').addEventListener('change', event => {
  const frame = $('#streamStage'), toggle = frame.contentDocument?.querySelector('#speechOutputToggle');
  if (!toggle) { event.target.checked = false; setText('#demoProgress', '主播舞台尚未准备好，请稍后开启语音。'); return; }
  toggle.checked = event.target.checked;
  toggle.dispatchEvent(new frame.contentWindow.Event('change', { bubbles: true }));
});
function addAudienceMessage(text, kind = 'system') {
  const row = document.createElement('p'); row.className = `chat-${kind}`; row.textContent = text;
  const list = $('#audienceMessages'); list.append(row);
  while (list.children.length > 40) list.firstElementChild.remove();
  list.scrollTop = list.scrollHeight;
}
let suggestionSignature = '';
function renderSuggestions(entries) {
  const signature = JSON.stringify(entries);
  if (signature === suggestionSignature) return;
  // Preserve an operator's in-progress edit while background polling continues.
  if (document.activeElement?.closest('#suggestionReview')) return;
  suggestionSignature = signature;
  const container = $('#suggestionReview'); container.replaceChildren();
  const labels = { summarizing: '千问整理中', ready: '等待你确认', confirmed: '已确认，下一轮规划考虑', dismissed: '已忽略', expired: '已过期', failed: '整理失败，未送入规划', 'not-a-suggestion': '普通聊天，无需游戏操作' };
  for (const entry of entries.slice(-5).reverse()) {
    const card = document.createElement('div'); card.className = 'suggestion-review';
    const title = document.createElement('p'); title.textContent = labels[entry.status] || entry.status; card.append(title);
    const original = document.createElement('p'); original.textContent = `原话：${entry.original}`; card.append(original);
    if (entry.status === 'ready') {
      const input = document.createElement('textarea'); input.value = entry.summary; input.maxLength = 500; input.rows = 2; input.setAttribute('aria-label', '可编辑的建议摘要'); card.append(input);
      for (const [action, label] of [['confirm', '确认交给 Astra'], ['dismiss', '忽略']]) {
        const button = document.createElement('button'); button.type = 'button'; button.textContent = label;
        button.addEventListener('click', async () => {
          card.querySelectorAll('button').forEach(b => { b.disabled = true; });
          try {
            const result = await api('/api/minecraft/suggestions', { method: 'POST', body: JSON.stringify({ action, id: entry.id, text: input.value }) });
            button.blur(); suggestionSignature = ''; renderSuggestions(result.suggestions); await refresh();
          } catch (error) { title.textContent = error.message; card.querySelectorAll('button').forEach(b => { b.disabled = false; }); }
        }); card.append(button);
      }
    } else if (entry.summary) { const text = document.createElement('p'); text.textContent = entry.confirmedText || entry.summary; card.append(text); }
    container.append(card);
  }
}
let audienceSending = false;
$('#audienceForm').addEventListener('submit', async event => {
  event.preventDefault();
  const input = $('#audienceInput'), text = input.value.trim();
  if (!text || audienceSending) return;
  audienceSending = true;
  const send = $('#audienceForm button[type=submit]');
  send.disabled = true; send.textContent = '发送中…';
  input.value = ''; addAudienceMessage(text, 'user');
  const chatGame = window.gameWorkbench?.game || 'minecraft';
  try {
    if (chatGame === 'sts2') {
      await window.gameWorkbench.ready();
      await api('/api/sts2/chat', { method: 'POST', body: JSON.stringify({ text }) });
      addAudienceMessage('聊天已送到尖塔直播间，岁歌会在解说间隙回应。');
      return;
    }
    const result = await api('/api/minecraft/chat', { method: 'POST', body: JSON.stringify({ text, influence: $('#influenceGame').checked }) });
    addAudienceMessage(result.suggestion ? '聊天已发送；千问正在整理建议，请在下方审核确认，尚未交给 Astra。' : '聊天已进入直播间。');
  } catch (error) {
    if (!input.value) input.value = text;
    addAudienceMessage(`发送未成功：${error.message}`);
  } finally { audienceSending = false; send.disabled = false; send.textContent = '发送 ↗'; }
});
document.querySelectorAll('[data-chat]').forEach(button => button.addEventListener('click', () => {
  $('#audienceInput').value = button.dataset.chat; $('#audienceForm').requestSubmit();
}));
document.querySelectorAll('[data-demo]').forEach(button => button.addEventListener('click', async () => {
  const goals = {
    crafting_table: '从当前真实背包开始，采集足够原木，合成木板，再合成一个工作台。优先保证安全和饱食度。每一步根据实际库存和配方决定数量，缺料不要重复合成。',
    iron_pickaxe: '从当前真实背包开始，逐步制作必要工具和熔炉，采集铁矿，使用燃料炼出至少三个铁锭，再结合木棍和工作台合成一把铁镐。随时根据饱食度、食物和危险调整优先级。'
  };
  button.disabled = true;
  try {
    const result = await api('/api/minecraft/demo', { method: 'POST', body: JSON.stringify({ goal: goals[button.dataset.demo], completionItem: button.dataset.demo }) });
    renderLoop(result); addAudienceMessage(`目标：${result.goal}`, 'user');
    setText('#demoProgress', '目标已提交 · 由所选模型决定每一步 · 聊天区可随时提出建议');
  } catch (error) { setText('#demoProgress', `尚未开始：${error.message}`); }
  finally { button.disabled = false; }
}));
let demoRecorder = null, recordingStream = null, lastDemoResult = '', lastStageSubtitle = '';
$('#recordDemo').addEventListener('click', async () => {
  if (demoRecorder?.state === 'recording') { demoRecorder.stop(); return; }
  try {
    if (!navigator.mediaDevices?.getDisplayMedia || !window.MediaRecorder) throw new Error('当前浏览器不支持录屏，请使用桌面录屏工具');
    recordingStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    const chunks = [];
    demoRecorder = new MediaRecorder(recordingStream);
    demoRecorder.ondataavailable = event => { if (event.data.size) chunks.push(event.data); };
    demoRecorder.onstop = () => {
      const blob = new Blob(chunks, { type: demoRecorder.mimeType });
      const url = URL.createObjectURL(blob), link = document.createElement('a');
      link.href = url; link.download = `suige-demo-${Date.now()}.webm`; link.click();
      setTimeout(() => URL.revokeObjectURL(url), 60000);
      recordingStream.getTracks().forEach(track => track.stop()); recordingStream = null;
      $('#recordDemo').textContent = '录制演示';
    };
    recordingStream.getVideoTracks()[0].addEventListener('ended', () => { if (demoRecorder?.state === 'recording') demoRecorder.stop(); });
    demoRecorder.start(1000); $('#recordDemo').textContent = '结束录制并保存';
  } catch (error) {
    recordingStream?.getTracks().forEach(track => track.stop()); recordingStream = null;
    setText('#demoProgress', error.name === 'NotAllowedError' ? '录屏选择已取消。' : `录屏未开始：${error.message}`);
  }
});
setInterval(() => {
  const loop = window.gameWorkbench?.game === 'sts2' ? null : state.loop;
  if (loop?.goalCompleted) setText('#demoProgress', '已核实目标物品出现在背包中 · 演示目标完成，主动任务停止');
  else if (loop?.enabled) setText('#demoProgress', `第 ${loop.step || 0} 步 · ${$('#gameActivity').textContent}`);
  const result = loop?.lastResult;
  if (result && result.at !== lastDemoResult) {
    lastDemoResult = result.at;
    addAudienceMessage(`游戏结果：${result.action?.action || '动作'} · ${result.status || '未知'}${result.result?.complete === false ? '（仅部分完成）' : ''}${result.error ? ` · ${result.error}` : ''}`, 'result');
  }
  try {
    const stageDoc = $('#streamStage').contentDocument;
    for (const [outer, inner] of [['panelVoiceCall', 'voiceCallButton'], ['panelVoiceMessage', 'voiceButton']]) {
      const control = stageDoc?.getElementById(inner);
      if (control) { $(`#${outer}`).textContent = control.textContent; $(`#${outer}`).disabled = control.disabled; $(`#${outer}`).setAttribute('aria-pressed', control.getAttribute('aria-pressed') || 'false'); }
    }
    const voiceStatus = stageDoc?.getElementById('voiceStatus');
    if (voiceStatus) setText('#panelVoiceStatus', voiceStatus.textContent);
    const calibration = stageDoc?.getElementById('voiceCallCalibration');
    const callActive = stageDoc?.getElementById('voiceCallButton')?.getAttribute('aria-pressed') === 'true';
    setText('#panelMicCalibration', callActive ? calibration?.textContent || '正在读取麦克风…' : '输入请选择实际使用的麦克风；主播输出控制 GPT-SoVITS，系统机器声音跟随系统默认。');
    for (const [outer, inner] of [['panelVoiceProvider', 'voiceProviderSelect'], ['panelPersona', 'personaSelect'], ['panelMicrophone', 'microphoneSelect'], ['panelSpeaker', 'speakerDeviceSelect']]) {
      const control = stageDoc?.getElementById(inner), target = $(`#${outer}`);
      if (control) {
        const optionsKey = Array.from(control.options, o => `${o.value}:${o.textContent}`).join('|');
        if (target.dataset.optionsKey !== optionsKey) { target.replaceChildren(...Array.from(control.options, o => new Option(o.textContent, o.value))); target.dataset.optionsKey = optionsKey; }
        target.value = control.value; target.disabled = control.disabled;
      }
    }
    const voiceToggle = stageDoc?.querySelector('#speechOutputToggle');
    if (voiceToggle) $('#demoVoice').checked = voiceToggle.checked;
    const subtitle = stageDoc?.querySelector('#subtitle')?.textContent?.trim();
    if (subtitle && subtitle !== lastStageSubtitle) { lastStageSubtitle = subtitle; addAudienceMessage(`岁歌：${subtitle}`, 'result'); }
  } catch { /* The stage is optional; never replace actual responses with invented speech. */ }
}, 2000);
let savedEngine = null;
let engineBusy = false;
function renderEngine(config) {
  savedEngine = config;
  $('#gameEngine').value = config.provider === 'astra-jev' ? 'astra' : config.provider;
  if (config.provider === 'deepseek') {
    setText('#engineStatus', config.verification?.ok ? 'DeepSeek 调用已验证 · 游戏连接见顶部状态' : config.verification?.error ? `DeepSeek 检查失败：${config.verification.error}` : config.keyConfigured ? 'DeepSeek 密钥已配置 · 可检查连接' : '请填入 DeepSeek API Key 并保存');
    updateEngineControls(); return;
  }
  const verification = config.verification;
  setText('#engineStatus', config.provider === 'local-qwen' ? '当前使用本地千问。切换方案并保存后，下一次游戏任务使用新方案。' :
    !config.keyConfigured ? '请填入 OpenAI API Key 并保存，千问互动使用本地服务。' :
      verification?.ok ? `Astra 调用已通过 · ${verification.plannerMs} ms · 游戏连接见顶部状态` :
        verification?.error ? `密钥已配置 · 检查失败：${verification.error}` : '密钥已配置 · 请检查 Astra 连接');
  updateEngineControls();
}
function updateEngineControls() {
  const cloud = $('#gameEngine').value === 'astra';
  const deepseek = $('#gameEngine').value === 'deepseek';
  $('#engineKeyField').hidden = !cloud && !deepseek;
  setText('#engineKeyLabel', deepseek ? 'DeepSeek API Key' : 'OpenAI API Key（Astra 专用）');
  $('#engineKeyLink').href = deepseek ? 'https://platform.deepseek.com/api_keys' : 'https://platform.openai.com/api-keys';
  $('#engineKeyLink').textContent = deepseek ? '获取 DeepSeek 密钥' : '获取 OpenAI 密钥';
  setText('#engineTestHelp', '检查只调用一次所选模型并产生 API 用量，不会执行游戏动作。');
  $('#testEngine').hidden = !cloud && !deepseek;
  $('#testEngine').textContent = deepseek ? '检查 DeepSeek 连接' : '检查 Astra 连接';
  $('#engineDescription').hidden = !cloud && !deepseek;
  $('#engineDescription').textContent = deepseek ? 'DeepSeek API 根据实测状态决定下一步 → 程序检查 → Mineflayer 执行与核验 → 反馈结果重新规划。游戏控制无需本地 4B 模型。' : 'Astra 阶段规划 → 程序检查 → Mineflayer 执行；本地千问互动。';
  $('#saveEngine').disabled = engineBusy || !savedEngine;
  $('#gameEngine').disabled = engineBusy || !savedEngine;
  $('#engineApiKey').disabled = engineBusy;
  $('#testEngine').disabled = engineBusy || !savedEngine?.keyConfigured || savedEngine?.provider !== $('#gameEngine').value || Boolean($('#engineApiKey').value);
}
$('#gameEngine').addEventListener('change', () => { $('#engineApiKey').value = ''; updateEngineControls(); setText('#engineStatus', '选择尚未保存，点击“保存配置”应用。'); });
$('#engineApiKey').addEventListener('input', updateEngineControls);
$('#engineForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (engineBusy) return;
  engineBusy = true; updateEngineControls();
  const update = { provider: $('#gameEngine').value };
  const key = $('#engineApiKey').value.trim();
  if (key) update.apiKey = key;
  try {
    const config = await api('/api/minecraft/engine', { method: 'POST', body: JSON.stringify(update) });
    $('#engineApiKey').value = '';
    renderEngine(config); await refresh();
  } catch (error) { setText('#engineStatus', `保存失败：${error.message}`); }
  finally { engineBusy = false; updateEngineControls(); }
});
$('#testEngine').addEventListener('click', async () => {
  if (engineBusy) return;
  engineBusy = true; updateEngineControls();
  setText('#engineStatus', '正在检查所选云模型，最多等待60秒；不会执行游戏动作…');
  try { renderEngine(await api('/api/minecraft/engine/test', { method: 'POST', body: '{}' })); }
  catch (error) { setText('#engineStatus', `连接检查失败：${error.message}`); }
  finally { engineBusy = false; updateEngineControls(); await refresh(); }
});
updateEngineControls();
void api('/api/minecraft/engine').then(renderEngine).catch(error => setText('#engineStatus', `配置读取失败：${error.message}`));
void loadPersona();
void refresh();
setInterval(() => void refresh(), 2000);
for (const [id, command] of [['botViewCommand', '/spectate jiaobenbot'], ['playerViewCommand', '/spectate']]) {
  document.getElementById(id).addEventListener('click', async () => {
    const status = document.getElementById('cameraStatus');
    try {
      await navigator.clipboard.writeText(command);
      status.textContent = `已复制 ${command}。在 Minecraft 按 T、粘贴并回车；当前玩家须处于旁观模式。复制不代表已切换。`;
    } catch {
      status.textContent = `请在 Minecraft 聊天栏执行：${command}。当前玩家须处于旁观模式。`;
    }
  });
}

for (const [field, form] of [['#commandInput', '#commandForm'], ['#audienceInput', '#audienceForm']]) {
  $(field).addEventListener('keydown', event => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing || event.keyCode === 229) return;
    event.preventDefault();
    if (event.repeat || $(form).querySelector('button[type=submit]').disabled) return;
    $(form).requestSubmit();
  });
}
