/**
 * test_provider.js —— Phase G：Node 侧 schema v2 校验与并发测试
 *
 * 用法：node tests/vision/test_provider.js
 */
const assert = require("assert");
const path = require("path");

const { validateFrame, VisionProvider } = require(path.join(__dirname, "..", "..", "src", "vision", "provider.js"));

function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

console.log("Phase G: provider validateFrame");

const validFrame = {
  schemaVersion: 2,
  frame: { width: 1280, height: 720, quality: { brightness: 0.5, usable: true } },
  scene: { name: "gameplay", confidence: 0.8, candidates: { gameplay: 0.8 }, evidence: ["a"] },
  results: { accuracy: { value: null, confidence: 0.0 }, misses: { value: 3, confidence: 0.7 } },
  timingMs: { total: 50 },
  warnings: [],
  ocr: { ready: true },
};

run("合法 v2 帧通过校验并归一化", () => {
  const out = validateFrame(validFrame, "x.png");
  assert.strictEqual(out.schemaVersion, 2);
  assert.strictEqual(out.scene.name, "gameplay");
  assert.strictEqual(out.results.misses.value, 3);
  assert.strictEqual(out.results.accuracy.value, null);
});

run("非对象输出被拒绝", () => {
  assert.throws(() => validateFrame(null, "x"), /not an object/);
  assert.throws(() => validateFrame("text", "x"), /not an object/);
});

run("错误对象被拒绝", () => {
  assert.throws(() => validateFrame({ schemaVersion: 2, error: "boom" }, "x"), /vision error/);
});

run("schema 版本不符被拒绝", () => {
  assert.throws(() => validateFrame({ ...validFrame, schemaVersion: 1 }, "x"), /schemaVersion/);
});

run("非法场景枚举被拒绝", () => {
  assert.throws(() => validateFrame({ ...validFrame, scene: { name: "boss" } }, "x"), /invalid scene name/);
});

run("越界置信度被拒绝", () => {
  assert.throws(() => validateFrame({ ...validFrame, scene: { name: "gameplay", confidence: 1.5 } }, "x"), /out of bounds/);
});

run("0 不能冒充未识别值（null 保持 null）", () => {
  const out = validateFrame(validFrame, "x");
  assert.strictEqual(out.results.accuracy.value, null);
});

run("字段置信度越界被拒绝", () => {
  const bad = { ...validFrame, results: { accuracy: { value: 95, confidence: 2.0 } } };
  assert.throws(() => validateFrame(bad, "x"), /bad confidence/);
});

run("accuracy 越界降级为 null 并附 warning", () => {
  const bad = { ...validFrame, scene: { name: "results", confidence: 0.9 }, results: { accuracy: { value: 999, confidence: 0.9 } } };
  const out = validateFrame(bad, "x");
  assert.strictEqual(out.results.accuracy.value, null);
  assert.ok(out.warnings.includes("accuracy-out-of-range"), "应记录越界 warning");
});

run("misses 负数降级为 null", () => {
  const bad = { ...validFrame, scene: { name: "results", confidence: 0.9 }, results: { misses: { value: -5, confidence: 0.9 } } };
  const out = validateFrame(bad, "x");
  assert.strictEqual(out.results.misses.value, null);
  assert.ok(out.warnings.includes("misses-out-of-range"));
});

run("grade 非枚举降级为 null 并附 warning", () => {
  const bad = { ...validFrame, scene: { name: "results", confidence: 0.9 }, results: { grade: { value: "XXX", confidence: 0.9 } } };
  const out = validateFrame(bad, "x");
  assert.strictEqual(out.results.grade.value, null);
  assert.ok(out.warnings.includes("grade-out-of-enum"));
});

run("grade 类型非字符串降级为 null", () => {
  const bad = { ...validFrame, scene: { name: "results", confidence: 0.9 }, results: { grade: { value: 123, confidence: 0.9 } } };
  const out = validateFrame(bad, "x");
  assert.strictEqual(out.results.grade.value, null);
});

run("宽度非法（-1/0）被拒绝", () => {
  const bad = { ...validFrame, frame: { width: -1, height: 720 } };
  assert.throws(() => validateFrame(bad, "x"), /dimensions/);
  const zero = { ...validFrame, frame: { width: 0, height: 720 } };
  assert.throws(() => validateFrame(zero, "x"), /dimensions/);
});

run("合法 grade 值（S）保留", () => {
  const good = { ...validFrame, scene: { name: "results", confidence: 0.9 }, results: { grade: { value: "S", confidence: 0.9 } } };
  const out = validateFrame(good, "x");
  assert.strictEqual(out.results.grade.value, "S");
});

console.log("\nPhase G: provider status structure");

run("状态字段结构完整", () => {
  const provider = new VisionProvider();
  const status = provider.getStatus();
  for (const key of ["provider", "version", "ready", "python", "opencv", "ocr", "queueLength", "avgLatencyMs", "lastLatencyMs", "droppedFrames", "lastError", "lastObservation"]) {
    assert.ok(key in status, `缺少状态字段 ${key}`);
  }
  assert.strictEqual(status.provider, "opencv-local-v2");
  assert.strictEqual(status.version, 2);
});

run("并发保护字段存在且初始为 false", () => {
  const provider = new VisionProvider();
  assert.strictEqual(provider.inFlight, false);
  assert.strictEqual(provider.pendingFrame, null);
});

console.log(process.exitCode ? "FAILED" : "PASSED");
