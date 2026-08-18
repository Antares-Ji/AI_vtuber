/**
 * run-baseline.js —— Phase A：v1 分析器 baseline
 *
 * 对 tests/fixtures/vision/ 下全部合成图运行现有 v1 (src/vision/osu_analyzer.py)，
 * 连续执行两次，保存输出并验证结构一致性（任务书 Phase A 完成条件）。
 *
 * 用法：node tests/vision/run-baseline.js
 * 输出：tests/fixtures/vision/baseline-v1-run1.json / run2.json
 */
const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");

const ROOT = path.join(__dirname, "..", "..");
const PYTHON = path.join(ROOT, "runtime", "vision-env", "Scripts", "python.exe");
const ANALYZER = path.join(ROOT, "src", "vision", "osu_analyzer.py");
const FIXTURE_DIR = path.join(ROOT, "tests", "fixtures", "vision");
const MANIFEST = path.join(FIXTURE_DIR, "manifest.json");

function runV1(imagePath) {
  const result = spawnSync(PYTHON, [ANALYZER, imagePath], { encoding: "utf8", timeout: 30_000 });
  if (result.error) return { error: String(result.error.message || result.error) };
  if (result.status !== 0) return { error: `exit ${result.status}: ${(result.stderr || "").slice(0, 200)}` };
  try {
    return { ok: true, value: JSON.parse(result.stdout) };
  } catch (error) {
    return { error: `invalid JSON: ${String(result.stdout).slice(0, 200)}` };
  }
}

function structuralKeys(value) {
  if (value === null || typeof value !== "object") return typeof value;
  if (Array.isArray(value)) return ["array", value.length];
  return Object.keys(value).sort();
}

function main() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, "utf8"));
  const fixtures = manifest.fixtures;
  const runs = { run1: [], run2: [] };

  for (const fixture of fixtures) {
    const imagePath = path.join(FIXTURE_DIR, fixture.file);
    for (const runName of ["run1", "run2"]) {
      const result = runV1(imagePath);
      runs[runName].push({
        fixture: fixture.id,
        resolution: fixture.resolution,
        expectedScene: fixture.expectedScene,
        ...result
      });
    }
  }

  // 一致性检查：两次运行的 JSON 结构（字段集合）必须一致，且场景判定一致
  const consistency = [];
  for (let index = 0; index < fixtures.length; index += 1) {
    const a = runs.run1[index];
    const b = runs.run2[index];
    const aKeys = a.ok ? structuralKeys(a.value) : `error:${a.error}`;
    const bKeys = b.ok ? structuralKeys(b.value) : `error:${b.error}`;
    const sameStructure = JSON.stringify(aKeys) === JSON.stringify(bKeys);
    const sameScene = a.ok && b.ok ? a.value.scene === b.value.scene : a.ok === b.ok;
    consistency.push({
      fixture: fixtures[index].id,
      sameStructure,
      sameScene,
      run1Scene: a.ok ? a.value.scene : "error",
      run2Scene: b.ok ? b.value.scene : "error"
    });
  }

  const allConsistent = consistency.every(item => item.sameStructure && item.sameScene);
  const out1 = path.join(FIXTURE_DIR, "baseline-v1-run1.json");
  const out2 = path.join(FIXTURE_DIR, "baseline-v1-run2.json");
  fs.writeFileSync(out1, JSON.stringify({ generatedAt: new Date().toISOString(), analyzer: "src/vision/osu_analyzer.py (v1)", results: runs.run1 }, null, 2));
  fs.writeFileSync(out2, JSON.stringify({ generatedAt: new Date().toISOString(), analyzer: "src/vision/osu_analyzer.py (v1)", results: runs.run2 }, null, 2));

  console.log(`baseline v1 完成：${fixtures.length} 张 fixture × 2 次运行`);
  console.log(`结构一致性：${allConsistent ? "通过" : "失败"}`);
  for (const item of consistency) {
    if (!item.sameStructure || !item.sameScene) console.warn(`  不一致: ${item.fixture} structure=${item.sameStructure} scene=${item.sameScene}`);
  }
  console.log(`输出：${out1} / ${out2}`);
  console.log("\n=== v1 场景判定结果 ===");
  for (const item of runs.run1) {
    const scene = item.ok ? item.value.scene : `error(${item.error})`;
    const mark = scene === item.expectedScene ? "✓" : "✗";
    console.log(`  ${mark} ${item.fixture}: v1=${scene} expected=${item.expectedScene}`);
  }
  process.exit(allConsistent ? 0 : 1);
}

main();
