const PRIVATE_STATE_FIELDS = Object.freeze([
  "shortTerm", "memory", "memoryStatus", "memoryRetrieval", "memoryAudit",
  "direction", "cognition", "timeCheck", "story"
]);

function assertPublicStateSafe(state) {
  const exposed = PRIVATE_STATE_FIELDS.filter(field => Object.prototype.hasOwnProperty.call(state, field));
  if (exposed.length) throw new Error(`public state exposes private fields: ${exposed.join(", ")}`);
  if (state.persona?.worldBook) throw new Error("public state exposes persona worldBook");
  return true;
}

function publicEmotion(emotion = {}) {
  return { name: emotion.name || "neutral", intensity: Number(emotion.intensity || 0) };
}

function publicSpeech(speech) {
  if (!speech) return null;
  return {
    id: speech.id,
    at: speech.at,
    item: { user: speech.item?.user || "你", type: speech.item?.type || "chat" },
    text: speech.text,
    emotion: publicEmotion(speech.emotion),
    performance: { profile: speech.performance?.profile || {} }
  };
}

function publicAsrStatus(status = {}) {
  return {
    provider: status.provider || "unknown",
    model: status.model || status.backend?.model || "unknown",
    backendReady: Boolean(status.backendReady),
    backend: status.backendReady ? { model: status.backend?.model || status.model || "unknown" } : null
  };
}

module.exports = { PRIVATE_STATE_FIELDS, assertPublicStateSafe, publicEmotion, publicSpeech, publicAsrStatus };
