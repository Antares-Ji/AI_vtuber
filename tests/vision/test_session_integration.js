/**
 * test_session_integration.js —— 返修：session-tracker 生产链路集成测试
 *
 * 用真实 fixture 帧序列（2 gameplay + 2 results）通过 provider.processFrame，
 * 验证状态机在生产链路中自动形成"开始→结算→一局完成"事件，并生成一次性结算记录。
 * 用法：node tests/vision/test_session_integration.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { VisionProvider } = require(path.join(__dirname, "..", "..", "src", "vision", "provider.js"));
const FIXTURES = path.join(__dirname, "..", "fixtures", "vision");

const gameplayPng = fs.readFileSync(path.join(FIXTURES, "gp-1280-a.png"));
const resultsPng = fs.readFileSync(path.join(FIXTURES, "rs-1280-a.png"));

async function main() {
  const provider = new VisionProvider();
  await new Promise(resolve => setTimeout(resolve, 1500)); // 等环境探测
  assert.strictEqual(provider.status.ready, true, "视觉环境应就绪");

  const events = [];
  // 2 gameplay + 2 results 帧序列（通过真实 Python 分析）
  for (const buffer of [gameplayPng, gameplayPng, resultsPng, resultsPng]) {
    const result = await provider.processFrame(buffer, "image/png");
    events.push(result.sessionEvent);
    if (result.sessionEvent === "session-complete") {
      assert.ok(result.session, "session-complete 应携带 session");
      assert.ok(result.session.result, "session 应含结算 result");
      assert.strictEqual(result.session.result.accuracy.value, 95.28, "结算 accuracy 应来自 results 帧 OCR");
      assert.strictEqual(result.session.result.misses.value, 3);
      assert.ok(result.sessionResult, "应生成 sessionResult（一次性结算记录）");
      assert.strictEqual(result.sessionResult.flat.accuracy, 95.28);
      assert.ok(result.sessionAnalysis, "一局完成应附带训练分析");
    }
  }

  console.log(`帧序列事件: ${events.join(" -> ")}`);
  assert.ok(events.includes("session-start"), "应出现 session-start");
  assert.ok(events.includes("session-complete"), "应出现 session-complete");
  assert.strictEqual(events.filter(e => e === "session-complete").length, 1, "一局只能完成一次");
  assert.strictEqual(provider.status.session.state, "idle", "完成后回到 idle");

  // 重复 results 帧不应再次 complete
  const extra = await provider.processFrame(resultsPng, "image/png");
  assert.notStrictEqual(extra.sessionEvent, "session-complete", "结算页重复帧不应重复完成");

  console.log("PASSED");
  process.exit(0);
}

main().catch(error => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
