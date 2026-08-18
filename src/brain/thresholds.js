function numberEnv(name, fallback, min = 0, max = 1) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

const BRAIN_THRESHOLDS = Object.freeze({
  emotion: Object.freeze({
    repetitionBoundary: numberEnv("BRAIN_REPETITION_BOUNDARY", 0.42),
    socialPerceptionConfidence: numberEnv("BRAIN_SOCIAL_PERCEPTION_CONFIDENCE", 0.55),
    irritationRegulation: numberEnv("BRAIN_IRRITATION_REGULATION", 0.5),
    lowSafetyBoundary: numberEnv("BRAIN_LOW_SAFETY_BOUNDARY", 0.35)
  }),
  memory: Object.freeze({
    minimumRelevance: numberEnv("BRAIN_MEMORY_MIN_RELEVANCE", 0.1),
    candidateCharacterSupport: numberEnv("BRAIN_CANDIDATE_CHARACTER_SUPPORT", 0.42),
    candidateMixedSupport: numberEnv("BRAIN_CANDIDATE_MIXED_SUPPORT", 0.3)
  }),
  proactive: Object.freeze({
    maxUnanswered: numberEnv("BRAIN_PROACTIVE_MAX_UNANSWERED", 3, 1, 10)
  }),
  output: Object.freeze({
    nearDuplicateJaccard: numberEnv("BRAIN_REPLY_DUPLICATE_JACCARD", 0.78)
  })
});

module.exports = { BRAIN_THRESHOLDS };
