const CHAT_COMPANION = {
  id: "chat-companion",
  name: "聊天陪伴",
  description: "AI 主播在轻松直播间里愿意聊一点日常，也尊重观众保持安静。",
  minDelayMs: Number(process.env.SCENE_CHAT_MIN_DELAY_MS || 60_000),
  maxDelayMs: Number(process.env.SCENE_CHAT_MAX_DELAY_MS || 90_000),
  prompts: [
    { id: "time-check-in", timeSensitive: true, text: "结合真实北京时间，主动但不打扰地关心观众此刻的日常。" },
    { id: "small-discovery", text: "分享一句很小的感受，再留一个容易回答的问题。" },
    { id: "music-bridge", text: "从音乐、创作或今天的情绪中找一个轻松话题。" },
    { id: "creative-spark", text: "聊聊灵感从哪里来，问一个关于创作、收藏或表达的小问题。" },
    { id: "game-moment", text: "用轻松方式聊游戏里的一个瞬间、失败后的小情绪或想练的目标。" },
    { id: "tiny-choice", text: "给一个没有标准答案的二选一小问题，让对方容易接话。" },
    { id: "daily-scene", text: "从桌面、窗外、通勤、吃饭或休息这些普通日常里挑一个话题。" },
    { id: "memory-thread", text: "如果存在合适的近期话题或用户记忆，温柔地延续；没有就换成日常闲聊。" },
    { id: "comfort-check", text: "关心对方现在是否累、是否在忙，但不要求对方解释。" },
    { id: "curiosity", text: "提出一个有一点想象力但不尴尬的小问题，例如最近想学什么或想保存什么瞬间。" },
    { id: "stage-note", text: "像直播中自然的自言自语一样说一个小观察，再给对方留一扇可回应的门。" },
    { id: "shared-space", text: "把直播间当作共同待着的空间，聊此刻的氛围、节奏或安静本身。" },
    { id: "recommendation", text: "邀请对方推荐一个不涉及完整歌词的作品、游戏或小习惯。" },
    { id: "gentle-pause", text: "承认安静也没关系，用一句温柔但不索取回应的话陪伴。" }
  ]
};
const { BRAIN_THRESHOLDS } = require("./thresholds");

function createSceneState(now = Date.now()) {
  return {
    sceneId: CHAT_COMPANION.id,
    chatEnabled: true,
    lastHumanActivityAt: now,
    lastProactiveAt: 0,
    nextProactiveAt: now + randomDelay(),
    awaitingReplyUntil: 0,
    interactionHoldUntil: 0,
    unansweredCount: 0,
    chatSuspended: false,
    suspendedReason: null,
    recentPromptIds: [],
    topicCursor: 0,
    lastTopicId: null,
    quietUntil: 0
  };
}

function chooseProactive(sceneState, now = Date.now(), context = {}) {
  if (!sceneState.chatEnabled || sceneState.chatSuspended || now < sceneState.interactionHoldUntil || now < sceneState.nextProactiveAt) return null;
  const unanswered = sceneState.lastProactiveAt > sceneState.lastHumanActivityAt;
  if (unanswered && now < sceneState.awaitingReplyUntil) return null;
  if (unanswered && sceneState.unansweredCount >= BRAIN_THRESHOLDS.proactive.maxUnanswered) return null;
  const engagement = unanswered ? engagementLevel(sceneState.unansweredCount + 1) : "warm";
  const prompt = choosePrompt(sceneState.recentPromptIds, { ...context, engagement, now });
  return { ...prompt, engagement };
}

function recordHumanActivity(sceneState, now = Date.now()) {
  return {
    ...sceneState,
    lastHumanActivityAt: now,
    nextProactiveAt: now + randomDelay(),
    awaitingReplyUntil: 0,
    interactionHoldUntil: 0,
    unansweredCount: 0,
    chatSuspended: false,
    suspendedReason: null
  };
}

function recordProactive(sceneState, prompt, now = Date.now()) {
  const replyWaitMs = randomDelay();
  return {
    ...sceneState,
    lastProactiveAt: now,
    nextProactiveAt: now + replyWaitMs,
    awaitingReplyUntil: now + replyWaitMs,
    unansweredCount: sceneState.lastProactiveAt > sceneState.lastHumanActivityAt ? sceneState.unansweredCount + 1 : 1,
    lastTopicId: prompt.id,
    topicCursor: (sceneState.topicCursor + 1) % CHAT_COMPANION.prompts.length,
    recentPromptIds: [...sceneState.recentPromptIds, prompt.id].slice(-4)
  };
}

