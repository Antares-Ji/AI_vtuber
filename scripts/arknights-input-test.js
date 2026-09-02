/**
 * One-shot interactive desktop verification for the native Arknights input
 * path. Intended to be launched in the currently logged-on Windows session.
 */
const fs = require("fs");
const path = require("path");
const {
  activateWindow,
  captureScreen,
  clickClientAtomic,
  getCursorPos,
  getWindowInfo,
} = require("../src/bot/windows-control");

const outputDir = path.join(__dirname, "..", "runtime", "vision", "captures", "arknights");
const reportPath = path.join(outputDir, "_interactive-input-report.json");
const beforePath = path.join(outputDir, "_interactive-input-before.png");
const afterPath = path.join(outputDir, "_interactive-input-after.png");

function save(report) {
  fs.mkdirSync(outputDir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
}

async function main() {
  const report = { startedAt: new Date().toISOString(), ok: false };
  try {
    report.activation = activateWindow();
    const before = getWindowInfo();
    captureScreen(before.client.x, before.client.y, before.client.width, before.client.height, beforePath);
    report.cursorBefore = getCursorPos();
    const clientX = Math.round((report.activation.client.width - 1) * 0.033);
    const clientY = Math.round((report.activation.client.height - 1) * 0.047);
    report.click = clickClientAtomic(clientX, clientY);
    await new Promise(resolve => setTimeout(resolve, 1200));
    const after = getWindowInfo();
    captureScreen(after.client.x, after.client.y, after.client.width, after.client.height, afterPath);
    report.cursorAfter = getCursorPos();
    report.windowAfter = after;
    report.beforePath = beforePath;
    report.afterPath = afterPath;
    report.ok = true;
  } catch (error) {
    report.error = error?.stack || String(error);
  }
  report.finishedAt = new Date().toISOString();
  save(report);
  if (!report.ok) process.exitCode = 1;
}

main();
