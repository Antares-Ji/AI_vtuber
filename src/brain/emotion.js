const EMOTIONS = ["neutral", "happy", "shy", "annoyed", "focused", "excited", "concerned", "sad", "grateful", "proud", "playful", "relieved", "curious", "nostalgic", "surprised", "lonely", "hopeful", "disappointed", "embarrassed", "protective", "admiring", "wary"];
const { AFFECT_GROUPS, AFFECT_DIMENSIONS, createAffectVector, updateAffectVector, deriveActionTendencies } = require("./affect-schema");
const { BRAIN_THRESHOLDS } = require("./thresholds");

const EVENT_RULES = [
  { id: "praise", pattern: /(?:你|主播).{0,8}(?:可爱|好听|厉害)|声音.{0,5}好听|我喜欢(?:你|主播)|支持你|给你加油|辛苦了/, emotion: "happy", score: 0.22, valence: 0.18, arousal: 0.08, social: 0.12, safety: 0.08, reason: "收到善意支持" },
  { id: "technical-feedback", pattern: /(?:声音|语音).{0,8}(?:不清晰|难听|刺耳|噪音|卡顿|坏了|乱了|重复|循环)/, emotion: "focused", score: 0.27, valence: -0.08, arousal: 0.04, focus: 0.24, reason: "收到需要处理的技术反馈" },
  { id: "compliment", pattern: /(?:你的)?声音.{0,6}(?:好听|可爱|温柔)|你.{0,5}(?:脸红|害羞).{0,5}(?:好可爱|可爱)|想看你(?:脸红|害羞)|挥手.{0,4}(?:好可爱|很可爱)/, emotion: "shy", score: 0.26, valence: 0.1, arousal: 0.06, social: -0.08, shyness: 0.22, reason: "收到贴近的夸奖" },
  { id: "game", pattern: /osu|打图|miss|acc|谱面|HR|Hard Rock|DT|Double Time|音乐游戏|结算/i, emotion: "focused", score: 0.24, focus: 0.28, arousal: 0.05, energy: -0.02, reason: "进入游戏分析话题" },
  { id: "arrival", pattern: /开播|来了|第一次|好多|紧张|激动/, emotion: "excited", score: 0.19, valence: 0.08, arousal: 0.2, social: 0.06, energy: 0.08, reason: "直播气氛升温" },
  { id: "vulnerability", pattern: /难过|焦虑|害怕|压力|失眠|不开心|撑不住/, emotion: "concerned", score: 0.25, valence: -0.06, arousal: -0.04, focus: 0.18, social: 0.16, safety: 0.05, reason: "察觉对方需要被认真接住" },
  { id: "success", pattern: /成功|满连|FC|终于过了|做到了|完成了/i, emotion: "proud", score: 0.28, valence: 0.2, arousal: 0.13, energy: 0.1, reason: "共同见证进展" },
  { id: "failure", pattern: /失败|又没过|崩了|搞砸|失误太多/, emotion: "sad", score: 0.19, valence: -0.15, arousal: -0.04, focus: 0.1, reason: "察觉挫折" },
  { id: "apology", pattern: /对不起|抱歉|不好意思/, emotion: "relieved", score: 0.16, valence: 0.06, arousal: -0.08, social: 0.1, safety: 0.1, reason: "关系出现修复信号" },
  { id: "play", pattern: /哈哈|笑死|开玩笑|逗你|有意思/, emotion: "playful", score: 0.2, valence: 0.13, arousal: 0.1, social: 0.08, reason: "轻松玩笑" },
  { id: "reunion", pattern: /好久不见|又来看你|我回来了|还记得我吗/, emotion: "grateful", score: 0.24, valence: 0.18, arousal: 0.08, social: 0.2, reason: "熟悉的人再次出现" },
  { id: "farewell", pattern: /我要走了|先下了|下次见|晚安|回头见/, emotion: "sad", score: 0.12, valence: -0.06, arousal: -0.08, social: 0.08, reason: "一段陪伴暂时告别" },
  { id: "nostalgia", pattern: /怀念|想起以前|小时候|曾经|那时候/, emotion: "nostalgic", score: 0.18, valence: 0.03, arousal: -0.08, social: 0.08, reason: "触及带有时间感的回忆" },
  { id: "injustice", pattern: /不公平|被冤枉|凭什么|太过分了/, emotion: "protective", score: 0.23, valence: -0.12, arousal: 0.1, focus: 0.12, reason: "察觉不公与受伤" },
  { id: "uncertainty", pattern: /我不知道怎么办|很迷茫|拿不准|没想明白/, emotion: "concerned", score: 0.17, valence: -0.05, arousal: -0.03, focus: 0.13, reason: "察觉犹豫与不确定" },
  { id: "surprise", pattern: /没想到|居然|真的假的|太突然了|震惊/, emotion: "surprised", score: 0.22, valence: 0.02, arousal: 0.2, energy: 0.08, reason: "出现意外信息" },
  { id: "embarrassment", pattern: /尴尬|社死|丢脸|不好意思死了/, emotion: "embarrassed", score: 0.18, valence: -0.06, arousal: 0.08, shyness: 0.13, reason: "察觉难为情" },
  { id: "loneliness", pattern: /没人理我|只有我一个人|好孤单|很孤独/, emotion: "lonely", score: 0.2, valence: -0.14, arousal: -0.08, social: 0.12, reason: "察觉孤独感" },
  { id: "hope", pattern: /希望|期待|一定会变好|等着那一天/, emotion: "hopeful", score: 0.2, valence: 0.12, arousal: 0.06, energy: 0.06, reason: "出现面向未来的期待" },
  { id: "disappointment", pattern: /太失望了|白期待了|结果还是|落空了/, emotion: "disappointed", score: 0.2, valence: -0.16, arousal: -0.04, reason: "期待没有实现" },
  { id: "fatigue", pattern: /我好累|累死了|困死了|没力气了/, emotion: "concerned", score: 0.18, valence: -0.05, arousal: -0.12, energy: -0.08, reason: "察觉疲惫" },
  { id: "curiosity", pattern: /你觉得|有没有想过|如果.*会怎样|为什么会这样/, emotion: "curious", score: 0.14, valence: 0.04, arousal: 0.05, focus: 0.1, reason: "问题引发探索兴趣" },
  { id: "threat", pattern: /威胁|恐吓|跟踪|曝光你|弄死你|让你消失/, emotion: "wary", score: 0.34, valence: -0.2, arousal: 0.18, social: -0.2, safety: -0.28, reason: "察觉威胁信号" },
  { id: "aversion", pattern: /太恶心了|令人作呕|非常反感/, emotion: "annoyed", score: 0.2, valence: -0.16, arousal: 0.06, social: -0.08, reason: "察觉强烈反感" },
  { id: "admiration", pattern: /(?:佩服|敬佩)|(?:这个|那位).{0,10}(?:P主|作者|画师|创作者).{0,8}(?:厉害|了不起)/i, emotion: "admiring", score: 0.22, valence: 0.14, arousal: 0.05, social: 0.12, reason: "对创作与努力产生钦佩" },
  { id: "betrayal", pattern: /骗了我|欺骗我|背叛|失信|说话不算数/, emotion: "disappointed", score: 0.25, valence: -0.2, arousal: 0.08, social: -0.16, reason: "察觉信任受损" },
  { id: "space-request", pattern: /别问了|不想说|给我点空间|让我静一静|先别打扰/, emotion: "relieved", score: 0.13, valence: -0.02, arousal: -0.1, social: -0.08, reason: "对方明确需要空间" },
  { id: "hostile", pattern: /笨|菜|垃圾|闭嘴|吵死|皱眉|不满/, emotion: "annoyed", score: 0.28, valence: -0.18, arousal: 0.12, social: -0.15, irritation: 0.26, safety: -0.18, reason: "遇到不友善表达" }
];

