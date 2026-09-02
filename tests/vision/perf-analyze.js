/**
 * perf-analyze.js —— Phase G：单帧分析延迟基准（性能目标 P95 < 1000ms @1280 宽 JPEG）
 *
 * 隔离：使用临时 observationsPath，测试前后断言正式数据文件完全不变，finally 清理。
 * 用法：node tests/vision/perf-analyze.js [rounds]
 * 输出：P50/P95/max 延迟、测试机信息、图片尺寸。
 */
const fs = require("fs");
const path = require("path");
const os = require("os");

const { VisionProvider } = require(path.join(__dirname, "..", "..", "src", "vision", "provider.js"));
const { readProdObservations, makeTmpObservationsPath, assertProdUnchanged, cleanupTmp } = require("./helpers");

async function main() {
  const prodBefore = readProdObservations();
  const tmpPath = makeTmpObservationsPath();
  const rounds = Math.min(20, Math.max(5, Number(process.argv[2]) || 10));
  const fixturePath = path.join(__dirname, "..", "fixtures", "vision", "gp-1280-a.png");
  const png = fs.readFileSync(fixturePath);
  const { spawnSync } = require("child_process");
  const python = path.join(__dirname, "..", "..", "runtime", "vision-env", "Scripts", "python.exe");
  const jpegPath = path.join(os.tmpdir(), `vision-perf-${Date.now()}.jpg`);
  const convert = spawnSync(python, ["-c", `
import cv2, sys
img = cv2.imread(sys.argv[1])
cv2.imwrite(sys.argv[2], img, [cv2.IMWRITE_JPEG_QUALITY, 80])
`, fixturePath, jpegPath], { encoding: "utf8", timeout: 20000 });
  if (convert.status !== 0) {
    console.error("JPEG 转换失败:", convert.stderr || convert.stdout);
    process.exit(1);
  }
  const buffer = fs.readFileSync(jpegPath);
  const provider = new VisionProvider({ observationsPath: tmpPath });
  try {
    await new Promise(resolve => setTimeout(resolve, 1500));
    console.log(`vision status: provider=${provider.status.provider} ready=${provider.status.ready} python=${provider.status.python.version} opencv=${provider.status.opencv.version}`);
    console.log(`fixture: gp-1280-a.png -> JPEG ${buffer.length} bytes, rounds=${rounds}, machine=${os.hostname()} cpu=${os.cpus()[0]?.model}`);

    const latencies = [];
    for (let index = 0; index < rounds; index += 1) {
      const started = Date.now();
      const result = await provider.analyzeScreenshot(buffer, "image/jpeg");
      const elapsed = Date.now() - started;
      if (result.queued) {
        console.warn(`  round ${index + 1}: queued (跳过，串行循环不应出现)`);
        continue;
      }
      latencies.push(elapsed);
    }

    if (!latencies.length) {
      console.error("无有效延迟样本");
      process.exit(1);
    }
    const sorted = [...latencies].sort((a, b) => a - b);
    const p50 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.5) - 1)];
    const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.95) - 1)];
    const max = sorted[sorted.length - 1];
    const target = 1000;
    console.log(`\n延迟（毫秒，image 1280x720 JPEG）: p50=${p50} p95=${p95} max=${max} samples=${sorted.length}`);
    console.log(`性能目标 P95 < ${target}ms: ${p95 < target ? "达标 ✓" : `未达标（实测 p95=${p95}ms，如实报告）`}`);
    console.log(`avg=${Math.round(latencies.reduce((s, v) => s + v, 0) / latencies.length)}ms`);
    assertProdUnchanged(prodBefore);
  } finally {
    cleanupTmp(tmpPath);
    try { fs.unlinkSync(jpegPath); } catch { /* 忽略 */ }
  }
  process.exit(0);
}

main().catch(error => {
  console.error("性能基准失败:", error.message);
  process.exit(1);
});
