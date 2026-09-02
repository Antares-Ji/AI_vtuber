/**
 * test_multi_session_trend.js —— 返修：多局趋势分析集成测试
 *
 * 预写同谱面历史 observation，验证 recordTelemetry 读取历史后
 * 触发"三局趋势"分析（而非永远只有一局）。
 * 用法：node tests/vision/test_multi_session_trend.js
 */
const fs = require("fs/promises");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { VisionProvider } = require(path.join(__dirname, "..", "..", "src", "vision", "provider.js"));
const { readProdObservations, assertProdUnchanged, cleanupTmp } = require("./helpers");

async function main() {
  const prodBefore = readProdObservations();
  const tmp = path.join(os.tmpdir(), `vision-trend-test-${Date.now()}.json`);
  const history = [
    { at: new Date().toISOString(), source: "telemetry", mapTitle: "mapA", accuracy: 90, misses: 8, combo: 200 },
    { at: new Date().toISOString(), source: "telemetry", mapTitle: "mapA", accuracy: 93, misses: 5, combo: 300 },
    { at: new Date().toISOString(), source: "telemetry", mapTitle: "mapB", accuracy: 80, misses: 15, combo: 100 },
  ];
  await fs.writeFile(tmp, JSON.stringify(history, null, 2));

  const provider = new VisionProvider({ observationsPath: tmp });
  const result = await provider.recordTelemetry({ mapTitle: "mapA", accuracy: 95.5, misses: 3, combo: 400 });

  assert.strictEqual(result.historyCount, 2, "应读取到 2 局同谱面历史");
  assert.strictEqual(result.analysis.summary.count, 3, "分析应聚合历史 2 局 + 当前 1 局");
  assert.ok(
    result.analysis.suggestions.some(s => s.category === "accuracy" && s.text.includes("上升趋势")),
    "三局上升趋势应触发 accuracy 建议：" + JSON.stringify(result.analysis.suggestions.map(s => s.text))
  );

  // 写入验证：当前局已追加
  const saved = JSON.parse(await fs.readFile(tmp, "utf8"));
  assert.strictEqual(saved.length, 4, "observation 文件应追加当前局");

  assertProdUnchanged(prodBefore);
  await fs.unlink(tmp);
  cleanupTmp(tmp);
  console.log("PASSED");
  process.exit(0);
}

main().catch(error => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
