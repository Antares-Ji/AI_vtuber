const fs = require("fs");
const path = require("path");
const { StreamerBrain } = require("./brain");

async function runEvaluation() {
  const databasePath = path.join(__dirname, "..", "runtime", "evaluation-memory.db");
  const storyPath = path.join(__dirname, "..", "runtime", "evaluation-story.json");
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
  fs.rmSync(storyPath, { force: true });
  const brain = new StreamerBrain({
    llmEnabled: false,
    memoryOptions: { databasePath, legacyPath: path.join(__dirname, "..", "runtime", "missing-legacy.json") },
    storyOptions: { filePath: storyPath }
  });
  const cases = [];
  try {
    await brain.reply({ user: "评测观众", text: "请记住：我在练 osu Hard Rock，稳定性一直不太好", type: "chat" });
    const recall = brain.memoryStore.retrieveForReply({ user: "评测观众", text: "Hard Rock 怎么练稳定？" });
    cases.push(result("长期记忆语义找回", recall.userFacts.some(fact => fact.text.includes("Hard Rock")), `找回 ${recall.userFacts.length} 条相关记忆`));

    await brain.reply({ user: "评测观众", text: "谢谢你，我今天有点累", type: "chat" });
    const relationship = brain.memoryStore.getRelationship("评测观众");
    cases.push(result("关系维度更新", relationship.trust > 0.35 && relationship.comfort > 0.35, `信任 ${relationship.trust}，舒适 ${relationship.comfort}`));

    const closure = await brain.reply({ user: "评测观众", text: "这个话题就结束吧", type: "chat" });
    cases.push(result("话题收束识别", closure.direction.intent === "topic_closure" && closure.cognition.conversation.status === "closed", closure.direction.intent));

    for (let index = 1; index <= 3; index += 1) await brain.reply({ user: "复读评测", text: "同一句内容", type: "chat", repeatCount: index });
    cases.push(result("重复耐受边界", brain.emotion.name === "annoyed", `当前情绪 ${brain.emotion.name}`));

    for (let index = 0; index < 12; index += 1) await brain.reply({ user: "复盘评测", text: `第 ${index} 次聊音乐创作`, type: "chat" });
    cases.push(result("低频角色反思", brain.memoryStore.getCharacterReflections().length > 0, `反思 ${brain.memoryStore.getCharacterReflections().length} 条`));
    const passed = cases.filter(item => item.passed).length;
    return { passed, total: cases.length, score: Math.round((passed / cases.length) * 100), cases };
  } finally {
    brain.memoryStore.close();
    for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${databasePath}${suffix}`, { force: true });
    fs.rmSync(storyPath, { force: true });
  }
}

function result(name, passed, detail) { return { name, passed, detail }; }

module.exports = { runEvaluation };
