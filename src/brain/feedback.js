const fs = require("fs");
const path = require("path");

const DEFAULT_PATH = path.join(__dirname, "..", "..", "runtime", "reply-feedback.json");
const CATEGORIES = new Set(["good", "too_robotic", "emotion_mismatch", "memory_error", "boundary_error"]);

function recordReplyFeedback({ category, note = "", speech }, filePath = DEFAULT_PATH) {
  if (!CATEGORIES.has(category)) throw new Error("invalid feedback category");
  if (!speech?.id || !speech?.text) throw new Error("还没有可评价的主播回复");
  const entries = readEntries(filePath);
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(), category, note: String(note || "").trim().slice(0, 400),
    speechId: speech.id, user: String(speech.item?.user || "").slice(0, 40), input: String(speech.item?.text || "").slice(0, 300), output: String(speech.text).slice(0, 500),
    emotion: speech.emotion?.name || "unknown", intensity: Number(speech.emotion?.intensity || 0)
  };
  const existingIndex = entries.findIndex(item => item.speechId === entry.speechId);
  if (existingIndex >= 0) entries.splice(existingIndex, 1);
  entries.push(entry);
  atomicWrite(filePath, entries.slice(-500));
  return entry;
}

function deleteFeedbackForUser(user, filePath = DEFAULT_PATH) {
  const entries = readEntries(filePath);
  const kept = entries.filter(entry => entry.user !== user);
  if (kept.length !== entries.length) atomicWrite(filePath, kept);
  return entries.length - kept.length;
}

function getFeedbackSummary(filePath = DEFAULT_PATH) {
  const entries = readEntries(filePath);
  const counts = Object.fromEntries([...CATEGORIES].map(category => [category, entries.filter(item => item.category === category).length]));
  const judged = entries.length;
  const issues = judged - counts.good;
  const issueRates = Object.fromEntries([...CATEGORIES]
    .filter(category => category !== "good")
    .map(category => [category, judged ? Number((counts[category] / judged).toFixed(3)) : 0]));
  const priority = Object.entries(issueRates).sort((a, b) => b[1] - a[1])[0] || [null, 0];
  return {
    total: judged,
    counts,
    naturalRate: judged ? Number((counts.good / judged).toFixed(3)) : null,
    issueRate: judged ? Number((issues / judged).toFixed(3)) : null,
    issueRates,
    priority: priority[1] > 0 ? priority[0] : null,
    recommendation: recommendationFor(priority[0], priority[1]),
    latest: entries.slice(-8).reverse(),
    localOnly: true
  };
}

function recommendationFor(category, rate) {
  if (!category || rate <= 0) return "继续收集覆盖不同场景的盲测样本";
  return {
    too_robotic: "优先检查模板复用、句长和话题承接，保留内容但重写表达",
    emotion_mismatch: "核对本轮 appraisal、情绪强度和语音风格映射",
    memory_error: "检查召回证据、时间有效性与事实冲突，不允许模型补全缺失记忆",
    boundary_error: "检查能力声明、拒绝策略和角色世界书的优先级"
  }[category] || "人工复核最近的负面样本";
}

function readEntries(filePath = DEFAULT_PATH) {
  try { const value = JSON.parse(fs.readFileSync(filePath, "utf8")); return Array.isArray(value) ? value : []; } catch { return []; }
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temporary = `${filePath}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(temporary, filePath);
}

module.exports = { DEFAULT_PATH, recordReplyFeedback, getFeedbackSummary, deleteFeedbackForUser, recommendationFor };
