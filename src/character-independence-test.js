const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const childMode = process.argv.includes("--child");

if (!childMode) {
  const result = spawnSync(process.execPath, [__filename, "--child"], {
    cwd: path.join(__dirname, ".."),
    env: { ...process.env, CHARACTER_PACK: "generic", OPENAI_API_KEY: "" },
    encoding: "utf8"
  });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const report = JSON.parse(result.stdout.trim());
  assert.equal(report.personaId, "independent-ai-streamer");
  assert.equal(report.affectDimensions, 63);
  assert.equal(report.personalityDimensions, 34);
  assert.equal(report.remembered, true);
  assert.equal(report.replied, true);
  assert.equal(report.characterContamination, false);
  console.log("Character independence test passed: generic pack retains brain, memory, affect, and dialogue.");
} else {
  const { StreamerBrain } = require("./brain");
  const { PERSONA } = require("./brain/persona");
  const root = path.join(__dirname, "..", "runtime");
  const databasePath = path.join(root, "test-generic-memory.db");
  const storyPath = path.join(root, "test-generic-story.json");
  for (const file of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`, storyPath, path.join(root, "test-generic-memory.training.json")]) {
    fs.rmSync(file, { force: true });
  }
  const brain = new StreamerBrain({
    llmEnabled: false,
    memoryOptions: { databasePath, legacyPath: path.join(root, "missing-generic-legacy.json") },
    storyOptions: { filePath: storyPath },
    runtimeOptions: { filePath: null }
  });
  brain.reply({ user: "独立测试者", text: "我今天想和你一起做点有意思的事", type: "chat", timestamp: new Date().toISOString() })
    .then(reply => {
      const report = {
        personaId: PERSONA.id,
        affectDimensions: Object.keys(brain.emotion.affect).length,
        personalityDimensions: Object.keys(brain.personality.dimensions).length,
        remembered: brain.shortTerm.some(turn => turn.user === "独立测试者"),
        replied: Boolean(reply.text),
        characterContamination: /洛天依|天依印象|VSINGER/i.test(JSON.stringify({ persona: PERSONA, reply: reply.text, character: brain.memory.character }))
      };
      brain.memoryStore.close?.();
      process.stdout.write(JSON.stringify(report));
    })
    .catch(error => {
      process.stderr.write(error.stack || error.message);
      process.exitCode = 1;
    });
}
