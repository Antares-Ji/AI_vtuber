'use strict';
// Reconnect supervisor for the autonomous Minecraft speedrun engine.
const fs = require('node:fs');
const path = require('node:path');
const cfg = require('./config');
const log = require('./log');
const { createBot } = require('./bot');
const planner = require('./agent/planner');
const bridge = cfg.hostBridge.enabled ? require('./host/bridge') : null;

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

{
  const pf = path.join(cfg.paths.runs, `bot_${cfg.mc.username}.pid`);
  try {
    const prev = parseInt(fs.readFileSync(pf, 'utf8'), 10);
    if (prev && prev !== process.pid && pidAlive(prev)) {
      log.err(`refusing to start: another bot (PID ${prev}) is already running as ${cfg.mc.username}`);
      console.error(`duplicate bot instance (PID ${prev}) - exiting`);
      process.exit(1);
    }
  } catch {}
  try { fs.mkdirSync(path.dirname(pf), { recursive: true }); fs.writeFileSync(pf, String(process.pid)); } catch {}
}

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

function reasonText(r) {
  try {
    if (typeof r === 'string') return r;
    if (r && typeof r.toString === 'function') { const s = r.toString(); if (s && s !== '[object Object]') return s; }
    const o = (r && r.reason) ? r.reason : r;
    if (typeof o === 'string') return o;
    if (o && typeof o.toString === 'function') { const s = o.toString(); if (s && s !== '[object Object]') return s; }
    return JSON.stringify(r).slice(0, 200);
  } catch { return String(r); }
}

let shuttingDown = false;

function startOnce() {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const bot = createBot();
    planner.attachChat(bot);
    if (bridge) bridge.attach(bot);
    bot.once('spawn', () => {
      log.info('spawned, launching autonomous planner loop');
      planner.run(bot).catch(e => log.err('planner crashed', e.message));
    });
    const done = (why) => {
      if (shuttingDown) return resolve();
      const up = Date.now() - t0;
      log.warn(`connection ${why} after ${Math.round(up / 1000)}s uptime`);
      resolve(up);
    };
    bot.once('end', (r) => done('end ' + reasonText(r)));
    bot.once('kicked', (r) => done('kicked ' + reasonText(r)));
  });
}

(async () => {
  log.info(`MC autonomous supervisor -> ${cfg.mc.host}:${cfg.mc.port} v${cfg.mc.version} as "${cfg.mc.username}" (model=${cfg.deepseek.model}, assist=${process.env.MC_ASSIST !== '0' ? 'on' : 'off'}, talk=${cfg.bot.talk}, bridge=${cfg.hostBridge.enabled ? 'on' : 'off'})`);
  let attempts = 0;
  while (!shuttingDown && attempts++ < 200) {
    const up = await startOnce();
    if (shuttingDown) break;
    const backoff = typeof up === 'number' && up < 15000 ? Math.min(60000, 5000 * Math.min(attempts, 12)) : 6000;
    log.info(`reconnecting in ${Math.round(backoff / 1000)}s (attempt ${attempts})`);
    await delay(backoff);
  }
  if (bridge) bridge.detach();
  log.info('supervisor exiting');
  process.exit(0);
})();

const shutdown = () => { shuttingDown = true; if (bridge) try { bridge.detach(); } catch {} process.exit(0); };
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('unhandledRejection', r => log.err('unhandledRejection', (r && r.message ? r.message : String(r)) + (r && r.stack
  ? ' @ ' + String(r.stack).split('\n').slice(1, 4).map(s => s.trim()).join(' <- ').slice(0, 220) : '')));
process.on('uncaughtException', e => log.err('uncaughtException', e.message));
