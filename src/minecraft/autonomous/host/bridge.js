'use strict';
// Native AI_vtuber control bridge for the autonomous Minecraft speedrun engine.
// Implements the full HTTP contract consumed by:
//   - integrations/minecraft-mcp/server.cjs (MCP guards)
//   - src/minecraft/autonomy-loop.js (controlRequest + loop state)
//   - src/minecraft/live-context.js & fact-speech.js (verified telemetry & narration)
//
// Cost discipline: /observe and /status read a 1s cached snapshot; request handlers never scan world chunks.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const log = require('../log');
const cfg = require('../config');

const HOSTILE = ['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'spider', 'cave_spider',
  'witch', 'pillager', 'enderman', 'blaze', 'zombified_piglin', 'ghast', 'vex'];

const NARRATABLE = ['gather_wood', 'mine', 'craft', 'hunt', 'eat', 'flee', 'explore', 'observe', 'collect', 'build_home', 'build_portal'];

const SKILL_TO_ACTION = {
  chop_trees: 'gather_wood',
  mine: 'mine', deep_shaft: 'mine', branch_mine: 'mine', strip_mine: 'mine', dig_to_y: 'mine',
  find_diamonds: 'mine', resume_shaft: 'mine', obsidian_farm: 'mine', make_obsidian: 'mine',
  craft: 'craft', grid_craft: 'craft', smelt: 'craft', ensure_tools: 'craft', ensure_diamond_pick: 'craft',
  ensure_bucket: 'craft', craft_eyes_of_ender: 'craft', equip: 'craft', light: 'craft',
  hunt: 'hunt', hunt_spider: 'hunt', farm_blaze: 'hunt', farm_pearl: 'hunt', fish: 'hunt',
  harvest_kelp: 'hunt', kill_dragon: 'hunt',
  eat: 'eat',
  dry_escape: 'flee', recover_surface: 'flee', pillar_up: 'flee', breathe: 'flee',
  roam: 'explore', walk_to: 'explore', tunnel_to: 'explore', goto: 'explore', follow: 'explore',
  locate_stronghold: 'explore', probe_stronghold: 'explore', search_nether_fortress: 'explore',
  enter_end: 'explore', raid_village: 'explore',
  build_nether_portal: 'build_portal', pour_portal_cell: 'build_portal', use_portal: 'build_portal', return_overworld: 'build_portal',
  forward_base: 'build_home', workshop: 'build_home', stow_workshop: 'build_home', build_ledge: 'build_home', bridge_to: 'build_home', place: 'build_home',
  tidy: 'collect', stash: 'collect',
  inspect: 'observe', status: 'observe', look: 'observe', find_block: 'observe', wait: 'observe',
};

const MAX_BODY = { skill: 4096, command: 2048 };
const LADDER_TOTAL = 23;

function mapSkillAction(skillName) {
  return SKILL_TO_ACTION[String(skillName || '')] || 'explore';
}

function cell(pos) {
  if (!pos) return null;
  const f = typeof pos.floored === 'function' ? pos.floored() : pos;
  const out = {};
  for (const k of ['x', 'y', 'z']) out[k] = Number.isFinite(f[k]) ? Math.floor(f[k]) : 0;
  return out;
}

function inventoryOf(bot) {
  const counts = new Map();
  for (const it of (bot.inventory && bot.inventory.items ? bot.inventory.items() : [])) {
    if (!it || !it.name) continue;
    counts.set(it.name, (counts.get(it.name) || 0) + (it.count || 0));
  }
  return [...counts.entries()].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([name, count]) => ({ name, count }));
}

function threatsOf(bot, radius = 24, limit = 4) {
  const here = bot.entity && bot.entity.position;
  if (!here || !bot.entities) return [];
  const out = [];
  for (const e of Object.values(bot.entities)) {
    if (!e || e === bot.entity || !e.position || !e.name) continue;
    if (!HOSTILE.includes(e.name)) continue;
    const d = e.position.distanceTo(here);
    if (d <= radius) out.push({ name: e.name, distance: Math.round(d * 10) / 10 });
  }
  return out.sort((a, b) => a.distance - b.distance).slice(0, limit);
}

