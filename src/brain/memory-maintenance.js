const { normalizeMemoryText, identityKey } = require("./memory");
const { assessMemoryQuality } = require("./memory-quality");

function analyzeMemoryHealth(store) {
  const rows = store.db.prepare(`SELECT id, scope, user_name AS user, kind, content, confidence, importance,
    created_at AS createdAt, last_confirmed_at AS lastConfirmedAt, access_count AS accessCount,
    last_accessed_at AS lastAccessedAt,
    (SELECT COUNT(*) FROM memory_evidence evidence WHERE evidence.memory_id = memories.id) AS evidenceCount
    FROM memories WHERE status = 'active' ORDER BY id`).all();
  const exactGroups = groupExact(rows);
  const nearDuplicates = findNearDuplicates(rows);
  const conflicts = findConflicts(rows);
  const now = Date.now();
  const cold = rows.filter(row => ageDays(row.lastConfirmedAt || row.createdAt, now) > 30 && !row.accessCount && row.importance < 0.7 && row.kind !== "training");
  const unverified = rows.filter(row => ["fact", "training"].includes(row.kind) && row.evidenceCount === 0);
  const evidenced = rows.filter(row => row.evidenceCount > 0);
  const recalled = rows.filter(row => row.accessCount > 0);
  const lowQuality = rows.map(row => ({ ...row, qualityReasons: assessMemoryQuality(row) })).filter(row => row.qualityReasons.length);
  const candidateStats = store.db.prepare(`SELECT
    SUM(CASE WHEN status = 'pending' THEN 1 ELSE 0 END) AS pending,
    SUM(CASE WHEN status = 'approved' THEN 1 ELSE 0 END) AS approved,
    SUM(CASE WHEN status = 'rejected' THEN 1 ELSE 0 END) AS rejected,
    SUM(CASE WHEN status = 'pending' AND duplicate_memory_id IS NOT NULL THEN 1 ELSE 0 END) AS pendingDuplicates,
    SUM(CASE WHEN status = 'pending' AND conflict_memory_id IS NOT NULL THEN 1 ELSE 0 END) AS pendingConflicts
    FROM memory_candidates`).get();
  const penalty = exactGroups.reduce((sum, group) => sum + group.ids.length - 1, 0) * 4 + nearDuplicates.length * 2 + conflicts.length * 7 + unverified.length * 3;
  return {
    score: Math.max(0, Math.min(100, 100 - penalty)),
    generatedAt: new Date().toISOString(),
    counts: { active: rows.length, exactDuplicateGroups: exactGroups.length, nearDuplicates: nearDuplicates.length, conflicts: conflicts.length, cold: cold.length, unverified: unverified.length, lowQuality: lowQuality.length },
    coverage: {
      evidencePercent: rows.length ? Math.round(evidenced.length / rows.length * 100) : 100,
      recalledPercent: rows.length ? Math.round(recalled.length / rows.length * 100) : 0,
      averageEvidence: rows.length ? round(rows.reduce((sum, row) => sum + row.evidenceCount, 0) / rows.length) : 0
    },
    candidates: Object.fromEntries(Object.entries(candidateStats).map(([key, value]) => [key, Number(value || 0)])),
    exactDuplicates: exactGroups.slice(0, 30), nearDuplicates: nearDuplicates.slice(0, 30), conflicts: conflicts.slice(0, 30),
    cold: cold.slice(0, 30).map(summary), unverified: unverified.slice(0, 30).map(summary), lowQuality: lowQuality.slice(0, 30).map(row => ({ ...summary(row), reasons: row.qualityReasons })),
    retention: { evidencePerMemory: 50, activeCharacterReflections: 120, resolvedCandidates: 2000, auditEntries: 10000, sessionMessages: 3000, policy: "human-approved memories are never automatically forgotten" }
  };
}

