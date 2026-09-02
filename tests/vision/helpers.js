/**
 * helpers.js —— 视觉测试辅助：临时 observation 文件 + 正式数据不变断言
 *
 * 所有涉及 provider 写入的测试都必须：
 *  1. 用 makeTmpObservationsPath() 生成临时文件，传入 VisionProvider({ observationsPath })
 *  2. 测试前后调用 assertProdUnchanged() 断言正式 data/osu-observations.json 内容完全不变
 *  3. finally 中删除临时文件
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

const ROOT = path.join(__dirname, "..", "..");
const PROD_OBSERVATIONS = path.join(ROOT, "data", "osu-observations.json");

function readProdObservations() {
  try {
    return fs.readFileSync(PROD_OBSERVATIONS, "utf8");
  } catch {
    return null;
  }
}

function makeTmpObservationsPath() {
  return path.join(os.tmpdir(), `vision-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`);
}

function assertProdUnchanged(before, label = "正式 observation 文件") {
  const after = readProdObservations();
  if (before !== after) {
    throw new Error(`${label}被测试修改（测试必须使用临时 observationsPath）`);
  }
}

function cleanupTmp(tmpPath) {
  for (const suffix of ["", ".tmp"]) {
    try {
      fs.rmSync(`${tmpPath}${suffix}`, { force: true });
    } catch { /* 忽略 */ }
  }
}

module.exports = { readProdObservations, makeTmpObservationsPath, assertProdUnchanged, cleanupTmp, PROD_OBSERVATIONS };
