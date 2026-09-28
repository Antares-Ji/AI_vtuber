const assert = require("node:assert/strict");
const { classifyComplexity, getLocalLlmConfig } = require("../src/brain/local-llm");
const { THINKING_PREFACES, selectThinkingPreface } = require("../src/brain/streaming-router");
const { buildRealtimeMessages } = require("../src/brain/realtime-context");

assert.equal(classifyComplexity({ text: "晚上好呀" }).route, "local");
assert.equal(classifyComplexity({ text: "Hello, Hello，能听到吗？" }).route, "local");
assert.equal(classifyComplexity({ text: "为什么呀？" }).route, "local");
assert.equal(classifyComplexity({ text: "请介绍一下你自己" }).route, "local");
assert.equal(classifyComplexity({ text: "比较一下这两首歌曲" }).route, "local");
assert.equal(classifyComplexity({ text: "比较一下这两个角色谁更可爱" }).route, "local");
assert.equal(classifyComplexity({ text: "你好，帮我写一条 SQL" }).route, "cloud");
assert.equal(classifyComplexity({ text: "晚上好，能分析这个系统架构为什么报错吗？" }).route, "cloud");
assert.equal(classifyComplexity({ text: "谢谢你，给我安排一个三个月计划" }).route, "cloud");
assert.equal(classifyComplexity({ text: "今天北京天气怎么样" }).route, "cloud");
assert.equal(classifyComplexity({ text: "帮我写一条 SQL" }).route, "cloud");
assert.equal(classifyComplexity({ text: "给我安排一个三个月计划" }).route, "cloud");
assert.equal(classifyComplexity({ text: "请分析一下这个系统架构为什么报错，并给出完整方案" }).route, "cloud");
assert.equal(classifyComplexity({ text: "a".repeat(81) }).route, "cloud");
assert.equal(getLocalLlmConfig().baseUrl, process.env.LOCAL_LLM_BASE_URL || "http://127.0.0.1:11435/v1");
assert.ok(THINKING_PREFACES.length >= 8);
const firstPreface = selectThinkingPreface({ text: "复杂问题" });
const secondPreface = selectThinkingPreface({ text: "复杂问题" });
assert.notEqual(firstPreface, secondPreface);
const realtimePrompt = buildRealtimeMessages(
  { user: "小明", text: "我上次说的目标是什么？", type: "chat" },
  {
    persona: "你是测试角色。",
    personality: { dimensions: { warmth: 0.8, curiosity: 0.7, playfulness: 0.5, boundaryStrength: 0.6, independence: 0.7, honesty: 0.9, coCreation: 0.8, reflectiveness: 0.7 } },
    worldBook: "舞台：测试世界书",
    emotion: { name: "focused", intensity: 0.6 },
    userMemory: "已记住：目标是完成双脑验收",
    sessionTopics: ["双脑验收"],
    direction: { instruction: "先直接回答", relationshipTone: "warm-polite", responseBudget: { maxSentences: 2, maxCharacters: 108 } },
    memoryLookup: { found: true, count: 1, facts: ["目标是完成双脑验收"] }
  }
).map(message => message.content).join("\n");
assert.match(realtimePrompt, /稳定人格权重/);
assert.match(realtimePrompt, /已记住：目标是完成双脑验收/);
assert.match(realtimePrompt, /长期记忆已在回答前同步查询/);
console.log("Local/cloud router test passed.");