function suspendIfIgnored(sceneState, now = Date.now()) {
  const unanswered = sceneState.lastProactiveAt > sceneState.lastHumanActivityAt;
  if (!unanswered || sceneState.unansweredCount < BRAIN_THRESHOLDS.proactive.maxUnanswered || now < sceneState.awaitingReplyUntil) return sceneState;
  return { ...sceneState, chatSuspended: true, suspendedReason: "three-unanswered-topics" };
}

function setChatEnabled(sceneState, enabled, now = Date.now()) {
  return { ...sceneState, chatEnabled: Boolean(enabled), chatSuspended: false, suspendedReason: null, unansweredCount: 0, nextProactiveAt: now + randomDelay() };
}

function setInteractionHold(sceneState, durationMs = 0, now = Date.now()) {
  const safeDuration = Math.min(Math.max(Number(durationMs) || 0, 0), 180_000);
  return { ...sceneState, interactionHoldUntil: Math.max(sceneState.interactionHoldUntil || 0, now + safeDuration) };
}

function clearInteractionHold(sceneState) {
  return { ...sceneState, interactionHoldUntil: 0 };
}

function randomDelay() {
  return CHAT_COMPANION.minDelayMs + Math.floor(Math.random() * (CHAT_COMPANION.maxDelayMs - CHAT_COMPANION.minDelayMs + 1));
}

function engagementLevel(unansweredCount) {
  if (unansweredCount <= 1) return "gentle";
  if (unansweredCount <= 2) return "low-pressure";
  return "quiet";
}

function choosePrompt(recentPromptIds = [], context = {}) {
  const candidates = CHAT_COMPANION.prompts.filter(prompt => !recentPromptIds.includes(prompt.id));
  const pool = candidates.length ? candidates : CHAT_COMPANION.prompts;
  const topics = context.topics || [];
  const hour = new Date(context.now || Date.now()).getHours();
  const ranked = pool.map(prompt => {
    let score = 1 + Math.random() * 0.35;
    const reasons = ["基础多样性"];
    if (prompt.id === "memory-thread" && (context.hasMemory || topics.length)) { score += 1.25; reasons.push("存在可延续记忆"); }
    if (prompt.id === "game-moment" && topics.some(topic => /游戏|osu/i.test(topic))) { score += 1.1; reasons.push("近期游戏话题"); }
    if (["music-bridge", "creative-spark", "recommendation"].includes(prompt.id) && topics.some(topic => /音乐|创作/.test(topic))) { score += 0.8; reasons.push("近期音乐话题"); }
    if (prompt.id === "time-check-in" && (hour >= 22 || hour <= 7)) { score += 0.9; reasons.push("深夜时间段"); }
    if (["gentle-pause", "shared-space"].includes(prompt.id) && ["low-pressure", "quiet"].includes(context.engagement)) { score += 1.5; reasons.push("降低互动压力"); }
    if (prompt.id === "tiny-choice" && context.engagement === "gentle") { score += 0.5; reasons.push("容易回应"); }
    const needs = context.needs || {};
    if (["shared-space", "memory-thread"].includes(prompt.id) && Number(needs.connection || 0) > 0.55) { score += Number(needs.connection) * 0.8; reasons.push("连接需求较高"); }
    if (["curiosity", "creative-spark", "tiny-choice"].includes(prompt.id) && Number(needs.novelty || 0) > 0.5) { score += Number(needs.novelty) * 0.7; reasons.push("新奇需求较高"); }
    if (["stage-note", "music-bridge"].includes(prompt.id) && Number(needs.expression || 0) > 0.5) { score += Number(needs.expression) * 0.65; reasons.push("表达需求较高"); }
    if (["gentle-pause", "comfort-check"].includes(prompt.id) && Number(needs.rest || 0) > 0.5) { score += Number(needs.rest) * 0.85; reasons.push("休息需求较高"); }
    if (prompt.id === "gentle-pause" && Number(needs.safety || 0) > 0.45) { score += Number(needs.safety) * 0.9; reasons.push("优先恢复安全"); }
    return { prompt, score, reasons };
  }).sort((a, b) => b.score - a.score);
  const selected = Math.random() < 0.78 ? ranked[0] : ranked[Math.min(1, ranked.length - 1)];
  return { ...selected.prompt, selectionScore: Number(selected.score.toFixed(3)), selectionReason: selected.reasons.join("、") };
}

module.exports = { CHAT_COMPANION, createSceneState, chooseProactive, recordHumanActivity, recordProactive, setChatEnabled, setInteractionHold, clearInteractionHold, suspendIfIgnored };
