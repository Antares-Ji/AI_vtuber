const { getLlmConfig } = require("./llm");
const { containsMemoryInstructionInjection } = require("./memory-safety");

async function generateMemoryCandidates(memoryStore, { disableExternal = false, sessionId = null } = {}) {
  const transcript = sessionId ? memoryStore.getSessionTranscript(sessionId, 120) : memoryStore.getCurrentSessionTranscript(120);
  if (!transcript.messages.length) throw new Error("本场还没有可提炼的对话");
  const primaryUser = mostFrequent(transcript.messages.map(message => message.user)) || "训练者";
  let candidates = [];
  let mode = "local-fallback";
  let error = null;
  if (!disableExternal && getLlmConfig().enabled) {
    try {
      candidates = await callCandidateLlm(transcript.messages, primaryUser);
      mode = "external";
    } catch (cause) {
      error = cause.message;
    }
  }
  if (!candidates.length) candidates = fallbackCandidates(transcript.messages, primaryUser);
  const stored = memoryStore.replacePendingCandidates(transcript.sessionId, normalizeCandidates(candidates, primaryUser, transcript.messages));
  return { mode, error, source: transcript.source, sessionId: transcript.sessionId, messageCount: transcript.messages.length, candidates: stored };
}

async function callCandidateLlm(messages, primaryUser) {
  const config = getLlmConfig();
  const transcript = messages.slice(-60).map(message =>
    `[消息#${message.id}][观众:${message.user}] ${String(message.text).slice(0, 500)}\n[当时内部情绪，仅作显著性参考] ${message.emotionName || "unknown"} ${Number(message.emotionIntensity || 0).toFixed(2)}${affectSummary(message.affect)}\n[主播回复，仅供理解上下文，不可作为记忆证据] ${String(message.reply).slice(0, 300)}`
  ).join("\n").slice(-16_000);
  const response = await fetch(config.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer " + process.env.OPENAI_API_KEY },
    body: JSON.stringify({
      model: config.model,
      temperature: 0.2,
      max_tokens: 900,
      messages: [
        { role: "system", content: "你是长期记忆整理器。只从观众发言中明确出现的信息提炼0到5条真正值得跨会话保留的记忆。优先：身份与关系、稳定偏好、项目目标、双方真实共同经历、重要约定。排除：寒暄、临时状态、重复句、ASR口误、主播回复中的自述或猜测、电话号码地址等敏感信息。每条候选必须提供 evidenceMessageIds，且只能引用标为[消息#数字]的观众发言；没有观众证据就不要输出。合并重复，不照抄整段原话。scope只能是user或character；user记忆关联具体说话者，character仅用于观众明确确认的共同经历或约定。只输出JSON数组：[{\"scope\":\"user\",\"user\":\"" + primaryUser + "\",\"content\":\"简洁且自洽的中文记忆\",\"reason\":\"为何值得长期保存\",\"evidenceMessageIds\":[1],\"confidence\":0.0,\"importance\":0.0}]" },
        { role: "user", content: "请整理这场对话：\n" + transcript }
      ]
    })
  });
  if (!response.ok) throw new Error("记忆提炼 API 返回 " + response.status);
  const data = await response.json();
  const content = data.choices?.[0]?.message?.content || "";
  const parsed = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim());
  return Array.isArray(parsed) ? parsed : parsed.candidates || [];
}

function fallbackCandidates(messages, primaryUser) {
  const sentences = messages.flatMap(message => String(message.text).split(/[。！？!?\n]+/).map(text => ({ id: message.id, user: message.user, text: text.trim(), emotionIntensity: message.emotionIntensity, affect: message.affect })))
    .filter(item => item.text.length >= 6 && item.text.length <= 220 && !isSensitive(item.text));
  const ranked = sentences.map(item => {
    const baseScore = candidateScore(item.text);
    return { ...item, score: baseScore > 0 ? baseScore + emotionalSalience(item) : 0 };
  }).filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score);
  const candidates = [];
  for (const item of ranked) {
    const normalized = item.text.replace(/\s+/g, "");
    if (candidates.some(candidate => candidate.user === (item.user || primaryUser) && similar(candidate.content, normalized))) continue;
    candidates.push({ scope: "user", user: item.user || primaryUser, content: item.text, reason: "本场对话中的明确身份、目标或约定", evidenceMessageIds: [item.id], evidenceExcerpt: item.text, confidence: 0.72, importance: Math.min(0.95, 0.68 + item.score * 0.04) });
    if (candidates.length >= 5) break;
  }
  return candidates;
}

