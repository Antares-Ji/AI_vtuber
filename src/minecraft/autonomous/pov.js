'use strict';
// 2 Hz snapshot for the in-game POV HUD (client mod -> tools/pov_server.js -> runs/pov.json).
//
// Design constraints, learned the hard way in this repo:
//   - no world scans here (findBlock / chunk sweeps pin the event loop);
//   - one small async write per tick, skipped while a previous write is still in flight;
//   - every field is a plain read off the bot object, so calling this from a skill is free.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const OUT = path.join(cfg.paths.runs, 'pov.json');
let bot = null;
let milestone = null;
let skill = null;
let label = '';
let done = 0;
let total = 0;
let startedAt = 0;
let endedAt = 0;
let timer = null;
let writing = false;

function snapshot() {
  const p = bot && bot.entity ? bot.entity.position : null;
  return {
    ts: Date.now(),
    name: bot && bot.username ? bot.username : null,
    milestone,
    skill,
    label,
    done,
    total,
    startedAt,
    endedAt,
    pos: p ? { x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z) } : null,
    dim: bot && bot.game ? bot.game.dimension : null,
    hp: bot && typeof bot.health === 'number' ? Math.round(bot.health) : null,
    food: bot ? bot.food : null,
  };
}

function start(b) {
  bot = b;
  if (timer) return;
  timer = setInterval(() => {
    if (writing) return;
    writing = true;
    let json;
    try {
      json = JSON.stringify(snapshot());
    } catch (e) {
      writing = false;
      return;
    }
    try {
      fs.writeFile(OUT, json, () => { writing = false; });
    } catch (e) {
      writing = false;
    }
  }, 500);
  if (timer.unref) timer.unref();
}

function setBot(b) { bot = b; }
function setMilestone(id) { milestone = id; }

function begin(name, l, t) {
  skill = name;
  label = l || '';
  done = 0;
  total = Number(t) || 0;
  startedAt = Date.now();
  endedAt = 0;
}

function progress(l, d, t) {
  if (l) label = String(l);
  if (d != null) done = Number(d) || 0;
  if (t != null) total = Number(t) || 0;
}

// Keep the last step visible between skills (the ladder runs them back-to-back); the HUD reads
// `endedAt` to freeze the elapsed counter instead of letting it grow while nothing is running.
function end() {
  endedAt = Date.now();
}

module.exports = { start, setBot, setMilestone, begin, progress, end, snapshot, OUT };
