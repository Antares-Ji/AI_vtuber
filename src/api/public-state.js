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
  let endpoint = null;
  if (status.backendReady && status.backend?.streaming?.ready === true) {
    try {
      const url = new URL(status.baseUrl);
      if (["http:", "https:"].includes(url.protocol) && !url.username && !url.password) {
        url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
        url.pathname = "/stream";
        url.search = "";
        url.hash = "";
        endpoint = url.href;
      }
    } catch {}
  }
  return {
    provider: status.provider || "unknown",
    model: status.model || status.backend?.model || "unknown",
    backendReady: Boolean(status.backendReady),
    backend: status.backendReady ? { model: status.backend?.model || status.model || "unknown" } : null,
    streaming: { ready: Boolean(endpoint), endpoint, sampleRate: 16000, channels: 1, format: "pcm_s16le" }
  };
}

module.exports = { PRIVATE_STATE_FIELDS, assertPublicStateSafe, publicEmotion, publicSpeech, publicAsrStatus };
