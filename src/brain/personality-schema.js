const PERSONALITY_GROUPS = {
  bigFive: ["openness", "conscientiousness", "extraversion", "agreeableness", "emotionalStability"],
  temperament: ["warmth", "curiosity", "playfulness", "assertiveness", "patience", "sensitivity", "vulnerability", "resilience"],
  socialStyle: ["empathy", "reciprocity", "independence", "boundaryStrength", "conflictAvoidance", "socialInitiative", "trustRate"],
  values: ["honesty", "fairness", "growth", "creativity", "gratitude", "autonomy", "care", "coCreation"],
  expression: ["humor", "formality", "directness", "enthusiasm", "selfDisclosure", "reflectiveness"]
};

const PERSONALITY_DIMENSIONS = Object.freeze(Object.values(PERSONALITY_GROUPS).flat());

const PERSONALITY_LABELS = Object.freeze({
  openness: "开放性", conscientiousness: "尽责性", extraversion: "外向性", agreeableness: "宜人性", emotionalStability: "情绪稳定",
  warmth: "温暖", curiosity: "好奇", playfulness: "玩心", assertiveness: "坚定", patience: "耐心", sensitivity: "敏感", vulnerability: "脆弱开放", resilience: "韧性",
  empathy: "共情", reciprocity: "互惠", independence: "独立", boundaryStrength: "边界强度", conflictAvoidance: "冲突回避", socialInitiative: "社交主动", trustRate: "信任速度",
  honesty: "诚实", fairness: "公平", growth: "成长", creativity: "创造", gratitude: "感恩", autonomy: "自主", care: "关怀", coCreation: "共创",
  humor: "幽默", formality: "正式度", directness: "直接度", enthusiasm: "热情", selfDisclosure: "自我披露", reflectiveness: "反思倾向"
});

function createPersonalityProfile(persona = {}) {
  const profile = {
    openness: 0.82, conscientiousness: 0.74, extraversion: 0.58, agreeableness: 0.82, emotionalStability: 0.66,
    warmth: 0.82, curiosity: 0.76, playfulness: 0.58, assertiveness: 0.44, patience: 0.76, sensitivity: 0.7, vulnerability: 0.46, resilience: 0.72,
    empathy: 0.8, reciprocity: 0.76, independence: 0.7, boundaryStrength: 0.68, conflictAvoidance: 0.64, socialInitiative: 0.62, trustRate: 0.42,
    honesty: 0.92, fairness: 0.78, growth: 0.84, creativity: 0.88, gratitude: 0.9, autonomy: 0.76, care: 0.86, coCreation: 0.9,
    humor: 0.56, formality: 0.28, directness: 0.58, enthusiasm: 0.68, selfDisclosure: 0.42, reflectiveness: 0.7
  };
  for (const [key, value] of Object.entries(persona.traitWeights || {})) if (key in profile) profile[key] = clamp(value);
  for (const [key, value] of Object.entries(persona.values || {})) if (key in profile) profile[key] = clamp(value);
  return { schemaVersion: 1, dimensions: profile, source: persona.id || "default", stability: "long-term" };
}

function personalityPrompt(profile) {
  const d = profile.dimensions;
  return `稳定人格权重：温暖 ${f(d.warmth)}、好奇 ${f(d.curiosity)}、玩心 ${f(d.playfulness)}、边界 ${f(d.boundaryStrength)}、独立 ${f(d.independence)}、诚实 ${f(d.honesty)}、共创 ${f(d.coCreation)}、反思 ${f(d.reflectiveness)}。这些是长期倾向，不因一条消息突然反转；情绪只调节本轮表达。`;
}

function deriveExpressedPersonality(profile, emotion = {}, relationship = {}) {
  const stable = profile?.dimensions || {};
  const affect = emotion.affect || {};
  const irritation = Number(emotion.dimensions?.irritation || 0);
  const boundary = Number(affect.boundaryPressure || relationship.boundaryPressure || 0);
  const trust = Number(relationship.trust ?? 0.35);
  const values = {
    warmth: clamp(Number(stable.warmth || 0.5) + Number(affect.empathy || 0) * 0.12 - boundary * 0.12),
    curiosity: clamp(Number(stable.curiosity || 0.5) + Number(affect.curiosity || 0) * 0.15),
    playfulness: clamp(Number(stable.playfulness || 0.5) + Number(affect.playfulness || 0) * 0.15 - Number(affect.tension || 0) * 0.16),
    assertiveness: clamp(Number(stable.assertiveness || 0.5) + boundary * 0.24),
    patience: clamp(Number(stable.patience || 0.5) - irritation * 0.22),
    directness: clamp(Number(stable.directness || 0.5) + boundary * 0.2),
    selfDisclosure: clamp(Number(stable.selfDisclosure || 0.4) * (0.45 + trust * 0.55)),
    empathy: clamp(Number(stable.empathy || 0.5) + Number(affect.compassion || 0) * 0.12)
  };
  return {
    values,
    modulation: {
      trust, boundaryPressure: boundary, irritation,
      reason: boundary > 0.35 ? "边界压力提高坚定和直接表达" : Number(affect.compassion || 0) > 0.3 ? "关怀提高温暖与共情表达" : "维持稳定人格的日常表达"
    }
  };
}

function clamp(value) { return Math.max(0, Math.min(1, Number(value))); }
function f(value) { return Number(value || 0).toFixed(2); }

module.exports = { PERSONALITY_GROUPS, PERSONALITY_DIMENSIONS, PERSONALITY_LABELS, createPersonalityProfile, personalityPrompt, deriveExpressedPersonality };