function createEmotionState(now = new Date().toISOString()) {
  return normalizeEmotion({
    name: "neutral",
    intensity: 0.18,
    updatedAt: now,
    dimensions: { valence: 0, arousal: 0.18, focus: 0.12, social: 0.2, irritation: 0, shyness: 0.08, energy: 0.72, safety: 0.65 },
    affect: createAffectVector(),
    scores: { happy: 0, shy: 0, annoyed: 0, focused: 0, excited: 0 },
    mood: { valence: 0.08, arousal: 0.16, social: 0.22, updatedAt: now },
    appraisal: { novelty: 0, goalCongruence: 0, control: 0.55, certainty: 0.5, socialNorm: 0.6, at: now },
    regulation: { strategy: "maintain", reason: "状态稳定", updatedAt: now },
    socialPerception: { userEmotion: "unknown", need: "unknown", act: "statement", confidence: 0, source: "none", updatedAt: now },
    trajectory: [],
    dynamics: { sampleCount: 0, meanValence: 0, variability: 0, instability: 0, inertia: 0, differentiation: 0 },
    causes: [],
    repetition: { pressure: 0, threshold: BRAIN_THRESHOLDS.emotion.repetitionBoundary, lastRepeatCount: 0 }
  });
}

function decayEmotion(state, now = new Date().toISOString()) {
  const previousAt = Date.parse(state.updatedAt || now);
  const elapsedMinutes = Math.max(0, (Date.parse(now) - previousAt) / 60_000);
  const interactionDecay = elapsedMinutes < 0.02 ? 0.88 : Math.pow(0.72, Math.min(elapsedMinutes, 20));
  const scores = {};
  for (const [name, score] of Object.entries(state.scores || {})) scores[name] = round(score * interactionDecay);
  const dimensions = {};
  for (const [name, value] of Object.entries(state.dimensions || {})) {
    const baseline = baselineFor(name);
    dimensions[name] = round(baseline + (value - baseline) * interactionDecay);
  }
  const repetition = state.repetition || {};
  const moodDecay = Math.pow(0.96, Math.min(elapsedMinutes, 120));
  const mood = {
    valence: round(0.08 + ((state.mood?.valence ?? 0.08) - 0.08) * moodDecay),
    arousal: round(0.16 + ((state.mood?.arousal ?? 0.16) - 0.16) * moodDecay),
    social: round(0.22 + ((state.mood?.social ?? 0.22) - 0.22) * moodDecay),
    updatedAt: now
  };
  return normalizeEmotion({
    ...state,
    updatedAt: now,
    scores,
    dimensions,
    mood,
    causes: (state.causes || []).filter(cause => Date.parse(now) - Date.parse(cause.at) < 15 * 60_000).slice(-8),
    repetition: { pressure: round(Math.max(0, (repetition.pressure || 0) * interactionDecay)), threshold: repetition.threshold || 0.42, lastRepeatCount: 0 }
  });
}

