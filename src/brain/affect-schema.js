const AFFECT_GROUPS = {
  core: ["valence", "arousal", "dominance", "energy", "focus", "safety", "socialApproach", "tension", "ambivalence", "emotionalInertia", "expressibility"],
  appraisal: ["novelty", "pleasantness", "goalRelevance", "goalCongruence", "certainty", "agencySelf", "agencyOther", "control", "copingPotential", "socialNorm", "fairness", "predictability"],
  emotion: ["joy", "sadness", "anger", "fear", "surprise", "disgust", "trust", "anticipation", "shyness", "pride", "gratitude", "admiration", "hope", "relief", "disappointment", "loneliness"],
  social: ["warmth", "affiliation", "empathy", "compassion", "attachment", "respect", "socialConfidence", "boundaryPressure", "reciprocity", "belonging"],
  motivation: ["curiosity", "playfulness", "persistence", "achievementDrive", "careDrive", "creativeDrive", "restNeed", "avoidance"],
  regulation: ["suppression", "reappraisal", "distancing", "acceptance", "expressionReadiness", "recovery"]
};

const AFFECT_DIMENSIONS = Object.freeze(Object.values(AFFECT_GROUPS).flat());

const AFFECT_LABELS = Object.freeze({
  valence: "愉悦度", arousal: "唤醒度", dominance: "主导感", energy: "精力", focus: "专注", safety: "安全感",
  socialApproach: "社交趋近", tension: "紧张", ambivalence: "矛盾情绪", emotionalInertia: "情绪惯性", expressibility: "可表达性",
  novelty: "新奇度", pleasantness: "事件愉悦", goalRelevance: "目标相关", goalCongruence: "目标一致", certainty: "确定性",
  agencySelf: "自身责任", agencyOther: "他人责任", control: "控制感", copingPotential: "应对潜力", socialNorm: "规范符合", fairness: "公平感", predictability: "可预测性",
  joy: "喜悦", sadness: "悲伤", anger: "愤怒", fear: "恐惧", surprise: "惊讶", disgust: "厌恶", trust: "信任", anticipation: "期待",
  shyness: "羞涩", pride: "自豪", gratitude: "感激", admiration: "钦佩", hope: "希望", relief: "释然", disappointment: "失望", loneliness: "孤独",
  warmth: "温暖", affiliation: "亲和", empathy: "共情", compassion: "关怀", attachment: "依恋", respect: "尊重", socialConfidence: "社交信心",
  boundaryPressure: "边界压力", reciprocity: "互惠感", belonging: "归属感",
  curiosity: "好奇", playfulness: "玩心", persistence: "坚持", achievementDrive: "成就动机", careDrive: "照顾动机", creativeDrive: "创作动机", restNeed: "休息需求", avoidance: "回避倾向",
  suppression: "表达抑制", reappraisal: "重新评价", distancing: "心理距离", acceptance: "接纳", expressionReadiness: "表达准备", recovery: "恢复能力"
});

function createAffectVector() {
  const values = Object.fromEntries(AFFECT_DIMENSIONS.map(name => [name, 0]));
  return { ...values, energy: 0.72, focus: 0.12, safety: 0.65, socialApproach: 0.2, emotionalInertia: 0.58, expressibility: 0.62, control: 0.55, copingPotential: 0.58, certainty: 0.5, socialNorm: 0.6, predictability: 0.5, warmth: 0.52, empathy: 0.48, careDrive: 0.52, curiosity: 0.46, persistence: 0.5, recovery: 0.62, expressionReadiness: 0.5 };
}

