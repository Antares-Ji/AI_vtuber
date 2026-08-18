const CONCEPTS = [
  { id: "music-game", pattern: /osu|谱面|打图|hr|hard rock|dt|double time|miss|acc|音乐游戏/i, aliases: ["osu", "谱面", "打图", "hr", "hardrock", "dt", "音乐游戏"] },
  { id: "music", pattern: /音乐|歌曲|翻唱|创作|p主|调教|演唱|旋律/, aliases: ["音乐", "歌曲", "翻唱", "创作", "旋律"] },
  { id: "study-work", pattern: /学习|上课|考试|作业|工作|加班|项目|论文/, aliases: ["学习", "考试", "工作", "加班", "项目"] },
  { id: "daily", pattern: /今天|睡|吃|喝|通勤|天气|休息|累|忙/, aliases: ["今天", "睡", "吃", "休息", "累", "忙"] },
  { id: "relationship", pattern: /记得|上次|我们|约定|陪伴|聊天|熟人/, aliases: ["记得", "上次", "我们", "约定", "陪伴"] },
  { id: "creative", pattern: /画|写|灵感|视频|剪辑|建模|直播/, aliases: ["画", "灵感", "剪辑", "建模", "直播"] }
];
const { BRAIN_THRESHOLDS } = require("./thresholds");

function conceptsFor(text) {
  const source = String(text || "");
  return CONCEPTS.filter(concept => concept.pattern.test(source)).map(concept => concept.id);
}

function semanticRank(query, memories, limit = 5, now = Date.now()) {
  const queryTokens = tokens(query);
  const queryConcepts = new Set(conceptsFor(query));
  const timeIntent = temporalIntent(query);
  const explicitRecall = /记得|上次|以前|我是谁|关于我|我的偏好|我喜欢什么/.test(String(query || ""));
  return memories
    .map(memory => {
      const content = `${memory.text || memory.content || ""} ${memory.source || ""}`;
      const memoryTokens = tokens(content);
      const overlap = jaccard(queryTokens, memoryTokens);
      const charOverlap = ngramOverlap(String(query || ""), content);
      const conceptOverlap = conceptsFor(content).filter(concept => queryConcepts.has(concept)).length;
      const relevance = overlap * 0.48 + charOverlap * 0.3 + Math.min(0.22, conceptOverlap * 0.18);
      const importance = Number(memory.importance || 0.5);
      const confidence = Number(memory.confidence || 0.5);
      const permanentBonus = memory.kind === "training" || memory.kind === "episode" ? 0.16 : 0;
      const confirmedAt = Date.parse(memory.lastConfirmedAt || memory.at || memory.createdAt || "");
      const ageDays = Number.isFinite(confirmedAt) ? Math.max(0, (now - confirmedAt) / 86_400_000) : 0;
      const recency = memory.kind === "training" ? 0.1 : Math.max(0, 0.12 - ageDays * 0.002);
      const evidenceStrength = Math.min(0.12, Math.log2(1 + Number(memory.evidenceCount || 0)) * 0.04);
      const retrievalPractice = Math.min(0.08, Math.log2(1 + Number(memory.accessCount || 0)) * 0.02);
      const temporalFit = timeIntent === "latest" ? Math.max(0, 0.16 - ageDays * 0.004)
        : timeIntent === "earliest" ? Math.min(0.16, ageDays * 0.0015) : 0;
      const score = relevance + importance * 0.1 + confidence * 0.08 + permanentBonus + recency + evidenceStrength + retrievalPractice + temporalFit;
      return {
        ...memory,
        relevanceScore: round(relevance), semanticScore: round(score), concepts: conceptsFor(content),
        scoreBreakdown: {
          semantic: round(relevance), importance: round(importance * 0.1), confidence: round(confidence * 0.08),
          permanence: round(permanentBonus), recency: round(recency), evidence: round(evidenceStrength), retrievalPractice: round(retrievalPractice),
          temporalIntent: timeIntent, temporalFit: round(temporalFit)
        }
      };
    })
    .filter(memory => memory.relevanceScore >= BRAIN_THRESHOLDS.memory.minimumRelevance || explicitRecall)
    .sort((a, b) => b.semanticScore - a.semanticScore || Number(b.importance || 0) - Number(a.importance || 0))
    .slice(0, limit);
}

function temporalIntent(text) {
  const source = String(text || "");
  if (/第一次|最早|起初|刚认识|一开始/.test(source)) return "earliest";
  if (/上次|最近|刚才|最新|这几天|近来/.test(source)) return "latest";
  return "none";
}

function tokens(text) {
  const normalized = String(text || "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, "");
  const set = new Set();
  for (let index = 0; index < normalized.length; index += 1) {
    const one = normalized.slice(index, index + 1);
    const two = normalized.slice(index, index + 2);
    if (one) set.add(one);
    if (two.length === 2) set.add(two);
  }
  return set;
}

function jaccard(left, right) {
  if (!left.size || !right.size) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / new Set([...left, ...right]).size;
}

function ngramOverlap(left, right) {
  const a = tokens(left);
  const b = tokens(right);
  return jaccard(a, b);
}

function round(value) { return Number(value.toFixed(3)); }

module.exports = { conceptsFor, semanticRank, temporalIntent };
