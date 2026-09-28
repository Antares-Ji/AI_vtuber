const { createVoiceCallStore, VoiceCallError } = require("../runtime/voice-call-store");

// Transport-neutral facade for server routes.  It deliberately receives text
// and an already policy-reviewed reply: ASR, brain execution and TTS remain
// orchestration concerns and cannot accidentally enqueue a danmaku here.
function createVoiceCallApi(memoryStore) {
  const store = createVoiceCallStore(memoryStore);
  return {
    store,
    start(body = {}) {
      return store.start({ user: body.user, source: body.source || "voice", metadata: body.metadata || {} });
    },
    get(callId, options) { return store.get(callId, options); },
    submit(callId, body = {}) {
      return store.record(callId, {
        sequence: body.sequence,
        text: body.text,
        reply: body.reply,
        status: body.status || "completed",
        source: body.source || "voice",
        asr: body.asr,
        review: body.review,
        idempotencyKey: body.idempotencyKey
      });
    },
    interrupt(callId, body = {}) {
      return store.record(callId, {
        sequence: body.sequence,
        text: body.text,
        status: "interrupted",
        source: body.source || "barge-in",
        asr: body.asr,
        review: body.review,
        idempotencyKey: body.idempotencyKey
      });
    },
    finish(callId, body = {}) { return store.finish(callId, { status: body.status || "ended", reason: body.reason }); }
  };
}

function voiceCallErrorResponse(error) {
  if (!(error instanceof VoiceCallError)) return { statusCode: 500, error: "voice call storage failed" };
  const statusCode = error.code === "CALL_NOT_FOUND" ? 404 : error.code === "CALL_CLOSED" || error.code === "SEQUENCE_CONFLICT" || error.code === "IDEMPOTENCY_CONFLICT" ? 409 : 400;
  return { statusCode, error: error.message, code: error.code };
}

module.exports = { createVoiceCallApi, voiceCallErrorResponse };
