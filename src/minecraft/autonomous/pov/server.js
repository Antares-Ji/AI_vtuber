'use strict';
// Read-only snapshot for the in-game POV HUD (client mod aipov polls this at 4 Hz).
//
// Sources, in order:
//   1. runs/pov.json  - written by the bot at 2 Hz
//   2. runs/live.json + stage_lock + nowcn - derived fallback
//   3. --demo         - sample payload for UI verification
//
// Pure local file reads; never touches or interrupts the bot process.

const http = require('http');
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const { summarize, MS_CN, cn } = require('../panel/nowcn');

const PORT = Number(process.env.POV_PORT || 8799);
const HOST = process.env.POV_HOST || '127.0.0.1';
const DEMO = process.argv.includes('--demo');

const LADDER = ['wood', 'crafting_table', 'wooden_pickaxe', 'stone', 'stone_tools', 'food', 'coal', 'iron_ore',
  'iron_ingots', 'iron_gear', 'armor', 'diamond_pick', 'diamond_gear', 'bow', 'obsidian', 'flint_steel',
  'nether', 'blaze_rods', 'pearls', 'eyes', 'stronghold', 'enter_end', 'kill_dragon'];

const readJson = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
const mtimeMs = (p) => { try { return fs.statSync(p).mtimeMs; } catch { return 0; } };

const KIT_ORDER = [
  'arrow', 'bow', 'ender_eye', 'ender_pearl', 'water_bucket', 'flint_and_steel',
  'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe',
  'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
  'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots',
  'diamond_chestplate', 'diamond_leggings', 'diamond_boots', 'diamond_helmet', 'leather_chestplate', 'leather_boots',
  'cobblestone', 'cobbled_deepslate', 'end_stone', 'stone_bricks', 'diorite', 'granite', 'andesite',
  'blue_bed', 'red_bed', 'white_bed',
];
const FOOD_FIRST = /^(cooked_)/;

function kitList(inv) {
  const rows = Object.entries(inv || {}).filter(([, c]) => Number(c) > 0).map(([n, c]) => ({ n, c: Number(c) }));
  const rank = (x) => {
    const i = KIT_ORDER.indexOf(x.n);
    if (i >= 0) return i;
    if (/_pickaxe$|_sword$|^arrow$|^bow$/.test(x.n)) return 100;
    if (FOOD_FIRST.test(x.n)) return 200;
    if (/^(raw_|coal|charcoal|iron_ingot|gold_nugget|flint|stick|string|feather|leather)/.test(x.n)) return 300;
    return 400;
  };
  return rows.sort((a, b) => (rank(a) - rank(b)) || (b.c - a.c) || (a.n < b.n ? -1 : 1)).slice(0, 40);
}

function demo() {
  return {
    ok: true, source: 'demo', ts: Date.now(), name: 'SuiGeBot',
    phase: '正在执行', task: '末影龙', pct: 33, elapsedSec: 1, pctKind: 'task',
    label: '采集 stone', done: 1, total: 3,
    ladderDone: 22, ladderTotal: 23, deaths: 1, llmCalls: 12, victory: false,
    goal: '现在在做：击杀末影龙（第 23/23 段）',
    next: '清理末地水晶并压低血线完成击杀',
    items: kitList({ arrow: 29, bow: 1, ender_eye: 3, ender_pearl: 10, stone_pickaxe: 2, iron_sword: 1, water_bucket: 1, cobblestone: 24, end_stone: 11, blue_bed: 1, oak_planks: 1, stick: 8, coal: 1, dirt: 3 }),
    worn: ['chestplate', 'boots'], free: 6, hp: 18, food: 20,
    pos: { x: 12, y: 58, z: 32 }, dim: 'the_end',
  };
}

let llmCountCache = { mtime: 0, count: 0 };
function countLlmCalls() {
  const p = path.join(cfg.paths.runs, 'llm.jsonl');
  const mt = mtimeMs(p);
  if (!mt) return 0;
  if (mt === llmCountCache.mtime) return llmCountCache.count;
  try {
    const raw = fs.readFileSync(p, 'utf8');
    const c = raw ? raw.trim().split(/\r?\n/).filter(Boolean).length : 0;
    llmCountCache = { mtime: mt, count: c };
    return c;
  } catch {
    return llmCountCache.count;
  }
}