function updateAffectVector(previous, { rule = null, appraisal = {}, relationship = {}, repeatCount = 0, reactivity = 1 } = {}) {
  const next = { ...createAffectVector(), ...(previous || {}) };
  for (const name of AFFECT_DIMENSIONS) next[name] = round(baseline(name) + (next[name] - baseline(name)) * 0.9);
  assign(next, appraisal);
  for (const [key, delta] of Object.entries({ valence: rule?.valence, arousal: rule?.arousal, energy: rule?.energy, focus: rule?.focus, safety: rule?.safety, socialApproach: rule?.social })) {
    if (delta !== undefined) next[key] = bump(next[key], delta * reactivity);
  }
  next.warmth = bump(next.warmth, (rule?.social || 0) * 0.7);
  next.trust = bump(next.trust, Number(relationship.trust || 0) * 0.03);
  next.affiliation = bump(next.affiliation, Number(relationship.affinity || 0) * 0.03);
  next.boundaryPressure = bump(next.boundaryPressure, rule?.id === "hostile" ? 0.28 : repeatCount * 0.06);
  next.predictability = bump(next.predictability, repeatCount > 0 ? 0.18 : 0);
  next.novelty = bump(next.novelty, repeatCount > 0 ? -0.25 : 0);
  const eventMap = {
    praise: { joy: 0.2, gratitude: 0.22, trust: 0.08, belonging: 0.1 },
    compliment: { joy: 0.12, shyness: 0.24, gratitude: 0.15, socialConfidence: -0.04 },
    "technical-feedback": { disappointment: 0.1, focus: 0.18, achievementDrive: 0.12, copingPotential: 0.08 },
    game: { curiosity: 0.16, achievementDrive: 0.18, focus: 0.18, anticipation: 0.1 },
    arrival: { surprise: 0.12, joy: 0.12, anticipation: 0.18, socialConfidence: 0.08 },
    vulnerability: { empathy: 0.26, compassion: 0.24, careDrive: 0.24, playfulness: -0.2 },
    hostile: { anger: 0.2, tension: 0.2, safety: -0.18, avoidance: 0.15, expressionReadiness: -0.08 },
    "support-event": { gratitude: 0.3, joy: 0.22, belonging: 0.16, reciprocity: 0.14 }
    ,success: { pride: 0.26, joy: 0.18, achievementDrive: 0.16, hope: 0.12 }
    ,failure: { disappointment: 0.24, sadness: 0.14, persistence: 0.08, hope: -0.05 }
    ,apology: { relief: 0.18, trust: 0.1, tension: -0.12, acceptance: 0.08 }
    ,play: { playfulness: 0.24, joy: 0.12, socialApproach: 0.08 }
    ,reunion: { joy: 0.16, gratitude: 0.18, attachment: 0.12, belonging: 0.16, reciprocity: 0.1 }
    ,farewell: { sadness: 0.1, attachment: 0.08, acceptance: 0.08, socialApproach: -0.04 }
    ,nostalgia: { sadness: 0.06, joy: 0.05, ambivalence: 0.1, attachment: 0.08, arousal: -0.08 }
    ,injustice: { anger: 0.14, compassion: 0.14, careDrive: 0.12, fairness: -0.2, tension: 0.08 }
    ,uncertainty: { empathy: 0.12, careDrive: 0.1, certainty: -0.18, copingPotential: 0.06 }
    ,surprise: { surprise: 0.28, novelty: 0.18, arousal: 0.12, curiosity: 0.08 }
    ,embarrassment: { shyness: 0.18, empathy: 0.1, socialConfidence: -0.1, tension: 0.08 }
    ,loneliness: { loneliness: 0.22, empathy: 0.18, compassion: 0.16, affiliation: 0.1, careDrive: 0.12 }
    ,hope: { hope: 0.24, anticipation: 0.16, persistence: 0.1, valence: 0.08 }
    ,disappointment: { disappointment: 0.24, sadness: 0.12, hope: -0.08, recovery: -0.04 }
    ,fatigue: { empathy: 0.14, compassion: 0.14, restNeed: 0.18, careDrive: 0.12, arousal: -0.08 }
    ,curiosity: { curiosity: 0.2, anticipation: 0.08, focus: 0.08, creativeDrive: 0.06 }
    ,threat: { fear: 0.28, tension: 0.24, avoidance: 0.22, safety: -0.24, suppression: 0.14, distancing: 0.16 }
    ,aversion: { disgust: 0.28, avoidance: 0.16, distancing: 0.12, expressionReadiness: -0.08 }
    ,admiration: { admiration: 0.28, respect: 0.2, warmth: 0.08, creativeDrive: 0.08 }
    ,betrayal: { disappointment: 0.2, trust: -0.2, tension: 0.12, distancing: 0.14, acceptance: -0.08 }
    ,"space-request": { respect: 0.16, distancing: 0.12, suppression: 0.1, acceptance: 0.12, socialApproach: -0.1 }
  };
  assignBumps(next, scaled(eventMap[rule?.id], reactivity));
  if (repeatCount > 0) assignBumps(next, { anger: Math.min(0.24, repeatCount * 0.06), tension: 0.1 });
  next.reappraisal = bump(next.reappraisal, next.boundaryPressure > 0.35 ? 0.16 : 0.02);
  next.acceptance = bump(next.acceptance, next.empathy > 0.55 ? 0.08 : 0.02);
  next.recovery = bump(next.recovery, next.safety > 0.5 ? 0.04 : -0.06);
  const positive = Math.max(next.joy, next.gratitude, next.pride, next.hope, next.relief);
  const negative = Math.max(next.sadness, next.anger, next.fear, next.disappointment);
  next.ambivalence = round(Math.min(Math.max(positive, 0), Math.max(negative, 0)));
  return next;
}

