const { randomUUID } = require("node:crypto");

const CALL_STATUSES = new Set(["active", "ended", "interrupted"]);
const TURN_STATUSES = new Set(["completed", "interrupted"]);

class VoiceCallError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "VoiceCallError";
    this.code = code;
  }
}

class VoiceCallStore {
  constructor(memoryStore) {
    if (!memoryStore?.db?.prepare) throw new TypeError("VoiceCallStore requires a MemoryStore with an open SQLite database");
    this.memoryStore = memoryStore;
    this.db = memoryStore.db;
    this.createSchema();
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS voice_calls (
        id TEXT PRIMARY KEY,
        user_name TEXT NOT NULL,
        source TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active', 'ended', 'interrupted')),
        started_at TEXT NOT NULL,
        ended_at TEXT,
        end_reason TEXT,
        last_sequence INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );
      CREATE INDEX IF NOT EXISTS idx_voice_calls_user_started ON voice_calls(user_name, started_at DESC);
      CREATE TABLE IF NOT EXISTS voice_call_turns (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        call_id TEXT NOT NULL REFERENCES voice_calls(id) ON DELETE CASCADE,
        sequence INTEGER NOT NULL CHECK(sequence > 0),
        status TEXT NOT NULL CHECK(status IN ('completed', 'interrupted')),
        source TEXT NOT NULL,
        input_text TEXT NOT NULL,
        reply_text TEXT,
        asr_json TEXT,
        review_json TEXT,
        idempotency_key TEXT,
        created_at TEXT NOT NULL,
        completed_at TEXT,
        interrupted_at TEXT,
        UNIQUE(call_id, sequence),
        UNIQUE(call_id, idempotency_key)
      );
      CREATE INDEX IF NOT EXISTS idx_voice_call_turns_call_sequence ON voice_call_turns(call_id, sequence);
    `);
  }

  start({ user, source = "voice", metadata = {} } = {}) {
    const userName = requiredText(user, "user", 80);
    const now = new Date().toISOString();
    const call = {
      id: randomUUID(), user: userName, source: optionalText(source, "voice", 64), status: "active",
      startedAt: now, endedAt: null, endReason: null, lastSequence: 0, metadata: safeObject(metadata)
    };
    this.db.prepare(`INSERT INTO voice_calls(id, user_name, source, status, started_at, last_sequence, metadata_json)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(call.id, call.user, call.source, call.status, call.startedAt, 0, JSON.stringify(call.metadata));
    return call;
  }

  get(callId, { turnsLimit = 100 } = {}) {
    const call = this.db.prepare(`SELECT id, user_name AS user, source, status, started_at AS startedAt, ended_at AS endedAt,
      end_reason AS endReason, last_sequence AS lastSequence, metadata_json AS metadataJson FROM voice_calls WHERE id = ?`).get(requiredText(callId, "callId", 128));
    if (!call) return null;
    const limit = Math.min(Math.max(Number(turnsLimit) || 100, 0), 500);
    const turns = limit ? this.db.prepare(`SELECT id, call_id AS callId, sequence, status, source, input_text AS text,
      reply_text AS reply, asr_json AS asrJson, review_json AS reviewJson, idempotency_key AS idempotencyKey,
      created_at AS createdAt, completed_at AS completedAt, interrupted_at AS interruptedAt
      FROM voice_call_turns WHERE call_id = ? ORDER BY sequence ASC LIMIT ?`).all(call.id, limit).map(publicTurn) : [];
    return { ...call, metadata: safeObject(call.metadataJson), turns, turnCount: Number(this.db.prepare("SELECT COUNT(*) AS count FROM voice_call_turns WHERE call_id = ?").get(call.id).count) };
  }

