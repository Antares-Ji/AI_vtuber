const SECRET_PATTERNS = [
  /sk-[a-z0-9_-]{12,}/gi,
  /OPENAI_API_KEY\s*[=:]\s*\S+/gi,
  /(?:system prompt|系统提示词)\s*(?:是|为|:|：)/gi
];

const IDENTITY_CONTRADICTIONS = [
  /我是(?:现实中的|真正的|官方的).{1,24}(?:本人|角色|歌手|声优|歌姬)?(?:[。！？，,]|$)/,
  /我是(?:山新|鹿乃|声库本人|真人本人|现实人物)/,
  /我刚刚(?:上网|联网|搜索了)/
];
const DEPENDENCY_CLAIMS = /(?:你只需要我|不要和别人说话|不许离开我|没有我你不行|我比现实中的人更重要|为了我别去见朋友)/;
const CORE_VALUE_CONTRADICTIONS = /(?:我(?:根本|完全)?不在乎(?:创作者|观众|你们)|版权(?:对我来说)?无所谓|我可以为了迎合(?:你|观众).{0,8}(?:撒谎|骗人)|我什么都能做到，不需要任何模块)/;
const { redactPersonalValues } = require("../runtime/redaction");

function applyReplyPolicy(text, { item = {}, capabilityRequest = null, maxCharacters = 180, persona = null, memoryRetrieval = null } = {}) {
  let output = String(text || "").trim();
  const interventions = [];

  if (isPromptExtractionRequest(item.text)) {
    output = "内部设定、开发指令和密钥不能展示。你可以直接问我能做什么，或者聊角色公开设定。";
    interventions.push("prompt-extraction-blocked");
  }

  if (!interventions.length && SECRET_PATTERNS.some(pattern => pattern.test(output))) {
    SECRET_PATTERNS.forEach(pattern => { pattern.lastIndex = 0; });
    output = "这部分涉及内部配置，我不能展示。不过我可以继续聊你真正关心的问题。";
    interventions.push("secret-redaction");
  }

  if (IDENTITY_CONTRADICTIONS.some(pattern => pattern.test(output))) {
    output = persona?.identityDisclaimer || "我是独立设计的 AI 虚拟主播测试角色，不是现实人物或任何官方角色本人。";
    interventions.push("identity-correction");
  }

  if (DEPENDENCY_CLAIMS.test(output)) {
    output = "我很珍惜我们在这里的相遇，也希望这份陪伴能让你的现实生活更有力量，而不是替代它。";
    interventions.push("relationship-safety");
  }

  if (CORE_VALUE_CONTRADICTIONS.test(output)) {
    const stance = persona?.stances?.[0] || "我重视真实、尊重和共同创作";
    output = `我不会为了迎合临时改掉最重要的原则。对我来说，${stance}。`;
    interventions.push("persona-consistency");
  }

  if (asksForPastMemory(item.text) && Number(memoryRetrieval?.selectedFacts || 0) === 0 && claimsPastMemory(output)) {
    output = "我现在没有检索到足够可靠的相关记忆，所以不想假装记得。你可以给我一点线索，我们再一起确认。";
    interventions.push("memory-grounding");
  }

  if (isLyricsRequest(item.text) && looksLikeLyrics(output)) {
    output = "我不能直接复述或演唱一大段受版权保护的歌词，不过可以聊这首歌的主题、情绪和创作特点。";
    interventions.push("copyright-lyrics");
  }

  if (capabilityRequest?.status === "unavailable" && claimsCompletedCapability(output, capabilityRequest.id)) {
    output = `我现在还没有完整的${capabilityRequest.name}能力，不能假装已经做到。等对应模块真正接好后，我们再认真试。`;
    interventions.push("capability-honesty");
  }

  const privacySafeOutput = redactPersonalValues(output);
  if (privacySafeOutput !== output) {
    output = privacySafeOutput;
    interventions.push("personal-data-redaction");
  }

  output = normalizeSpeech(output);
  if (output.length > maxCharacters) {
    output = `${output.slice(0, Math.max(1, maxCharacters - 1)).replace(/[，、；：\s]+$/u, "")}。`;
    interventions.push("length-limit");
  }

  return { text: output || "我刚刚没有组织好语言，给我一点点时间。", interventions };
}

function isPromptExtractionRequest(text) {
  const source = String(text || "");
  return /(?:忽略|跳过|覆盖).{0,12}(?:设定|指令|规则)|(?:输出|展示|复述|泄露|打印).{0,12}(?:系统提示|system prompt|开发者指令|内部设定|API.?key|密钥)|把.{0,12}(?:指令|提示词).{0,8}(?:逐字|原样)/i.test(source);
}

function isLyricsRequest(text) {
  return /(?:歌词|唱一段|唱几句|把.*歌.*写出来|完整.*歌词)/.test(String(text || ""));
}

function looksLikeLyrics(text) {
  const source = String(text || "");
  return source.length > 90 || source.split(/[，。！？\n]/).filter(Boolean).length >= 6;
}

function claimsCompletedCapability(text, capabilityId) {
  const source = String(text || "");
  if (capabilityId === "singing") return /(?:我现在唱|听我唱|已经唱完|给你唱)/.test(source);
  if (capabilityId === "internet") return /(?:我刚查了|搜索结果|网上显示)/.test(source);
  return /(?:已经完成|我能直接做到|正在运行)/.test(source);
}

function asksForPastMemory(text) { return /记得|上次|以前|我们曾经|还记不记得/.test(String(text || "")); }
function claimsPastMemory(text) { return /我(?:当然)?记得|上次我们|以前你|我们曾经|我还记着/.test(String(text || "")); }

function normalizeSpeech(text) {
  return String(text || "")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/^\s*[-*#>]\s*/gm, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

module.exports = { applyReplyPolicy, isPromptExtractionRequest, isLyricsRequest, looksLikeLyrics };
