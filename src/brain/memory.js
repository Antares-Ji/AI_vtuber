const fs = require("fs");
const path = require("path");
const { randomUUID } = require("crypto");
const { DatabaseSync } = require("node:sqlite");
const { PERSONA } = require("./persona");
const { semanticRank, conceptsFor, temporalIntent } = require("./memory-retrieval");
const { assessMemoryQuality } = require("./memory-quality");
const { containsMemoryInstructionInjection } = require("./memory-safety");

const DATA_DIR = path.join(__dirname, "..", "..", "data");
const MEMORY_PATH = path.join(DATA_DIR, "memories.json");
const DATABASE_PATH = path.join(DATA_DIR, "memory.db");
const BACKUP_PATH = path.join(DATA_DIR, "memories.pre-sqlite.json");
const TRAINING_LEDGER_PATH = path.join(DATA_DIR, "training-memories.json");

function readJson(filePath, fallback) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function safeJsonArray(value) {
  try { const parsed = JSON.parse(value || "[]"); return Array.isArray(parsed) ? parsed : []; } catch { return []; }
}

function safeJsonObject(value) {
  try { const parsed = JSON.parse(value || "{}"); return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {}; } catch { return {}; }
}

function defaultMemory() {
  return {
    users: {}, session: { shortTerm: [], startedAt: new Date().toISOString() }, stream: { events: [], topics: [] },
    character: { id: PERSONA.id, name: PERSONA.name, traits: PERSONA.traits, worldBook: PERSONA.worldBook, runningJokes: [] }
  };
}

