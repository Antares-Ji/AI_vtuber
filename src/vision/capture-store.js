/**
 * capture-store.js —— 数据采集工具：保存用户标注的屏幕帧
 *
 * 用于真实画面采集（osu / 明日方舟 / 其他游戏）：
 *  - 保存截图到 runtime/vision/captures/<game>/（不入库、不进 git）
 *  - 追加标注到该 game 的 manifest.json（file/scene/note/at）
 *  - 串行写入，避免并发损坏
 *
 * 后续用户可把采集样本整理进 tests/fixtures/real/<game>/ 做正式评测。
 */
const fs = require("fs/promises");
const path = require("path");
const { randomUUID } = require("crypto");

const ROOT = path.join(__dirname, "..", "..");
const CAPTURES_DIR = path.join(ROOT, "runtime", "vision", "captures");

let writeQueue = Promise.resolve();

function sanitize(value) {
  return String(value || "unknown").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 40);
}

function sanitizeScene(value) {
  return sanitize(value) || "unknown";
}

async function saveCapture(buffer, { game = "unknown", scene = "unknown", note = "", contentType = "image/png" } = {}) {
  if (!buffer?.length) throw new Error("image is required");
  const gameDir = path.join(CAPTURES_DIR, sanitize(game));
  await fs.mkdir(gameDir, { recursive: true });
  const extension = contentType.includes("jpeg") ? ".jpg" : ".png";
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const fileName = `${sanitizeScene(scene)}-${stamp}-${randomUUID().slice(0, 6)}${extension}`;
  await fs.writeFile(path.join(gameDir, fileName), buffer);

  const record = {
    file: fileName,
    scene: sanitizeScene(scene),
    note: String(note || "").trim().slice(0, 200),
    at: new Date().toISOString(),
  };

  // 串行追加 manifest
  const manifestPath = path.join(gameDir, "manifest.json");
  const task = writeQueue.then(async () => {
    let manifest = { schemaVersion: 1, game: sanitize(game), captures: [] };
    try {
      manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch { /* 首次采集 */ }
    if (!Array.isArray(manifest.captures)) manifest.captures = [];
    manifest.captures.push(record);
    const temporary = `${manifestPath}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(manifest, null, 2), "utf8");
    await fs.rename(temporary, manifestPath);
  });
  writeQueue = task.catch(() => {});
  await task;

  return { ...record, game: sanitize(game), manifestCount: 0 };
}

module.exports = { saveCapture, CAPTURES_DIR };