function previewEmotion(state, now = new Date().toISOString()) {
  const elapsed = Date.parse(now) - Date.parse(state.updatedAt || now);
  if (!Number.isFinite(elapsed) || elapsed < 1_200) return state;
  return decayEmotion(state, now);
}

function updateEmotion(state, text, type = "chat", now = new Date().toISOString(), context = {}) {
  const next = decayEmotion(state, now);
  const matched = EVENT_RULES.filter(rule => rule.pattern.test(text));
  if (isNamedPraise(text, context.persona)) {
    matched.push({ id: "praise", emotion: "happy", score: 0.22, valence: 0.18, arousal: 0.08, social: 0.12, safety: 0.08, reason: "收到带有角色称呼的善意支持" });
  }
  const rules = type === "gift" || type === "superchat" || type === "guard"
    ? [{ id: "support-event", emotion: "grateful", score: 0.34, valence: 0.24, arousal: 0.14, social: 0.14, reason: "收到直播间支持" }, ...matched]
    : matched;
  next.socialPerception = inferSocialPerception(text, rules, type, now);
  const rule = [...rules].sort((a, b) => b.score - a.score)[0] || null;
  const relationship = context.relationship || {};
  const personality = context.personality || {};
  const appraisal = appraiseEvent(text, rule, type, relationship, now);
  next.appraisal = appraisal;
  if (!rules.length) {
    next.affect = updateAffectVector(next.affect, { appraisal, relationship });
    next.regulation = regulationFor(next, appraisal, now);
    next.trajectory = appendTrajectory(next.trajectory, { at: now, events: [], appraisal, emotions: [], affect: affectSnapshot(next.affect) });
    return normalizeEmotion(next);
  }

  let moodValence = 0, moodArousal = 0, moodSocial = 0;
  const personalityInfluence = [];
  for (const event of rules) {
    const socialBuffer = event.id === "hostile" ? 1 - Math.min(0.25, Number(relationship.trust || 0) * 0.2) : 1;
    const traitScale = personalityScale(event.id, personality);
    const eventScale = socialBuffer * traitScale;
    next.scores[event.emotion] = clamp((next.scores[event.emotion] || 0) + event.score * eventScale, 0, 1);
    for (const key of ["valence", "arousal", "focus", "social", "irritation", "shyness", "energy", "safety"]) {
      if (event[key] !== undefined) next.dimensions[key] = clamp((next.dimensions[key] || 0) + event[key] * eventScale, -1, 1);
    }
    next.affect = updateAffectVector(next.affect, { rule: event, appraisal, relationship, reactivity: traitScale });
    next.causes.push({ id: event.id, reason: event.reason, at: now, emotion: event.emotion });
    personalityInfluence.push({ event: event.id, scale: round(traitScale), traits: influencingTraits(event.id) });
    moodValence += (event.valence || 0) * traitScale; moodArousal += (event.arousal || 0) * traitScale; moodSocial += (event.social || 0) * traitScale;
  }
  next.mood = {
    valence: round(clamp((next.mood?.valence ?? 0.08) + moodValence * 0.1, -1, 1)),
    arousal: round(clamp((next.mood?.arousal ?? 0.16) + moodArousal * 0.08, -1, 1)),
    social: round(clamp((next.mood?.social ?? 0.22) + moodSocial * 0.08, -1, 1)),
    updatedAt: now
  };
  next.regulation = regulationFor(next, appraisal, now);
  next.personalityInfluence = personalityInfluence;
  next.trajectory = appendTrajectory(next.trajectory, { at: now, events: rules.map(event => event.id), appraisal, emotions: rules.map(event => event.emotion), affect: affectSnapshot(next.affect) });
  return normalizeEmotion(next);
}

