'use strict';
// Where the bot's own placed crafting table / furnace is.
//
// Why this exists: at 05:15:55 the craft chain logged `craft wooden_pickaxe: nothing in the pack but a
// table is PLACED at 611,36,731 (37 blocks away) - walking to it instead of hunting wood`, walked, failed
// to get within 8, and then went to look for LOGS to build a second table - while the pack owned one.
// The next round (05:25:06) it was blind again: `findBlock` only sees LOADED chunks, and a table left at
// y=36 under a bot standing on a reef at y=63 is not loaded. The coordinates were known once, printed,
// and thrown away - the same mistake the shaft and the shelf records were built to stop.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILE = path.join(cfg.paths.runs, 'workshop.json');
// Structures the bot PLACED do not age out. The old 12 h TTL erased the Nether portal frame's origin
// while its obsidian was still standing, and the cost was not a missing hint but an active wrong
// conclusion: `build_nether_portal` then priced the portal at 10 FRESH blocks and `make_obsidian` mined
// the standing frame to get them (2026-11-01 03:03-03:20, 17 min of the `nether` rung, one cell destroyed
// for nothing). It also silently disabled the `pour-frame` stage route, whose `ready` gate is
// `!!workshopRecord.at('nether_portal_frame')` - a route that can never be offered again is the same
// fault as a gate nobody can satisfy.
// Same decision the project already made for terrain memory (lava/obsidian, §19d: "岩浆池不会过期，是记忆被
// 时钟删了"). A stale cell is retired by evidence, not by a clock: `stow_workshop` walks to the
// coordinates, reads the block, and calls `forget()` when the chunk disagrees; `craft()` re-notes what it
// can currently see.
const TTL = Infinity;

let mem = null;
function load() {
  if (mem !== null && mem !== undefined) return mem;
  try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { mem = null; }
  return mem;
}
function save(r) {
  mem = r;
  try { fs.writeFileSync(FILE, JSON.stringify(r)); } catch { /* a read-only disk must not stop a craft */ }
}

// name: 'crafting_table' | 'furnace' | any block name the caller wants remembered
function note(name, pos, extra) {
  if (!pos || !Number.isFinite(pos.x)) return null;
  const r = load() || { items: {} };
  r.items = r.items || {};
  r.items[name] = { x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z), ts: Date.now(), extra: extra || '' };
  r.ts = Date.now();
  save(r);
  return r.items[name];
}

// The remembered cell for `name`, or null when it is unknown or stale.
function at(name) {
  const r = load();
  if (!r || !r.items || !r.items[name]) return null;
  const it = r.items[name];
  if (!Number.isFinite(it.x) || !Number.isFinite(it.y)) return null;
  if (Date.now() - (it.ts || 0) > TTL) return null;
  return it;
}

// Forget a cell that has been proven gone (picked up, or the chunk says otherwise).
function forget(name) {
  const r = load();
  if (!r || !r.items || !r.items[name]) return;
  delete r.items[name];
  save(r);
}

module.exports = { note, at, forget, FILE };