function fromFiles() {
  const live = readJson(path.join(cfg.paths.runs, 'live.json')) || {};
  const lock = readJson(path.join(cfg.paths.runs, 'stage_lock.json')) || {};
  const state = readJson(path.join(cfg.paths.runs, 'state.json')) || {};
  const done = Object.keys(state.done || {});
  const cur = (live.milestones && live.milestones.current) || null;
  const st = (lock.stages || {})[cur] || {};
  const lastObs = st.lastObs || '';
  const hist = Array.isArray(st.history) ? st.history : [];
  const last = hist.length ? hist[hist.length - 1] : {};
  const invNow = (() => { try { return JSON.parse(live.inv || '{}'); } catch { return {}; } })();

  const s = summarize({
    live, current: cur, doneCount: done.length, doneIds: done,
    stall: { stage: cur, verdict: st.verdict, segmentMin: st.since ? Math.round((Date.now() - st.since) / 60000) : 0, lastObs, dossier: st.dossier },
    activity: lastObs ? [lastObs] : [],
    inventory: invNow,
    metrics: { freeSlots: live.freeSlots },
  });

  const idx = cur ? LADDER.indexOf(cur) : LADDER.length;
  const pct = Math.max(0, Math.min(100, Math.round(100 * idx / LADDER.length)));
  const phase = lastObs ? '正在执行' : '准备中';

  return {
    ok: true,
    source: mtimeMs(path.join(cfg.paths.runs, 'live.json')) ? 'live.json' : 'none',
    ts: Number(live.ts) || 0,
    name: live.username || 'bot',
    phase,
    task: cur ? (MS_CN[cur] || cur) : '已完成',
    pct,
    elapsedSec: last.durS || 0,
    pctKind: 'milestone',
    label: lastObs ? String(cn(lastObs)).slice(0, 34) : '',
    done: done.length, total: LADDER.length,
    ladderDone: done.length, ladderTotal: LADDER.length,
    deaths: typeof live.deaths === 'number' ? live.deaths : null,
    llmCalls: countLlmCalls(),
    victory: Boolean(live.victory),
    goal: s.headline,
    next: s.next || '',
    items: kitList(invNow),
    worn: Array.isArray(live.worn) ? live.worn.filter(Boolean) : [],
    free: typeof live.freeSlots === 'number' ? live.freeSlots : null,
    hp: typeof live.hp === 'number' ? Math.round(live.hp) : null,
    food: typeof live.food === 'number' ? live.food : null,
    pos: live.pos && Number.isFinite(live.pos.x) ? live.pos : null,
    dim: live.dim || null,
  };
}

function current() {
  if (DEMO) return demo();
  const base = fromFiles();
  const povPath = path.join(cfg.paths.runs, 'pov.json');
  const fresh = mtimeMs(povPath) && Date.now() - mtimeMs(povPath) < 3000;
  const p = fresh ? readJson(povPath) : null;
  if (!p) return base;

  const done = Number(p.done) || 0;
  const total = Number(p.total) || 0;
  return Object.assign(base, {
    source: 'pov.json',
    ts: Number(p.ts) || base.ts,
    name: p.name || base.name,
    phase: p.endedAt ? '准备下一步' : '正在执行',
    task: p.milestone ? (MS_CN[p.milestone] || p.milestone) : base.task,
    pctKind: total > 0 ? 'task' : 'milestone',
    pct: total > 0 ? Math.round(100 * Math.min(done, total) / total) : base.pct,
    elapsedSec: p.startedAt ? Math.max(0, Math.round(((p.endedAt || Date.now()) - p.startedAt) / 1000)) : 0,
    label: p.label || '',
    done: total > 0 ? done : base.done,
    total: total > 0 ? total : base.total,
    pos: p.pos || base.pos,
    dim: p.dim || base.dim,
    hp: typeof p.hp === 'number' ? p.hp : base.hp,
    food: typeof p.food === 'number' ? p.food : base.food,
  });
}

function startServer(opts = {}) {
  const port = Number(opts.port || PORT);
  const host = opts.host || HOST;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, `http://${host}:${port}`);
    if (u.pathname !== '/api/pov') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: false, note: 'only /api/pov' }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(current()));
  });
  server.listen(port, host, () => {
    console.log(`pov ${DEMO ? '(demo) ' : ''}http://${host}:${port}/api/pov`);
  });
  return server;
}

if (require.main === module) {
  startServer();
}

module.exports = { current, fromFiles, kitList, startServer };