function normalizeCandidates(candidates, primaryUser, messages = []) {
  const humanMessages = new Map(messages.map(message => [Number(message.id), { user: String(message.user || ""), text: String(message.text || "").trim() }]));
  const output = [];
  for (const raw of candidates) {
    const content = String(raw.content || "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (content.length < 4 || isSensitive(content) || containsMemoryInstructionInjection(content)) continue;
    const evidenceMessageIds = [...new Set((Array.isArray(raw.evidenceMessageIds) ? raw.evidenceMessageIds : [])
      .map(Number).filter(id => Number.isInteger(id) && humanMessages.has(id)))].slice(0, 8);
    if (!evidenceMessageIds.length) continue;
    const scope = raw.scope === "character" ? "character" : "user";
    const user = String(raw.user || primaryUser).slice(0, 40);
    if (output.some(item => item.scope === scope && item.user === (scope === "user" ? user : null) && similar(item.content, content))) continue;
    const evidenceRows = evidenceMessageIds.map(id => humanMessages.get(id));
    if (scope === "user" && evidenceRows.some(message => message.user !== user)) continue;
    const evidence = evidenceRows.map(message => message.text);
    if (!isSupportedByHumanEvidence(content, evidence, scope === "user" ? user : null)) continue;
    output.push({
      scope, user: scope === "user" ? user : null, content,
      reason: String(raw.reason || "从本场对话提炼").slice(0, 300), evidenceMessageIds,
      evidenceExcerpt: evidenceRows.map(message => `[观众:${message.user}] ${message.text}`).join("；").slice(0, 700), confidence: number(raw.confidence, 0.82), importance: number(raw.importance, 0.82)
    });
    if (output.length >= 5) break;
  }
  return output;
}

function candidateScore(text) {
  let score = 0;
  if (/我叫|我是.{0,12}(?:开发者|作者|主人)|称呼我/.test(text)) score += 5;
  if (/项目|目标|创造你|希望你|对标|AI主播|虚拟主播/.test(text)) score += 4;
  if (/我们(?:一起|约定|第一次)|共同经历|以后/.test(text)) score += 4;
  if (/我喜欢|我不喜欢|我在练|我希望/.test(text)) score += 2;
  return score;
}

function similar(left, right) {
  const a = String(left).replace(/[\s，。！？、：；]/g, "");
  const b = String(right).replace(/[\s，。！？、：；]/g, "");
  return a.includes(b) || b.includes(a);
}

function isSupportedByHumanEvidence(content, evidence, user = null) {
  // Require each factual clause to occur in one human utterance. Character-set
  // overlap loses word order and negation, and cannot establish a fact.
  const canonical = value => String(value).toLowerCase().replace(/[\s，,：:、]/g, "")
    .replace(/^(?:请记住|记住|训练记忆)[：:]?/, "")
    .replace(/^我叫/, "自称").replace(/^我是/, "是").replace(/^我的?/, "")
    .replace(/目标是(?:做一个|制作)/g, "目标是制作");
  const clauses = String(content).split(/[。！？!?；;\n]+/).map(canonical).filter(Boolean);
  const sources = evidence.filter(text => !/[？?]|如果|假如|可能|也许|是否/.test(String(text)))
    .flatMap(text => String(text).split(/[。！？!?；;\n]+/)).map(canonical);
  return clauses.length > 0 && clauses.every(clause => {
    const claim = user && clause.startsWith(canonical(user)) ? clause.slice(canonical(user).length).replace(/^的/, "") : clause;
    return claim.length >= 2 && sources.some(source => {
      if (source === claim) return true;
      const index = source.indexOf(claim);
      if (index !== 0) return false;
      // A positive substring inside a negated or hypothetical statement is not evidence.
      return !/(?:不|没|未|不是|并非|从未|如果|假如|是否|可能)$/.test(source.slice(0, index));
    });
  });
}

function isSensitive(text) { return /(?:手机号|电话|微信|QQ|住在|地址|身份证|银行卡|密码)/.test(text); }
function number(value, fallback) { const parsed = Number(value); return Number.isFinite(parsed) ? Math.max(0, Math.min(1, parsed)) : fallback; }
function mostFrequent(values) { const counts = new Map(); for (const value of values) counts.set(value, (counts.get(value) || 0) + 1); return [...counts].sort((a, b) => b[1] - a[1])[0]?.[0]; }
function affectSummary(affect = {}) {
  const ranked = ["joy", "sadness", "anger", "fear", "surprise", "gratitude", "admiration", "hope", "disappointment", "loneliness", "empathy", "boundaryPressure"]
    .map(name => ({ name, value: Number(affect[name] || 0) })).filter(item => item.value > 0.08).sort((a, b) => b.value - a.value).slice(0, 3);
  return ranked.length ? `；显著维度 ${ranked.map(item => `${item.name}:${item.value.toFixed(2)}`).join("、")}` : "";
}
function emotionalSalience(item = {}) {
  const affect = item.affect || {};
  const peak = Math.max(...["joy", "sadness", "anger", "fear", "surprise", "gratitude", "admiration", "hope", "disappointment", "loneliness", "empathy", "boundaryPressure"].map(name => Math.max(0, Number(affect[name] || 0))));
  return Math.min(1.5, Number(item.emotionIntensity || 0) * 0.7 + peak * 0.8);
}

module.exports = { generateMemoryCandidates, fallbackCandidates, normalizeCandidates, isSupportedByHumanEvidence };