function snapshot(bot, st) {
  const spawned = Boolean(bot.entity && bot.entity.position);
  const phase = String(bot._loopPhase || '');
  const reflex = /defend|survive|flee|wet|escape|spiral/i.test(phase) ? 'evading' : 'idle';
  const autonomous = {
    driver: 'autonomous-ladder',
    milestonesDone: Number.isInteger(st.milestonesDone) ? st.milestonesDone : 0,
    milestonesTotal: LADDER_TOTAL,
    doneList: st.doneList || [],
    currentMilestone: st.currentMilestone || null,
    currentMilestoneCn: st.currentMilestoneCn || null,
    activeSkill: st.activeSkill || null,
    activeSkillCn: st.activeSkillCn || null,
    activeAction: st.activeSkill ? mapSkillAction(st.activeSkill) : null,
    phase: phase || null,
    deaths: Number.isFinite(st.deaths) ? st.deaths : (Number.isFinite(bot._deaths) ? bot._deaths : 0),
    victory: Boolean(st.victory || bot._dragonKilled),
    assistFree: process.env.MC_ASSIST === '0',
    lastEvent: st.lastEvent || null,
    lastAnnouncement: st.lastAnnouncement || null,
  };
  return {
    capabilityPolicy: 'expanded-survival',
    connected: spawned && st.connected,
    // Ladder owns the single pair of hands unless takeover=1.
    busy: cfg.hostBridge.takeover ? Boolean(bot._stepBusy || st.activeTaskId) : true,
    activeTaskId: st.activeTaskId,
    sessionId: st.sessionId,
    mode: (bot.game && bot.game.gameMode) || 'survival',
    dimension: (bot.game && bot.game.dimension) || 'overworld',
    position: cell(bot.entity && bot.entity.position),
    health: Number.isFinite(bot.health) ? bot.health : 0,
    food: Number.isFinite(bot.food) ? bot.food : 0,
    oxygen: Number.isFinite(bot.oxygenLevel) ? bot.oxygenLevel : 20,
    inventory: inventoryOf(bot),
    threats: threatsOf(bot),
    hazards: [],
    craftable: [],
    timeOfDay: bot.time && Number.isFinite(bot.time.timeOfDay) ? bot.time.timeOfDay : null,
    isNight: Boolean(bot.time && bot.time.timeOfDay >= 12500 && bot.time.timeOfDay <= 23500),
    reactive: { enabled: true, mode: reflex, lifecycleEpoch: st.lifecycleEpoch, phase: phase || null },
    autonomous,
    mcLadder: { milestones: autonomous.milestonesDone, current: autonomous.currentMilestone, deaths: autonomous.deaths },
    capturedAt: new Date().toISOString(),
  };
}

function statusView(snap) {
  return {
    connected: snap.connected, busy: snap.busy, activeTaskId: snap.activeTaskId,
    position: snap.position, mode: snap.mode, health: snap.health, food: snap.food,
    dimension: snap.dimension, reactive: snap.reactive, inventory: snap.inventory,
    autonomous: snap.autonomous,
    sessionId: snap.sessionId, logPath: snap.sessionId,
  };
}

const COMMAND_POLICY = {
  status: { allow: true, note: 'read-only' },
  defend: { allow: true, note: 'autonomous survival & defense gates are always active' },
  stop: { allow: true, note: 'autonomous ladder keeps driving; stop the autonomous process directly to halt' },
  tp: { allow: false, error: 'refused: /tp would break the assist-free autonomous run (MC_ASSIST=0 forbids teleport)' },
  workbench: { allow: false, error: 'refused: single-driver policy; the autonomous ladder owns crafting & movement' },
  quit: { allow: false, error: 'refused: stream commands cannot disconnect an autonomous run' },
};

function readBody(req, limit, send) {
  return new Promise((resolve) => {
    let body = '';
    let answered = false;
    req.on('data', (c) => {
      if (answered) return;
      body += c;
      if (body.length > limit) { answered = true; send(413, { error: 'Too large' }); resolve(null); }
    });
    req.on('end', () => { if (!answered) resolve(body); });
    req.on('error', () => { if (!answered) { answered = true; send(400, { error: 'Body read failed' }); resolve(null); } });
  });
}

function authed(req, token) {
  const got = String(req.headers.authorization || '');
  const want = `Bearer ${token}`;
  if (got.length !== want.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(got), Buffer.from(want)); } catch { return false; }
}

let server = null;
let timer = null;
let activeBot = null;
let firstSeenAt = 0;
let goalSyncBusy = false;
let lastGoalKey = '';
let lastGoalSyncAt = 0;