function isNamedPraise(text, persona) {
  const names = [persona?.displayName, persona?.name, ...(persona?.aliases || [])]
    .map(name => String(name || "").trim())
    .filter(name => name.length >= 2);
  if (!names.some(name => String(text).includes(name))) return false;
  return /可爱|好听|厉害|喜欢|支持|加油|辛苦/.test(String(text));
}

function applyRepetition(state, repeatCount = 0, now = new Date().toISOString()) {
  const next = decayEmotion(state, now);
  next.repetition.lastRepeatCount = repeatCount;
  next.affect = updateAffectVector(next.affect, { appraisal: next.appraisal, repeatCount });
  if (repeatCount <= 0) return normalizeEmotion(next);
  const increase = Math.min(0.3, 0.06 + repeatCount * 0.08);
  next.repetition.pressure = clamp(Math.max(next.repetition.pressure + increase, Math.min(0.72, repeatCount * 0.12)), 0, 1);
  next.dimensions.irritation = clamp(next.dimensions.irritation + increase * 0.8, 0, 1);
  next.dimensions.social = clamp(next.dimensions.social - increase * 0.35, -1, 1);
  next.dimensions.safety = clamp(next.dimensions.safety - increase * 0.2, 0, 1);
  if (next.repetition.pressure >= next.repetition.threshold) {
    const annoyedDelta = 0.1 + (next.repetition.pressure - next.repetition.threshold) * 0.55;
    next.scores.annoyed = clamp((next.scores.annoyed || 0) + annoyedDelta, 0, 1);
    next.causes.push({ id: "repetition", reason: "同类弹幕持续重复", at: now, emotion: "annoyed" });
  }
  next.appraisal = { novelty: 0.1, goalCongruence: -0.45, control: 0.62, certainty: 0.92, socialNorm: -0.5, at: now };
  next.regulation = regulationFor(next, next.appraisal, now);
  next.trajectory = appendTrajectory(next.trajectory, { at: now, events: ["repetition"], appraisal: next.appraisal, emotions: ["annoyed"], affect: affectSnapshot(next.affect) });
  return normalizeEmotion(next);
}

