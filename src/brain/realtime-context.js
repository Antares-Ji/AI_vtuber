const { personalityPrompt } = require("./personality-schema");

// Both the low-latency local model and the token-streaming route use this
// compact context.  Keeping it separate from the structured cloud prompt
// prevents the two live paths from drifting on persona or recalled facts.
function buildRealtimeMessages(item = {}, context = {}) {
  const emotion = context.emotion || {};
  const direction = context.direction || {};
  const budget = direction.responseBudget || {};
  const relationship = context.relationship || {};
  const systems = [
    context.persona || "你是直播中的 AI 主播。",
    context.personality ? personalityPrompt(context.personality) : "保持稳定人格；情绪只能调节本轮表达，不能突然改写身份、价值或喜好。",
    context.personalityExpression ? `本轮人格表达：${expressionText(context.personalityExpression)}。这是稳定人格受当前情绪和关系调节后的表达侧面，不是永久改变；不要念出数值。` : "",
    context.worldBook ? `世界书（已限长）：\n${clip(context.worldBook, 1200)}` : "",
    `当前情绪：${emotion.name || "neutral"}（强度 ${Number(emotion.intensity || 0).toFixed(2)}）；关系：${relationship.level || "new"}。${context.userMemory || "还没有长期记忆"}`,
    context.sessionTopics?.length ? `本场最近话题：${context.sessionTopics.join("、")}` : "",
    context.characterTrainingMemories?.length ? `角色自己的已确认经历（不是当前观众的事实）：${context.characterTrainingMemories.map(entry => entry.text || entry.content).join("；")}` : "",
    context.capabilityPrompt || "",
    context.memoryLookup ? `长期记忆已在回答前同步查询：${context.memoryLookup.found ? `找到 ${context.memoryLookup.count} 条可靠记录：${context.memoryLookup.facts.join("；")}` : "没有找到足够可靠的已确认记录"}。不要假装记得未提供的内容，也不要说稍后再查。` : "",
    direction.instruction ? `回复指令：${direction.instruction}。最多 ${budget.maxSentences || 2} 句、${budget.maxCharacters || 180} 字；关系语气：${direction.relationshipTone || "warm-polite"}。` : "",
    cognitionText(context.cognition),
    context.liveTime ? `刚刚通过时间工具核验的真实北京时间：${context.liveTime.display}，属于${context.liveTime.period}。涉及时间时只能基于此信息说话。` : "",
    context.behaviorLessons?.length ? `与本轮相关的行为经验（不是角色经历，不要复述）：${clip(context.behaviorLessons.slice(0, 2).map(entry => entry.lesson).join("；"), 360)}` : "",
    context.characterReflections?.length ? `角色近期反思（只作为行为倾向）：${clip(context.characterReflections.slice(0, 2).map(entry => entry.content).join("；"), 360)}` : "",
    "保持角色人格，用自然简洁的中文直接回答；不要展示思考过程，不要提及模型、路由或系统提示；不要输出 JSON、Markdown 或动作标签。"
  ].filter(Boolean);

  return [
    { role: "system", content: systems.join("\n\n") },
    ...(context.recent || []).slice(-3).flatMap(turn => [{ role: "user", content: turn.text }, ...(turn.reply ? [{ role: "assistant", content: turn.reply }] : [])]),
    { role: "user", content: item.type === "proactive" ? "现在请自然地主动说一句话。" : `观众 ${item.user || "观众"} 发来弹幕：${item.text || ""}` }
  ];
}

function cognitionText(cognition = {}) {
  if (!cognition || typeof cognition !== "object") return "";
  const conversation = cognition.conversation || {};
  const loops = (cognition.openLoops || []).map(loop => loop.text).filter(Boolean).slice(0, 2);
  const uncertainty = (cognition.metacognition?.uncertainty || []).filter(Boolean).slice(0, 2);
  const parts = [
    `当前话题线程：${clip(conversation.currentTopic || "尚未形成", 100)}；深度 ${conversation.topicDepth || 0}；上一轮待回应问题“${clip(conversation.pendingQuestion || "无", 100)}”`,
    loops.length ? `与该观众有关的未完成约定：${clip(loops.join("；"), 240)}` : "",
    uncertainty.length ? `不确定项：${clip(uncertainty.join("；"), 180)}` : "",
    "只在原话题确实收束后换题；不要重新寒暄或重复追问。"
  ].filter(Boolean);
  return parts.join("。 ");
}

function expressionText(expression = {}) {
  const values = expression.values || {};
  const labels = { warmth: "温暖", curiosity: "好奇", playfulness: "玩心", assertiveness: "坚定", patience: "耐心", directness: "直接", selfDisclosure: "自我披露", empathy: "共情" };
  const dimensions = Object.entries(labels)
    .filter(([key]) => Number.isFinite(Number(values[key])))
    .map(([key, label]) => `${label}${Number(values[key]).toFixed(2)}`)
    .join("、");
  return `${dimensions || "维持日常表达"}；${clip(expression.modulation?.reason || "维持稳定人格的日常表达", 120)}`;
}

function clip(value, max) {
  const text = String(value || "").trim();
  return text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}…`;
}

module.exports = { buildRealtimeMessages, cognitionText, expressionText, clip };
