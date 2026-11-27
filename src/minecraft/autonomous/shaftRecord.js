'use strict';
// The shaft in progress.
//
// Why this exists: `find_diamonds` ended 25 consecutive rounds (2026-10-30, last at 20:58:38) with
//   `pinned at Y=52 (below -25 required for diamonds) - surfaced and relocated from 27,750 to -39,780
//    y=62; dive a new shaft here`
// That exit was UNCONDITIONAL: any round finishing above -25 pulled the bot back to the surface and
// walked it 100-200 blocks sideways, so the descent that had already been paid for was deleted every
// round - a round that reached y=45 started the next at y=63 - and the diamond count sat at 1 for hours
// while picks and buckets kept changing (which is why every monitor called that healthy). A human
// digging for diamonds keeps ONE shaft and goes down it over many sitting-downs.
//
// That needs the column and its depth to outlive the step: a plan window here is 70 s
// (planner._planDeadline) while an honest descent from the ocean floor is 10+ minutes. So the record
// lives on disk - a reconnect and an abandoned lease both keep it.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');

const FILE = path.join(cfg.paths.runs, 'shaft.json');
const TTL = 3 * 60 * 60 * 1000; // a shaft nobody has stood at for 3 h may be flooded or caved in

let mem = null;
function load() {
  if (mem !== null && mem !== undefined) return mem;
  try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); } catch { mem = null; }
  return mem;
}
function save(r) {
  mem = r;
  try { fs.writeFileSync(FILE, JSON.stringify(r)); } catch { /* a read-only disk must not stop a dig */ }
}
// An `abandon`ed record keeps its `given` counter on disk with ts=0 so the discard tally survives,
// but stops being a head the bot is asked to walk back to.
function live(r) { return !!r && !!r.ts && (Date.now() - r.ts <= TTL); }

// The shaft to continue, or null.
function current() {
  const r = load();
  return live(r) ? r : null;
}

// Called after any descent attempt. Deeper -> the head moves down and the stall clock resets. Ending
// AT the head is not a stall: that is what a round that spent its whole window digging looks like. A
// stall is finishing a round ABOVE the head the bot already owns - i.e. the shaft got lifted out of,
// which is the exact pattern this record exists to break.
function note(bot, opts) {
  const f = bot.entity.position.floored();
  const r = load();
  if (live(r) && !opts.force) {
    if (f.y < r.y) {
      const next = { x: f.x, y: f.y, z: f.z, toY: opts.toY ?? r.toY ?? -53, ts: Date.now(), stall: 0, given: r.given || 0 };
      save(next);
      return next;
    }
    if (f.y - r.y > 1) { r.stall = (r.stall || 0) + 1; save(r); }
    return r;
  }
  const next = { x: f.x, y: f.y, z: f.z, toY: opts.toY ?? -53, ts: Date.now(), stall: 0, given: (r && r.given) || 0 };
  save(next);
  return next;
}

// Take a column off the shelf because it is dead on physical evidence (flood, bedrock, trap) or
// because it has not moved in too many rounds. Returns the discard tally for the log line.
function abandon(bot, why) {
  const r = load();
  if (!r) return null;
  const given = (r.given || 0) + 1;
  save({ x: r.x, y: r.y, z: r.z, toY: r.toY, ts: 0, stall: r.stall || 0, given });
  return { given, was: `${r.x},${r.y},${r.z}`, why };
}

module.exports = { current, note, abandon, live, FILE };
