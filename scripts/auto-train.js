/**
 * auto-train.js —— 一键自动训练器
 *
 * 读取 data/training-plan.json 训练剧本，对运行中的主播执行：
 *   1. 灌输：确定性的知识直接写入长期记忆（/api/memory/train）
 *   2. 对话训练：剧本场景变成观众弹幕 -> 主播真实回复 -> 会话结束提炼候选
 *      -> 高置信且有观众原话证据的候选自动确认，低置信的留在工作台待人工审
 *   3. 归档：结束训练会话，生成训练报告 runtime/auto-train-report.json
 *
 * 用法：npm run train:auto  （或 node scripts/auto-train.js）
 * 可选环境变量：TRAIN_BASE_URL（默认 http://127.0.0.1:3000）
 */
const fs = require("fs");
const path = require("path");

const BASE = (process.env.TRAIN_BASE_URL || "http://127.0.0.1:3000").replace(/\/$/, "");
const PLAN_PATH = path.join(__dirname, "..", "data", "training-plan.json");
const REPORT_PATH = path.join(__dirname, "..", "runtime", "auto-train-report.json");

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(pathname, body) {
  const response = await fetch(`${BASE}${pathname}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body || {})
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${pathname} HTTP ${response.status}: ${JSON.stringify(data).slice(0, 220)}`);
  return data;
}

