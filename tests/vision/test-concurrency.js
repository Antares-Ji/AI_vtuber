/**
 * test-concurrency.js —— Phase G：并发与队列冒烟测试
 *
 * 同时发起多个 analyzeScreenshot 请求：
 *  - 全部请求必须 settle（不挂起）
 *  - 在途时新帧返回 queued（只保留最新，不堆积）
 *  - droppedFrames 计数生效
 *  - 结束后 inFlight 复位、队列清空
 *
 * 隔离：使用临时 observationsPath，测试前后断言正式数据文件完全不变，finally 清理。
 * 用法：node tests/vision/test-concurrency.js
 */
const fs = require("fs");
const path = require("path");
const assert = require("assert");

const { VisionProvider } = require(path.join(__dirname, "..", "..", "src", "vision", "provider.js"));
const { readProdObservations, makeTmpObservationsPath, assertProdUnchanged, cleanupTmp } = require("./helpers");

async function main() {
  const prodBefore = readProdObservations();
  const tmpPath = makeTmpObservationsPath();
  const fixture = fs.readFileSync(path.join(__dirname, "..", "fixtures", "vision", "gp-1280-a.png"));
  const provider = new VisionProvider({ observationsPath: tmpPath });
  try {
    await new Promise(resolve => setTimeout(resolve, 1500));

    const CONCURRENCY = 12;
    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, () => provider.analyzeScreenshot(fixture, "image/png"))
    );

    const fulfilled = results.filter(r => r.status === "fulfilled");
    const rejected = results.filter(r => r.status === "rejected");
    const queued = fulfilled.filter(r => r.value?.queued === true);
    const analyzed = fulfilled.filter(r => r.value?.schemaVersion === 2);

    console.log(`并发 ${CONCURRENCY} 请求: fulfilled=${fulfilled.length} rejected=${rejected.length} queued=${queued.length} analyzed=${analyzed.length}`);
    assert.strictEqual(rejected.length, 0, `存在失败请求: ${rejected.map(r => r.reason?.message).join("; ")}`);
    assert.ok(analyzed.length >= 1, "至少一帧应被实际分析");
    assert.ok(queued.length >= 1, "在途时应有过期帧被标记 queued");
    assert.ok(provider.status.droppedFrames >= 1, "droppedFrames 应累计");
    assert.strictEqual(provider.inFlight, false, "结束后 inFlight 必须复位");
    assert.strictEqual(provider.pendingFrame, null, "结束后 pending 必须清空");
    assert.strictEqual(provider.status.queueLength, 0, "结束后队列必须清空");
    console.log(`droppedFrames=${provider.status.droppedFrames} avgLatency=${provider.status.avgLatencyMs}ms lastLatency=${provider.status.lastLatencyMs}ms`);

    assertProdUnchanged(prodBefore);
    console.log("PASSED");
  } finally {
    cleanupTmp(tmpPath);
  }
  process.exit(0);
}

main().catch(error => {
  console.error("FAILED:", error.message);
  process.exit(1);
});
