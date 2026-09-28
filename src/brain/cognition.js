function createCognitionState(persona = {}, now = new Date().toISOString()) {
  if (typeof persona === "string") { now = persona; persona = {}; }
  return {
    goal: "让直播间保持轻松、被听见且不过度打扰的陪伴感",
    goals: [
      { id: "belonging", text: "维持温暖但不纠缠的陪伴感", priority: 0.9, progress: 0.2, status: "active" },
      { id: "continuity", text: "准确延续经过确认的共同经历", priority: 0.88, progress: 0.15, status: "active" },
      { id: "honesty", text: "对能力与记忆边界保持诚实", priority: 0.96, progress: 0.3, status: "active" }
    ],
    activePlan: { focus: "建立自然互动", nextAction: "等待并观察", updatedAt: now },
    openLoops: [],
    completedLoops: [],
    workspace: { attention: "直播间", userIntent: "unknown", salientTopics: [], retrievedFacts: 0, updatedAt: now },
    selfModel: {
      identity: persona.id || "ai-character",
      displayName: persona.displayName || "AI 主播",
      embodiment: "live2d",
      values: Object.entries(persona.values || {}).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([name]) => name),
      interests: [...(persona.interests || [])].slice(0, 8),
      stances: [...(persona.stances || [])].slice(0, 8),
      knownLimits: [], continuityConfidence: 0.5, selfEfficacy: 0.5, updatedAt: now
    },
    metacognition: { responseConfidence: 0.5, memoryConfidence: 0, uncertainty: ["尚无当前对话证据"], lastReviewAt: now },
    needs: { connection: 0.32, novelty: 0.38, competence: 0.42, expression: 0.3, rest: 0.18, safety: 0.12, updatedAt: now },
    observations: [],
    actionHistory: [],
    capabilityFailures: [],
    interactionsSinceReflection: 0,
    reflectionPressure: 0,
    lastReflectionAt: null,
    lastDecision: null,
    conversations: {},
    conversation: { status: "open", turnCount: 0, currentTopic: null, topicDepth: 0, momentum: 0, pendingQuestion: null, lastMemoryLookup: null, lastClosedTopic: null, closedAt: null }
  };
}

