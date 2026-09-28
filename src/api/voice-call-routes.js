const { createVoiceCallApi, voiceCallErrorResponse } = require("./voice-call");
const { responseAbortController } = require("../runtime/request-lifecycle");
const { classifyComplexity } = require("../brain/local-llm");

function createVoiceCallRoutes({ brain, streamRoutedReply, parseBody, send, acquire }) {
  const api = createVoiceCallApi(brain.memoryStore);
  const active = new Map();
  return async function handle(req, res, url) {
    try {
      if (req.method === "POST" && url.pathname === "/api/voice-calls/start") {
        return send(res, 200, { call: api.start(await parseBody(req)) });
      }
      const match = url.pathname.match(/^\/api\/voice-calls\/([^/]+)(?:\/(turn|end))?$/);
      if (!match) return send(res, 404, { error: "unknown voice call endpoint" });
      const [, id, action] = match;
      const call = api.get(id, { turnsLimit: 500 });
      if (!call) return send(res, 404, { error: "voice call not found" });
      if (req.method === "GET" && !action) return send(res, 200, { call });
      if (req.method !== "POST") return send(res, 405, { error: "method not allowed" });
      const body = await parseBody(req);
      if (action === "end") {
        active.get(id)?.abort();
        return send(res, 200, { call: api.finish(id) });
      }
      if (action !== "turn") return send(res, 404, { error: "unknown voice call endpoint" });
      if (call.status !== "active") return send(res, 410, { error: "voice call has ended" });
      const sequence = Number(body.sequence);
      const text = String(body.text || "").trim();
      if (!Number.isSafeInteger(sequence) || sequence < 1 || !text || text.length > 4000) return send(res, 400, { error: "invalid voice turn" });
      const existing = brain.memoryStore.db.prepare("SELECT status, input_text, reply_text FROM voice_call_turns WHERE call_id = ? AND sequence = ?").get(id, sequence);
      if (existing) {
        if (existing.input_text !== text) return send(res, 422, { error: "sequence belongs to another input" });
        if (body.interrupted) return send(res, 200, { ok: true, idempotent: true });
        if (existing.status !== "completed") return send(res, 410, { error: "turn was interrupted; start a new turn" });
        res.writeHead(200, { "content-type": "application/x-ndjson" });
        return res.end(`${JSON.stringify({ type: "delta", text: existing.reply_text, reviewed: true })}\n${JSON.stringify({ type: "done", text: existing.reply_text })}\n`);
      }
      if (body.interrupted) return send(res, 200, { turn: api.interrupt(id, { sequence, text }) });
      const release = acquire();
      if (!release) return send(res, 409, { error: "reply is busy" });
      const controller = responseAbortController(res);
      active.set(id, controller);
      try {
        const startedAt = Date.now();
        let firstTokenMs = null;
        let routing = null;
        // Persist input before awaiting a model. A disconnect/crash cannot turn
        // an unfinished answer into an apparently completed conversation.
        api.interrupt(id, { sequence, text });
        const prepared = brain.prepareStreamReply({ id: `call-${id}-${sequence}`, user: call.user, contextScope: `voice:${id}`, voiceCallId: id, voiceSequence: sequence, text, type: "chat", training: false, timestamp: new Date().toISOString() });
        if (classifyComplexity(prepared.item).route === "local" && !/详细|长一点|完整|故事|展开/.test(text)) {
          prepared.context.realtimeMaxTokens = 96;
          prepared.context.direction = { ...prepared.context.direction, responseBudget: { ...prepared.context.direction?.responseBudget, maxSentences: 2, maxCharacters: 100 }, instruction: `${prepared.context.direction?.instruction || ""}。这是语音通话，简短直接回答，不要额外追问。` };
        }
        res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store" });
        res.write(`${JSON.stringify({ type: "start", item: prepared.item, emotion: brain.visibleEmotion() })}\n`);
        let draft = "";
        for await (const event of streamRoutedReply(prepared.item, prepared.context, controller.signal)) {
          controller.signal.throwIfAborted();
          if (event.type === "delta") {
            firstTokenMs ??= Date.now() - startedAt;
            routing = event.routing;
            draft += event.text;
          }
        }
        controller.signal.throwIfAborted();
        if (!draft.trim()) throw new Error("empty voice reply");
        const reply = brain.commitStreamReply(prepared.item, prepared.context, draft.trim());
        api.store.complete(id, sequence, reply.text);
        const timing = { firstTokenMs, approvedDeltaMs: Date.now() - startedAt };
        res.end(`${JSON.stringify({ type: "delta", text: reply.text, reviewed: true, routing, timing })}\n${JSON.stringify({ type: "done", text: reply.text, reviewed: true, routing, timing })}\n`);
      } catch (error) {
        if (controller.signal.aborted || res.destroyed) return;
        if (!res.headersSent) return send(res, 500, { error: "voice reply failed" });
        res.end(`${JSON.stringify({ type: "error", error: "本轮回复失败，输入已保存，可继续说话" })}\n`);
      } finally {
        if (active.get(id) === controller) active.delete(id);
        release();
      }
    } catch (error) {
      const failure = voiceCallErrorResponse(error);
      return send(res, failure.statusCode, failure);
    }
  };
}
module.exports = { createVoiceCallRoutes };
