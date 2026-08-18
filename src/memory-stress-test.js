const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { MemoryStore } = require("./brain/memory");

const databasePath = path.join(__dirname, "..", "runtime", "memory-stress.db");
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });

const store = new MemoryStore({ databasePath, legacyPath: path.join(__dirname, "..", "runtime", "missing-legacy.json") });
const started = performance.now();
for (let index = 0; index < 1000; index += 1) {
  store.remember({
    user: `压力观众${index % 40}`,
    text: index % 7 === 0 ? "请记住：我在练 osu Hard Rock" : `第 ${index} 条普通互动`,
    type: index % 23 === 0 ? "gift" : "chat",
    repeatCount: 0
  }, "收到啦。");
}
const elapsedMs = Math.round(performance.now() - started);
const status = store.getStatus();
assert.equal(store.integrityCheck().ok, true);
assert.equal(status.counts.users, 40);
assert.equal(status.session.messageCount, 1000);
// A compound utterance may create several distinct facts; deduplication should
// still keep growth bounded to a small constant per viewer.
assert.ok(status.counts.memories <= 160);
const repeatedId = store.insertMemory({ scope: "user", userName: "压力观众0", kind: "fact", content: "证据容量测试", source: "test", confidence: 0.7, importance: 0.5, createdAt: new Date().toISOString() });
for (let index = 0; index < 80; index += 1) store.addEvidence(repeatedId, `证据 ${index}`, new Date(Date.now() + index).toISOString(), 0.7);
assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM memory_evidence WHERE memory_id = ?").get(repeatedId).count, 50);
console.log(`Memory stress test passed: 1000 writes in ${elapsedMs}ms; ${status.counts.users} users; integrity ok.`);
store.close();
for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