function observeTurn(state, item, direction, emotion, topics = [], context = {}) {
  let openLoops = [...state.openLoops];
  const completedLoops = [...(state.completedLoops || [])];
  const now = new Date().toISOString();
  const completion = /(?:已经完成|做完了|完成了|不用继续|取消约定|不需要提醒)/.test(item.text || "");
  if (completion) {
    const index = findResolvableLoop(openLoops, item.user, item.text, conversationKey(item));
    if (index >= 0) completedLoops.push({ ...openLoops[index], status: "resolved", resolvedAt: now, resolution: String(item.text).slice(0, 100) });
    if (index >= 0) openLoops.splice(index, 1);
  } else if (item.type !== "proactive" && isFutureCommitment(item.text)) {
    const loopText = String(item.text).slice(0, 100);
    if (!openLoops.some(loop => loop.user === item.user && loop.conversationKey === conversationKey(item) && overlap(loop.text, loopText) > 0.55)) openLoops.push({ id: `loop-${Date.now()}`, text: loopText, user: item.user, contextScope: item.contextScope || "danmaku", conversationKey: conversationKey(item), createdAt: now, status: "open", priority: 0.7 });
  }
  const focus = topics[topics.length - 1] || (direction.intent === "proactive_chat" ? "轻松陪伴" : "直播互动");
  const key = conversationKey(item);
  const previousConversation = state.conversations?.[key]?.conversation || {};
  const sameTopic = previousConversation.currentTopic === focus;
  const responseText = String(context.responseText || "");
  const pendingQuestion = responseText.match(/([^。！？]{2,60}[？?])(?:$|[^？?]*$)/)?.[1] || null;
  const conversation = direction.intent === "topic_closure"
    ? { ...previousConversation, status: "closed", currentTopic: null, topicDepth: 0, momentum: 0, pendingQuestion: null, lastClosedTopic: focus, closedAt: now }
    : {
      ...previousConversation, status: "open", currentTopic: focus,
      topicDepth: sameTopic ? Math.min(12, Number(previousConversation.topicDepth || 0) + 1) : 1,
      momentum: clamp((sameTopic ? Number(previousConversation.momentum || 0) * 0.62 : 0.12) + (item.type === "proactive" ? 0.08 : 0.28)),
      pendingQuestion,
      lastMemoryLookup: context.memoryLookup ? { user: context.memoryLookup.user, query: context.memoryLookup.query, found: context.memoryLookup.found, checkedAt: context.memoryLookup.checkedAt } : previousConversation.lastMemoryLookup || null,
      updatedAt: now
    };
  const capabilityFailures = [...(state.capabilityFailures || [])];
  if (direction.intent === "capability_boundary") capabilityFailures.push({ user: item.user, capability: direction.capability?.id, at: now, request: String(item.text).slice(0, 100), handledHonestly: true });
  const goals = (state.goals || []).map(goal => {
    let delta = 0;
    if (goal.id === "honesty" && direction.intent === "capability_boundary") delta = 0.025;
    if (goal.id === "continuity" && topics.length) delta = 0.008;
    if (goal.id === "belonging" && emotion.dimensions?.social > 0.2) delta = 0.006;
    return { ...goal, progress: Math.min(1, Number(goal.progress || 0) + delta) };
  });
  const memoryCount = Number(context.retrieval?.selectedFacts || 0);
  const capabilityId = direction.capability?.id;
  const uncertainty = [];
  if (!memoryCount && /记得|上次|以前/.test(item.text || "")) uncertainty.push("没有找到足够相关的已确认记忆");
  if (capabilityId) uncertainty.push(`能力 ${capabilityId} 当前为 ${direction.capability.status}`);
  if ((emotion.socialPerception?.confidence || 0) < 0.55) uncertainty.push("对观众当前情绪的判断置信度较低");
  const responseConfidence = direction.intent === "capability_boundary" ? 0.9 : memoryCount ? 0.78 : direction.intent === "casual_reply" ? 0.58 : 0.7;
  const needs = updateNeeds(state.needs, { item, direction, emotion, topics, responseConfidence, now });
  const reflectionPressure = clamp(Number(state.reflectionPressure || 0)
    + Number(emotion.intensity || 0) * 0.22
    + uncertainty.length * 0.16
    + (direction.priority === "high" ? 0.12 : 0));
  return {
    ...state,
    goals,
    interactionsSinceReflection: state.interactionsSinceReflection + (item.type === "proactive" ? 0 : 1),
    reflectionPressure,
    openLoops: openLoops.filter(loop => loop.status === "open").slice(-12),
    completedLoops: completedLoops.slice(-24),
    workspace: { attention: item.user || "直播间", userIntent: direction.intent, salientTopics: topics.slice(-3), retrievedFacts: memoryCount, perceivedUserEmotion: emotion.socialPerception?.userEmotion || "unknown", updatedAt: now },
    selfModel: {
      ...(state.selfModel || {}),
      knownLimits: [...new Set([...(state.selfModel?.knownLimits || []), capabilityId].filter(Boolean))].slice(-12),
      continuityConfidence: Math.min(1, 0.45 + memoryCount * 0.1),
      selfEfficacy: clamp(Number(state.selfModel?.selfEfficacy ?? 0.5) + (direction.intent === "capability_boundary" ? -0.01 : responseConfidence >= 0.75 ? 0.008 : 0)),
      updatedAt: now
    },
    metacognition: { responseConfidence, memoryConfidence: memoryCount ? Math.min(0.95, 0.58 + memoryCount * 0.08) : 0, uncertainty, lastReviewAt: now },
    needs,
    observations: [...(state.observations || []), { at: now, source: item.type, user: item.user, summary: String(item.text).slice(0, 120), topics: topics.slice(-3) }].slice(-30),
    actionHistory: [...(state.actionHistory || []), { at: now, user: item.user, intent: direction.intent, capability: direction.capability, outcome: "reply-produced" }].slice(-30),
    capabilityFailures: capabilityFailures.slice(-20),
    activePlan: { focus, nextAction: nextActionFor(direction, emotion), rationale: planRationale(direction, emotion), updatedAt: now },
    lastDecision: { intent: direction.intent, capability: direction.capability, at: now },
    conversations: Object.fromEntries([...Object.entries(state.conversations || {}).filter(([id]) => id !== key), [key, { user: item.user, conversation: { ...conversation, turnCount: Number(previousConversation.turnCount || 0) + 1 } }]].slice(-100)),
    lastUser: item.user,
    lastConversationKey: key,
    conversation: { ...conversation, turnCount: Number(previousConversation.turnCount || 0) + 1 }
  };
}

function isFutureCommitment(text) {
  const source = String(text || "");
  if (/(?:以后叫我|我以后叫|以后称呼我|以后我的名字)/.test(source)) return false;
  return /(?:下次|以后|回头|记得提醒|我们约定)/.test(source);
}

function updateNeeds(previous = {}, { item, direction, emotion, topics, responseConfidence, now }) {
  const needs = {
    connection: Number(previous.connection ?? 0.32), novelty: Number(previous.novelty ?? 0.38), competence: Number(previous.competence ?? 0.42),
    expression: Number(previous.expression ?? 0.3), rest: Number(previous.rest ?? 0.18), safety: Number(previous.safety ?? 0.12)
  };
  const proactive = item.type === "proactive";
  const hostile = (emotion.affect?.boundaryPressure || 0) > 0.35;
  needs.connection += proactive ? 0.025 : -0.09;
  needs.novelty += topics.length ? -0.06 : 0.025;
  needs.competence += responseConfidence >= 0.75 ? -0.05 : 0.035;
  needs.expression += proactive ? -0.1 : -0.035;
  needs.rest += Math.max(0.008, Number(emotion.affect?.arousal || 0) * 0.018);
  needs.safety += hostile ? 0.16 : -0.025;
  if (direction.intent === "topic_closure") { needs.connection += 0.03; needs.rest -= 0.03; }
  if (direction.intent === "capability_boundary") needs.competence += 0.045;
  return { ...Object.fromEntries(Object.entries(needs).map(([key, value]) => [key, clamp(value)])), updatedAt: now };
}

