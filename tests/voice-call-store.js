const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { MemoryStore } = require("../src/brain/memory");
const { createVoiceCallStore, VoiceCallError } = require("../src/runtime/voice-call-store");
const { createVoiceCallApi, voiceCallErrorResponse } = require("../src/api/voice-call");

const root = path.join(os.tmpdir(), `ai-vtuber-voice-call-${process.pid}-${Date.now()}`);
const databasePath = `${root}.db`;
const cleanup = () => [databasePath, `${databasePath}-wal`, `${databasePath}-shm`].forEach(file => fs.rmSync(file, { force: true }));
let memory;

try {
  cleanup();
  memory = new MemoryStore({ databasePath, legacyPath: `${root}.missing.json` });
  const store = createVoiceCallStore(memory);
  const call = store.start({ user: "固定用户", source: "browser-voice", metadata: { language: "zh" } });
  assert.match(call.id, /^[0-9a-f-]{36}$/i);
  assert.equal(call.status, "active");

  const first = store.record(call.id, {
    sequence: 1, text: "你好", reply: "你好呀。", source: "asr-stream",
    asr: { provider: "funasr" }, review: { approved: true }, idempotencyKey: "event-1"
  });
  assert.equal(first.idempotent, false);
  const retried = store.record(call.id, {
    sequence: 1, text: "你好", reply: "你好呀。", source: "asr-stream",
    asr: { provider: "funasr" }, review: { approved: true }, idempotencyKey: "event-1"
  });
  assert.equal(retried.idempotent, true);

  assert.throws(() => store.record(call.id, { sequence: 1, text: "不同输入", reply: "不同回复", idempotencyKey: "event-1" }), error => error instanceof VoiceCallError && error.code === "IDEMPOTENCY_CONFLICT");
  const interrupted = store.record(call.id, { sequence: 2, text: "等一下", status: "interrupted", source: "barge-in", idempotencyKey: "event-2" });
  assert.equal(interrupted.status, "interrupted");
  const active = store.get(call.id);
  assert.equal(active.user, "固定用户");
  assert.equal(active.turnCount, 2);
  assert.equal(active.turns[0].reply, "你好呀。");
  assert.equal(memory.db.prepare("SELECT COUNT(*) AS count FROM session_messages").get().count, 0, "voice turns must not enter the stream session transcript");
  assert.equal(memory.db.prepare("SELECT COUNT(*) AS count FROM memories").get().count, 0, "voice turns must not become long-term memory automatically");

  assert.equal(store.finish(call.id, { status: "ended", reason: "user-ended" }).status, "ended");
  assert.equal(store.finish(call.id, { status: "ended" }).idempotent, true);
  assert.throws(() => store.record(call.id, { sequence: 3, text: "不能再提交", reply: "不应保存" }), error => error instanceof VoiceCallError && error.code === "CALL_CLOSED");
  assert.equal(voiceCallErrorResponse(new VoiceCallError("CALL_CLOSED", "closed")).statusCode, 409);
  const facade = createVoiceCallApi(memory);
  const facadeCall = facade.start({ user: "API用户" });
  assert.equal(facade.interrupt(facadeCall.id, { sequence: 1, text: "打断", idempotencyKey: "interrupt-1" }).status, "interrupted");
  assert.equal(facade.finish(facadeCall.id, { status: "interrupted" }).status, "interrupted");
  console.log("Voice call store test passed.");
} finally {
  memory?.close();
  cleanup();
}