function getPerformanceProfile(state) {
  const profile = {
    neutral: { expression: "neutral", motion: "idle", speechRate: 1, pitch: 0, pauseMs: 180, replySentences: 2 },
    happy: { expression: "happy", motion: "smile", speechRate: 1.04, pitch: 0.06, pauseMs: 120, replySentences: 2 },
    shy: { expression: "shy", motion: "soft-look-away", speechRate: 0.96, pitch: 0.04, pauseMs: 250, replySentences: 1 },
    annoyed: { expression: "annoyed", motion: "small-sigh", speechRate: 0.94, pitch: -0.03, pauseMs: 280, replySentences: 1 },
    focused: { expression: "focused", motion: "attention", speechRate: 0.98, pitch: 0, pauseMs: 150, replySentences: 2 },
    excited: { expression: "excited", motion: "bright", speechRate: 1.07, pitch: 0.08, pauseMs: 90, replySentences: 2 }
    ,concerned: { expression: "concerned", motion: "gentle-attention", speechRate: 0.92, pitch: -0.02, pauseMs: 300, replySentences: 2 }
    ,sad: { expression: "sad", motion: "soft-down", speechRate: 0.9, pitch: -0.04, pauseMs: 340, replySentences: 1 }
    ,grateful: { expression: "happy", motion: "grateful", speechRate: 0.98, pitch: 0.04, pauseMs: 180, replySentences: 2 }
    ,proud: { expression: "excited", motion: "proud", speechRate: 1.04, pitch: 0.05, pauseMs: 120, replySentences: 2 }
    ,playful: { expression: "happy", motion: "playful", speechRate: 1.06, pitch: 0.06, pauseMs: 100, replySentences: 2 }
    ,relieved: { expression: "happy", motion: "relieved", speechRate: 0.96, pitch: 0.01, pauseMs: 230, replySentences: 2 }
    ,curious: { expression: "focused", motion: "attention", speechRate: 1.01, pitch: 0.02, pauseMs: 160, replySentences: 2 }
    ,nostalgic: { expression: "neutral", motion: "soft-look-away", speechRate: 0.92, pitch: -0.02, pauseMs: 300, replySentences: 2 }
    ,surprised: { expression: "excited", motion: "bright", speechRate: 1.05, pitch: 0.07, pauseMs: 100, replySentences: 1 }
    ,lonely: { expression: "sad", motion: "soft-down", speechRate: 0.9, pitch: -0.04, pauseMs: 330, replySentences: 1 }
    ,hopeful: { expression: "happy", motion: "gentle-attention", speechRate: 0.99, pitch: 0.03, pauseMs: 190, replySentences: 2 }
    ,disappointed: { expression: "sad", motion: "small-sigh", speechRate: 0.91, pitch: -0.04, pauseMs: 320, replySentences: 1 }
    ,embarrassed: { expression: "shy", motion: "soft-look-away", speechRate: 0.94, pitch: 0.03, pauseMs: 290, replySentences: 1 }
    ,protective: { expression: "focused", motion: "attention", speechRate: 0.96, pitch: -0.01, pauseMs: 210, replySentences: 2 }
    ,admiring: { expression: "happy", motion: "gentle-attention", speechRate: 0.98, pitch: 0.02, pauseMs: 190, replySentences: 2 }
    ,wary: { expression: "annoyed", motion: "attention", speechRate: 0.9, pitch: -0.04, pauseMs: 340, replySentences: 1 }
  }[state.name] || { expression: "neutral", motion: "idle", speechRate: 1, pitch: 0, pauseMs: 180, replySentences: 2 };
  const energy = state.dimensions.energy ?? 0.72;
  const shyness = state.dimensions.shyness ?? 0.08;
  const safety = state.dimensions.safety ?? 0.65;
  return {
    ...profile,
    speechRate: round(clamp(profile.speechRate * (0.92 + energy * 0.1) * (shyness > 0.45 ? 0.96 : 1), 0.85, 1.15)),
    pitch: round(profile.pitch + (shyness > 0.42 ? 0.025 : 0) - (safety < 0.32 ? 0.02 : 0)),
    pauseMs: Math.round(profile.pauseMs + (shyness > 0.42 ? 70 : 0) + (safety < 0.32 ? 80 : 0)),
    intensity: state.intensity,
    arousal: state.dimensions.arousal,
    energy,
    shyness,
    safety,
    moodValence: state.mood?.valence ?? 0.08,
    valence: state.affect?.valence ?? state.dimensions.valence ?? 0,
    dominance: state.affect?.dominance ?? 0,
    tension: state.affect?.tension ?? 0,
    expressibility: state.affect?.expressibility ?? 0.5,
    regulation: state.regulation?.strategy || "maintain"
  };
}

