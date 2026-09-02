/**
 * windows-control.js —— Windows 原生输入控制（全自动 Bot 执行层）
 *
 * 封装 PowerShell + user32/System.Drawing 原生 API：
 *  - captureScreen(x, y, w, h, outPath)：截取屏幕区域
 *  - moveMouse(x, y)：移动鼠标
 *  - click(x, y)：移动 + 左键点击
 *  - getCursorPos()：读取鼠标位置
 *
 * 零 npm 原生依赖，兼容 Node 24。注意：本模块运行在服务器进程（用户环境），
 * 不受 agent 沙箱限制。
 */
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const PS_SCRIPT = path.join(__dirname, "win-control.ps1");

function runPs(action, args = []) {
  const result = spawnSync(
    "powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", PS_SCRIPT, action, ...args],
    { encoding: "utf8", timeout: 30_000, windowsHide: true }
  );
  if (result.error) throw new Error(`powerShell launch failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`win-control ${action} failed: ${(result.stderr || result.stdout || "").trim().slice(0, 300)}`);
  return result.stdout.trim();
}

function activateWindow() {
  return parseJson(runPs("activate"), "activate");
}

function revealWindow() {
  return parseJson(runPs("reveal"), "reveal");
}

function unpinWindow() {
  return parseJson(runPs("unpin"), "unpin");
}

function captureScreen(x, y, width, height, outPath) {
  if (!Number.isInteger(x) || !Number.isInteger(y) || width <= 0 || height <= 0) {
    throw new Error("captureScreen requires integer x/y and positive width/height");
  }
  runPs("capture", [String(x), String(y), String(width), String(height), outPath]);
  if (!fs.existsSync(outPath)) throw new Error("capture produced no file");
  return fs.readFileSync(outPath);
}

function captureWindow(outPath) {
  runPs("capturewindow", ["0", "0", "0", "0", outPath]);
  if (!fs.existsSync(outPath)) throw new Error("window capture produced no file");
  return fs.readFileSync(outPath);
}

function moveMouse(x, y) {
  return parseJson(runPs("move", [String(Math.round(x)), String(Math.round(y))]), "move");
}

function click(x, y) {
  return parseJson(runPs("click", [String(Math.round(x)), String(Math.round(y))]), "click");
}

function clickMessage(x, y) {
  return parseJson(runPs("msgclick", [String(Math.round(x)), String(Math.round(y))]), "msgclick");
}

function getWindowInfo() {
  return parseJson(runPs("info"), "info");
}

function clickClient(x, y) {
  const info = getWindowInfo();
  const clientX = Math.round(x);
  const clientY = Math.round(y);
  if (clientX < 0 || clientY < 0 || clientX >= info.client.width || clientY >= info.client.height) {
    throw new Error(`client click outside Arknights window: ${clientX},${clientY}`);
  }
  return click(info.client.x + clientX, info.client.y + clientY);
}

function clickClientAtomic(x, y) {
  return parseJson(runPs("clientclick", [String(Math.round(x)), String(Math.round(y))]), "clientclick");
}

function dragClientAtomic(startX, startY, endX, endY) {
  return parseJson(runPs("clientdrag", [
    String(Math.round(startX)), String(Math.round(startY)),
    String(Math.round(endX)), String(Math.round(endY)),
  ]), "clientdrag");
}

function clickClientMessageAtomic(x, y) {
  return parseJson(runPs("clientmsgclick", [String(Math.round(x)), String(Math.round(y))]), "clientmsgclick");
}

function clickClientMessage(x, y) {
  const info = getWindowInfo();
  const clientX = Math.round(x);
  const clientY = Math.round(y);
  if (clientX < 0 || clientY < 0 || clientX >= info.client.width || clientY >= info.client.height) {
    throw new Error(`client message click outside Arknights window: ${clientX},${clientY}`);
  }
  return clickMessage(info.client.x + clientX, info.client.y + clientY);
}

function clickNormalized(xRatio, yRatio) {
  if (!Number.isFinite(xRatio) || !Number.isFinite(yRatio) || xRatio < 0 || xRatio > 1 || yRatio < 0 || yRatio > 1) {
    throw new Error("normalized click ratios must be between 0 and 1");
  }
  const info = getWindowInfo();
  return click(
    info.client.x + Math.round((info.client.width - 1) * xRatio),
    info.client.y + Math.round((info.client.height - 1) * yRatio)
  );
}

function getCursorPos() {
  return parseJson(runPs("pos"), "pos");
}

function parseJson(output, action) {
  try {
    return JSON.parse(output);
  } catch {
    throw new Error(`invalid ${action} output: ${output}`);
  }
}

module.exports = {
  captureScreen,
  captureWindow,
  moveMouse,
  click,
  clickMessage,
  clickClient,
  clickClientAtomic,
  dragClientAtomic,
  clickClientMessageAtomic,
  clickClientMessage,
  clickNormalized,
  getCursorPos,
  getWindowInfo,
  activateWindow,
  revealWindow,
  unpinWindow,
};
