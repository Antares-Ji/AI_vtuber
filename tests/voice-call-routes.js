const assert = require("node:assert/strict");
const { DatabaseSync } = require("node:sqlite");
const { EventEmitter } = require("node:events");
const { createVoiceCallRoutes } = require("../src/api/voice-call-routes");
class Response extends EventEmitter {
  output = "";
  writeHead(code) { this.code = code; this.headersSent = true; }
  write(text) { this.output += text; }
  end(text = "") { this.write(text); this.writableEnded = true; this.emit("finish"); }
}
(async () => {
  const db = new DatabaseSync(":memory:");
  let commits = 0, releaseToken, busy = false;
  const brain = { memoryStore: { db }, visibleEmotion: () => ({}), prepareStreamReply: item => ({ item, context: {} }), commitStreamReply(item, context, text) { commits++; return { text: `审核:${text}` }; } };
  const route = createVoiceCallRoutes({ brain, parseBody: async req => req.body, send: (res, code, body) => { res.writeHead(code); res.end(JSON.stringify(body)); }, acquire: () => { if (busy) return null; busy = true; return () => { busy = false; }; }, streamRoutedReply: async function* (item) {
    if (item.text === "等待取消") await new Promise(resolve => { releaseToken = resolve; });
    yield { type: "delta", text: "模型草稿" };
  } });
  const run = async (path, body = {}, method = "POST", res = new Response()) => { await route({ method, body }, res, new URL(`http://local${path}`)); return res; };
  const start = JSON.parse((await run("/api/voice-calls/start", { user: "测试" })).output).call;
  const base = `/api/voice-calls/${start.id}`;
  const response = await run(`${base}/turn`, { sequence: 1, text: "你好" });
  assert.equal(response.code, 200);
  assert.equal(commits, 1);
  assert.ok(response.output.includes("审核:模型草稿"));
  await run(`${base}/turn`, { sequence: 1, text: "你好" });
  assert.equal(commits, 1, "retry must not duplicate memory");
  const pending = run(`${base}/turn`, { sequence: 2, text: "等待取消" });
  while (!releaseToken) await new Promise(resolve => setImmediate(resolve));
  assert.equal(db.prepare("SELECT input_text FROM voice_call_turns WHERE sequence = 2").get().input_text, "等待取消", "input survives before model completion");
  await run(`${base}/end`);
  releaseToken();
  await pending;
  assert.equal(commits, 1, "ended call cannot commit late model output");
  assert.equal(busy, false);
  assert.equal((await run(`${base}/turn`, { sequence: 3, text: "迟到" })).code, 410);
  const saved = JSON.parse((await run(base, {}, "GET")).output).call;
  assert.equal(saved.turnCount, 2);
  assert.equal(saved.turns[0].reply, "审核:模型草稿");
  assert.equal(saved.turns[1].status, "interrupted");
  db.close();
  console.log("Voice call routes passed: reviewed output, persisted input, idempotency, end cancellation, late-write rejection.");
})().catch(error => { console.error(error); process.exitCode = 1; });
