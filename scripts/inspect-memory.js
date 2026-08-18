/**
 * inspect-memory.js —— 只读诊断：检查记忆候选表状态与本次训练写入情况。
 * 用法：node scripts/inspect-memory.js
 */
const { DatabaseSync } = require("node:sqlite");
const path = require("path");

const db = new DatabaseSync(path.join(__dirname, "..", "data", "memory.db"), { readOnly: true });

console.log("=== memory_candidates 状态分布 ===");
console.log(JSON.stringify(db.prepare("SELECT status, COUNT(*) AS n FROM memory_candidates GROUP BY status").all(), null, 2));

console.log("\n=== 候选表最近 30 条（含 scope/user/置信度）===");
console.log(JSON.stringify(db.prepare(`SELECT id, session_id AS session, scope, user_name AS user,
  substr(content,1,60) AS content, confidence, importance, status,
  substr(created_at,1,19) AS created
  FROM memory_candidates ORDER BY id DESC LIMIT 30`).all(), null, 2));

console.log("\n=== 星野/小白/Maple/路人 名下的记忆 ===");
console.log(JSON.stringify(db.prepare(`SELECT id, scope, user_name AS user, kind, substr(content,1,70) AS content,
  substr(created_at,1,19) AS created FROM memories
  WHERE user_name IN ('星野','小白','Maple','路人') ORDER BY id`).all(), null, 2));

console.log("\n=== 2026-08-17 之后写入的训练记忆 ===");
console.log(JSON.stringify(db.prepare(`SELECT id, scope, user_name AS user, kind, substr(content,1,70) AS content,
  substr(created_at,1,19) AS created FROM memories
  WHERE created_at >= '2026-08-17T00:00:00Z' ORDER BY id`).all(), null, 2));

console.log("\n=== 记忆总数与最近 5 条 ===");
console.log(JSON.stringify(db.prepare("SELECT COUNT(*) AS total FROM memories").get(), null, 2));
console.log(JSON.stringify(db.prepare(`SELECT id, scope, user_name AS user, kind, substr(content,1,50) AS content,
  substr(created_at,1,19) AS created FROM memories ORDER BY id DESC LIMIT 5`).all(), null, 2));

db.close();