function deriveActionTendencies(affect = {}) {
  const home = createAffectVector();
  const up = name => Math.max(0, Number(affect[name] || 0) - Number(home[name] || 0));
  const down = name => Math.max(0, Number(home[name] || 0) - Number(affect[name] || 0));
  const average = (...values) => values.reduce((sum, value) => sum + value, 0) / values.length;
  const values = {
    support: average(up("empathy"), up("compassion"), up("careDrive"), up("warmth")) * 2,
    explore: average(up("curiosity"), up("novelty"), up("creativeDrive"), up("focus")) * 1.7,
    approach: average(up("socialApproach"), up("affiliation"), up("trust"), up("belonging")) * 2,
    celebrate: average(up("joy"), up("pride"), up("gratitude"), up("expressionReadiness")) * 2,
    persist: average(up("persistence"), up("achievementDrive"), up("hope"), up("copingPotential")) * 2,
    protectBoundary: average(up("boundaryPressure"), up("anger"), up("tension"), down("safety")) * 2,
    withdraw: average(up("avoidance"), up("distancing"), up("fear"), up("restNeed")) * 2,
    regulate: 0.04 + average(up("reappraisal"), up("suppression"), up("acceptance"), up("recovery")) * 1.5
  };
  const ranked = Object.entries(values)
    .map(([name, score]) => ({ name, score: round(clamp(score, 0, 1)) }))
    .sort((a, b) => b.score - a.score);
  return { primary: ranked[0]?.name || "regulate", ranked };
}

function assign(target, source) { for (const [key, value] of Object.entries(source || {})) if (key in target && typeof value === "number") target[key] = round(clamp(value, -1, 1)); }
function assignBumps(target, source) { for (const [key, value] of Object.entries(source || {})) if (key in target) target[key] = bump(target[key], value); }
function scaled(source, factor) { return Object.fromEntries(Object.entries(source || {}).map(([key, value]) => [key, value * factor])); }
function bump(value, delta) { return round(clamp(Number(value || 0) + Number(delta || 0), -1, 1)); }
function baseline(name) { return createAffectVector()[name] || 0; }
function clamp(value, min, max) { return Math.min(max, Math.max(min, value)); }
function round(value) { return Number(value.toFixed(3)); }

module.exports = { AFFECT_GROUPS, AFFECT_DIMENSIONS, AFFECT_LABELS, createAffectVector, updateAffectVector, deriveActionTendencies };
