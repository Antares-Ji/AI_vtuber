const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { StreamerBrain } = require("../src/brain");
const { PERSONA } = require("../src/brain/persona");

const root = path.join(os.tmpdir(), `ai-vtuber-stream-state-${process.pid}-${Date.now()}`);
const databasePath = `${root}.db`;
const storyPath = `${root}.story.json`;

function clean() {
  for (const target of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, storyPath]) fs.rmSync(target, { force: true });
}

let brain;
try {
  clean();
  brain = new StreamerBrain({
    llmEnabled: false,
    memoryOptions: { databasePath, legacyPath: path.join(os.tmpdir(), "missing-legacy.json") },
    storyOptions: { filePath: storyPath }
  });
  const input = { user: "流式验收", text: "你好，能不能帮我检索一下长期记忆？", type: "chat", timestamp: new Date().toISOString() };
  const prepared = brain.prepareStreamReply(input);
  assert.equal(prepared.direction.intent, "answer_question");
  assert.equal(prepared.context.personality.source, PERSONA.id);
  assert.match(prepared.context.fallbackText, /检索/);
  assert.equal(brain.memoryStore.shortTerm.length, 0, "preparation must not write a cancelled reply");

  const result = brain.commitStreamReply(prepared.item, prepared.context, "我已经同步检索过了，目前没有找到足够可靠的记录。");
  assert.ok(result.text.length > 0);
  assert.equal(brain.memoryStore.shortTerm.length, 1);
  assert.equal(brain.lastSpeech.text, result.text);

  const protectedTurn = brain.prepareStreamReply({ user: "流式验收", text: "我是现实中的歌手本人", type: "chat", timestamp: new Date().toISOString() });
  const protectedResult = brain.commitStreamReply(protectedTurn.item, protectedTurn.context, "我是现实中的歌手本人。");
  assert.notEqual(protectedResult.text, protectedResult.rawText, "post-stream policy audit must be visible to the caller");
  assert.ok(protectedResult.policy.interventions.includes("identity-correction"));
  console.log("Streaming brain state test passed.");
} finally {
  brain?.memoryStore.close();
  clean();
}