const state = {
  snap: null, connected: false, spawnedOnce: false, activeTaskId: null,
  sessionId: null, lifecycleEpoch: 0,
  milestonesDone: 0, doneList: [], currentMilestone: null, currentMilestoneCn: null,
  activeSkill: null, activeSkillCn: null, deaths: 0, victory: false,
  lastEvent: null, lastAnnouncement: null, token: null, task: null,
};

function buildMilestoneGoal() {
  const done = (state.doneList || []).slice().sort();
  const cur = state.victory ? '已通关（末影龙已击杀）' : (state.currentMilestoneCn ? `${state.currentMilestoneCn} (${state.currentMilestone})` : (state.currentMilestone || '准备中'));
  const rules = process.env.MC_ASSIST === '0'
    ? '规则：纯不作弊（MC_ASSIST=0，bot 非 OP，真实昼夜，仅服务端开启死亡不掉落）'
    : '规则：辅助测试模式';
  return [
    `Minecraft 自主通关引擎（阶梯 ${done.length}/${LADDER_TOTAL}，单驾驶者模式，主播只读实况解说）`,
    `当前阶段：${cur}`,
    rules,
    `已完成：${done.join('、') || '暂无'}`,
  ].join('。').slice(0, 950);
}

async function syncGoalToHost(force = false) {
  if (!cfg.hostBridge.syncGoal || goalSyncBusy) return;
  const key = `${state.milestonesDone}|${state.currentMilestone || ''}|${state.victory ? 1 : 0}`;
  if (!force && key === lastGoalKey) return;
  if (!force && Date.now() - lastGoalSyncAt < 8000) return;
  goalSyncBusy = true;
  try {
    const goal = buildMilestoneGoal();
    const base = cfg.hostBridge.hostUrl;
    const loopRes = await fetch(`${base}/api/minecraft/loop`, { signal: AbortSignal.timeout(4000) });
    if (!loopRes.ok) return;
    const loop = await loopRes.json();
    if (loop.goal === goal && loop.enabled) { lastGoalKey = key; return; }
    const post = async (body) => {
      const r = await fetch(`${base}/api/minecraft/loop`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
      });
      return r.ok;
    };
    if (loop.enabled) await post({ enabled: false });
    const ok = await post({ enabled: true, goal, untilStopped: true, continuous: true });
    if (ok) {
      lastGoalKey = key;
      lastGoalSyncAt = Date.now();
      log.info(`host bridge: synced milestone goal to ${base} (${state.milestonesDone}/${LADDER_TOTAL}, cur=${state.currentMilestone || 'done'})`);
    }
  } catch {
    // Host server (:3000) might be offline or without a key; fail open so the bot never slows down.
  } finally {
    goalSyncBusy = false;
  }
}

