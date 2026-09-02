/**
 * Visual text-region click helper for Arknights screenshots.
 *
 * Default mode is dry-run: create a numbered preview and list candidates.
 * Only `--click` sends a physical mouse click, and it requires `--index`.
 *
 * Usage:
 *   node scripts/arknights-text-click.js runtime/vision/captures/arknights/frame.png
 *   node scripts/arknights-text-click.js frame.png --index 2 --click
 */
const { spawnSync } = require("child_process");
const path = require("path");
const { click } = require("../src/bot/windows-control.js");

const ROOT = path.join(__dirname, "..");
const PYTHON = path.join(ROOT, "runtime", "vision-env", "Scripts", "python.exe");
const DETECTOR = path.join(ROOT, "src", "bot", "detect-text-regions.py");

const args = process.argv.slice(2);
const image = args.find(value => !value.startsWith("--"));
const indexAt = args.indexOf("--index");
const index = indexAt >= 0 ? Number(args[indexAt + 1]) : null;
const shouldClick = args.includes("--click");

if (!image || (shouldClick && (!Number.isInteger(index) || index < 0))) {
  console.error("用法：node scripts/arknights-text-click.js <截图> [--index N --click]");
  process.exit(1);
}

const preview = `${path.resolve(image)}.text-regions.png`;
const result = spawnSync(PYTHON, [DETECTOR, path.resolve(image), "--preview", preview], { encoding: "utf8", windowsHide: true });
if (result.status !== 0) {
  console.error(result.stderr || result.stdout || "文字区域识别失败");
  process.exit(1);
}
const report = JSON.parse(result.stdout);
console.log(`识别到 ${report.count} 个文字区域；预览：${preview}`);
report.candidates.forEach((item, i) => console.log(`#${i} 中心=(${item.center.x},${item.center.y}) 框=${item.box.width}x${item.box.height} 排名=${item.score}`));

if (!shouldClick) {
  console.log("未点击。确认预览框选正确后，使用 --index N --click。截图必须来自同一全屏坐标系。");
  process.exit(0);
}
const target = report.candidates[index];
if (!target) {
  console.error(`不存在候选 #${index}`);
  process.exit(1);
}
click(target.center.x, target.center.y);
console.log(`已点击候选 #${index}：(${target.center.x},${target.center.y})`);