function normalizeEmotion(state) {
  state.affect = { ...createAffectVector(), ...(state.affect || {}) };
  let topName = "neutral";
  let topScore = 0;
  for (const [name, score] of Object.entries(state.scores || {})) {
    if (score > topScore) { topName = name; topScore = score; }
  }
  const irritation = state.dimensions?.irritation || 0;
  if (irritation >= 0.42 && (state.repetition?.pressure || 0) >= state.repetition?.threshold) {
    topName = "annoyed";
    topScore = Math.max(topScore, irritation);
  }
  const name = topScore < 0.08 ? "neutral" : (EMOTIONS.includes(topName) ? topName : "neutral");
  const intensity = name === "neutral" ? 0.18 : round(clamp(Math.max(topScore, Math.abs(state.dimensions?.valence || 0) * 0.65), 0.12, 1));
  const next = { ...state, name, intensity, dynamics: summarizeAffectDynamics(state.trajectory || []) };
  next.actionTendencies = deriveActionTendencies(next.affect);
  next.performance = getPerformanceProfile({ ...next, performance: undefined });
  return next;
}

function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function round(value) { return Number(value.toFixed(3)); }

function personalityScale(eventId, personality) {
  const value = (name, fallback = 0.5) => Number.isFinite(Number(personality[name])) ? Number(personality[name]) : fallback;
  if (["praise", "compliment", "support-event", "admiration"].includes(eventId)) return clamp(0.72 + value("warmth") * 0.16 + value("gratitude") * 0.2, 0.7, 1.12);
  if (eventId === "vulnerability") return clamp(0.7 + value("empathy") * 0.2 + value("care") * 0.2, 0.72, 1.12);
  if (["hostile", "threat", "aversion", "betrayal"].includes(eventId)) return clamp(0.78 + value("sensitivity") * 0.28 - value("emotionalStability") * 0.2 + value("boundaryStrength") * 0.08, 0.62, 1.1);
  if (eventId === "space-request") return clamp(0.78 + value("empathy") * 0.12 + value("boundaryStrength") * 0.16, 0.75, 1.08);
  if (["game", "success", "failure"].includes(eventId)) return clamp(0.78 + value("conscientiousness") * 0.16 + value("curiosity") * 0.14, 0.75, 1.08);
  if (eventId === "play") return clamp(0.75 + value("playfulness") * 0.3, 0.75, 1.08);
  return clamp(0.82 + value("sensitivity") * 0.18, 0.8, 1.05);
}

function influencingTraits(eventId) {
  if (["praise", "compliment", "support-event", "admiration"].includes(eventId)) return ["warmth", "gratitude"];
  if (eventId === "vulnerability") return ["empathy", "care"];
  if (["hostile", "threat", "aversion", "betrayal"].includes(eventId)) return ["sensitivity", "emotionalStability", "boundaryStrength"];
  if (eventId === "space-request") return ["empathy", "boundaryStrength"];
  if (["game", "success", "failure"].includes(eventId)) return ["conscientiousness", "curiosity"];
  if (eventId === "play") return ["playfulness"];
  return ["sensitivity"];
}

function appendTrajectory(trajectory, entry) { return [...(trajectory || []), entry].slice(-48); }

function affectSnapshot(affect) {
  return Object.fromEntries(["valence", "arousal", ...AFFECT_GROUPS.emotion].map(key => [key, Number(affect[key] || 0)]));
}

