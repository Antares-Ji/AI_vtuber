const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { EventEmitter } = require("node:events");
const { StreamerBrain } = require("../src/brain");
const { buildRealtimeMessages } = require("../src/brain/realtime-context");
const { responseAbortController } = require("../src/runtime/request-lifecycle");
const { SpeechOutputArbiter } = require("../public/speech-output-arbiter");
const { PersonaPresentation } = require("../public/persona-presentation");

const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };

async function arbitration() {
  const arbiter = new SpeechOutputArbiter();
  const gate = deferred(), order = [];
  const first = arbiter.enqueue(async () => { order.push("first"); await gate.promise; });
  const second = arbiter.enqueue(() => order.push("second"));
  assert.equal(await arbiter.enqueue(() => order.push("dropped"), { policy: "drop" }), false);
  await tick();
  assert.deepEqual(order, ["first"]);
  gate.resolve();
  await Promise.all([first, second]);
  await tick();
  assert.deepEqual(order, ["first", "second"]);

  const oldGate = deferred(), newGate = deferred();
  const old = arbiter.enqueue(() => oldGate.promise, { cancel() { throw new Error("cleanup failure"); } });
  const queued = arbiter.enqueue(() => order.push("must not run"));
  await tick();
  const replacement = arbiter.enqueue(() => newGate.promise, { policy: "interrupt" });
  const newOwner = arbiter.current.outputId;
  assert.equal(await old, false);
  assert.equal(await queued, false);
  oldGate.resolve();
  await tick();
  assert.equal(arbiter.current.outputId, newOwner, "late completion must not release replacement");
  newGate.resolve(); await replacement; await tick();
  assert.equal(arbiter.current, null);
  const fail = arbiter.enqueue(() => { throw new Error("TTS unavailable"); });
  const recovered = arbiter.enqueue(() => "recovered");
  await assert.rejects(fail, /TTS unavailable/);
  assert.equal(await recovered, "recovered");
  assert.equal(order.includes("must not run"), false);
  assert.equal(await arbiter.enqueue(() => "expired", { ttlMs: -1 }), false);
}

function presentationChecks() {
  let invalidations = 0;
  const ui = new PersonaPresentation(() => invalidations++);
  const sui = { sessionId: "process-a", personaId: "sui", generationEpoch: 0 };
  const ge = { ...sui, personaId: "ge", generationEpoch: 1 };
  assert(ui.adopt(sui));
  const oldPollRevision = ui.revision;
  assert(ui.adopt(ge));
  assert(!ui.adopt(sui, oldPollRevision), "in-flight old poll cannot change expression");
  assert(!ui.adopt(sui), "older epoch rejected even with fresh local revision");
  assert(ui.adopt({ ...sui, generationEpoch: 2 }));
  assert(!ui.isCurrent(sui), "same persona after switch-back is still a different generation");
  assert(ui.adopt({ ...sui, sessionId: "process-b" }));
  assert(!ui.adopt({ ...sui, generationEpoch: 100 }), "retired server cannot return");
  assert.equal(invalidations, 3);
}

function brainChecks() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "jisui-runtime-"));
  const options = { dualPersonas: true, llmEnabled: false,
    memoryOptions: { databasePath: path.join(dir, "memory.db"), legacyPath: path.join(dir, "absent.json") },
    runtimeOptions: { filePath: path.join(dir, "runtime.json") }, storyOptions: { filePath: path.join(dir, "story.json") } };
  let brain = new StreamerBrain(options);
  const input = text => ({ user: "测试观众", text, type: "chat" });
  const commit = (text, reply) => { const p = brain.prepareStreamReply(input(text)); return brain.commitStreamReply(p.item, p.context, reply); };
  try {
    commit("下次约定一起研究音乐", "岁专属回答：你喜欢哪首歌曲？");
    brain.emotion.name = "curious";
    brain.cognition.selfModel.stances = ["岁自己的判断"];
    const pending = brain.prepareStreamReply(input("尚未完成的旧请求"));
    const response = new EventEmitter();
    response.destroy = () => { response.destroyed = true; response.emit("close"); };
    const controller = responseAbortController(response, pending.context.taskSignal);
    brain.switchPersona("ge");
    assert(pending.context.taskSignal.aborted && controller.signal.aborted && response.destroyed);
    let context = brain.buildContext(input("继续音乐话题"));
    assert.equal(context.recent.length, 0);
    assert.match(context.partnerContext, /岁专属回答/);
    const messages = buildRealtimeMessages(input("继续"), context);
    assert(messages.some(m => m.role === "user" && m.content.includes("岁专属回答")));
    assert(!messages.some(m => m.role === "assistant" && m.content.includes("岁专属回答")));
    assert(!JSON.stringify(brain.cognition).includes("岁自己的判断"));
    commit("接下来研究画画", "歌专属回答：你喜欢哪种颜色？");
    brain.cognition.selfModel.stances = ["歌自己的判断"];
    brain.switchPersona("sui");
    assert.deepEqual(brain.cognition.selfModel.stances, ["岁自己的判断"]);
    assert.throws(() => brain.commitStreamReply(pending.item, pending.context, "过期回流"), { name: "AbortError" });
    context = brain.buildContext(input("继续"));
    assert(context.recent.every(turn => turn.personaId === "sui"));
    assert.match(context.partnerContext, /歌专属回答/);
    assert.equal(brain.memoryStore.getSessionStatus().messageCount, 2);
    brain.switchPersona("ge");
    for (let index = 0; index < 5; index++) commit(`歌连续发言 ${index}`, `这是歌的回答 ${index}`);
    brain.switchPersona("sui");
    assert(brain.buildContext(input("继续")).recent.some(turn => turn.reply.includes("岁专属回答")), "partner turns cannot evict own context window");
    const stopped = brain.prepareStreamReply(input("停止这句话"));
    brain.interruptTurn();
    assert(stopped.context.taskSignal.aborted);
    assert.throws(() => brain.commitStreamReply(stopped.item, stopped.context, "不应写入"), { name: "AbortError" });
    const beforeRestart = brain.personaStatus();
    brain.memoryStore.close();
    brain = new StreamerBrain(options);
    assert(!brain.personaRuntime.isCurrent(beforeRestart));
    assert.deepEqual(brain.cognition.selfModel.stances, ["岁自己的判断"]);
    brain.switchPersona("ge");
    assert.deepEqual(brain.cognition.selfModel.stances, ["歌自己的判断"]);
  } finally {
    brain.memoryStore.close();
    // Remove only this test's individually named temporary files.
    for (const name of fs.readdirSync(dir)) fs.unlinkSync(path.join(dir, name));
    fs.rmdirSync(dir);
  }
}

(async () => {
  brainChecks(); presentationChecks(); await arbitration();
  console.log("Dual personas passed: attributed history, independent state, switch-back/restart revocation, response abort, stale UI, output queue and cancellation races.");
})().catch(error => { console.error(error); process.exitCode = 1; });
