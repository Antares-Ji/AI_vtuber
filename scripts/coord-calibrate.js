/**
 * coord-calibrate.js —— 明日方舟按钮坐标采集工具
 *
 * 用法（在你自己的终端里运行，需要交互）：
 *   node scripts/coord-calibrate.js
 *
 * 流程：
 *   1. 输入按钮名称（如"基建"）
 *   2. 把鼠标移到屏幕上该按钮的正中心
 *   3. 按回车，记录坐标
 *   4. 重复；输入 q 结束并保存
 *
 * 输出：runtime/vision/captures/arknights/buttons.json
 * 说明：坐标与截屏/点击共用同一虚拟屏幕坐标系，可直接用于自动化点击。
 */
const readline = require("readline");
const fs = require("fs");
const path = require("path");

const { getCursorPos } = require("../src/bot/windows-control.js");

const OUT_PATH = path.join(__dirname, "..", "runtime", "vision", "captures", "arknights", "buttons.json");

// 若已有记录，先加载
let buttons = {};
try {
  buttons = JSON.parse(fs.readFileSync(OUT_PATH, "utf8"));
} catch { /* 首次采集 */ }

const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

function save() {
  fs.writeFileSync(OUT_PATH, JSON.stringify(buttons, null, 2), "utf8");
  console.log(`\n已保存 ${Object.keys(buttons).length} 个按钮到: ${OUT_PATH}`);
  console.log(JSON.stringify(buttons, null, 2));
}

function askName() {
  rl.question('\n按钮名称（输入 "q" 结束）: ', (name) => {
    name = name.trim();
    if (name === "" ) return askName();
    if (name.toLowerCase() === "q") {
      save();
      rl.close();
      return;
    }
    rl.question(`  把鼠标移到「${name}」的正中心，然后按回车...`, () => {
      const pos = getCursorPos();
      buttons[name] = { x: pos.x, y: pos.y };
      console.log(`  ✓ 记录 ${name} = (${pos.x}, ${pos.y})`);
      askName();
    });
  });
}

console.log("=== 明日方舟按钮坐标采集 ===");
console.log("建议采集顺序：侧边栏各按钮、顶部资源数字、基建内各入口等");
askName();
