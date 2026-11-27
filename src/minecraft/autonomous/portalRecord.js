'use strict';
// The end portal room, once seen, stays seen.
//
// Why this exists: at 09:29:40 the bot SAW the room - `find_block ok: found end_portal_frame at
// -212,15,1499` - and four hours later it was still tunneling around (-174,34,1465), the column
// `/locate` had named, reporting `no end_portal_frame in range (dig to the portal room)`. The sighting
// lived in one log line. `/locate` reports the stronghold's bounding corner, not the portal room, and
// the frames are only visible inside a 24-block scan radius, so a room 50 blocks off the corner reads
// as "not found" forever while the bot digs at the corner. A player who has seen the door goes back to
// the door.
//
// No TTL: the shaft record expires because a flooded or caved-in column is a real possibility, but a
// stronghold portal room does not move and does not get destroyed by anything this bot does. The
// record is nevertheless RE-DERIVED from the world and written back on every fresh sighting, so a
// wrong or stale value cannot outlive the next look (see the run's own §"remembered state expires"
// class).
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILE = path.join(cfg.paths.runs, 'portal_room.json');

let mem = undefined;
function load() {
  if (mem !== undefined) return mem;
  try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')) || null; } catch { mem = null; }
  return mem;
}

// Called with any position that IS an end_portal_frame block. Same room (within a few blocks) only
// refreshes the timestamp; a genuinely different sighting overwrites, because the newest look at the
// world is the best record of it.
function remember(p) {
  if (!p) return null;
  const cur = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), ts: Date.now() };
  const old = load();
  if (old && Math.abs(old.x - cur.x) <= 3 && Math.abs(old.y - cur.y) <= 3 && Math.abs(old.z - cur.z) <= 3) {
    old.ts = cur.ts;
    mem = old;
  } else {
    mem = cur;
  }
  try { fs.writeFileSync(FILE, JSON.stringify(mem)); } catch (e) { /* a read-only disk must not stop a dig */ }
  return mem;
}

// Called when the twelfth eye goes in. Without this the pack's leftover eyes become "evidence" that the
// portal still needs building: at 03:39-03:44, 357 blocks from an ALREADY-OPEN portal, the planner
// produced `build_nether_portal -> pour_portal_cell -> search_nether_fortress -> farm_blaze -> farm_pearl
// | Only 3 eyes for...` four rounds running - back to the Nether for material the door stopped needing
// hours ago. This is the fact that closes that loop.
function markRingComplete() {
  const r = load() || {};
  r.ringComplete = true;
  r.ts = Date.now();
  mem = r;
  try { fs.writeFileSync(FILE, JSON.stringify(mem)); } catch {}
  return mem;
}

// The cell the bot has actually STOOD ON inside the room, recorded when it pins /spawnpoint there. The
// bed anchor in progression.js used to re-pin the respawn point to the surface before every dive, and a
// death in the End then cost a fresh 45-block descent (02:38:45 bed pin -> 02:55:22 End death -> respawn
// on the surface, 79 blocks and one shaft away). This is the fact that makes the bed pin wrong to use.
function rememberAnchor(p) {
  if (!p) return null;
  const r = load() || {};
  r.anchor = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z), ts: Date.now() };
  mem = r;
  try { fs.writeFileSync(FILE, JSON.stringify(mem)); } catch {}
  return r.anchor;
}

// The room as last seen, or null.
function current() { return load(); }

// Used for logs and for the verdict text: a bot that is told "not in range" has no idea where to dig,
// while "portal room remembered at -212,15,1499, 51 blocks off" is an order of business.
function distanceTo(bot) {
  const r = load();
  if (!r) return null;
  try {
    const f = bot.entity.position.floored();
    return { ...r, dx: r.x - f.x, dy: r.y - Math.round(f.y), dz: r.z - f.z, dist: Math.round(Math.hypot(r.x - f.x, r.z - f.z)) };
  } catch { return { ...r, dist: null }; }
}

module.exports = { remember, markRingComplete, rememberAnchor, current, distanceTo, FILE };