function advanceNeeds(previous = {}, now = Date.now()) {
  const elapsedMinutes = Math.max(0, Math.min(30, (now - Date.parse(previous.updatedAt || new Date(now).toISOString())) / 60_000));
  if (!elapsedMinutes) return previous;
  return {
    ...previous,
    connection: clamp(Number(previous.connection || 0) + elapsedMinutes * 0.012),
    novelty: clamp(Number(previous.novelty || 0) + elapsedMinutes * 0.008),
    competence: clamp(Number(previous.competence || 0) + elapsedMinutes * 0.003),
    expression: clamp(Number(previous.expression || 0) + elapsedMinutes * 0.01),
    rest: clamp(Number(previous.rest || 0) - elapsedMinutes * 0.012),
    safety: clamp(Number(previous.safety || 0) - elapsedMinutes * 0.008),
    updatedAt: new Date(now).toISOString()
  };
}

function shouldReflect(state) {
  return state.interactionsSinceReflection >= 12
    || (state.interactionsSinceReflection >= 6 && Number(state.reflectionPressure || 0) >= 0.82);
}

function createReflection(state, memory) {
  const topics = memory.getRecentTopics(3);
  const topicText = topics.length ? topics.join("、") : "轻松聊天";
  const unresolved = state.openLoops.filter(loop => loop.status !== "answered").length;
  const capabilityBoundaries = (state.capabilityFailures || []).slice(-3).map(item => item.capability).filter(Boolean);
  const uncertainty = state.metacognition?.uncertainty?.[0];
  const recentIntents = [...new Set((state.actionHistory || []).slice(-8).map(item => item.intent))];
  const needEntries = Object.entries(state.needs || {}).filter(([key]) => key !== "updatedAt").sort((a, b) => b[1] - a[1]);
  const dominantNeed = needEntries[0]?.[0] || "connection";
  return `反思观察：本场近期围绕${topicText}，主要互动意图为${recentIntents.join("、") || "日常交流"}。解释：当前最需要调节的是 ${dominantNeed}，${unresolved ? `还有 ${unresolved} 个真实约定待延续` : "没有必须强行延续的约定"}。下一次调整：保持${state.activePlan.focus}，${state.activePlan.nextAction}；${uncertainty ? `对“${uncertainty}”先核实再表达` : "不急着塞满每一段安静"}。${capabilityBoundaries.length ? `继续诚实处理能力边界：${[...new Set(capabilityBoundaries)].join("、")}。` : ""}`;
}

function afterReflection(state) { return { ...state, interactionsSinceReflection: 0, reflectionPressure: 0, lastReflectionAt: new Date().toISOString() }; }

function nextActionFor(direction, emotion) {
  if (emotion.dimensions?.irritation > 0.55) return "降低刺激，保持简短边界";
  if (direction.intent === "game_discussion") return "继续围绕游戏细节追问或分析";
  if (direction.intent === "music_discussion") return "延续创作与音乐话题";
  if (direction.intent === "proactive_chat") return "等待观众是否愿意接住话题";
  if (direction.intent === "topic_closure") return "尊重话题收束，留出空白后再决定是否换话题";
  if (direction.intent === "capability_boundary") return "说明当前边界，给出可以做到的相邻方案，不虚构承诺";
  return "观察弹幕，优先回应有意义的互动";
}

function planRationale(direction, emotion) {
  if (direction.intent === "capability_boundary") return "能力诚实优先于迎合用户";
  if (emotion.dimensions?.irritation > 0.55) return "当前刺激较高，先恢复稳定再延续内容";
  if (direction.priority === "high") return "高优先级直播事件需要及时且简短处理";
  return "兼顾当前话题、关系距离与直播节奏";
}

function findResolvableLoop(loops, user, text, scope) {
  const own = loops.map((loop, index) => ({ loop, index })).filter(item => item.loop.user === user && item.loop.conversationKey === scope);
  if (!own.length) return -1;
  const ranked = own.map(item => ({ ...item, score: overlap(item.loop.text, text) })).sort((a, b) => b.score - a.score);
  return ranked[0].index;
}

function overlap(left, right) {
  const chars = value => new Set(String(value || "").replace(/[\s\p{P}]/gu, ""));
  const a = chars(left), b = chars(right); if (!a.size || !b.size) return 0;
  let shared = 0; for (const value of a) if (b.has(value)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

function clamp(value) { return Math.max(0, Math.min(1, Number(value) || 0)); }

function conversationKey(item) { return JSON.stringify([item.sessionId || "", item.contextScope || "danmaku", item.user || ""]); }

module.exports = { conversationKey, createCognitionState, observeTurn, shouldReflect, createReflection, afterReflection, updateNeeds, advanceNeeds, isFutureCommitment };
