/**
 * bot.js —— 明日方舟自动化基础：读按钮地图 + 点击
 * 用法：node scripts/bot.js <按钮名>  （点击某个按钮）
 *       node scripts/bot.js click <x> <y>  （点击任意坐标）
 */
const fs = require("fs");
const path = require("path");
const { click, captureScreen } = require("../src/bot/windows-control.js");

const BUTTONS_PATH = path.join(__dirname, "..", "runtime", "vision", "captures", "arknights", "buttons.json");

function loadButtons() {
  return JSON.parse(fs.readFileSync(BUTTONS_PATH, "utf8"));
}

async function main() {
  const args = process.argv.slice(2);
  let x, y, label;

  if (args[0] === "click" && args.length === 3) {
    x = Number(args[1]);
    y = Number(args[2]);
    label = `(${x},${y})`;
  } else if (args.length === 1) {
    const buttons = loadButtons();
    const target = buttons[args[0]];
    if (!target) {
      console.error(`未知按钮「${args[0]}」，可用按钮：${Object.keys(buttons).join("、")}`);
      process.exit(1);
    }
    x = target.x;
    y = target.y;
    label = `${args[0]}@(${x},${y})`;
  } else {
    console.error("用法: node scripts/bot.js <按钮名>  或  node scripts/bot.js click <x> <y>");
    process.exit(1);
  }

  console.log(`点击 ${label}`);
  click(x, y);
  // 点击后截图留证
  const out = path.join(__dirname, "..", "runtime", "vision", "captures", "arknights", `_after-click-${Date.now()}.png`);
  setTimeout(() => {
    try {
      const buf = captureScreen(0, 0, 1920, 1080, out);
      console.log(`已截图留证: ${out} (${buf.length} bytes)`);
    } catch (error) {
      console.warn("截图失败:", error.message);
    }
    process.exit(0);
  }, 1500);
}

main();