async function main() {
  const plan = JSON.parse(fs.readFileSync(PLAN_PATH, "utf8"));
  const policy = plan.confirmPolicy || { minConfidence: 0.8, requireEvidence: true };
  const report = {
    startedAt: new Date().toISOString(),
    meta: plan.meta,
    policy,
    injects: [],
    conversations: [],
    errors: []
  };

  console.log(`[auto-train] 开始：${plan.meta.name}`);
  console.log(`[auto-train] 确认策略：置信度 >= ${policy.minConfidence} 且有观众原话证据的候选自动确认`);

  // ---------- 阶段 1：直接灌输 ----------
  console.log("\n=== 阶段 1：灌输确定性知识 ===");
  for (const item of plan.injects || []) {
    const user = item.user || "训练者";
    const scope = item.scope || "user";
    try {
      const result = await api("/api/memory/train", {
        user,
        text: item.text,
        scope,
        title: item.title || null
      });
      report.injects.push({ ...item, ok: true, memoryId: result.memoryId });
      console.log(`  [OK] #${result.memoryId} ${scope}${scope === "user" ? `/${user}` : ""}: ${item.text.slice(0, 36)}...`);
    } catch (error) {
      report.injects.push({ ...item, ok: false, error: error.message });
      report.errors.push(`inject(${item.text.slice(0, 20)}): ${error.message}`);
      console.warn(`  [失败] ${error.message}`);
    }
    await sleep(150);
  }

  // ---------- 阶段 2 前置：归档旧会话，隔离训练内容 ----------
  // 训练弹幕带 training:true 会打训练标记；若不归档，旧会话里堆积的历史训练弹幕
  // 会混入本轮提炼，造成重复记忆。先结束旧会话，让训练发生在一个全新会话中。
  console.log("\n=== 阶段 2 前置：归档旧会话 ===");
  try {
    const archived = await api("/api/session/end", {});
    report.archivedPreviousSession = archived.ended;
    console.log(`  [OK] 已归档旧会话：${archived.ended?.id}（${archived.ended?.summary || ""}）`);
  } catch (error) {
    report.errors.push(`session/end(pre-train): ${error.message}`);
    console.warn(`  [警告] 旧会话归档失败，训练内容可能混入历史弹幕：${error.message}`);
  }

  // ---------- 阶段 2：对话训练 ----------
  console.log("\n=== 阶段 2：对话训练 ===");
  for (const convo of plan.conversations || []) {
    const record = { title: convo.title, rounds: [], candidates: [], autoApproved: [], pending: [] };
    console.log(`\n--- 对话：${convo.title} ---`);
    try {
      for (const round of convo.rounds || []) {
        const posted = await api("/api/danmaku", {
          user: round.user, text: round.text, type: "chat", training: true
        });
        if (posted.suppressed) {
          record.rounds.push({ ...round, skipped: true, reason: "duplicate-suppressed" });
          console.warn(`  [跳过-重复抑制] ${round.user}: ${round.text.slice(0, 20)}`);
          continue;
        }
        let reply = null;
        for (let attempt = 0; attempt < 6; attempt += 1) {
          const next = await api("/api/next", { preferFresh: true });
          if (!next.idle) { reply = next.reply; break; }
          await sleep(1500);
        }
        record.rounds.push({ ...round, reply: reply ? { text: reply.text, emotion: reply.emotion?.name } : null });
        console.log(`  观众 ${round.user}: ${round.text}`);
        if (reply) console.log(`  └ 主播: ${reply.text.slice(0, 56)}`);
        await sleep(400);
      }

      // 提炼本段会话候选
      const generated = await api("/api/memory/candidates/generate", {});
      record.candidates = generated.candidates || [];
      const auto = [];
      for (const candidate of record.candidates) {
        const hasEvidence = (candidate.evidenceMessageIds || []).length > 0;
        const highConfidence = Number(candidate.confidence) >= Number(policy.minConfidence ?? 0.8);
        if ((!policy.requireEvidence || hasEvidence) && highConfidence) auto.push(candidate);
      }
      if (auto.length) {
        const commit = await api("/api/memory/candidates/commit", {
          items: auto.map(candidate => ({
            id: candidate.id,
            selected: true,
            scope: candidate.scope,
            user: candidate.user || "训练者",
            content: candidate.content
          }))
        });
        record.autoApproved = (commit.result?.approved || []).map(item => ({
          memoryId: item.memoryId, content: item.content
        }));
      }
      record.pending = record.candidates
        .filter(candidate => !auto.includes(candidate))
        .map(candidate => ({
          id: candidate.id, scope: candidate.scope, user: candidate.user,
          content: candidate.content, confidence: candidate.confidence,
          reason: candidate.reason
        }));
      report.conversations.push(record);
      console.log(`  [提炼] 候选 ${record.candidates.length} 条 -> 自动确认 ${record.autoApproved.length} 条，留待人工 ${record.pending.length} 条`);
    } catch (error) {
      report.errors.push(`conversation(${convo.title}): ${error.message}`);
      report.conversations.push(record);
      console.warn(`  [失败] ${error.message}`);
    }
  }

  // ---------- 阶段 3：归档训练会话 ----------
  console.log("\n=== 阶段 3：归档训练会话 ===");
  try {
    const ended = await api("/api/session/end", {});
    report.session = ended.ended;
    console.log(`  [OK] 训练会话已归档：${ended.ended?.id}（${ended.ended?.summary || ""}）`);
  } catch (error) {
    report.errors.push(`session/end: ${error.message}`);
    console.warn(`  [失败] ${error.message}`);
  }

  // ---------- 汇总 ----------
  report.finishedAt = new Date().toISOString();
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  try {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2), "utf8");
    console.log(`  报告：${REPORT_PATH}`);
  } catch (error) {
    report.reportWriteError = error.message;
    console.warn(`  [警告] 报告文件写入失败（不影响记忆数据）：${error.message}`);
  }

  const injectedOk = report.injects.filter(item => item.ok).length;
  const autoApproved = report.conversations.reduce((sum, convo) => sum + convo.autoApproved.length, 0);
  const pendingCount = report.conversations.reduce((sum, convo) => sum + convo.pending.length, 0);
  console.log("\n=== 训练完成 ===");
  console.log(`  灌输写入：${injectedOk}/${report.injects.length} 条`);
  console.log(`  对话训练：${report.conversations.length} 段，自动确认 ${autoApproved} 条记忆`);
  console.log(`  待人工确认：${pendingCount} 条（打开 /studio.html 的「记忆训练」页审阅）`);
  if (report.errors.length) console.warn(`  警告 ${report.errors.length} 条：${report.errors.join(" | ")}`);
}

main().catch(error => {
  console.error("[auto-train] 致命错误:", error);
  process.exit(1);
});
