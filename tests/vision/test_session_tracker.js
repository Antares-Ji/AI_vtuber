/**
 * test_session_tracker.js —— Phase E：session 状态机测试
 *
 * 覆盖：去抖、完整一局、重复结算、突然中断、重新开始、超时中断。
 * 用法：node tests/vision/test_session_tracker.js
 */
const assert = require("assert");
const path = require("path");

const { SessionTracker, normalizeResult, STATE } = require(path.join(__dirname, "..", "..", "src", "vision", "session-tracker.js"));

const scene = (name, confidence = 0.8) => ({ scene: { name, confidence } });
const resultsFrame = (overrides = {}) => ({
  scene: { name: "results", confidence: 0.9 },
  results: {
    accuracy: { value: 95.28, confidence: 0.9 },
    misses: { value: 3, confidence: 0.8 },
    maxCombo: { value: 412, confidence: 0.8 },
    score: { value: 2341567, confidence: 0.7 },
    grade: { value: "S", confidence: 0.9 },
    ...overrides,
  },
});

function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

console.log("Phase E: session tracker");

run("去抖：单帧 gameplay 不进入 gameplay", () => {
  const tracker = new SessionTracker({ gameplayDebounce: 2, resultsDebounce: 2 });
  const r1 = tracker.ingest(scene("gameplay"), 1000);
  assert.strictEqual(r1.event, "none");
  assert.strictEqual(tracker.getState().state, STATE.POSSIBLE_GAMEPLAY);
  // 单帧 results 抖动回 idle
  const r2 = tracker.ingest(scene("results"), 1200);
  assert.strictEqual(r2.event, "none");
  assert.strictEqual(tracker.getState().state, STATE.IDLE);
});

run("连续两帧 gameplay 开始一局并持续更新", () => {
  const tracker = new SessionTracker({ gameplayDebounce: 2, resultsDebounce: 2 });
  tracker.ingest(scene("gameplay"), 1000);
  const start = tracker.ingest(scene("gameplay"), 1300);
  assert.strictEqual(start.event, "session-start");
  assert.ok(start.sessionId);
  const update = tracker.ingest(scene("gameplay"), 1600);
  assert.strictEqual(update.event, "session-update");
  assert.strictEqual(update.session.frames, 2);
});

run("连续两帧 results 触发一次完成事件并带结算字段", () => {
  const tracker = new SessionTracker({ gameplayDebounce: 2, resultsDebounce: 2 });
  tracker.ingest(scene("gameplay"), 1000);
  tracker.ingest(scene("gameplay"), 1300);
  const r1 = tracker.ingest(resultsFrame(), 1600);
  assert.strictEqual(r1.event, "session-update"); // possibleResults
  assert.strictEqual(r1.session.frames, 2);       // session 内帧数（第2帧 gameplay + 本 results 帧）
  const complete = tracker.ingest(resultsFrame(), 1900);
  assert.strictEqual(complete.event, "session-complete");
  assert.strictEqual(complete.session.result.accuracy.value, 95.28);
  assert.strictEqual(complete.session.result.misses.value, 3);
  assert.ok(complete.session.endedAt);
  assert.strictEqual(tracker.getState().state, STATE.IDLE);
});

run("同一结算页重复帧不重复生成完成事件", () => {
  const tracker = new SessionTracker({ gameplayDebounce: 2, resultsDebounce: 2 });
  tracker.ingest(scene("gameplay"), 1000);
  tracker.ingest(scene("gameplay"), 1300);
  tracker.ingest(resultsFrame(), 1600);
  tracker.ingest(resultsFrame(), 1900); // complete
  const repeat = tracker.ingest(resultsFrame(), 2200);
  assert.strictEqual(repeat.event, "none");
  const secondComplete = tracker.ingest(resultsFrame(), 2500);
  assert.strictEqual(secondComplete.event, "none");
});

run("结算页抖动回 gameplay 不误触发完成", () => {
  const tracker = new SessionTracker({ gameplayDebounce: 2, resultsDebounce: 2 });
  tracker.ingest(scene("gameplay"), 1000);
  tracker.ingest(scene("gameplay"), 1300);
  tracker.ingest(resultsFrame(), 1600);
  const back = tracker.ingest(scene("gameplay"), 1900);
  assert.strictEqual(back.event, "session-update");
  assert.strictEqual(tracker.getState().state, STATE.GAMEPLAY);
});

run("unknown 帧中断当前一局", () => {
  const tracker = new SessionTracker({ gameplayDebounce: 2, resultsDebounce: 2 });
  tracker.ingest(scene("gameplay"), 1000);
  tracker.ingest(scene("gameplay"), 1300);
  const abort = tracker.ingest(scene("unknown", 0.6), 1600);
  assert.strictEqual(abort.event, "session-abort");
  assert.strictEqual(abort.session.aborted, true);
  assert.strictEqual(tracker.getState().state, STATE.IDLE);
});

run("完成后重新开始生成新 sessionId", () => {
  const tracker = new SessionTracker({ gameplayDebounce: 2, resultsDebounce: 2, inactivityAbortMs: 0 });
  tracker.ingest(scene("gameplay"), 1000);
  tracker.ingest(scene("gameplay"), 1300);
  tracker.ingest(resultsFrame(), 1600);
  const complete = tracker.ingest(resultsFrame(), 1900);
  const firstId = complete.sessionId;
  tracker.ingest(scene("gameplay"), 2200);
  const secondStart = tracker.ingest(scene("gameplay"), 2500);
  assert.strictEqual(secondStart.event, "session-start");
  assert.notStrictEqual(secondStart.sessionId, firstId);
});

run("会话超时后中断", () => {
  const tracker = new SessionTracker({ gameplayDebounce: 2, resultsDebounce: 2, sessionTimeoutMs: 5000 });
  tracker.ingest(scene("gameplay"), 1000);
  const start = tracker.ingest(scene("gameplay"), 1300);
  assert.strictEqual(start.event, "session-start");
  // 5.5 秒后没有任何 gameplay/results 帧，出现其他场景时判定超时中断
  const abort = tracker.ingest(scene("songSelect"), 6500);
  assert.strictEqual(abort.event, "session-abort");
  assert.strictEqual(abort.session.aborted, true);
});

run("normalizeResult 只保留已发布字段", () => {
  const result = normalizeResult({
    accuracy: { value: 95.28, confidence: 0.9 },
    misses: { value: null, confidence: 0.0 },
    grade: { value: "S", confidence: 0.9 },
  });
  assert.deepStrictEqual(Object.keys(result).sort(), ["accuracy", "grade"]);
});

console.log(process.exitCode ? "FAILED" : "PASSED");