  record(callId, input = {}) {
    const id = requiredText(callId, "callId", 128);
    const sequence = positiveInteger(input.sequence, "sequence");
    const payload = normalizeTurnInput(input);
    return this.transaction(() => {
      const existing = this.db.prepare("SELECT * FROM voice_call_turns WHERE call_id = ? AND sequence = ?").get(id, sequence);
      if (existing) return this.resolveRetry(existing, payload);
      if (payload.idempotencyKey) {
        const sameEvent = this.db.prepare("SELECT * FROM voice_call_turns WHERE call_id = ? AND idempotency_key = ?").get(id, payload.idempotencyKey);
        if (sameEvent) return this.resolveRetry(sameEvent, payload);
      }
      const call = this.db.prepare("SELECT id, status, last_sequence AS lastSequence FROM voice_calls WHERE id = ?").get(id);
      if (!call) throw new VoiceCallError("CALL_NOT_FOUND", "voice call not found");
      if (call.status !== "active") throw new VoiceCallError("CALL_CLOSED", "voice call is no longer active");
      if (sequence <= Number(call.lastSequence)) throw new VoiceCallError("SEQUENCE_CONFLICT", "voice turn sequence has already been used");

      const now = new Date().toISOString();
      const completedAt = payload.status === "completed" ? now : null;
      const interruptedAt = payload.status === "interrupted" ? now : null;
      const result = this.db.prepare(`INSERT INTO voice_call_turns(call_id, sequence, status, source, input_text, reply_text,
        asr_json, review_json, idempotency_key, created_at, completed_at, interrupted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, sequence, payload.status, payload.source, payload.text, payload.reply,
        jsonOrNull(payload.asr), jsonOrNull(payload.review), payload.idempotencyKey, now, completedAt, interruptedAt
      );
      this.db.prepare("UPDATE voice_calls SET last_sequence = ? WHERE id = ?").run(sequence, id);
      return { ...this.turnById(result.lastInsertRowid), idempotent: false };
    });
  }

  finish(callId, { status = "ended", reason = null } = {}) {
    const id = requiredText(callId, "callId", 128);
    if (!CALL_STATUSES.has(status) || status === "active") throw new VoiceCallError("INVALID_STATUS", "call completion status must be ended or interrupted");
    return this.transaction(() => {
      const call = this.get(id, { turnsLimit: 0 });
      if (!call) throw new VoiceCallError("CALL_NOT_FOUND", "voice call not found");
      if (call.status !== "active") {
        if (call.status === status) return { ...call, idempotent: true };
        throw new VoiceCallError("CALL_CLOSED", "voice call has already finished with a different status");
      }
      const endedAt = new Date().toISOString();
      this.db.prepare("UPDATE voice_calls SET status = ?, ended_at = ?, end_reason = ? WHERE id = ?").run(status, endedAt, optionalText(reason, null, 300), id);
      return { ...this.get(id, { turnsLimit: 0 }), idempotent: false };
    });
  }

  complete(callId, sequence, reply) {
    const call = this.get(callId, { turnsLimit: 0 });
    if (!call || call.status !== "active") throw new VoiceCallError("CALL_CLOSED", "voice call is no longer active");
    const text = requiredText(reply, "reply", 8_000);
    const result = this.db.prepare("UPDATE voice_call_turns SET status = 'completed', reply_text = ?, completed_at = ?, interrupted_at = NULL WHERE call_id = ? AND sequence = ? AND status = 'interrupted'").run(text, new Date().toISOString(), callId, sequence);
    if (!result.changes) throw new VoiceCallError("SEQUENCE_CONFLICT", "voice turn is not pending");
  }

  resolveRetry(existing, payload) {
    const current = publicTurn(existing);
    const same = current.sequence === payload.sequence && current.status === payload.status && current.source === payload.source
      && current.text === payload.text && (current.reply || null) === payload.reply && (current.idempotencyKey || null) === payload.idempotencyKey;
    if (!same) throw new VoiceCallError("IDEMPOTENCY_CONFLICT", "sequence or idempotency key belongs to a different voice turn");
    return { ...current, idempotent: true };
  }

  turnById(id) {
    const row = this.db.prepare(`SELECT id, call_id AS callId, sequence, status, source, input_text AS text, reply_text AS reply,
      asr_json AS asrJson, review_json AS reviewJson, idempotency_key AS idempotencyKey, created_at AS createdAt,
      completed_at AS completedAt, interrupted_at AS interruptedAt FROM voice_call_turns WHERE id = ?`).get(id);
    return publicTurn(row);
  }

  transaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = callback();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
}

function createVoiceCallStore(memoryStore) { return new VoiceCallStore(memoryStore); }
function start(store, input) { return requireStore(store).start(input); }
function get(store, callId, options) { return requireStore(store).get(callId, options); }
function record(store, callId, input) { return requireStore(store).record(callId, input); }
function finish(store, callId, input) { return requireStore(store).finish(callId, input); }
function requireStore(store) { if (!(store instanceof VoiceCallStore)) throw new TypeError("store must be a VoiceCallStore"); return store; }

function normalizeTurnInput(input = {}) {
  const status = input.status || "completed";
  if (!TURN_STATUSES.has(status)) throw new VoiceCallError("INVALID_STATUS", "turn status must be completed or interrupted");
  const text = requiredText(input.text, "text", 4_000);
  const reply = input.reply == null ? null : optionalText(input.reply, null, 8_000);
  if (status === "completed" && !reply) throw new VoiceCallError("REPLY_REQUIRED", "a completed voice turn requires an approved reply");
  return {
    sequence: positiveInteger(input.sequence, "sequence"), status, text, reply,
    source: optionalText(input.source, "voice", 64), asr: input.asr == null ? null : safeObject(input.asr),
    review: input.review == null ? null : safeObject(input.review), idempotencyKey: input.idempotencyKey == null ? null : requiredText(input.idempotencyKey, "idempotencyKey", 160)
  };
}

function publicTurn(row) {
  return {
    id: Number(row.id), callId: row.callId || row.call_id, sequence: Number(row.sequence), status: row.status, source: row.source,
    text: row.text || row.input_text, reply: row.reply ?? row.reply_text ?? null,
    asr: safeObject(row.asrJson || row.asr_json), review: safeObject(row.reviewJson || row.review_json),
    idempotencyKey: row.idempotencyKey || row.idempotency_key || null, createdAt: row.createdAt || row.created_at,
    completedAt: row.completedAt || row.completed_at || null, interruptedAt: row.interruptedAt || row.interrupted_at || null
  };
}

function requiredText(value, name, max) {
  const text = String(value || "").trim();
  if (!text) throw new VoiceCallError("INVALID_INPUT", `${name} is required`);
  if (text.length > max) throw new VoiceCallError("INVALID_INPUT", `${name} is too long`);
  return text;
}
function optionalText(value, fallback, max) { return value == null ? fallback : requiredText(value, "value", max); }
function positiveInteger(value, name) { const parsed = Number(value); if (!Number.isSafeInteger(parsed) || parsed < 1) throw new VoiceCallError("INVALID_INPUT", `${name} must be a positive integer`); return parsed; }
function safeObject(value) { return value && typeof value === "object" && !Array.isArray(value) ? value : {}; }
function jsonOrNull(value) { return value == null ? null : JSON.stringify(value); }

module.exports = { VoiceCallStore, VoiceCallError, createVoiceCallStore, start, get, record, finish };