function publishEvent(evt) {
  if (!evt || typeof evt !== 'object') return;
  const at = new Date().toISOString();
  const id = `auto-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  if (evt.kind === 'skill_started') {
    state.activeSkill = evt.skill || null;
    state.activeSkillCn = evt.skillCn || null;
    if (evt.milestone !== undefined) state.currentMilestone = evt.milestone;
    if (evt.milestoneCn !== undefined) state.currentMilestoneCn = evt.milestoneCn;
    refresh();
    return;
  }
  if (evt.kind === 'milestone_started') {
    state.currentMilestone = evt.milestone || null;
    state.currentMilestoneCn = evt.milestoneCn || null;
    state.activeSkill = evt.milestone || null;
    state.activeSkillCn = evt.milestoneCn || null;
    refresh();
    void syncGoalToHost(false);
    return;
  }
  if (evt.kind === 'milestone_done' || evt.kind === 'victory' || evt.kind === 'skill_done' || evt.kind === 'skill_failed') {
    if (evt.kind === 'victory') state.victory = true;
    state.lastEvent = {
      id, at,
      sessionId: state.sessionId,
      lifecycleEpoch: state.lifecycleEpoch,
      dimension: (activeBot && activeBot.game && activeBot.game.dimension) || 'overworld',
      kind: evt.kind,
      milestone: evt.milestone || state.currentMilestone || null,
      milestoneCn: evt.milestoneCn || state.currentMilestoneCn || null,
      skill: evt.skill || state.activeSkill || null,
      skillCn: evt.skillCn || state.activeSkillCn || null,
      action: mapSkillAction(evt.skill || evt.milestone || state.activeSkill),
      status: evt.kind === 'skill_failed' ? 'failed' : 'completed',
      verified: evt.verified === true,
      partial: evt.partial === true,
      summary: String(evt.summary || '').slice(0, 240),
    };
    if (evt.kind === 'milestone_done' || evt.kind === 'victory') {
      state.activeSkill = null;
      state.activeSkillCn = null;
    }
    refresh();
    if (evt.kind === 'milestone_done' || evt.kind === 'victory') void syncGoalToHost(true);
  }
}

function publishAnnouncement(text, meta = {}) {
  state.lastAnnouncement = { at: new Date().toISOString(), text: String(text || '').slice(0, 240), ...meta };
  refresh();
}

function refresh() {
  const bot = activeBot;
  if (!bot) return;
  try {
    if (typeof bot._liveBuild === 'function') {
      const live = bot._liveBuild();
      state.doneList = live.milestones && Array.isArray(live.milestones.done) ? live.milestones.done : state.doneList;
      state.milestonesDone = state.doneList.length;
      state.currentMilestone = live.milestones ? live.milestones.current : state.currentMilestone;
      if (live.milestones && live.milestones.currentCn) state.currentMilestoneCn = live.milestones.currentCn;
      if (Number.isFinite(live.deaths)) state.deaths = live.deaths;
      if (typeof live.victory === 'boolean') state.victory = live.victory;
    }
    state.snap = snapshot(bot, state);
  } catch (e) {
    log.warn(`host bridge: snapshot failed (${e.message}) - serving last snapshot`);
  }
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function writeControlFile(port, token) {
  const file = cfg.hostBridge.controlFile;
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const prev = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
    if (prev) {
      try {
        const owner = JSON.parse(prev);
        if (owner.pid && owner.pid !== process.pid && pidAlive(owner.pid)) {
          log.err(`host bridge: ${file} belongs to live PID ${owner.pid} (port ${owner.port}) - not overwriting`);
          return false;
        }
      } catch {}
    }
    fs.writeFileSync(file, JSON.stringify({ port, token, pid: process.pid, driver: 'autonomous-ladder' }));
    log.info(`host bridge: control file written -> ${file} (port ${port})`);
    return true;
  } catch (e) {
    log.err(`host bridge: could not write ${file} (${e.message})`);
    return false;
  }
}

function handle(req, res) {
  const send = (code, value) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(value));
  };
  const url = new URL(req.url, 'http://127.0.0.1');
  try {
    if (!authed(req, state.token)) return send(401, { error: 'Unauthorized' });
    const snap = state.snap || { connected: false, busy: true, activeTaskId: null, inventory: [], threats: [], position: null, autonomous: null };

    if (req.method === 'GET' && url.pathname === '/observe') return send(200, snap);
    if (req.method === 'GET' && url.pathname === '/status') return send(200, statusView(snap));
    if (req.method === 'GET' && url.pathname === '/autonomous') {
      let stall = null;
      try { stall = JSON.parse(fs.readFileSync(path.join(cfg.paths.runs, 'stall_report.json'), 'utf8')); } catch {}
      return send(200, { connected: snap.connected, position: snap.position, dimension: snap.dimension, health: snap.health, food: snap.food, autonomous: snap.autonomous, stall });
    }
    if (req.method === 'GET' && url.pathname === '/capabilities') {
      const actions = [...NARRATABLE, 'respawn', 'smelt', 'place_water', 'collect_water', 'dig_staircase', 'furnish_home', 'enter_portal'];
      return send(200, { expanded: true, count: actions.length, actions, schema: { oneOf: actions.map(a => ({ properties: { action: { const: a } } })) } });
    }
    if (req.method === 'GET' && url.pathname === '/task') {
      const entry = state.task;
      if (!entry || entry.taskId !== url.searchParams.get('id')) return send(404, { error: 'Unknown task' });
      return send(200, entry);
    }
    if (req.method === 'POST' && url.pathname === '/skill') {
      return readBody(req, MAX_BODY.skill, send).then((raw) => {
        if (raw === null) return;
        let payload; try { payload = JSON.parse(raw || '{}'); } catch { return send(400, { error: 'Invalid JSON body' }); }
        state.lastSkill = { taskId: payload.taskId, action: payload.action, at: new Date().toISOString() };
        return send(409, { error: cfg.hostBridge.takeover
          ? 'takeover dispatch is not implemented yet - the autonomous ladder owns the hand'
          : 'takeover disabled: MC_HOST_TAKEOVER=0, the autonomous ladder is the only driver' });
      });
    }
    if (req.method === 'POST' && url.pathname === '/cancel-task') {
      return readBody(req, MAX_BODY.skill, send).then((raw) => {
        if (raw === null) return;
        let payload; try { payload = JSON.parse(raw || '{}'); } catch { payload = {}; }
        const matched = Boolean(state.task && state.task.taskId === payload.taskId && state.task.status === 'running');
        return send(200, { requested: true, matched });
      });
    }
    if (req.method === 'POST' && url.pathname === '/command') {
      return readBody(req, MAX_BODY.command, send).then((raw) => {
        if (raw === null) return;
        let command; try { command = JSON.parse(raw || '{}').command; } catch { return send(400, { error: 'Invalid JSON body' }); }
        const key = String(command || '').trim();
        const alias = { '状态': 'status', '查看状态': 'status', '停止': 'stop', '停止任务': 'stop', '自动防卫': 'defend', '打僵尸': 'defend',
          '传送到我身边': 'tp', '制作工作台': 'workbench', '砍树并制作工作台': 'workbench', '退出游戏': 'quit' }[key] || key;
        const policy = Object.prototype.hasOwnProperty.call(COMMAND_POLICY, alias) ? COMMAND_POLICY[alias] : null;
        if (!policy) return send(400, { error: `未支持的指令: ${String(command).slice(0, 40)}` });
        if (!policy.allow) return send(400, { error: policy.error });
        if (alias === 'defend') log.info('host bridge: defend accepted (autonomous survival gate is active)');
        if (alias === 'stop') log.warn('host bridge: stop requested (read-only bridge)');
        return send(202, { accepted: alias, completed: false, note: policy.note, logPath: state.sessionId });
      });
    }
    if (req.method === 'POST' && url.pathname === '/reload') {
      return send(501, { error: 'not implemented: restart at step boundary' });
    }
    return send(404, { error: 'Not found' });
  } catch (e) {
    log.err('host bridge: handler threw', e.message);
    try { return send(500, { error: e.message }); } catch {}
  }
}

function wireBot(bot) {
  if (activeBot === bot) return;
  if (!firstSeenAt) { firstSeenAt = Date.now(); state.lifecycleEpoch = 1; state.sessionId = `mc-${cfg.mc.username}-${firstSeenAt}`; }
  activeBot = bot;
  bot.once('spawn', () => {
    if (state.spawnedOnce) state.lifecycleEpoch += 1;
    state.spawnedOnce = true;
    state.sessionId = `mc-${cfg.mc.username}-${firstSeenAt}-l${state.lifecycleEpoch}`;
    state.connected = true;
    refresh();
    setTimeout(() => void syncGoalToHost(true), 2500).unref();
  });
  bot.on('end', () => { state.connected = false; });
}

function attach(bot) {
  wireBot(bot);
  if (server) return server;
  process.once('exit', () => { try { detach(); } catch {} });
  state.token = crypto.randomBytes(32).toString('hex');
  refresh();
  timer = setInterval(() => { refresh(); void syncGoalToHost(false); }, Math.max(200, cfg.hostBridge.snapshotMs));
  if (timer.unref) timer.unref();
  server = http.createServer((req, res) => { const r = handle(req, res); if (r && r.catch) r.catch(e => log.err('host bridge: async handler threw', e.message)); });
  server.on('error', (e) => log.err('host bridge: http error', e.message));
  server.listen(cfg.hostBridge.port, '127.0.0.1', () => {
    const port = server.address().port;
    writeControlFile(port, state.token);
    log.info(`host bridge ready -> 127.0.0.1:${port} as ${cfg.mc.username} (takeover=${cfg.hostBridge.takeover ? 'on' : 'off'}, snapshot=${cfg.hostBridge.snapshotMs}ms)`);
  });
  return server;
}

function detach() {
  try { if (timer) clearInterval(timer); } catch {}
  timer = null;
  activeBot = null;
  try { if (server) { server.closeAllConnections?.(); server.close(); } } catch {}
  server = null;
  try {
    const file = cfg.hostBridge.controlFile;
    if (fs.existsSync(file)) {
      const owner = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (owner.pid === process.pid) fs.unlinkSync(file);
    }
  } catch {}
  state.token = null;
  state.victory = false;
  state.lastEvent = null;
  state.activeSkill = null;
  state.activeSkillCn = null;
}

module.exports = {
  attach, detach, snapshot, statusView, cell, inventoryOf, threatsOf,
  publishEvent, publishAnnouncement, mapSkillAction, syncGoalToHost,
  NARRATABLE, HOSTILE, _state: state,
};
