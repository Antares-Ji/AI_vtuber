/**
 * build-buttons.js —— 把 coords.txt 的坐标按顺序对应按钮名，生成 buttons.json
 * 用法：node scripts/build-buttons.js
 */
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const COORDS = path.join(ROOT, "runtime", "vision", "captures", "arknights", "coords.txt");
const OUT = path.join(ROOT, "runtime", "vision", "captures", "arknights", "buttons.json");

// 与采集顺序一一对应
const NAMES = [
  "设置", "活动公告", "邮件", "签到", "充值源石", "补充体力", "终端",
  "当期活动一", "当期活动二", "编队", "干员", "采购中心", "公开招募",
  "干员寻访", "任务", "基建", "仓库", "隐藏ui", "替换看板角色",
  "临时礼包或皮肤推荐", "好友", "档案", "将源石转化为合成玉",
];

const lines = fs.readFileSync(COORDS, "utf8").split(/\r?\n/).filter(line => /^\d+,\d+$/.test(line));
if (lines.length !== NAMES.length) {
  console.error(`坐标数 ${lines.length} 与按钮名数 ${NAMES.length} 不一致，请检查`);
  process.exit(1);
}

const buttons = {};
lines.forEach((line, index) => {
  const [x, y] = line.split(",").map(Number);
  buttons[NAMES[index]] = { x, y };
});

fs.writeFileSync(OUT, JSON.stringify(buttons, null, 2), "utf8");
console.log(`已生成 ${Object.keys(buttons).length} 个按钮 -> ${OUT}`);
console.log(JSON.stringify(buttons, null, 2));