class MemoryStore {
  constructor({ databasePath = DATABASE_PATH, legacyPath = MEMORY_PATH, trainingLedgerPath = null } = {}) {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
    this.databasePath = databasePath;
    this.legacyPath = legacyPath;
    this.trainingLedgerPath = trainingLedgerPath || (path.resolve(databasePath) === path.resolve(DATABASE_PATH)
      ? TRAINING_LEDGER_PATH : path.join(path.dirname(databasePath), `${path.basename(databasePath, path.extname(databasePath))}.training.json`));
    this.db = new DatabaseSync(databasePath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 3000;");
    this.createSchema();
    this.migrateSchema();
    this.ensureActiveSession();
    this.migrateLegacyJsonOnce();
    this.expireMemories();
    this.refreshSnapshot();
  }

  createSchema() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS users (
        user_name TEXT PRIMARY KEY, seen_count INTEGER NOT NULL DEFAULT 0,
        first_seen_at TEXT NOT NULL, last_seen_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memories (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        scope TEXT NOT NULL CHECK(scope IN ('user', 'session', 'stream', 'character', 'world')),
        user_name TEXT, kind TEXT NOT NULL, content TEXT NOT NULL, source TEXT,
        confidence REAL NOT NULL DEFAULT 0.5, importance REAL NOT NULL DEFAULT 0.5,
        sensitivity TEXT NOT NULL DEFAULT 'normal' CHECK(sensitivity IN ('normal', 'private')),
        created_at TEXT NOT NULL, last_confirmed_at TEXT, expires_at TEXT,
        status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'stale', 'forgotten')),
        access_count INTEGER NOT NULL DEFAULT 0, last_accessed_at TEXT, supersedes_memory_id INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_memories_user_active ON memories(user_name, status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_memories_scope_active ON memories(scope, status, created_at DESC);
      CREATE TABLE IF NOT EXISTS session_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, at TEXT NOT NULL, user_name TEXT NOT NULL, text TEXT NOT NULL, reply TEXT NOT NULL,
        training_hint INTEGER NOT NULL DEFAULT 0, emotion_name TEXT, emotion_intensity REAL, affect_json TEXT, appraisal_json TEXT
      );
      CREATE TABLE IF NOT EXISTS stream_events (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, at TEXT NOT NULL, type TEXT NOT NULL, user_name TEXT NOT NULL, text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stream_topics (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT, at TEXT NOT NULL, text TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS stream_sessions (
        id TEXT PRIMARY KEY, started_at TEXT NOT NULL, ended_at TEXT, status TEXT NOT NULL CHECK(status IN ('active', 'ended')),
        summary TEXT, event_count INTEGER NOT NULL DEFAULT 0, review_status TEXT NOT NULL DEFAULT 'unreviewed', reviewed_at TEXT
      );
      CREATE TABLE IF NOT EXISTS memory_evidence (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        memory_id INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        source TEXT NOT NULL,
        observed_at TEXT NOT NULL,
        confidence REAL NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_memory_evidence_memory ON memory_evidence(memory_id, observed_at DESC);
      CREATE TABLE IF NOT EXISTS memory_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        at TEXT NOT NULL,
        action TEXT NOT NULL,
        memory_id INTEGER,
        user_name TEXT,
        detail TEXT
      );
      CREATE TABLE IF NOT EXISTS user_relationships (
        user_name TEXT PRIMARY KEY REFERENCES users(user_name) ON DELETE CASCADE,
        familiarity REAL NOT NULL DEFAULT 0,
        affinity REAL NOT NULL DEFAULT 0,
        trust REAL NOT NULL DEFAULT 0.35,
        comfort REAL NOT NULL DEFAULT 0.35,
        boundary_pressure REAL NOT NULL DEFAULT 0,
        repeat_strikes INTEGER NOT NULL DEFAULT 0,
        preferred_name TEXT,
        last_topic TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_candidates (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL, user_name TEXT, scope TEXT NOT NULL,
        content TEXT NOT NULL, reason TEXT, confidence REAL NOT NULL DEFAULT 0.8, importance REAL NOT NULL DEFAULT 0.8,
        status TEXT NOT NULL DEFAULT 'pending', created_at TEXT NOT NULL, resolved_at TEXT, memory_id INTEGER,
        duplicate_memory_id INTEGER, conflict_memory_id INTEGER,
        evidence_message_ids TEXT, evidence_excerpt TEXT
      );
    `);
  }

  migrateLegacyJsonOnce() {
    if (this.getMeta("legacy_json_migrated_at")) return;
    const legacy = readJson(this.legacyPath, null);
    if (!legacy) {
      this.setMeta("legacy_json_migrated_at", new Date().toISOString());
      return;
    }
    if (this.legacyPath === MEMORY_PATH && !fs.existsSync(BACKUP_PATH)) fs.copyFileSync(this.legacyPath, BACKUP_PATH);
    this.withTransaction(() => {
      for (const [userName, user] of Object.entries(legacy.users || {})) {
        const now = user.lastSeen || new Date().toISOString();
        this.upsertUser(userName, Number(user.seen || 0), user.firstSeen || now, now);
        for (const rawFact of user.facts || []) {
          const legacyFact = typeof rawFact === "string" ? { text: rawFact, source: "legacy-json", at: now, confidence: 0.6 } : rawFact;
          this.insertMemory({
            scope: "user", userName, kind: "fact", content: legacyFact.text, source: legacyFact.source || "legacy-json",
            confidence: legacyFact.confidence ?? 0.6, importance: 0.6, createdAt: legacyFact.at || now, lastConfirmedAt: legacyFact.at || now
          }, true);
        }
      }
      for (const message of legacy.session?.shortTerm || []) {
        this.db.prepare("INSERT INTO session_messages(session_id, at, user_name, text, reply) VALUES (?, ?, ?, ?, ?)")
          .run(this.ensureActiveSession(), message.at || new Date().toISOString(), message.user || "匿名观众", message.text || "", message.reply || "");
      }
      for (const event of legacy.stream?.events || []) {
        this.db.prepare("INSERT INTO stream_events(session_id, at, type, user_name, text) VALUES (?, ?, ?, ?, ?)")
          .run(this.ensureActiveSession(), event.at || new Date().toISOString(), event.type || "chat", event.user || "匿名观众", event.text || "");
      }
      for (const topic of legacy.stream?.topics || []) {
        this.db.prepare("INSERT INTO stream_topics(session_id, at, text) VALUES (?, ?, ?)").run(this.ensureActiveSession(), topic.at || new Date().toISOString(), topic.text || topic);
      }
      this.trimTables();
      this.setMeta("legacy_json_migrated_at", new Date().toISOString());
    });
  }

  migrateSchema() {
    const version = Number(this.getMeta("schema_version") || 1);
    if (version < 2) this.withTransaction(() => {
      this.setMeta("schema_version", "2");
      this.audit("schema-upgrade", null, null, "memory evidence and audit tables enabled");
    });
    if (version < 3) this.withTransaction(() => {
      this.setMeta("schema_version", "3");
      this.audit("schema-upgrade", null, null, "relationship profile table enabled");
    });
    if (version < 4) this.withTransaction(() => {
      this.ensureColumn("session_messages", "session_id", "TEXT");
      this.ensureColumn("stream_events", "session_id", "TEXT");
      this.ensureColumn("stream_topics", "session_id", "TEXT");
      const legacySessionId = this.ensureActiveSession();
      this.db.prepare("UPDATE session_messages SET session_id = ? WHERE session_id IS NULL").run(legacySessionId);
      this.db.prepare("UPDATE stream_events SET session_id = ? WHERE session_id IS NULL").run(legacySessionId);
      this.db.prepare("UPDATE stream_topics SET session_id = ? WHERE session_id IS NULL").run(legacySessionId);
      this.setMeta("schema_version", "4");
      this.audit("schema-upgrade", null, null, "stream session table enabled");
    });
    if (version < 5) this.withTransaction(() => {
      this.ensureColumn("user_relationships", "trust", "REAL NOT NULL DEFAULT 0.35");
      this.ensureColumn("user_relationships", "comfort", "REAL NOT NULL DEFAULT 0.35");
      this.ensureColumn("user_relationships", "boundary_pressure", "REAL NOT NULL DEFAULT 0");
      this.ensureColumn("user_relationships", "last_topic", "TEXT");
      this.setMeta("schema_version", "5");
      this.audit("schema-upgrade", null, null, "relationship dimensions and hybrid memory retrieval enabled");
    });
    if (version < 6) this.withTransaction(() => {
      this.ensureColumn("session_messages", "training_hint", "INTEGER NOT NULL DEFAULT 0");
      this.setMeta("schema_version", "6");
      this.audit("schema-upgrade", null, null, "reviewable session memory candidates enabled");
    });
    if (version < 7) this.withTransaction(() => {
      this.ensureColumn("memories", "access_count", "INTEGER NOT NULL DEFAULT 0");
      this.ensureColumn("memories", "last_accessed_at", "TEXT");
      this.ensureColumn("memories", "supersedes_memory_id", "INTEGER");
      this.ensureColumn("memory_candidates", "duplicate_memory_id", "INTEGER");
      this.ensureColumn("memory_candidates", "conflict_memory_id", "INTEGER");
      this.setMeta("schema_version", "7");
      this.audit("schema-upgrade", null, null, "memory lifecycle and candidate diagnostics enabled");
    });
    if (version < 8) this.withTransaction(() => {
      this.ensureColumn("stream_sessions", "review_status", "TEXT NOT NULL DEFAULT 'unreviewed'");
      this.ensureColumn("stream_sessions", "reviewed_at", "TEXT");
      this.setMeta("schema_version", "8");
      this.audit("schema-upgrade", null, null, "reviewable session archive enabled");
    });
    if (version < 9) this.withTransaction(() => {
      this.ensureColumn("memory_candidates", "evidence_message_ids", "TEXT");
      this.ensureColumn("memory_candidates", "evidence_excerpt", "TEXT");
      this.setMeta("schema_version", "9");
      this.audit("schema-upgrade", null, null, "human-evidence-backed memory candidates enabled");
    });
    if (version < 10) this.withTransaction(() => {
      const now = new Date().toISOString();
      this.db.prepare(`UPDATE memory_candidates SET status = 'superseded', resolved_at = ?
        WHERE status = 'pending' AND (evidence_message_ids IS NULL OR evidence_message_ids = '' OR evidence_message_ids = '[]')`).run(now);
      this.setMeta("schema_version", "10");
      this.audit("schema-upgrade", null, null, "ungrounded legacy memory candidates retired");
    });
    if (version < 11) this.withTransaction(() => {
      this.ensureColumn("session_messages", "emotion_name", "TEXT");
      this.ensureColumn("session_messages", "emotion_intensity", "REAL");
      this.ensureColumn("session_messages", "affect_json", "TEXT");
      this.ensureColumn("session_messages", "appraisal_json", "TEXT");
      this.setMeta("schema_version", "11");
      this.audit("schema-upgrade", null, null, "emotion-tagged episodic session memory enabled");
    });
  }

  ensureColumn(tableName, columnName, definition) {
    const columns = this.db.prepare(`PRAGMA table_info(${tableName})`).all();
    if (!columns.some(column => column.name === columnName)) this.db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
  }

  ensureActiveSession() {
    const activeId = this.getMeta("active_session_id");
    if (activeId && this.db.prepare("SELECT id FROM stream_sessions WHERE id = ? AND status = 'active'").get(activeId)) return activeId;
    const id = randomUUID();
    this.db.prepare("INSERT INTO stream_sessions(id, started_at, status) VALUES (?, ?, 'active')").run(id, new Date().toISOString());
    this.setMeta("active_session_id", id);
    this.audit("session-started", null, null, id);
    return id;
  }

  getSessionStatus() {
    const id = this.ensureActiveSession();
    const session = this.db.prepare("SELECT id, started_at, status, review_status, reviewed_at FROM stream_sessions WHERE id = ?").get(id);
    const messageCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ?").get(id).count);
    const pendingCandidates = Number(this.db.prepare("SELECT COUNT(*) AS count FROM memory_candidates WHERE session_id = ? AND status = 'pending'").get(id).count);
    return { id, startedAt: session.started_at, status: session.status, reviewStatus: session.review_status, reviewedAt: session.reviewed_at, messageCount, pendingCandidates };
  }

  getCurrentSessionTranscript(limit = 120) {
    return this.getSessionTranscript(this.ensureActiveSession(), limit);
  }

  getSessionTranscript(sessionId, limit = 120) {
    const exists = this.db.prepare("SELECT id FROM stream_sessions WHERE id = ?").get(sessionId);
    if (!exists) throw new Error("session not found");
    const hintedCount = Number(this.db.prepare("SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND training_hint = 1").get(sessionId).count);
    const rows = this.db.prepare(`SELECT id, at, user_name AS user, text, reply, training_hint AS trainingHint,
      emotion_name AS emotionName, emotion_intensity AS emotionIntensity, affect_json AS affectJson, appraisal_json AS appraisalJson
      FROM session_messages WHERE session_id = ? ${hintedCount ? "AND training_hint = 1" : ""}
      ORDER BY id DESC LIMIT ?`).all(sessionId, Math.min(Math.max(Number(limit) || 120, 1), 300)).reverse();
    return {
      sessionId, source: hintedCount ? "training-hints" : "whole-session",
      messages: rows.map(row => ({ ...row, affect: safeJsonObject(row.affectJson), appraisal: safeJsonObject(row.appraisalJson), affectJson: undefined, appraisalJson: undefined }))
    };
  }

  listSessions(limit = 30) {
    return this.db.prepare(`SELECT id, started_at AS startedAt, ended_at AS endedAt, status, summary, event_count AS eventCount,
      review_status AS reviewStatus, reviewed_at AS reviewedAt,
      (SELECT COUNT(*) FROM session_messages messages WHERE messages.session_id = stream_sessions.id) AS messageCount,
      (SELECT COUNT(*) FROM memory_candidates candidates WHERE candidates.session_id = stream_sessions.id AND candidates.status = 'pending') AS pendingCandidates
      FROM stream_sessions ORDER BY started_at DESC LIMIT ?`).all(Math.min(Math.max(Number(limit) || 30, 1), 100));
  }

  replacePendingCandidates(sessionId, candidates) {
    const now = new Date().toISOString();
    this.db.prepare("UPDATE memory_candidates SET status = 'superseded', resolved_at = ? WHERE session_id = ? AND status = 'pending'").run(now, sessionId);
    const insert = this.db.prepare(`INSERT INTO memory_candidates
      (session_id, user_name, scope, content, reason, confidence, importance, status, created_at, duplicate_memory_id, conflict_memory_id, evidence_message_ids, evidence_excerpt)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`);
    for (const candidate of candidates.slice(0, 5)) {
      const scope = candidate.scope === "character" ? "character" : "user";
      const user = scope === "user" ? candidate.user || null : null;
      const content = String(candidate.content).trim().slice(0, 500);
      const diagnostic = this.diagnoseCandidate({ scope, user, content });
      insert.run(sessionId, user, scope, content,
        String(candidate.reason || "从本场对话提炼").slice(0, 300), clamp(Number(candidate.confidence) || 0.82),
        clamp(Number(candidate.importance) || 0.82), now, diagnostic.duplicateMemoryId, diagnostic.conflictMemoryId,
        JSON.stringify(candidate.evidenceMessageIds || []), String(candidate.evidenceExcerpt || "").slice(0, 700));
    }
    return this.listMemoryCandidates("pending", sessionId);
  }

  listMemoryCandidates(status = "pending", sessionId = null) {
    const clauses = ["status = ?"];
    const values = [status];
    if (sessionId) { clauses.push("session_id = ?"); values.push(sessionId); }
    return this.db.prepare(`SELECT id, session_id AS sessionId, user_name AS user, scope, content, reason,
      confidence, importance, status, created_at AS createdAt, duplicate_memory_id AS duplicateMemoryId,
      conflict_memory_id AS conflictMemoryId, evidence_message_ids AS evidenceMessageIds, evidence_excerpt AS evidenceExcerpt FROM memory_candidates
      WHERE ${clauses.join(" AND ")} ORDER BY id ASC`).all(...values).map(row => ({
        ...row, evidenceMessageIds: safeJsonArray(row.evidenceMessageIds)
      }));
  }

  diagnoseCandidate({ scope, user, content }) {
    const rows = this.db.prepare(`SELECT id, content FROM memories WHERE scope = ? AND COALESCE(user_name, '') = COALESCE(?, '') AND status = 'active'`).all(scope, user || null);
    const normalized = normalizeMemoryText(content);
    const duplicate = rows.find(row => {
      const existing = normalizeMemoryText(row.content);
      return existing === normalized || (Math.min(existing.length, normalized.length) >= 12 && (existing.includes(normalized) || normalized.includes(existing)));
    });
    let conflict = null;
    const identity = identityKey(content);
    if (identity) conflict = rows.find(row => row.id !== duplicate?.id && identityKey(row.content) === identity && normalizeMemoryText(row.content) !== normalized);
    return { duplicateMemoryId: duplicate?.id || null, conflictMemoryId: conflict?.id || null };
  }

  commitMemoryCandidates(items = []) {
    const approved = [];
    const rejected = [];
    for (const update of items.slice(0, 20)) {
      const candidate = this.db.prepare("SELECT * FROM memory_candidates WHERE id = ? AND status = 'pending'").get(Number(update.id));
      if (!candidate) continue;
      const content = String(update.content || candidate.content).trim().slice(0, 500);
      if (update.selected && content) {
        const scope = update.scope === "character" ? "character" : "user";
        const user = scope === "user" ? String(update.user || candidate.user_name || "训练者").slice(0, 40) : null;
        const evidenceIds = safeJsonArray(candidate.evidence_message_ids);
        const evidence = evidenceIds.map(id => ({
          source: `session-message#${id}: ${String(candidate.evidence_excerpt || "").slice(0, 500)}`,
          confidence: candidate.confidence
        }));
        const memoryId = this.saveTrainingMemory(user, content, { scope, evidence });
        this.db.prepare("UPDATE memory_candidates SET status = 'approved', resolved_at = ?, memory_id = ?, content = ?, scope = ?, user_name = ? WHERE id = ?")
          .run(new Date().toISOString(), memoryId, content, scope, user, candidate.id);
        approved.push({ candidateId: candidate.id, memoryId, content });
      } else {
        this.db.prepare("UPDATE memory_candidates SET status = 'rejected', resolved_at = ? WHERE id = ?").run(new Date().toISOString(), candidate.id);
        rejected.push(candidate.id);
      }
    }
    this.audit("memory-candidates-reviewed", null, null, `approved ${approved.length}, rejected ${rejected.length}`);
    const sessionIds = [...new Set(items.map(item => this.db.prepare("SELECT session_id AS id FROM memory_candidates WHERE id = ?").get(Number(item.id))?.id).filter(Boolean))];
    for (const sessionId of sessionIds) {
      const pending = Number(this.db.prepare("SELECT COUNT(*) AS count FROM memory_candidates WHERE session_id = ? AND status = 'pending'").get(sessionId).count);
      if (!pending) this.db.prepare("UPDATE stream_sessions SET review_status = 'reviewed', reviewed_at = ? WHERE id = ?").run(new Date().toISOString(), sessionId);
    }
    this.refreshSnapshot();
    return { approved, rejected };
  }

  endCurrentSession() {
    const id = this.ensureActiveSession();
    const now = new Date().toISOString();
    const counts = this.db.prepare("SELECT COUNT(*) AS messages, COUNT(DISTINCT user_name) AS viewers FROM session_messages WHERE session_id = ?").get(id);
    const topics = this.db.prepare("SELECT text FROM stream_topics WHERE session_id = ? ORDER BY id DESC LIMIT 4").all(id).reverse().map(row => row.text);
    const trainingHints = Number(this.db.prepare("SELECT COUNT(*) AS count FROM session_messages WHERE session_id = ? AND training_hint = 1").get(id).count);
    const summary = `本场收到 ${counts.messages} 次有效互动，${counts.viewers} 位观众参与${topics.length ? `，主要话题：${[...new Set(topics)].join("、")}` : ""}；其中 ${trainingHints} 条标记为训练素材。`;
    this.withTransaction(() => {
      this.db.prepare("UPDATE stream_sessions SET ended_at = ?, status = 'ended', summary = ?, event_count = ? WHERE id = ?")
        .run(now, summary, counts.messages, id);
      this.audit("session-ended", null, null, summary);
      this.db.prepare("DELETE FROM meta WHERE key = 'active_session_id'").run();
    });
    this.ensureActiveSession();
    this.refreshSnapshot();
    return { id, summary, endedAt: now, active: this.getSessionStatus() };
  }

  getMeta(key) { return this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key)?.value || null; }

  setMeta(key, value) {
    this.db.prepare("INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, String(value));
  }

  upsertUser(userName, seenCount, firstSeenAt, lastSeenAt) {
    this.db.prepare(`INSERT INTO users(user_name, seen_count, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(user_name) DO UPDATE SET seen_count = MAX(users.seen_count, excluded.seen_count), last_seen_at = excluded.last_seen_at`)
      .run(userName, seenCount, firstSeenAt, lastSeenAt);
  }

  insertMemory(memory, ignoreDuplicates = false) {
    const existing = this.db.prepare(`SELECT id FROM memories WHERE scope = ? AND COALESCE(user_name, '') = COALESCE(?, '')
      AND kind = ? AND content = ? AND status = 'active' LIMIT 1`).get(memory.scope, memory.userName || null, memory.kind, memory.content);
    if (existing) {
      if (!ignoreDuplicates) this.db.prepare("UPDATE memories SET last_confirmed_at = ?, confidence = MAX(confidence, ?) WHERE id = ?")
        .run(memory.lastConfirmedAt || memory.createdAt, memory.confidence, existing.id);
      return existing.id;
    }
    return this.db.prepare(`INSERT INTO memories(scope, user_name, kind, content, source, confidence, importance, sensitivity, created_at, last_confirmed_at, expires_at, status, supersedes_memory_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(memory.scope, memory.userName || null, memory.kind, memory.content, memory.source || null, memory.confidence ?? 0.5,
        memory.importance ?? 0.5, memory.sensitivity || "normal", memory.createdAt, memory.lastConfirmedAt || null,
        memory.expiresAt || null, memory.status || "active", memory.supersedesMemoryId || null).lastInsertRowid;
  }

  addEvidence(memoryId, source, observedAt, confidence) {
    this.db.prepare("INSERT INTO memory_evidence(memory_id, source, observed_at, confidence) VALUES (?, ?, ?, ?)")
      .run(memoryId, source, observedAt, confidence);
    this.db.prepare(`DELETE FROM memory_evidence WHERE memory_id = ? AND id NOT IN
      (SELECT id FROM memory_evidence WHERE memory_id = ? ORDER BY observed_at DESC, id DESC LIMIT 50)`).run(memoryId, memoryId);
  }

  audit(action, memoryId, userName, detail) {
    this.db.prepare("INSERT INTO memory_audit(at, action, memory_id, user_name, detail) VALUES (?, ?, ?, ?, ?)")
      .run(new Date().toISOString(), action, memoryId, userName, detail);
  }

  getUserFacts(userName) {
    const now = new Date().toISOString();
    return this.db.prepare(`SELECT id, kind, content AS text, source, created_at AS at, last_confirmed_at AS lastConfirmedAt,
      confidence, importance, expires_at AS expiresAt, access_count AS accessCount, last_accessed_at AS lastAccessedAt,
      (SELECT COUNT(*) FROM memory_evidence evidence WHERE evidence.memory_id = memories.id) AS evidenceCount
      FROM memories WHERE scope = 'user' AND user_name = ? AND status = 'active' AND (expires_at IS NULL OR expires_at > ?)
      ORDER BY confidence DESC, importance DESC, last_confirmed_at DESC LIMIT 80`).all(userName, now);
  }

  saveTrainingMemory(userName, text, { scope = "user", title = null, evidence = [] } = {}) {
    const content = String(text || "").trim().slice(0, 800);
    if (!content) throw new Error("training text is required");
    if (containsSensitiveClaim(content)) throw new Error("training memory cannot contain sensitive personal information");
    if (containsMemoryInstructionInjection(content)) throw new Error("training memory contains instruction injection");
    const now = new Date().toISOString();
    const conflicts = scope === "user" ? this.resolveConflicts(userName, { content }) : [];
    const memoryId = this.insertMemory({
      scope, userName: scope === "user" ? userName : null, kind: "training", content: title ? `${title}：${content}` : content,
      source: "guided-training", confidence: 0.96, importance: 0.98, createdAt: now, lastConfirmedAt: now,
      supersedesMemoryId: conflicts[0] || null
    });
    const sources = Array.isArray(evidence) && evidence.length ? evidence : [{ source: content, confidence: 0.96 }];
    for (const item of sources.slice(0, 8)) this.addEvidence(memoryId, String(item.source || content).slice(0, 700), now, clamp(Number(item.confidence) || 0.8));
    this.audit("training-memory-saved", memoryId, scope === "user" ? userName : null, content.slice(0, 180));
    this.refreshSnapshot();
    this.exportTrainingLedger();
    return memoryId;
  }

  listMemories({ scope = null, user = null, kind = null, status = "active", limit = 100 } = {}) {
    const clauses = ["status = ?"];
    const values = [status];
    if (scope) { clauses.push("scope = ?"); values.push(scope); }
    if (user) { clauses.push("user_name = ?"); values.push(user); }
    if (kind) { clauses.push("kind = ?"); values.push(kind); }
    values.push(Math.min(Math.max(Number(limit) || 100, 1), 500));
    return this.db.prepare(`SELECT id, scope, user_name AS user, kind, content, source, confidence, importance, created_at AS createdAt,
      last_confirmed_at AS lastConfirmedAt, expires_at AS expiresAt, status, access_count AS accessCount, last_accessed_at AS lastAccessedAt,
      (SELECT COUNT(*) FROM memory_evidence evidence WHERE evidence.memory_id = memories.id) AS evidenceCount FROM memories
      WHERE ${clauses.join(" AND ")} ORDER BY importance DESC, id DESC LIMIT ?`).all(...values);
  }

  updateMemory(id, patch) {
    const current = this.db.prepare("SELECT * FROM memories WHERE id = ?").get(Number(id));
    if (!current) throw new Error("memory not found");
    const content = patch.content === undefined ? current.content : String(patch.content).trim().slice(0, 1200);
    if (!content) throw new Error("memory content cannot be empty");
    if (containsSensitiveClaim(content)) throw new Error("memory cannot contain sensitive personal information");
    if (containsMemoryInstructionInjection(content)) throw new Error("memory contains instruction injection");
    const confidenceValue = Number(patch.confidence);
    const importanceValue = Number(patch.importance);
    const confidence = patch.confidence === undefined || !Number.isFinite(confidenceValue) ? current.confidence : clamp(confidenceValue);
    const importance = patch.importance === undefined || !Number.isFinite(importanceValue) ? current.importance : clamp(importanceValue);
    const status = ["active", "stale", "forgotten"].includes(patch.status) ? patch.status : current.status;
    this.db.prepare("UPDATE memories SET content = ?, confidence = ?, importance = ?, status = ?, last_confirmed_at = ? WHERE id = ?")
      .run(content, confidence, importance, status, new Date().toISOString(), Number(id));
    this.audit("memory-edited", Number(id), current.user_name, content.slice(0, 180));
    this.refreshSnapshot();
    if (current.kind === "training") this.exportTrainingLedger();
    return this.db.prepare("SELECT id, scope, user_name AS user, kind, content, confidence, importance, status FROM memories WHERE id = ?").get(Number(id));
  }

  exportTrainingLedger() {
    const rows = this.db.prepare(`SELECT scope, user_name AS user, content, source, confidence, importance, created_at AS createdAt
      FROM memories WHERE kind = 'training' AND status = 'active' ORDER BY id ASC`).all();
    const temporary = `${this.trainingLedgerPath}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify({ exportedAt: new Date().toISOString(), memories: rows }, null, 2), "utf8");
    fs.renameSync(temporary, this.trainingLedgerPath);
    return { path: this.trainingLedgerPath, count: rows.length };
  }

  expireMemories(now = new Date().toISOString()) {
    const expired = this.db.prepare("SELECT id, user_name, content FROM memories WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").all(now);
    if (!expired.length) return 0;
    this.withTransaction(() => {
      this.db.prepare("UPDATE memories SET status = 'stale' WHERE status = 'active' AND expires_at IS NOT NULL AND expires_at <= ?").run(now);
      for (const memory of expired) this.audit("memory-expired", memory.id, memory.user_name, memory.content);
    });
    return expired.length;
  }

  resolveConflicts(userName, candidate) {
    const key = identityKey(candidate.content);
    if (!key) return 0;
    const conflicts = this.db.prepare(`SELECT id, content FROM memories
      WHERE user_name = ? AND status = 'active' AND content <> ?`).all(userName, candidate.content)
      .filter(memory => identityKey(memory.content) === key);
    if (!conflicts.length) return [];
    const stale = this.db.prepare("UPDATE memories SET status = 'stale' WHERE id = ?");
    for (const conflict of conflicts) stale.run(conflict.id);
    for (const conflict of conflicts) this.audit("memory-conflict-staled", conflict.id, userName, `replaced by ${candidate.content}`);
    return conflicts.map(conflict => conflict.id);
  }

  getRecentTopics(limit = 5) {
    return this.db.prepare("SELECT text FROM stream_topics WHERE session_id = ? ORDER BY id DESC LIMIT ?")
      .all(this.ensureActiveSession(), limit).reverse().map(row => row.text);
  }

  getCharacterReflections(limit = 3) {
    return this.db.prepare(`SELECT content, created_at AS at FROM memories
      WHERE scope = 'character' AND kind = 'reflection' AND status = 'active'
      ORDER BY id DESC LIMIT ?`).all(limit).reverse();
  }

  recordCharacterReflection(content) {
    const recent = this.getCharacterReflections(1)[0];
    if (recent?.content === content) return null;
    const id = this.insertMemory({
      scope: "character", kind: "reflection", content, source: "local-cognition",
      confidence: 0.78, importance: 0.72, createdAt: new Date().toISOString()
    });
    this.audit("character-reflection", id, null, content);
    this.db.exec(`UPDATE memories SET status = 'stale' WHERE scope = 'character' AND kind = 'reflection' AND status = 'active'
      AND id NOT IN (SELECT id FROM memories WHERE scope = 'character' AND kind = 'reflection' AND status = 'active' ORDER BY id DESC LIMIT 120)`);
    this.refreshSnapshot();
    return id;
  }

  recordUserEpisode(userName) {
    const recent = this.getSessionMessagesForUser(userName, 6);
    if (recent.length < 3) return null;
    const topics = [...new Set(recent.flatMap(turn => [extractTopic(turn.text)].filter(Boolean)))];
    const content = `与 ${userName} 的近期互动：围绕${topics.length ? topics.join("、") : "日常交流"}聊过 ${recent.length} 次；后续若相关话题自然出现，可以温和延续。`;
    const id = this.insertMemory({
      scope: "user", userName, kind: "episode", content, source: "session-consolidation",
      confidence: 0.76, importance: 0.78, createdAt: new Date().toISOString(), lastConfirmedAt: new Date().toISOString()
    });
    this.audit("user-episode-consolidated", id, userName, content);
    this.refreshSnapshot();
    return id;
  }

  getRelationship(userName) {
    const user = this.db.prepare("SELECT seen_count, first_seen_at, last_seen_at FROM users WHERE user_name = ?").get(userName);
    const seenCount = Number(user?.seen_count || 0);
    const profile = this.db.prepare("SELECT familiarity, affinity, trust, comfort, boundary_pressure, repeat_strikes, preferred_name, last_topic, updated_at FROM user_relationships WHERE user_name = ?").get(userName);
    const decayed = decayTransientRelationship(profile, new Date().toISOString());
    const familiarity = Number(decayed?.familiarity ?? Math.min(1, seenCount / 20));
    const level = seenCount >= 20 ? "old_friend" : seenCount >= 6 ? "regular" : seenCount >= 2 ? "returning" : "new";
    return {
      level, seenCount, familiarity, affinity: Number(profile?.affinity || 0), trust: Number(profile?.trust ?? 0.35), comfort: Number(profile?.comfort ?? 0.35),
      boundaryPressure: Number(decayed?.boundary_pressure || 0), repeatStrikes: Number(decayed?.repeat_strikes || 0), lastTopic: profile?.last_topic || null,
      daysSinceInteraction: decayed?.daysSinceInteraction || 0,
      preferredName: profile?.preferred_name || null, firstSeenAt: user?.first_seen_at || null, lastSeenAt: user?.last_seen_at || null
    };
  }

  updateRelationship(item, user) {
    const rawPrevious = this.db.prepare("SELECT familiarity, affinity, trust, comfort, boundary_pressure, repeat_strikes, preferred_name, last_topic, updated_at FROM user_relationships WHERE user_name = ?").get(item.user) || {};
    const now = new Date().toISOString();
    const previous = decayTransientRelationship(rawPrevious, now);
    const seenCount = Number(user.seen_count || 0);
    const familiarity = Math.min(1, Math.sqrt(seenCount) / Math.sqrt(24));
    const positive = item.type === "gift" || item.type === "superchat" || item.type === "guard" || /加油|谢谢|支持|辛苦|厉害|我喜欢你|喜欢主播/.test(item.text);
    const hostile = /笨|菜|垃圾|闭嘴|吵死/.test(item.text);
    const vulnerable = /难过|焦虑|害怕|累|压力|失眠|不开心/.test(item.text);
    const repeatStrikes = Math.max(0, Number(previous.repeat_strikes || 0) + (Number(item.repeatCount || 0) >= 2 ? 1 : -1));
    const affinityDelta = hostile ? -0.12 : positive ? 0.045 : 0.001;
    const affinity = Math.max(-1, Math.min(1, Number(previous.affinity || 0) + affinityDelta));
    const trust = clamp(Number(previous.trust ?? 0.35) + (hostile ? -0.08 : positive ? 0.035 : vulnerable ? 0.025 : 0.002));
    const comfort = clamp(Number(previous.comfort ?? 0.35) + (hostile ? -0.1 : positive ? 0.025 : vulnerable ? 0.04 : 0.002));
    const boundaryPressure = clamp(Number(previous.boundary_pressure || 0) + (hostile ? 0.16 : Number(item.repeatCount || 0) >= 2 ? 0.1 : -0.025));
    const nameFact = this.getUserFacts(item.user).find(fact => fact.text.startsWith("自称 "));
    const preferredName = nameFact?.text.slice(3) || previous.preferred_name || null;
    const lastTopic = extractTopic(item.text) || previous.last_topic || null;
    this.db.prepare(`INSERT INTO user_relationships(user_name, familiarity, affinity, trust, comfort, boundary_pressure, repeat_strikes, preferred_name, last_topic, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(user_name) DO UPDATE SET familiarity = excluded.familiarity, affinity = excluded.affinity,
      trust = excluded.trust, comfort = excluded.comfort, boundary_pressure = excluded.boundary_pressure, repeat_strikes = excluded.repeat_strikes,
      preferred_name = excluded.preferred_name, last_topic = excluded.last_topic, updated_at = excluded.updated_at`)
      .run(item.user, familiarity, affinity, trust, comfort, boundaryPressure, repeatStrikes, preferredName, lastTopic, now);
  }

  getSessionMessagesForUser(userName, limit = 4) {
    return this.db.prepare(`SELECT at, user_name AS user, text, reply FROM session_messages
      WHERE session_id = ? AND user_name = ? ORDER BY id DESC LIMIT ?`).all(this.ensureActiveSession(), userName, limit).reverse();
  }

  retrieveForReply(item, { factLimit = 5, sessionLimit = 4, worldLimit = 2 } = {}) {
    const allUserFacts = this.getUserFacts(item.user);
    const eligibleFacts = allUserFacts.filter(fact => assessMemoryQuality(fact).length === 0);
    const userFacts = semanticRank(item.text, eligibleFacts, factLimit);
    if (userFacts.length) {
      const now = new Date().toISOString();
      const touch = this.db.prepare("UPDATE memories SET access_count = access_count + 1, last_accessed_at = ? WHERE id = ?");
      for (const fact of userFacts) touch.run(now, fact.id);
    }
    const sessionMessages = this.getSessionMessagesForUser(item.user, sessionLimit);
    const worldBook = selectWorldBook(item.text, worldLimit);
    const topics = this.getRecentTopics(3);
    const relationship = this.getRelationship(item.user);
    const characterReflections = this.getCharacterReflections(3);
    return {
      userFacts,
      sessionMessages,
      worldBook,
      topics,
      relationship,
      characterReflections,
      debug: {
        strategy: "hybrid-semantic-v3-with-rejection",
        selectedFacts: userFacts.length,
        excludedLowQuality: allUserFacts.length - eligibleFacts.length,
        selectedConcepts: conceptsFor(item.text),
        temporalIntent: temporalIntent(item.text),
        selectedSessionMessages: sessionMessages.length,
        selectedWorldEntries: worldBook.map(entry => entry.key),
        selectedReflections: characterReflections.length,
        excludedPrivate: true,
        relationship
      }
    };
  }

  remember(item, reply, emotionalContext = {}) {
    const now = new Date().toISOString();
    const sessionId = this.ensureActiveSession();
    const storedText = redactSensitiveText(item.text);
    this.expireMemories(now);
    let seenCount = 0;
    let extracted = [];
    this.withTransaction(() => {
      const emotion = emotionalContext.emotion || {};
      this.db.prepare(`INSERT INTO session_messages(session_id, at, user_name, text, reply, training_hint,
        emotion_name, emotion_intensity, affect_json, appraisal_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        sessionId, now, item.user, storedText, reply, item.training ? 1 : 0,
        emotion.name || null, Number.isFinite(Number(emotion.intensity)) ? Number(emotion.intensity) : null,
        emotion.affect ? JSON.stringify(emotion.affect) : null, emotion.appraisal ? JSON.stringify(emotion.appraisal) : null
      );
      const user = this.db.prepare("SELECT seen_count, first_seen_at FROM users WHERE user_name = ?").get(item.user);
      this.upsertUser(item.user, Number(user?.seen_count || 0) + 1, user?.first_seen_at || now, now);
      // Ordinary conversation remains session-only. Only an explicit memory command
      // or a later reviewed candidate may cross into long-term memory.
      const explicit = item.training ? null : extractTrainingMemory(item.text);
      const confirmedFacts = explicit ? extractFacts(explicit.confirmedText).map(memory => ({
        ...memory, source: item.text, confidence: Math.max(0.94, memory.confidence), expiresAt: null
      })) : [];
      extracted = explicit ? (confirmedFacts.length ? confirmedFacts : [explicit]).filter(memory => !containsMemoryInstructionInjection(memory.content)) : [];
      for (const memory of extracted) {
        const conflicts = this.resolveConflicts(item.user, memory);
        const memoryId = this.insertMemory({ ...memory, scope: "user", userName: item.user, importance: memory.importance ?? 0.65, supersedesMemoryId: conflicts[0] || null });
        this.addEvidence(memoryId, item.text, now, memory.confidence);
        this.audit("memory-observed", memoryId, item.user, memory.content);
      }
      this.db.prepare("INSERT INTO stream_events(session_id, at, type, user_name, text) VALUES (?, ?, ?, ?, ?)").run(sessionId, now, item.type || "chat", item.user, storedText);
      const topic = extractTopic(item.text);
      if (topic) this.db.prepare("INSERT INTO stream_topics(session_id, at, text) VALUES (?, ?, ?)").run(sessionId, now, topic);
      const updatedUser = this.db.prepare("SELECT seen_count FROM users WHERE user_name = ?").get(item.user);
      seenCount = Number(updatedUser?.seen_count || 0);
      this.updateRelationship(item, updatedUser);
      this.trimTables();
    });
    this.refreshSnapshot();
    if (extracted.some(memory => memory.kind === "training")) this.exportTrainingLedger();
    if (seenCount > 0 && seenCount % 8 === 0) this.recordUserEpisode(item.user);
  }

  trimTables() {
    this.db.exec("DELETE FROM session_messages WHERE id NOT IN (SELECT id FROM session_messages ORDER BY id DESC LIMIT 3000)");
    this.db.exec("DELETE FROM stream_events WHERE id NOT IN (SELECT id FROM stream_events ORDER BY id DESC LIMIT 6000)");
    this.db.exec("DELETE FROM stream_topics WHERE id NOT IN (SELECT id FROM stream_topics ORDER BY id DESC LIMIT 600)");
    this.db.exec("DELETE FROM memory_audit WHERE id NOT IN (SELECT id FROM memory_audit ORDER BY id DESC LIMIT 10000)");
    this.db.exec(`DELETE FROM memory_candidates WHERE status <> 'pending' AND id NOT IN
      (SELECT id FROM memory_candidates WHERE status <> 'pending' ORDER BY id DESC LIMIT 2000)`);
  }

  deleteUserMemories(userName) {
    this.withTransaction(() => {
      this.db.prepare("DELETE FROM memories WHERE user_name = ?").run(userName);
      this.db.prepare("DELETE FROM session_messages WHERE user_name = ?").run(userName);
      this.db.prepare("DELETE FROM stream_events WHERE user_name = ?").run(userName);
      this.db.prepare("DELETE FROM memory_candidates WHERE user_name = ?").run(userName);
      this.db.prepare("DELETE FROM memory_audit WHERE user_name = ?").run(userName);
      this.db.prepare("DELETE FROM user_relationships WHERE user_name = ?").run(userName);
      this.db.prepare("DELETE FROM users WHERE user_name = ?").run(userName);
      this.audit("user-forgotten", null, null, "one user requested complete local deletion");
    });
    this.refreshSnapshot();
    this.exportTrainingLedger();
  }

  getStatus() {
    const count = sql => Number(this.db.prepare(sql).get().count);
    return {
      provider: "sqlite", databasePath: this.databasePath, schemaVersion: this.getMeta("schema_version") || "1",
      migratedAt: this.getMeta("legacy_json_migrated_at"),
      session: this.getSessionStatus(),
      counts: { users: count("SELECT COUNT(*) AS count FROM users"), memories: count("SELECT COUNT(*) AS count FROM memories WHERE status = 'active'"),
        staleMemories: count("SELECT COUNT(*) AS count FROM memories WHERE status = 'stale'"), evidence: count("SELECT COUNT(*) AS count FROM memory_evidence"),
        audits: count("SELECT COUNT(*) AS count FROM memory_audit"), relationships: count("SELECT COUNT(*) AS count FROM user_relationships"), sessionMessages: count("SELECT COUNT(*) AS count FROM session_messages"), streamEvents: count("SELECT COUNT(*) AS count FROM stream_events") }
    };
  }

  getRecentAudit(limit = 12) {
    return this.db.prepare(`SELECT at, action, user_name AS user, detail FROM memory_audit
      ORDER BY id DESC LIMIT ?`).all(limit).reverse();
  }

  integrityCheck() {
    const result = this.db.prepare("PRAGMA quick_check").all().map(row => Object.values(row)[0]);
    return { ok: result.length === 1 && result[0] === "ok", result };
  }

  withTransaction(work) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  refreshSnapshot() {
    const users = {};
    for (const user of this.db.prepare("SELECT user_name, seen_count, first_seen_at, last_seen_at FROM users ORDER BY last_seen_at DESC").all()) {
      users[user.user_name] = { seen: user.seen_count, firstSeen: user.first_seen_at, lastSeen: user.last_seen_at, facts: this.getUserFacts(user.user_name) };
    }
    const session = this.getSessionStatus();
    this.shortTerm = this.db.prepare("SELECT at, user_name AS user, text, reply FROM session_messages WHERE session_id = ? ORDER BY id DESC LIMIT 20").all(session.id).reverse();
    this.data = {
      users, session: { shortTerm: this.shortTerm, startedAt: session.startedAt, id: session.id },
      stream: { events: this.db.prepare("SELECT at, type, user_name AS user, text FROM stream_events WHERE session_id = ? ORDER BY id DESC LIMIT 80").all(session.id).reverse(), topics: this.db.prepare("SELECT at, text FROM stream_topics WHERE session_id = ? ORDER BY id DESC LIMIT 12").all(session.id).reverse() },
      character: defaultMemory().character
    };
  }

  close() { this.db.close(); }
}

function extractFact(text) {
  return extractFacts(text)[0] || null;
}

function extractFacts(text) {
  const now = new Date().toISOString();
  if (containsSensitiveClaim(text)) return [];
  const facts = [];
  if (/我[^，。！!？?]{0,18}(?:在练|练习|正在打)[^，。！!？?]*(?:HR|Hard Rock)/i.test(text)) facts.push(fact("在练 Hard Rock", text, now, 0.9, 180));
  if (/我[^，。！!？?]{0,18}(?:在练|练习|正在打)[^，。！!？?]*(?:DT|Double Time)/i.test(text)) facts.push(fact("在练 Double Time", text, now, 0.9, 180));
  if (/我[^，。！!？?]{0,18}(?:在练|练习|正在打|喜欢玩)[^，。！!？?]*osu/i.test(text)) facts.push(fact("在练或喜欢 osu!", text, now, 0.86, 180));
  if (/^(?:我是)?(?:第一次来|新粉|新人)/.test(text)) facts.push(fact("第一次来到直播间", text, now, 0.78, 30));
  const nameMatch = text.match(/(?:我叫|我是|可以叫我|我以后叫|以后叫我)\s*([^，。！!？?\s]{1,16})/);
  if (nameMatch) facts.push(fact(`自称 ${nameMatch[1]}`, text, now, 0.88, null));
  const favoriteMatch = text.match(/(?:我喜欢|最喜欢)\s*([^，。！!？?]{2,24})/);
  if (favoriteMatch) facts.push(fact(`喜欢 ${favoriteMatch[1]}`, text, now, 0.76, 180));
  const dislikeMatch = text.match(/(?:我不喜欢|最不喜欢)\s*([^，。！!？?]{2,24})/);
  if (dislikeMatch) facts.push(fact(`不喜欢 ${dislikeMatch[1]}`, text, now, 0.78, 180));
  return [...new Map(facts.map(item => [item.content, item])).values()];
}

function extractTrainingMemory(text) {
  const source = String(text || "").trim();
  if (containsSensitiveClaim(source)) return null;
  const match = source.match(/^(?:请)?(?:你)?(?:记住|记下|训练记录|长期记忆|我们约定)[：:]?\s*(.{3,700})$/);
  if (!match) return null;
  const now = new Date().toISOString();
  const confirmedText = match[1].trim();
  return { kind: "training", content: `训练记忆：${confirmedText}`, confirmedText, source, createdAt: now, lastConfirmedAt: now, confidence: 0.96, importance: 0.98, expiresAt: null };
}

function extractTopic(text) {
  if (/歌曲|音乐|P主|创作|调教/.test(text)) return "音乐与创作";
  if (/osu|打图|谱面|HR|DT|miss|acc/i.test(text)) return "音乐游戏";
  if (/项目|代码|开发|学习|课程|考试|工作|论文/.test(text)) return "学习与项目";
  if (/难过|焦虑|害怕|压力|失眠|孤独|开心|失望|累/.test(text)) return "情绪与近况";
  if (/记得|上次|以前|共同经历|我们约定/.test(text)) return "共同经历";
  if (/今天|吃饭|喝水|睡觉|通勤|天气|休息/.test(text)) return "日常生活";
  if (/争议|吵|黑|讨厌/.test(text)) return "不同意见";
  if (/直播|弹幕|观众/.test(text)) return "直播互动";
  return null;
}

function selectWorldBook(text, limit) {
  const normalized = String(text || "").toLowerCase();
  const worldBook = Array.isArray(PERSONA.worldBook) ? PERSONA.worldBook : [];
  const ranked = worldBook
    .map(entry => ({ entry, score: (entry.keywords || []).reduce((score, keyword) => score + (normalized.includes(keyword.toLowerCase()) ? 1 : 0), 0) }))
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.entry);
  return (ranked.length ? ranked : worldBook.slice(0, 1)).filter(Boolean).slice(0, limit);
}

function containsSensitiveClaim(text) {
  const source = String(text || "");
  return /(?:手机号|电话|微信(?:号)?|QQ(?:号)?|住在|详细地址|身份证|银行卡|密码|验证码)/i.test(source)
    || /(?:^|\D)1[3-9]\d{9}(?:\D|$)/.test(source)
    || /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/i.test(source)
    || /(?:^|\D)\d{17}[\dXx](?:\D|$)/.test(source)
    || /(?:^|\D)\d{16,19}(?:\D|$)/.test(source);
}

function redactSensitiveText(text) {
  return containsSensitiveClaim(text) ? "[包含敏感个人信息，原文未落盘]" : String(text || "");
}

function normalizeMemoryText(text) { return String(text || "").toLowerCase().replace(/[\s，。！？、：；,.!?;:'"“”‘’（）()\[\]]/g, ""); }
function identityKey(text) {
  const source = String(text || "");
  if (/自称|名字|叫/.test(source)) return "identity:name";
  if (/项目目标|创造.{0,8}(?:原因|目的)|开发目标/.test(source)) return "identity:project-goal";
  const preference = source.match(/^(不喜欢|喜欢)\s*(.{2,40})$/);
  if (preference) return `preference:${normalizeMemoryText(preference[2])}`;
  return null;
}

function fact(content, source, createdAt, confidence, expiresInDays) {
  return {
    kind: "fact", content, source, createdAt, lastConfirmedAt: createdAt, confidence,
    expiresAt: expiresInDays ? new Date(Date.parse(createdAt) + expiresInDays * 86_400_000).toISOString() : null
  };
}

function decayTransientRelationship(profile = {}, now = new Date().toISOString()) {
  const elapsed = Date.parse(now) - Date.parse(profile.updated_at || now);
  const days = Number.isFinite(elapsed) ? Math.max(0, elapsed / 86_400_000) : 0;
  const boundaryDecay = Math.exp(-days / 3);
  const repetitionDecay = Math.exp(-days / 2);
  const familiarityRecency = 0.8 + 0.2 * Math.exp(-days / 120);
  return {
    ...profile,
    familiarity: Math.max(0, Math.min(1, Number(profile.familiarity || 0) * familiarityRecency)),
    boundary_pressure: Math.max(0, Math.min(1, Number(profile.boundary_pressure || 0) * boundaryDecay)),
    repeat_strikes: Math.max(0, Number(profile.repeat_strikes || 0) * repetitionDecay),
    daysSinceInteraction: Number(days.toFixed(2))
  };
}

function clamp(value) { return Math.max(0, Math.min(1, Number(value.toFixed(3)))); }

module.exports = { MemoryStore, extractFact, extractFacts, extractTrainingMemory, extractTopic, normalizeMemoryText, identityKey, decayTransientRelationship, containsSensitiveClaim, redactSensitiveText, MEMORY_PATH, DATABASE_PATH, BACKUP_PATH, TRAINING_LEDGER_PATH };
