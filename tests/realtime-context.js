const assert = require("node:assert/strict");
const { buildRealtimeMessages } = require("../src/brain/realtime-context");

const worldBook = `舞台设定：${"星".repeat(1_500)}`;
const messages = buildRealtimeMessages(
  { user: "验收观众", text: "现在几点？上次的约定还记得吗？", type: "chat" },
  {
    persona: "你是测试主播。",
    personality: { dimensions: { warmth: 0.8, curiosity: 0.7, playfulness: 0.5, boundaryStrength: 0.6, independence: 0.7, honesty: 0.9, coCreation: 0.8, reflectiveness: 0.7 } },
    personalityExpression: { values: { warmth: 0.91, directness: 0.64, empathy: 0.88 }, modulation: { reason: "关怀提高温暖与共情表达" } },
    worldBook,
    emotion: { name: "concerned", intensity: 0.62 },
    relationship: { level: "regular" },
    userMemory: "已记住：想完成双脑验收",
    sessionTopics: ["双脑验收"],
    memoryLookup: { found: true, count: 1, facts: ["想完成双脑验收"] },
    direction: { instruction: "先直接回答", relationshipTone: "familiar-warm", responseBudget: { maxSentences: 2, maxCharacters: 108 } },
    cognition: {
      conversation: { currentTopic: "双脑验收", topicDepth: 2, pendingQuestion: "什么时候跑完回归？" },
      openLoops: [{ text: "验收结束后发送结果" }],
      metacognition: { uncertainty: ["尚未验证线上 ASR 延迟"] }
    },
    liveTime: { display: "2026年9月5日 14:30", period: "下午" }
  }
);

const prompt = messages.map(message => message.content).join("\n");
assert.match(prompt, /本轮人格表达：温暖0\.91/);
assert.match(prompt, /真实北京时间：2026年9月5日 14:30/);
assert.match(prompt, /未完成约定：验收结束后发送结果/);
assert.match(prompt, /长期记忆已在回答前同步查询：找到 1 条可靠记录/);
assert.equal(messages.filter(message => message.role === "system").length, 1, "Qwen requires one leading system message");
assert.equal(messages[0].role, "system");
const worldBookMessage = messages[0].content.split("\n\n").find(content => content.startsWith("世界书（已限长）"));
assert.ok(worldBookMessage.length <= 1210, "world book must stay bounded in realtime prompts");
console.log("Realtime context test passed.");
