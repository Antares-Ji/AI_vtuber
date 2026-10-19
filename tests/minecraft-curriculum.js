const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { parseCommand, validateCommand } = require('../src/minecraft/commands');
const cases = [
  ['查看状态', { connected: true }, 'status'],
  ['砍树并制作工作台', { connected: true, mode: 'survival' }, 'workbench'],
  ['停止', { connected: true, busy: true }, 'stop'],
  ['停止', { connected: false }, 'stop'],
  ['传送到我身边', { connected: true }, 'tp'],
  ['退出游戏', { connected: false }, 'quit'],
  ['制作工作台', { connected: false }, null],
  ['制作工作台', { connected: true, mode: 'creative' }, null],
  ['制作工作台', { connected: true, mode: 'survival', busy: true }, null],
  ['tp', { connected: true, busy: true }, null],
  ['/give @a diamond 64', { connected: true }, null],
  ['制作工作台然后退出游戏', { connected: true, mode: 'survival' }, null],
  ['帮我弄一下', { connected: true }, null]
];
const results = cases.map(([text, state, expected]) => {
  let command = null;
  try { command = parseCommand(text); validateCommand(command, state); } catch { command = null; }
  assert.equal(command, expected, text);
  return { text, state, expected, actual: command, passed: true };
});
const report = { at: new Date().toISOString(), kind: 'offline-command-curriculum', total: results.length, passed: results.length,
  liveGameplayVerified: false, modelWeightsTrained: false, results };
const target = path.resolve(__dirname, '../logs/minecraft-curriculum.json');
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: results.length, total: results.length, report: target, liveGameplayVerified: false }));
