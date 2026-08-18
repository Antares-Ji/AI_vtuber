function directReply(item, emotion, relationship, context = {}) {
  const text = item.text || "";
  const repeated = Number(item.repeatCount || 0) > 0 || (emotion.repetition?.pressure || 0) >= (emotion.repetition?.threshold || 1);
  let intent = "casual_reply";
  let priority = "normal";

  if (context.capabilityRequest && context.capabilityRequest.status !== "ready") {
    intent = "capability_boundary";
    priority = "high";
  } else if (item.type === "proactive") {
    intent = "proactive_chat";
    priority = "low";
  } else if (/(?:这个话题(?:就)?(?:到这里|结束)|先聊到这|先到这|换个话题|不聊了|就这样吧|好了(?:，|,|。|$))/.test(text)) {
    intent = "topic_closure";
  } else if (["superchat", "gift", "guard"].includes(item.type)) {
    intent = "support_thanks";
    priority = "high";
  } else if (repeated && emotion.name === "annoyed") {
    intent = "gentle_boundary";
    priority = "high";
  } else if ((emotion.trajectory?.at(-1)?.events || []).some(event => ["hostile", "threat", "aversion"].includes(event))) {
    intent = "gentle_boundary";
    priority = "high";
  } else if (/(?:别问了|不想说|给我点空间|让我静一静|先别打扰)/.test(text)) {
    intent = "respect_space";
    priority = "high";
  } else if (emotion.socialPerception?.need === "support" && Number(emotion.socialPerception?.confidence || 0) >= 0.6) {
    intent = "emotional_support";
    priority = "high";
  } else if (/osu|打图|谱面|HR|DT|miss|acc/i.test(text)) {
    intent = "game_discussion";
  } else if (/歌曲|音乐|P主|创作|调教|翻唱|版权|授权/.test(text)) {
    intent = "music_discussion";
  } else if (/[?？]|怎么|为什么|能不能|会不会/.test(text)) {
    intent = "answer_question";
  } else if (/可爱|好听|喜欢|加油|支持/.test(text)) {
    intent = "warm_acknowledgement";
  }

  const responseBudget = chooseResponseBudget({ item, emotion, intent, context });
  return {
    intent,
    priority,
    responseBudget,
    relationshipTone: relationship.boundaryPressure > 0.6 || relationship.affinity < -0.25 ? "brief-boundary" : relationship.trust > 0.65 ? "familiar-warm" : "warm-polite",
    shouldRead: true,
    capability: context.capabilityRequest ? { id: context.capabilityRequest.id, status: context.capabilityRequest.status } : null,
    instruction: instructionFor(intent),
    actionTendency: emotion.actionTendencies?.primary || "regulate",
    reason: `${intent}; ${relationship.level}; ${emotion.name}`
  };
}

// The director, not the model, decides when a reply deserves more room. This
// keeps short live-chat rhythm while letting a real question or grounded memory
// become a small conversation instead of a one-line acknowledgement.
function chooseResponseBudget({ item, emotion, intent, context }) {
  const text = String(item.text || "");
  const recalledFacts = Math.max(Number(context.retrieval?.selectedFacts || 0), Number(context.memoryLookup?.count || 0));
  const asksForMemory = /记得|上次|以前|我们曾经|关于我|我的偏好/.test(text);
  const openQuestion = /(?:为什么|怎么看|怎么做|如何|聊聊|说说|分析|介绍|建议|计划|有什么想法|你觉得)/.test(text);
  const explicitlyInvitesElaboration = /(?:详细|展开|具体|多说一点|慢慢讲)/.test(text);
  const mustStayBrief = item.type === "proactive"
    || ["topic_closure", "respect_space", "gentle_boundary", "capability_boundary"].includes(intent)
    || Number(item.repeatCount || 0) > 0
    || Number(emotion.repetition?.pressure || 0) >= Number(emotion.repetition?.threshold || 1);

  if (mustStayBrief) return { mode: "brief", maxSentences: 1, maxCharacters: 56, reason: "直播节奏、边界或复读场景" };
  if (explicitlyInvitesElaboration || (openQuestion && recalledFacts > 0)) {
    return { mode: "deep", maxSentences: 4, maxCharacters: 260, reason: explicitlyInvitesElaboration ? "观众明确希望展开" : "开放问题命中可靠记忆" };
  }
  if (openQuestion || (asksForMemory && recalledFacts > 0) || recalledFacts >= 2) {
    return { mode: "expanded", maxSentences: 3, maxCharacters: 180, reason: openQuestion ? "开放式问题" : "可靠记忆可自然延展" };
  }
  const sentences = emotion.performance?.replySentences || 2;
  return { mode: "normal", maxSentences: sentences, maxCharacters: sentences === 1 ? 56 : 108, reason: "普通直播互动" };
}

function instructionFor(intent) {
  return ({
    topic_closure: "只自然收束当前话题，不立刻开启新话题，不追问",
    emotional_support: "先接住感受，少量追问，未经请求不要连续给建议，也不要夸大陪伴承诺",
    gentle_boundary: "简短指出边界，不反击、不说教",
    respect_space: "确认收到并停止追问，不另起话题",
    capability_boundary: "诚实说明限制，并只提供确实可行的相邻方案",
    answer_question: "先直接回答，再在必要时补一个澄清问题",
    proactive_chat: "只说一个轻量话题，不索取回应"
  })[intent] || "延续当前语境，避免重新寒暄和模板化复述";
}

module.exports = { directReply, instructionFor, chooseResponseBudget };
