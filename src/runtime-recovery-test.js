const assert = require("assert");
const fs = require("fs");
const path = require("path");
const { StreamerBrain } = require("./brain");
const { QueueStore } = require("./runtime/queue-store");
const { runIsolatedSimulation } = require("./simulation");

(async () => {
  const root = path.join(__dirname, "..", "runtime", "recovery-test");
  const databasePath = path.join(root, "memory.db");
  const storyPath = path.join(root, "story.json");
  const statePath = path.join(root, "brain.json");
  const queuePath = path.join(root, "queue.json");
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  let brain = createBrain();
  const reply = await brain.reply({ user: "恢复测试", text: "终于成功了，但前面失败太多还是有点难过", type: "chat" });
  const previousEmotion = reply.emotion.name;
  const previousAmbivalence = reply.emotion.affect.ambivalence;
  brain.sceneState.nextProactiveAt = Date.now() - 1;
  brain.persistRuntime();
  brain.memoryStore.close();

  brain = createBrain();
  assert.equal(brain.emotion.name, previousEmotion);
  assert.equal(brain.emotion.affect.ambivalence, previousAmbivalence);
  assert.ok(brain.cognition.observations.length > 0);
  assert.ok(brain.sceneState.nextProactiveAt >= Date.now() + 55_000);
  await brain.reply({ user: "敏感恢复测试", text: "我的手机号是 13800138000", type: "chat" });
  assert.equal(fs.readFileSync(statePath, "utf8").includes("13800138000"), false);
  brain.memoryStore.close();

  fs.writeFileSync(statePath, "{broken-json", "utf8");
  brain = createBrain();
  assert.equal(brain.emotion.name, "neutral");
  assert.ok(Object.keys(brain.emotion.affect).length >= 50);
  brain.memoryStore.close();

  fs.writeFileSync(queuePath, "not-json", "utf8");
  const queue = new QueueStore({ filePath: queuePath });
  assert.deepEqual(queue.items, []);
  queue.push({ user: "队列", text: "重启后恢复", timestamp: new Date().toISOString() });
  assert.equal(new QueueStore({ filePath: queuePath }).items.length, 1);

  const oldKey = process.env.OPENAI_API_KEY;
  process.env.OPENAI_API_KEY = "";
  const simulation = await runIsolatedSimulation(2);
  if (oldKey === undefined) delete process.env.OPENAI_API_KEY; else process.env.OPENAI_API_KEY = oldKey;
  assert.equal(simulation.isolated, true);
  assert.equal(simulation.productionMemoryChanged, false);
  assert.equal(simulation.transcript.length, 2);

  fs.rmSync(root, { recursive: true, force: true });
  console.log("Runtime recovery test passed: state, corrupt-file fallback, queue, and simulation isolation work.");

  function createBrain() {
    return new StreamerBrain({
      llmEnabled: false,
      memoryOptions: { databasePath, legacyPath: path.join(root, "missing.json") },
      storyOptions: { filePath: storyPath },
      runtimeOptions: { filePath: statePath }
    });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