function summarizeAffectDynamics(trajectory) {
  const samples = trajectory.map(item => item.affect).filter(Boolean).slice(-24);
  if (!samples.length) return { sampleCount: 0, meanValence: 0, variability: 0, instability: 0, inertia: 0, differentiation: 0 };
  const valences = samples.map(item => item.valence);
  const meanValence = mean(valences);
  const variability = Math.sqrt(mean(valences.map(value => (value - meanValence) ** 2)));
  const instability = samples.length < 2 ? 0 : mean(samples.slice(1).map((item, index) => {
    const previous = samples[index];
    return ((item.valence - previous.valence) ** 2 + (item.arousal - previous.arousal) ** 2) / 2;
  }));
  const inertia = lagCorrelation(valences);
  const emotionKeys = AFFECT_GROUPS.emotion;
  const differentiation = mean(samples.map(item => {
    const ranked = emotionKeys.map(key => Math.max(0, item[key] || 0)).sort((a, b) => b - a);
    return ranked[0] <= 0.02 ? 0 : (ranked[0] - ranked[1]) / Math.max(0.01, ranked[0]);
  }));
  return { sampleCount: samples.length, meanValence: round(meanValence), variability: round(variability), instability: round(instability), inertia: round(inertia), differentiation: round(differentiation) };
}

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0; }
function lagCorrelation(values) {
  if (values.length < 3) return 0;
  const left = values.slice(0, -1), right = values.slice(1), leftMean = mean(left), rightMean = mean(right);
  const numerator = left.reduce((sum, value, index) => sum + (value - leftMean) * (right[index] - rightMean), 0);
  const denominator = Math.sqrt(left.reduce((sum, value) => sum + (value - leftMean) ** 2, 0) * right.reduce((sum, value) => sum + (value - rightMean) ** 2, 0));
  return denominator < 1e-9 ? 0 : clamp(numerator / denominator, -1, 1);
}
function baselineFor(name) {
  return ({ arousal: 0.18, focus: 0.12, social: 0.2, shyness: 0.08, energy: 0.72, safety: 0.65 })[name] ?? 0;
}

function appraiseEvent(text, rule, type, relationship, at) {
  const source = String(text || "");
  const hostile = ["hostile", "threat", "aversion", "betrayal"].includes(rule?.id);
  const supportive = ["praise", "compliment", "support-event", "apology", "admiration"].includes(rule?.id);
  const asksQuestion = /[?？]|为什么|怎么|能不能|可以吗/.test(source);
  const achievement = ["game", "success", "failure"].includes(rule?.id);
  const knownPattern = Boolean(rule) || type === "proactive";
  return {
    novelty: round(clamp(/[?？]|第一次|突然|居然/.test(source) ? 0.72 : rule ? 0.42 : 0.18, 0, 1)),
    pleasantness: round(clamp(rule?.valence ?? (supportive ? 0.4 : hostile ? -0.65 : 0), -1, 1)),
    goalRelevance: round(clamp(achievement || supportive || hostile ? 0.8 : asksQuestion ? 0.58 : 0.32, 0, 1)),
    goalCongruence: round(clamp(rule?.valence ?? (type === "proactive" ? 0.08 : 0), -1, 1)),
    certainty: round(clamp(rule?.id === "uncertainty" ? 0.28 : knownPattern ? 0.82 : asksQuestion ? 0.58 : 0.46, 0, 1)),
    agencySelf: round(clamp(/我(?:做|唱|说|答应|忘)/.test(source) ? 0.66 : 0.18, 0, 1)),
    agencyOther: round(clamp(type === "proactive" ? 0.1 : hostile || supportive || achievement ? 0.78 : 0.45, 0, 1)),
    control: round(clamp(hostile ? 0.38 : type === "gift" ? 0.78 : 0.6, 0, 1)),
    copingPotential: round(clamp(hostile ? 0.56 : rule?.id === "vulnerability" ? 0.64 : 0.7, 0, 1)),
    socialNorm: round(clamp(hostile ? -0.72 : /谢谢|支持|喜欢/.test(source) ? 0.72 : Number(relationship.comfort || 0.35) * 0.4, -1, 1)),
    fairness: round(clamp(hostile ? -0.58 : supportive ? 0.62 : 0.18, -1, 1)),
    predictability: round(clamp(knownPattern ? 0.7 : 0.42, 0, 1)),
    at
  };
}

