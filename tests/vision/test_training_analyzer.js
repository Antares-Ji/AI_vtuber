/**
 * test_training_analyzer.js —— Phase F：训练建议模块测试
 *
 * 覆盖：边界值、缺失字段、单局初步建议、多局趋势、evidence 存在性、
 * 不武断归因（miss 多时 category 不得为 aim/reading/speed）。
 * 用法：node tests/vision/test_training_analyzer.js
 */
const assert = require("assert");
const path = require("path");

const { analyzeObservations, normalizeObservation, CATEGORIES } = require(path.join(__dirname, "..", "..", "src", "vision", "training-analyzer.js"));

function run(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
  } catch (error) {
    console.error(`  ✗ ${name}: ${error.message}`);
    process.exitCode = 1;
  }
}

console.log("Phase F: training analyzer");

run("空数据返回 insufficient-data", () => {
  const result = analyzeObservations([]);
  assert.strictEqual(result.summary.count, 0);
  assert.strictEqual(result.suggestions[0].category, "insufficient-data");
  assert.ok(result.suggestions[0].evidence.length >= 0);
});

run("单局 acc<90 给出降速建议且 evidence 含数值", () => {
  const result = analyzeObservations([{ mapTitle: "test", accuracy: 85.5, misses: 12, maxCombo: 200 }]);
  const suggestions = result.suggestions;
  assert.ok(suggestions.some(s => s.category === "consistency"));
  const target = suggestions.find(s => s.evidence.some(e => e.includes("accuracy=85.50")));
  assert.ok(target, "应包含带 accuracy 数值的 evidence");
  assert.ok(target.text.length > 10);
});

run("边界值：acc=100 不触发低 acc 建议", () => {
  const result = analyzeObservations([{ mapTitle: "test", accuracy: 100, misses: 0 }]);
  assert.ok(result.suggestions.every(s => !s.text.includes("降速")));
});

run("越界值被规范化（acc=150 -> 不发布）", () => {
  const normalized = normalizeObservation({ mapTitle: "test", accuracy: 150, misses: -5 });
  assert.strictEqual(normalized.accuracy, 100);  // 裁剪到上限
  assert.strictEqual(normalized.misses, 0);      // 裁剪到下限
});

run("null/undefined/空字符串视为缺失（不发布为 0）", () => {
  const normalized = normalizeObservation({ mapTitle: "test", accuracy: null, misses: undefined, maxCombo: "" });
  assert.strictEqual(normalized.accuracy, undefined, "null 不得变 0");
  assert.strictEqual(normalized.misses, undefined, "undefined 不得变 0");
  assert.strictEqual(normalized.maxCombo, undefined, "空字符串不得变 0");
  // 全缺失时不得触发"降速"建议（不能把未知当 0%）
  const result = analyzeObservations([{ mapTitle: "test" }]);
  assert.ok(result.suggestions.every(s => !s.text.includes("降速")), "未知数据不应触发降速建议");
});

run("缺失字段不产生虚假建议", () => {
  const result = analyzeObservations([{ mapTitle: "test" }]);
  // 只有谱面名：不发布任何数值型建议
  assert.ok(result.suggestions.length >= 1);
  assert.ok(result.suggestions.every(s => s.evidence.every(e => !/\d+\.\d+/.test(e) || e.includes("count"))));
});

run("miss 多时不武断归因 aim/reading/speed", () => {
  const result = analyzeObservations([{ mapTitle: "test", accuracy: 88, misses: 25 }]);
  for (const s of result.suggestions) {
    assert.notStrictEqual(s.category, "aim", s.text);
    assert.notStrictEqual(s.category, "speed", s.text);
  }
  // 允许 reading 仅当 mods 证据存在时
  const reading = result.suggestions.filter(s => s.category === "reading");
  assert.strictEqual(reading.length, 0, "无 mods 数据时不应断言 reading");
});

run("HR/DT mods 触发对照实验建议", () => {
  const result = analyzeObservations([{ mapTitle: "test", accuracy: 91.2, misses: 8, mods: ["HR"] }]);
  assert.ok(result.suggestions.some(s => s.evidence.some(e => e.includes("mods=HR"))));
});

run("单局只给初步建议，无趋势断言", () => {
  const result = analyzeObservations([{ mapTitle: "test", accuracy: 93, misses: 4 }]);
  assert.ok(result.suggestions.every(s => !s.text.includes("趋势")));
});

run("三局同谱面上升趋势给 accuracy 建议", () => {
  const observations = [
    { mapTitle: "mapA", accuracy: 90, misses: 8 },
    { mapTitle: "mapA", accuracy: 93, misses: 5 },
    { mapTitle: "mapA", accuracy: 95.5, misses: 3 },
  ];
  const result = analyzeObservations(observations);
  assert.ok(result.suggestions.some(s => s.category === "accuracy" && s.text.includes("上升趋势")));
});

run("三局同谱面波动大给一致性建议", () => {
  const observations = [
    { mapTitle: "mapB", accuracy: 88, misses: 10 },
    { mapTitle: "mapB", accuracy: 97, misses: 1 },
    { mapTitle: "mapB", accuracy: 89, misses: 9 },
  ];
  const result = analyzeObservations(observations);
  assert.ok(result.suggestions.some(s => s.category === "consistency" && s.text.includes("波动较大")));
});

run("建议 category 全部在枚举内", () => {
  const result = analyzeObservations([{ mapTitle: "t", accuracy: 80, misses: 20 }]);
  for (const s of result.suggestions) {
    assert.ok(CATEGORIES.includes(s.category), s.category);
  }
});

run("每条建议都有 evidence 和 nextMeasurement", () => {
  const result = analyzeObservations([{ mapTitle: "t", accuracy: 91, misses: 6 }]);
  for (const s of result.suggestions) {
    assert.ok(Array.isArray(s.evidence) && s.evidence.length > 0, s.text);
    assert.ok(s.nextMeasurement && s.nextMeasurement.length > 0, s.text);
    assert.ok(s.confidence >= 0 && s.confidence <= 1, s.text);
  }
});

console.log(process.exitCode ? "FAILED" : "PASSED");
