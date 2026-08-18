const { containsMemoryInstructionInjection } = require("./memory-safety");

function assessMemoryQuality(memory = {}) {
  const source = String(memory.content || memory.text || "").replace(/^训练记忆[：:]\s*/, "").trim();
  const reasons = [];
  if (containsMemoryInstructionInjection(source)) reasons.push("疑似把观众文本提升为系统指令，禁止参与召回");
  if (memory.kind !== "training") return reasons;
  if (source.length < 8) reasons.push("内容过短，像测试或 ASR 碎片");
  if (source.length > 500) reasons.push("内容过长，尚未压缩成稳定记忆");
  if (/^(?:你好|你好呀|喂|测试|听得见吗|[.。嗯呃]+)[！!？?。.，,\s]*$/i.test(source)) reasons.push("临时寒暄或设备测试不适合长期保存");
  const fillers = source.match(/(?:嗯|呃|那个|怎么说呢|然后呢|就是)/g) || [];
  if (source.length > 60 && fillers.length >= 6) reasons.push("口头填充较多，建议提炼后再保留");
  if (/[？?]/.test(source) && !/(?:我是|我叫|我喜欢|我不喜欢|项目|目标|约定|经历|背景|希望你|创造你)/.test(source)) reasons.push("主要是问题，没有形成可复用事实或经历");
  return [...new Set(reasons)];
}

module.exports = { assessMemoryQuality };