function regulationFor(state, appraisal, at) {
  if ((state.dimensions?.irritation || 0) > BRAIN_THRESHOLDS.emotion.irritationRegulation) return { strategy: "down-regulate", reason: "降低刺激并缩短回应", updatedAt: at };
  if ((state.dimensions?.safety || 0.65) < BRAIN_THRESHOLDS.emotion.lowSafetyBoundary) return { strategy: "boundary", reason: "优先恢复安全感和边界", updatedAt: at };
  if (appraisal.goalCongruence < -0.2 && appraisal.control > 0.5) return { strategy: "reappraise", reason: "把负面刺激重新解释为可处理事件", updatedAt: at };
  if ((state.dimensions?.arousal || 0) > 0.7) return { strategy: "settle", reason: "降低唤醒，避免表达过冲", updatedAt: at };
  return { strategy: "maintain", reason: "维持当前表达强度", updatedAt: at };
}

function applySocialPerception(state, perception, now = new Date().toISOString()) {
  if (!perception || Number(perception.confidence || 0) < BRAIN_THRESHOLDS.emotion.socialPerceptionConfidence) return normalizeEmotion(state);
  const next = normalizeEmotion({ ...state, affect: { ...state.affect } });
  next.socialPerception = { ...perception, source: "llm-structured", updatedAt: now };
  if (["sad", "anxious", "afraid", "tired", "frustrated"].includes(perception.userEmotion)) {
    next.affect.empathy = round(clamp(next.affect.empathy + 0.06 * perception.confidence, -1, 1));
    next.affect.careDrive = round(clamp(next.affect.careDrive + 0.05 * perception.confidence, -1, 1));
    next.affect.playfulness = round(clamp(next.affect.playfulness - 0.05 * perception.confidence, -1, 1));
  }
  return normalizeEmotion(next);
}

function inferSocialPerception(text, rules = [], type = "chat", now = new Date().toISOString()) {
  const source = String(text || "");
  const ids = new Set(rules.map(rule => rule.id));
  let userEmotion = "unknown", need = "unknown", confidence = 0.25;
  if (/(?:焦虑|压力|失眠|撑不住|迷茫)/.test(source)) { userEmotion = "anxious"; need = "support"; confidence = 0.78; }
  else if (/(?:难过|不开心|孤独|失望|落空)/.test(source)) { userEmotion = "sad"; need = "support"; confidence = 0.76; }
  else if (/(?:害怕|恐惧|担心死了)/.test(source)) { userEmotion = "afraid"; need = "support"; confidence = 0.76; }
  else if (ids.has("fatigue") || /(?:好累|困死|没力气)/.test(source)) { userEmotion = "tired"; need = "space"; confidence = 0.74; }
  else if (ids.has("hostile") || ids.has("threat") || ids.has("aversion")) { userEmotion = "angry"; need = "space"; confidence = 0.7; }
  else if (ids.has("success") || ids.has("arrival") || ids.has("surprise")) { userEmotion = "excited"; need = "recognition"; confidence = 0.68; }
  else if (ids.has("praise") || ids.has("play") || ids.has("reunion")) { userEmotion = "happy"; need = "play"; confidence = 0.64; }
  const act = type === "proactive" ? "statement" : /(?:到这里|结束|不聊了|先走了)/.test(source) ? "closure"
    : /[?？]|为什么|怎么|能不能|会不会/.test(source) ? "question" : ids.has("praise") || ids.has("admiration") ? "praise" : ids.has("play") ? "tease" : ids.has("hostile") || ids.has("threat") || ids.has("space-request") ? "boundary" : "statement";
  if (act === "question" && need === "unknown") need = "information";
  return { userEmotion, need, act, confidence, source: "local-heuristic", updatedAt: now };
}

module.exports = { EMOTIONS, AFFECT_DIMENSIONS, createEmotionState, updateEmotion, applyRepetition, decayEmotion, previewEmotion, getPerformanceProfile, appraiseEvent, regulationFor, applySocialPerception, inferSocialPerception, summarizeAffectDynamics };
