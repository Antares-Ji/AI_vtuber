'use strict';
// Ore memory.
//
// Why this exists: the bot repeatedly REPORTS the veins it can see - `mine: heading to iron_ore at
// -176,29,620`, `-165,38,636`, `-206,24,631` - and then loses them when the round ends, so the next
// round tunnels for its whole budget at the wrong altitude. Measured 03:35-03:42: `armor` spent a full
// 420 s in `branch_mine` at y=78 (mountain top) and collected nothing, while veins it had itself named
// at y=24-38 were forgotten one round earlier. A player remembers where the ore was.
//
// Kept on disk, not on `bot._x`: a reconnect builds a NEW bot object (see §4 of the notes), so
// anything the run must remember across deaths/kicks lives in runs/.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILE = path.join(cfg.paths.runs, 'ore_cache.json');
const MAX = 90;
const TTL = 45 * 60 * 1000; // a vein mined out or forgotten 45 min ago is not worth a detour

let mem = null;
function entries() {
  if (mem) return mem;
  try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')).entries || []; } catch { mem = []; }
  return mem;
}
function save() {
  try { fs.writeFileSync(FILE, JSON.stringify({ ts: Date.now(), entries: mem })); } catch (e) { /* read-only disk must not break a dig loop */ }
}

// Which block names are NOT worth remembering: they are everywhere, so caching them would push real
// veins out of the cache (`mine` is also called for cobblestone/deepslate as filler).
const UNWORTHY = /^(cobblestone|stone|deepslate|dirt|netherrack|end_stone|granite|diorite|andesite|tuff)$/;

// Which entries are TERRAIN rather than a finite vein. A lava pool, a water source and an obsidian
// field do not get used up by being looked at, so an age clock on them silently deletes knowledge the
// bot paid a long walk to acquire. Measured 06:25:49, the worst instance of this: the cache held 21
// lava cells, every one of them older than the 6-hour terrain TTL (newest 7.7 h, oldest 24.9 h), so
// `list(['lava'])` returned an empty array and `obsidian_farm` announced "nothing to farm - 0 lava ...
// remembered" and handed control to `make_obsidian`'s continent-wide re-search - the same re-search that
// produced 40x `no lava pool within N blocks even after descending to y=N` yesterday. The pools are
// still there; the bot had simply been made to forget them on a clock.
const TERRAIN = /^(lava|water|obsidian|weeping_vines|nether_wart_block|soul_sand|gravel)$/;
const ttlFor = (name) => (TERRAIN.test(name) ? Infinity : TTL);

// Record one exposed vein. Nearby duplicates of the same ore collapse into one entry so a 12-block
// vein does not eat the whole cache.
function remember(name, x, y, z) {
  if (UNWORTHY.test(name)) return;
  const e = entries();
  // Re-confirmed: a sighting of the same cell refreshes it. Without this a pool the bot visits every
  // ten minutes still ages out on its FIRST timestamp, which is how the 6-hour clock behaved like a
  // 6-hour countdown from discovery.
  const dup = e.find(v => v.name === name && Math.abs(v.x - x) <= 3 && Math.abs(v.y - y) <= 3 && Math.abs(v.z - z) <= 3);
  if (dup) { dup.ts = Date.now(); save(); return; }
  e.push({ name, x, y, z, ts: Date.now() });
  // Trim back to the cap, but spend the cap on ore: a stack of 24 diamond veins must not be able to
  // push the only known lava pool out of memory. (My first version of this splice dropped the
  // trim-to-MAX loop entirely and let the cache sit above its cap - self-test #3 caught it.)
  while (e.length > MAX) {
    const i = e.findIndex(v => !TERRAIN.test(v.name));
    e.splice(i >= 0 ? i : 0, 1);
  }
  save();
}

// Closest remembered vein of any of `names`, fresh enough to be worth walking to.
function nearest(names, from) {
  const want = new Set(names);
  const now = Date.now();
  let best = null, bd = Infinity;
  for (const v of entries()) {
    if (!want.has(v.name)) continue;
    // A lava pool, a water source and obsidian are terrain, not a finite vein: they are still there
    // tomorrow, and losing them costs the bot a 100-block re-dig (measured 10:28-10:53, where two
    // pools it had reached were dropped by a 45-minute clock meant for ore).
    if (now - v.ts > ttlFor(v.name)) continue;
    // Vertical distance costs more than horizontal (it means digging a shaft), so weight it.
    const d = Math.hypot(v.x - from.x, (v.y - from.y) * 1.6, v.z - from.z);
    if (d < bd) { bd = d; best = v; }
  }
  return best ? Object.assign({}, best, { dist: Math.round(bd) }) : null;
}

// Every fresh entry of these names, closest first. `nearest` answers "what is the best one cell";
// obsidian needs the best PAIR (a water source and a lava source a short walk apart), which cannot be
// found by two independent nearest() calls - each is greedy about distance from the bot, and the pair
// that matters is the one whose two ends are close to EACH OTHER.
function list(names, from) {
  const want = new Set(names);
  const now = Date.now();
  const out = [];
  for (const v of entries()) {
    if (!want.has(v.name)) continue;
    if (now - v.ts > ttlFor(v.name)) continue;
    out.push(Object.assign({}, v));
  }
  if (from) out.sort((a, b) => Math.hypot(a.x - from.x, (a.y - from.y) * 1.6, a.z - from.z)
    - Math.hypot(b.x - from.x, (b.y - from.y) * 1.6, b.z - from.z));
  return out;
}

function forget(x, y, z) {
  const e = entries();
  const i = e.findIndex(v => Math.abs(v.x - x) <= 1 && Math.abs(v.y - y) <= 1 && Math.abs(v.z - z) <= 1);
  if (i >= 0) { e.splice(i, 1); save(); }
}

module.exports = { remember, nearest, list, forget, FILE };
