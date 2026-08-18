/**
 * clean-duplicate-memories.js —— 清理训练产生的重复记忆变体
 *
 * 只处理 2026-08-18T01:49:00Z 之后（本轮自动训练窗口）写入的记忆：
 *   1. 按文本相似度分组（bigram 包含度 >= 0.5 视为同一事实的变体）
 *   2. 每组只保留一条（重要度 > 置信度 > id 新）
 *   3. 其余通过 /api/memory/update 标记为 forgotten（带审计，可恢复）
 *   4. 用户名为"开发者"的三条错误灌输（#43-45）直接作废
 *
 * 用法：node scripts/clean-duplicate-memories.js
 */
const path = require("path");

const BASE = (process.env.TRAIN_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const CUTOFF = process.env.CLEAN_CUTOFF || "2026-08-18T01:49:00Z";

async function listActiveMemories() {
  const response = await fetch(`${BASE}/api/memories?status=active&limit=500`);
  const data = await response.json();
  if (!response.ok) throw new Error(`list: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data;
}

async function forgetMemory(id) {
  const response = await fetch(`${BASE}/api/memory/update`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ id, status: "forgotten" })
  });
  const data = await response.json();
  if (!response.ok) throw new Error(`update #${id}: HTTP ${response.status} ${JSON.stringify(data).slice(0, 200)}`);
  return data.memory;
}

function normalize(text) {
  return String(text || "")
    .replace(/^训练记忆[：:]\s*/, "")
    .replace(/[\s，。！？、：；,.!?;:'"“”‘’（）()\[\]【】]/g, "")
    .toLowerCase();
}

function grams(text) {
  const source = normalize(text);
  const set = new Set();
  for (let index = 0; index < source.length - 1; index += 1) set.add(source.slice(index, index + 2));
  return set;
}

// 共享 bigram 数 / 较短者 bigram 数（包含度），比全集 Jaccard 更能识别长句变体
function containment(left, right) {
  const a = grams(left), b = grams(right);
  if (!a.size || !b.size) return 0;
  let shared = 0;
  for (const value of a) if (b.has(value)) shared += 1;
  return shared / Math.min(a.size, b.size);
}

async function main() {
  const memories = await listActiveMemories();
  const candidates = memories.filter(memory => memory.createdAt >= CUTOFF);
  const keep = [];
  const forget = [];
  const processed = [];

  for (const memory of candidates) {
    // 错误的开发者档案（基于项目文档的猜测，与真实信息不符）直接作废
    if (memory.user === "开发者") {
      forget.push({ id: memory.id, reason: "错误灌输（用户真实档案是秋月江心）", content: memory.content });
      continue;
    }
    let group = null;
    for (const entry of processed) {
      if (containment(memory.content, entry.content) >= 0.5) { group = entry; break; }
    }
    if (!group) {
      group = { content: memory.content, members: [] };
      processed.push(group);
    }
    group.members.push(memory);
  }

  for (const group of processed) {
    group.members.sort((a, b) =>
      (Number(b.importance || 0) - Number(a.importance || 0)) ||
      (Number(b.confidence || 0) - Number(a.confidence || 0)) ||
      (Number(b.id) - Number(a.id))
    );
    const winner = group.members[0];
    keep.push(winner);
    for (const member of group.members.slice(1)) {
      forget.push({ id: member.id, reason: `重复变体（保留 #${winner.id}）`, content: member.content });
    }
  }

  console.log(`分析 ${candidates.length} 条训练窗口记忆 -> 保留 ${keep.length} 条，作废 ${forget.length} 条`);
  for (const item of forget) {
    try {
      await forgetMemory(item.id);
      console.log(`  [作废] #${item.id} ${item.reason}: ${item.content.slice(0, 36)}...`);
    } catch (error) {
      console.warn(`  [失败] #${item.id}: ${error.message}`);
    }
  }
  console.log("\n=== 保留的记忆 ===");
  for (const item of keep) {
    console.log(`  #${item.id} [${item.scope}${item.user ? "/" + item.user : ""}] ${item.content.slice(0, 60)}`);
  }
}

main().catch(error => {
  console.error("[clean] 致命错误:", error);
  process.exit(1);
});
