'use strict';
// Tiny logger. Console stays ASCII (Windows GBK console mangles CJK); full detail goes to UTF-8 logs/run.log.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
try { fs.mkdirSync(cfg.paths.logs, { recursive: true }); } catch {}
const file = path.join(cfg.paths.logs, 'run.log');
// The timestamp of the last line actually written. A step that stops talking is a different fault from
// a step that takes long: at 05:40:30 the obsidian round logged one line and then said nothing for 8.5
// minutes while an `equip` await never acked, and the planner could not see that because its own
// iteration clock only measures steps that finish. The planner's quiet-abort reads this.
let lastWriteAt = Date.now();

function fmt(a) {
  return a.map(x => (typeof x === 'string' ? x : (x instanceof Error ? (x.stack || x.message) : JSON.stringify(x)))).join(' ');
}
function write(tag, args) {
  const t = new Date().toISOString();
  const msg = fmt(args);
  lastWriteAt = Date.now();
  try { fs.appendFileSync(file, `[${t}] [${tag}] ${msg}\n`, 'utf8'); } catch {}
  // Keep the console line short and printable.
  const ascii = msg.replace(/[^\x20-\x7e]/g, '?');
  try { console.log(`[${tag}] ${ascii.slice(0, 300)}`); } catch {}
}
module.exports = {
  info: (...a) => write('info', a),
  warn: (...a) => write('warn', a),
  err: (...a) => write('err ', a),
  skill: (...a) => write('skill', a),
  llm: (...a) => write('llm ', a),
  lastAt: () => lastWriteAt,
  file,
};
