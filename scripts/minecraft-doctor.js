'use strict';
// Self-check for AI_vtuber's integrated autonomous Minecraft speedrun engine.
const checks = [];
const ok = (name, detail) => { checks.push({ name, ok: true }); console.log('OK  ', name, detail ? ':: ' + detail : ''); };
const fail = (name, err) => { checks.push({ name, ok: false }); console.log('FAIL', name, '::', err); };

try {
  const pf = require('mineflayer-pathfinder');
  if (!pf.goals || !pf.goals.GoalNear) throw new Error('missing goals.GoalNear');
  ok('mineflayer-pathfinder', Object.keys(pf).join(','));
} catch (e) { fail('mineflayer-pathfinder', e.message); }

for (const mod of ['mineflayer', 'mineflayer-pvp', 'mineflayer-tool', 'mineflayer-armor-manager', 'mineflayer-auto-eat', 'minecraft-data', 'dotenv', '@modelcontextprotocol/client', '@modelcontextprotocol/server', 'zod']) {
  try { require(mod); ok('dep ' + mod); } catch (e) { fail('dep ' + mod, e.message); }
}

try {
  const cfg = require('../src/minecraft/autonomous/config');
  require('../src/minecraft/autonomous/skills/primitives');
  const prog = require('../src/minecraft/autonomous/skills/progression');
  require('../src/minecraft/autonomous/skills/base');
  require('../src/minecraft/autonomous/skills/endgame');
  const reg = require('../src/minecraft/autonomous/skills/registry');
  const planner = require('../src/minecraft/autonomous/agent/planner');
  const bridge = require('../src/minecraft/autonomous/host/bridge');
  ok('skills registered', `${reg.names().length} skills`);
  if (!Array.isArray(prog.LADDER) || prog.LADDER.length !== 23) throw new Error(`expected 23 ladder rungs, got ${prog.LADDER?.length}`);
  ok('ladder defined', `${prog.LADDER.length} milestones`);
  if (typeof planner.runHelper !== 'function' || typeof planner.handleVictory !== 'function') throw new Error('missing planner hardening exports');
  ok('planner guards exported');
  if (typeof bridge.publishEvent !== 'function') throw new Error('missing bridge event publisher');
  ok('host bridge loaded', `port=${cfg.hostBridge.port} talk=${cfg.bot.talk}`);
  if (cfg.deepseek.apiKey) ok('DEEPSEEK_API_KEY present', `model=${cfg.deepseek.model}`);
  else fail('DEEPSEEK_API_KEY', 'missing in .env.local/.env');
} catch (e) { fail('autonomous engine load', e.stack || e.message); }

const bad = checks.filter(c => !c.ok).length;
console.log(bad ? `\nDOCTOR FAILED (${bad} issues)` : '\nDOCTOR: all good');
process.exit(bad ? 1 : 0);