function consolidateExactDuplicates(store, { apply = false } = {}) {
  const report = analyzeMemoryHealth(store);
  if (!apply) return { applied: false, groups: report.exactDuplicates, merged: 0 };
  let merged = 0;
  for (const group of report.exactDuplicates) {
    const records = store.db.prepare(`SELECT * FROM memories WHERE id IN (${group.ids.map(() => "?").join(",")})`).all(...group.ids)
      .sort((a, b) => b.importance - a.importance || b.confidence - a.confidence || a.id - b.id);
    const winner = records[0];
    for (const duplicate of records.slice(1)) {
      store.db.prepare("UPDATE memory_evidence SET memory_id = ? WHERE memory_id = ?").run(winner.id, duplicate.id);
      store.db.prepare("UPDATE memories SET status = 'forgotten', supersedes_memory_id = ? WHERE id = ?").run(winner.id, duplicate.id);
      store.audit("exact-duplicate-merged", duplicate.id, duplicate.user_name, `merged into ${winner.id}`);
      merged += 1;
    }
    store.db.prepare(`UPDATE memories SET confidence = MAX(confidence, ?), importance = MAX(importance, ?),
      access_count = access_count + ?, last_confirmed_at = MAX(COALESCE(last_confirmed_at, ''), ?) WHERE id = ?`)
      .run(...records.slice(1).reduce((acc, row) => [Math.max(acc[0], row.confidence), Math.max(acc[1], row.importance), acc[2] + row.access_count, maxDate(acc[3], row.last_confirmed_at)], [winner.confidence, winner.importance, 0, winner.last_confirmed_at || winner.created_at]), winner.id);
  }
  store.refreshSnapshot();
  store.exportTrainingLedger();
  return { applied: true, merged, health: analyzeMemoryHealth(store) };
}

function groupExact(rows) {
  const groups = new Map();
  for (const row of rows) {
    const key = [row.scope, row.user || "", row.kind, normalizeMemoryText(row.content)].join("|");
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(row);
  }
  return [...groups.values()].filter(group => group.length > 1).map(group => ({ ids: group.map(row => row.id), scope: group[0].scope, user: group[0].user, kind: group[0].kind, content: group[0].content }));
}

function findNearDuplicates(rows) {
  const output = [];
  for (let left = 0; left < rows.length; left += 1) for (let right = left + 1; right < rows.length; right += 1) {
    const a = rows[left], b = rows[right];
    if (a.scope !== b.scope || a.user !== b.user || a.kind !== b.kind) continue;
    const score = bigramJaccard(a.content, b.content);
    if (score >= 0.68 && normalizeMemoryText(a.content) !== normalizeMemoryText(b.content)) output.push({ left: summary(a), right: summary(b), score: round(score) });
  }
  return output.sort((a, b) => b.score - a.score);
}

function findConflicts(rows) {
  const grouped = new Map();
  for (const row of rows) {
    const key = identityKey(row.content);
    if (!key) continue;
    const group = [row.scope, row.user || "", key].join("|");
    if (!grouped.has(group)) grouped.set(group, []);
    grouped.get(group).push(row);
  }
  return [...grouped.entries()].filter(([, values]) => new Set(values.map(row => normalizeMemoryText(row.content))).size > 1)
    .map(([key, values]) => ({ key, memories: values.map(summary), requiresHumanReview: true }));
}

function bigramJaccard(left, right) { const a = grams(left), b = grams(right); if (!a.size || !b.size) return 0; let shared = 0; for (const value of a) if (b.has(value)) shared += 1; return shared / new Set([...a, ...b]).size; }
function grams(text) { const source = normalizeMemoryText(text); const values = new Set(); for (let index = 0; index < source.length - 1; index += 1) values.add(source.slice(index, index + 2)); return values; }
function summary(row) { return { id: row.id, scope: row.scope, user: row.user, kind: row.kind, content: row.content, confidence: row.confidence, importance: row.importance, accessCount: row.accessCount, evidenceCount: row.evidenceCount }; }
function ageDays(value, now) { const parsed = Date.parse(value || 0); return Number.isFinite(parsed) ? Math.max(0, (now - parsed) / 86_400_000) : 0; }
function maxDate(left, right) { return Date.parse(left || 0) >= Date.parse(right || 0) ? left : right; }
function round(value) { return Number(value.toFixed(3)); }

module.exports = { analyzeMemoryHealth, consolidateExactDuplicates, bigramJaccard, assessMemoryQuality };
