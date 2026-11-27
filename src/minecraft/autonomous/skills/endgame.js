'use strict';
// Endgame deterministic skills: deep mining -> diamonds -> obsidian -> portal -> Nether fortress
// -> blaze rods + pearls -> eyes of ender -> stronghold (triangulated) -> The End -> dragon.
// These are real mineflayer routines. Each is defensive: missing inputs => ok:false + clear reason
// (so the LLM endgame / human can assist) rather than throwing. Registering is side-effect on require.
const mcdata = require('minecraft-data');
const fs = require('fs');
const path = require('path');
const cfg = require('../config');
const Vec3 = require('vec3');
const reg = require('./registry');
const ob = require('../observe');
const oreCache = require('../oreCache');
const shaftRecord = require('../shaftRecord');
const P = require('./primitives');
const log = require('../log');
const { countItem, craft, itemId, blockIds, sleep, data } = P;
function GN() { const pf = require('mineflayer-pathfinder'); return (pf.goals && pf.goals.GoalNear) || pf.pathfinder.Goals.GoalNear; }
function GB() { const pf = require('mineflayer-pathfinder'); return (pf.goals && pf.goals.GoalBlock) || pf.pathfinder.Goals.GoalBlock; }
// A fluid's `level` state is the only honest source test: water fills a bucket only from a level-0
// cell, and lava turns to obsidian only when the poured cell is level-0 (flowing lava gives
// cobblestone - which is exactly what the two successful pours at 15:12 and 16:04 produced).
// prismarine-block exposes it as block.properties.level even though minecraft-data has no
// `blockStates` export here (verified 16:26 against 1.21.1 stateIds 96/97/104).
// If the property is missing entirely, treat the cell as a source so nothing regresses.
// prismarine-block stores the decoded states in `_properties` and exposes them through
// getProperties(); `block.properties` does not exist (measured 16:28: every case read undefined
// until the accessor was used), which is also why `drainable` looked undefined all day.
function fluidLevel(b) {
  if (!b) return undefined;
  let p = null;
  try { p = typeof b.getProperties === 'function' ? b.getProperties() : (b._properties || b.properties); } catch { p = null; }
  return p ? p.level : undefined;
}
function isFluidSource(b) {
  const l = fluidLevel(b);
  return l === undefined || l === null || String(l) === '0';
}
// Bulk rock digging must not burn the high-tier picks. The equipPick above walks
// netherite->diamond->iron->stone, so the shaft diggers - which only ever cut stone,
// deepslate and dirt - spent the ONE diamond pickaxe the obsidian chain requires
// (06:15 dpick@86% grinding dirt -> gone by 06:38, obsidian blocked). Cheapest pick that
// can still do the job wins: stone and wooden cut everything in a shaft.
// The equip ack is the whole story here. `bot.equip()` on an item that lives in the main inventory does
// a window click and resolves late, so the 3.5 s race abandons a call that then LANDS seconds later -
// and the caller, told "true", digs with whatever the hand actually holds. Measured 19:27-19:35: the
// shaft dug stone at 37.5 s per block with `pick=-` (empty hand) after equipPick returned true for an
// iron pick at slot 30 that never arrived; and the diamond pick died the same way, spent on rock the
// cheap pick was supposed to take. So: state what the hand must become, then prove it.
const digsLeft = (h) => (h && h.maxDurability ? h.maxDurability - (h.durabilityUsed || 0) : 999);
const handIsPick = (h) => !!(h && /_pickaxe$/.test(h.name) && digsLeft(h) >= 8);
async function settleHand(bot, is, ms = 8000) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    if (is(bot.heldItem)) return true;
    await sleep(250);
  }
  return is(bot.heldItem);
}
async function equipBulkPick(bot, preferIron) {
  // Cheap-pick choice already in the hand? Then do nothing. Re-running bot.equip on every dig was
  // measured at 33.7s per call (three identical 33760/33764/33754 ms stalls on deepslate_gold_ore at
  // 13:17-13:18, i.e. a timeout path, not mining time): mineflayer's 1.21 equip does a window click
  // and waits for an ack that arrives late - and this project has repeatedly been bitten by exactly
  // that ack. An "already holding it" short-circuit costs nothing and removes the wait.
  const held = bot.heldItem;
  if (held && held.name.endsWith('_pickaxe')) {
    const left = held.maxDurability ? held.maxDurability - (held.durabilityUsed || 0) : 999;
    const tierOk = !/diamond|netherite/.test(held.name);
    if (tierOk && left >= 8) return true;
  }
  // Cheap-pick supply, before the fallback below reaches the diamond tier. A stone pick is 3 cobble +
  // 2 sticks and buys ~130 digs of rock; those digs are exactly what killed the last two picks
  // (80% -> 30% -> gone across 60 minutes of descents, because with the stone pick discarded as worn
  // and the iron one spent, the cheapest pick left in `order` WAS the diamond one). Throttled to one
  // attempt every 90 s because this helper runs around every dig.
  const cheapInPack = bot.inventory.items().some(i => /_pickaxe$/.test(i.name) && !/diamond|netherite/.test(i.name)
    && ((i.maxDurability || 999) - (i.durabilityUsed || 0)) >= 8);
  const bulkCob = countItem(bot, 'cobblestone') + countItem(bot, 'cobbled_deepslate') + countItem(bot, 'blackstone');
  const bulkLogs = (P.LOG_NAMES || []).reduce((s, n) => s + countItem(bot, n), 0);
  const bulkPlanks = bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
  const canBootstrapSticks = countItem(bot, 'stick') >= 2 || (bulkPlanks + bulkLogs * 4) >= 2;
  if (!cheapInPack && bulkCob >= 3 && canBootstrapSticks
    && Date.now() - (bot._bulkCraftAt || 0) > 30000) {
    bot._bulkCraftAt = Date.now();
    try {
      if (countItem(bot, 'stick') < 2) {
        if (bulkPlanks < 2 && bulkLogs > 0) { try { await P.craftPlanks(bot); } catch {} }
        try { await craft(bot, 'stick', 4); } catch {}
      }
      if (countItem(bot, 'stick') >= 2) {
        const c = await craft(bot, 'stone_pickaxe', 1);
        log.skill(`equipBulkPick: no cheap pick left to cut rock with - crafted stone_pickaxe (${String(c.observation).slice(0, 110)})`);
      }
    } catch (e) { log.warn(`equipBulkPick: stone_pickaxe bootstrap threw ${e.message}`); }
  }
  // Iron first when the rock may hide an ore: an iron pick drops every ore except ancient debris,
  // while a stone pick takes a diamond ore's time and drops NOTHING (measured cost: the diamond pick
  // fell 87% -> 62% in ten minutes of tunneling because mineBlockHere equipped the best tier to cut
  // deepslate on the way to a lava pool).
  const order = preferIron
    ? ['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']
    : ['stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];
  const inv = bot.inventory.items();
  const rank = (n) => { const i = order.indexOf(n); return i < 0 ? 99 : i; };
  for (const n of order) {
    const cand = inv.filter(i => i.name === n).sort((a, b) => (ob.wear(bot, b) ?? 0) - (ob.wear(bot, a) ?? 0))[0];
    if (!cand) continue;
    if ((ob.wear(bot, cand) ?? 100) < 12) continue;
    // Accept a pick that is at least as cheap as the one asked for - but NOT a better one. If the hand
    // still holds the diamond pick while stone was selected, returning "true" here is exactly the lie
    // that spent the diamond pick on 200 blocks of deepslate between 19:03 and 19:19.
    const okHand = async (ms) => settleHand(bot, h => handIsPick(h) && rank(h.name) <= rank(cand.name), ms);
    // Same discipline as equipPick: select the hotbar slot when it has one (one tiny packet) and cap
    // the window-click path. This call used to be an uncapped `bot.equip`, which is where the
    // measured 33.7 s per dig came from (ds slow-dig x3 at 13:17-13:18).
    if (cand.slot >= 36 && cand.slot <= 44 && (!bot.heldItem || bot.heldItem.name !== cand.name)) {
      try { await bot.setQuickBarSlot(cand.slot - 36); } catch {}
      if (await okHand(3000)) return true;
    }
    const t0 = Date.now();
    try { await Promise.race([bot.equip(cand, 'hand'), sleep(3500)]); } catch { /* the ack may still land */ }
    const settled = await okHand(9000);
    if (Date.now() - t0 > 2000 || !settled) log.info(`equipBulkPick: asked ${cand.name} in ${Date.now() - t0}ms, hand=${bot.heldItem ? bot.heldItem.name : '-'} -> ${settled ? 'verified' : 'NOT in hand'}`);
    // A candidate that will not reach the hand is not a reason to stop: the stone pick in the hotbar
    // still works. Try the next one, and only report failure once none of them landed.
    if (settled) return true;
  }
  return false;
}

async function equipPick(bot) {
  const names = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'golden_pickaxe', 'wooden_pickaxe'];
  const inv = bot.inventory.items();
  // A pick at 0 uses looks held but digs nothing - that silent failure stalled the bot for hundreds
  // of loops, so skip anything with fewer than 8 uses left. It used to be a 15% PERCENT floor, which
  // threw the whole diamond hunt away at 12:05-12:07: iron@11% (54 uses left on a 487-use pick) and
  // diamond@8% (125 uses) both read "unusable", find_diamonds returned in 1 ms with no pick at all,
  // and the obsidian milestone looped on `no diamond pickaxe yet` for two minutes straight. Durability
  // is a count of digs, so gate on digs - a percentage floor means something different on every tier.
  let pick = null;
  for (const n of names) {
    const cand = inv.filter(i => i.name === n).sort((a, b) => (ob.wear(bot, b) ?? 0) - (ob.wear(bot, a) ?? 0))[0];
    if (!cand) continue;
    const left = (cand.maxDurability || 0) - (cand.durabilityUsed || 0);
    if (cand.maxDurability && left < 8) continue;
    pick = cand; break;
  }
  if (!pick) return false;
  if (bot._lastPick !== pick.name || !bot.heldItem || bot.heldItem.name !== pick.name) {
    bot._lastPick = pick.name;
    // Attribute the diamond pickaxe's wear loss to the phase that caused it. 20:03:33 `wear=93%` and
    // 20:45:40 `dpick=0`: the pick died again in 40 minutes even after deep_shaft's own floor, so the
    // open question is WHICH caller spends it - this line is the cheapest way to answer that.
    let wearDelta = '';
    if (/diamond|netherite/.test(pick.name)) {
      const w = Number(String(ob.wear(bot, pick)).replace(/[^0-9.]/g, '')) || 0;
      const drop = typeof bot._dpickWear === 'number' ? bot._dpickWear - w : 0;
      if (drop > 0) wearDelta = ` (-${drop}% since the last sighting, spent while the phase was "${bot._dpickPhase || '?'}")`;
      bot._dpickWear = w; bot._dpickPhase = bot._loopPhase || '?';
    }
    log.info(`equipPick found=${pick.name} wear=${ob.wear(bot, pick)}% slot=${pick.slot} held=${bot.heldItem ? bot.heldItem.name : 'none'}${wearDelta}`);
  }
  // Prefer selecting its hotbar slot (a tiny packet) over bot.equip's window machinery, which hung here.
  // Prove the hand, both ways. This used to `return true` on an ack that never landed, the caller
  // believed a pick was held, and the bot hand-dug at 37.5 s per block with `pick=-` (19:31-19:35).
  const settled = async (ms) => settleHand(bot, handIsPick, ms);
  if (pick.slot >= 36 && pick.slot <= 44) {
    if (!bot.heldItem || bot.heldItem.name !== pick.name) { try { await bot.setQuickBarSlot(pick.slot - 36); } catch {} }
    if (await settled(3000)) return true;
  }
  try { await Promise.race([bot.equip(pick, 'hand'), sleep(3500)]); } catch {}
  const okHand = await settled(9000);
  if (!okHand) log.warn(`equipPick: asked ${pick.name} (slot=${pick.slot}) and the hand holds ${bot.heldItem ? bot.heldItem.name : 'nothing'} - callers must not dig on this`);
  return okHand;
}
function bestOrePickOk(bot, block) {
  // deepslate diamonds/obsidian need iron/diamond tier; stone pick can't.
  return !!bot.inventory.items().find(i => /_(pickaxe)$/.test(i.name) && (i.name.startsWith('iron_') || i.name.startsWith('diamond_') || i.name.startsWith('netherite_')));
}

// ---- deep mining ----
// Straight-down digging is what actually descends (a 45-degree staircase turned into a flat
// tunnel here: bot.dig() on an already-air block resolves happily and "succeeded" sideways).
// The real hazard at depth is the unrequested 20-block drop into a cave, so dig straight and
// keep slow falling on: the bot survives the fall and simply walks back up the rubble.
// Feet or head inside a water source. Used as a hard stop, not a hint: while the bot is in water
// it drowns (two deaths in its own shaft in 30 s) and any milestone skill that keeps digging
// ignores the planner-level escape, because a running skill is never preempted.
function wetCell(bot) {
  try {
    const f = bot.entity.position.floored();
    const wet = (p) => { const b = bot.blockAt(p); return !!b && b.name.includes('water'); };
    return wet(f) || wet(f.offset(0, 1, 0));
  } catch { return false; }
}

// Columns the bot has already flooded (and drowned in). Kept on disk because every reconnect
// builds a NEW bot object, so bot._ anything is lost - the trap was being re-entered after each
// death for exactly that reason.
const floodFile = () => require('../config').paths.runs + '/flooded_columns.json';
function loadFloods(bot) {
  if (!bot._floods) { try { bot._floods = JSON.parse(require('fs').readFileSync(floodFile(), 'utf8')); } catch { bot._floods = []; } }
  return bot._floods;
}
function noteFlood(bot, x, z, y) {
  const l = loadFloods(bot);
  if (!l.some(c => Math.abs(c.x - x) <= 2 && Math.abs(c.z - z) <= 2)) l.push({ x, z, y });
  try { require('fs').writeFileSync(floodFile(), JSON.stringify(l)); } catch {}
}
function nearFlood(bot, x, z, r) {
  const rad = r || 5;
  return loadFloods(bot).some(c => Math.abs(c.x - x) <= rad && Math.abs(c.z - z) <= rad);
}

// Sea level on this seed is y=62-63, so a column whose surface reads "dry land" at y=62-66 is an
// ocean floor: digging down from it meets an aquifer within ~20 blocks (measured twice 12:36-12:39 -
// flooded at y=40 after 25 digs from y=64, then the relocation walk landed at y=63 and flooded
// immediately). `recover_surface` already pins a genuinely dry spot in bot._dryLand, which was at
// y=74 - that is the ground a shaft should start from.
const MIN_HIGH_Y = 68;
// A chosen site stays chosen. Without this the farm re-decided every round and the decisions chased each
// other: 01:12 -> lava 118,-9,845, 01:17 -> 149,52,774, 01:20 -> 114,9,774, 01:24 -> 118,-9,845 again,
// while the bot was walking ~40 blocks per round back toward z~770 after respawning at the world spawn
// (14,66,16). A 700-block approach only converges if the destination is held, so the lock outlives the
// round, and a round that actually produced obsidian keeps the lock (it is the right place).
let siteLock = null;
const SITE_LOCK_MS = 30 * 60000;

// Sites whose ROUTE failed, by cell, with the time it failed. Process-local on purpose: the point is to
// stop the same round from re-attempting the same pool it just bounced off, and 371 `notdone` obsidian
// rounds were mostly that - at 20:04-20:09 the farm tried 486,-24,762 (blocked at a coastal ledge),
// then 125,40,858 (blocked at 94,32,759 with `ahead=air/air`), each round starting from cell [0] again.
// A restart re-probes them, which is correct: a chasm crossed once is still crossable.
// A station whose fill was refused is NOT on the menu for as long as a site whose ROUTE failed:
// 127,62,858 filled successfully at 22:29, 22:33, 22:51, 22:54 and 23:23 but reads "all cells flowing"
// when the bot happens to stop on the wrong side of it, and one such sample froze the only lake near the
// obsidian pool for 25 minutes - at 00:07:05 the farm gave up on the proven pool and started trekking
// 400 blocks east to 486,-24,762, the site that had already failed on the coastal shelf.
const SITE_COOLDOWN_MS = 25 * 60000;
// How long a wedged interface (only reachable through flooded chimneys) stays off the menu. Longer than
// an ordinary refusal because the wedge is structural - the pool geometry will not change in 25 minutes -
// but finite, so a site that becomes workable after a shelf is built gets another turn.
const SITE_WEDGE_COOLDOWN_MS = Number(process.env.OBSIDIAN_WEDGE_COOLDOWN_MS || 40 * 60000);
const FILL_COOLDOWN_MS = 4 * 60000;
// The map is persisted to runs/site_fails.json. Keeping it in memory only was my own bug: the watchdog
// restarts the bot every 12 minutes without progress, and every restart re-offered the same never
// converting hillside flow - 149,52,774 was poured at 03:04, 03:14, 03:21 and 03:22 with
// `no obsidian within 10` each time, so the bot kept re-learning a lesson it had already learned.
const SITE_FILE = path.join(cfg.paths.runs, 'site_fails.json');
let siteFails = new Map();
try {
  for (const [k, v] of Object.entries(JSON.parse(fs.readFileSync(SITE_FILE, 'utf8')))) siteFails.set(k, Number(v));
} catch { /* no file yet, or unreadable - start empty, never block a dig */ }
function saveSiteFails() {
  try {
    const now = Date.now(), o = {};
    // `#n` keys are structural-failure STRIKE counts, not deadlines - they must survive the sweep or the
    // proven-over-cooldown override below loses its memory on the next write and re-arms forever.
    for (const [k, v] of siteFails) if (k.endsWith('#n') || v > now) o[k] = v;
    fs.writeFileSync(SITE_FILE, JSON.stringify(o));
  } catch (e) { log.warn(`site_fails save threw ${e.message}`); }
}
const siteKey = (e) => `${e.x},${e.y},${e.z}`;
const siteCooling = (e) => { const until = siteFails.get(siteKey(e)); return !!until && Date.now() < until; };
const siteStrikes = (e) => Number(siteFails.get(`${siteKey(e)}#n`) || 0);
// A short re-arm that is NOT a structural failure: the pool is still workable, the round just could not
// use it (budget, a shelf two blocks away, a temporary mob). Counting these as strikes would let the
// proven-pool cap suppress a site that is actually fine.
const coolSiteOnly = (e, ms) => { siteFails.set(siteKey(e), Date.now() + ms); saveSiteFails(); };
// The pair that last PRODUCED obsidian is the strongest site evidence the run can have - stronger than
// "there is remembered obsidian nearby", because those cells get evicted from the 90-entry cache and the
// proof silently disappears. Measured 07:05:57 / 07:10:19: the farm chose `lava 486,-24,762 + station
// 500,70,760` (45 apart but 800 blocks away, the coastal shelf §26u/§26dd record as failing to convert)
// over the pool that actually yielded obsidian, because all four of its surface stations were on an
// 8-minute fill cooldown and `proven()` had lost its obsidian memories. Persisting the worked pair keeps
// the lesson across cache churn, station cooldowns and supervisor restarts.
const LAST_SITE = path.join(cfg.paths.runs, 'last_site.json');
let lastSite = null;
try { lastSite = JSON.parse(fs.readFileSync(LAST_SITE, 'utf8')); } catch { lastSite = null; }
const lastSiteFresh = (ms) => !!lastSite && (Date.now() - lastSite.ts) < (ms || 6 * 3600 * 1000);
const rememberPair = (lv, wv) => {
  // A success clears the strike count: the override earns its right to re-arm the pool by producing,
  // not by having produced once hours ago.
  try { siteFails.set(`${siteKey(lv)}#n`, 0); if (wv) siteFails.set(`${siteKey(wv)}#n`, 0); saveSiteFails(); } catch {}
  try {
    lastSite = { lv: { x: lv.x, y: lv.y, z: lv.z }, wv: { x: wv.x, y: wv.y, z: wv.z }, ts: Date.now() };
    fs.writeFileSync(LAST_SITE, JSON.stringify(lastSite));
  } catch (e) { log.warn(`last_site save threw ${e.message}`); }
};
const markSiteFail = (e, why, ms = SITE_COOLDOWN_MS) => { siteFails.set(siteKey(e), Date.now() + ms); siteFails.set(`${siteKey(e)}#n`, siteStrikes(e) + 1); saveSiteFails(); log.warn(`obsidian_farm: site ${e.x},${e.y},${e.z} is off the menu for ${Math.round(ms / 60000)} min (${why}) - strike ${siteStrikes(e)}${siteStrikes(e) >= 3 ? ' [proven pool has now failed 3 ways: the override below will NOT re-arm it until something succeeds]' : ''}`); };

async function relocateToHighGround(bot, why) {
  const dl = bot._dryLand;
  log.skill(`${why}: surface y=${Math.round(bot.entity.position.y)}, pinned dry land = ${dl ? `${dl.x},${dl.y},${dl.z}` : 'none'}`);
  // Unless we are already standing on the thing we came for. At 14:14:15 the hop had just delivered
  // the bot 2 blocks from a remembered lava pool's column and this function was about to walk it tens
  // of blocks away because that column is at y=62-63 - relocation must never undo an arrival.
  const overPool = oreCache.nearest(['lava', 'diamond_ore', 'deepslate_diamond_ore'], bot.entity.position);
  if (overPool && Math.hypot(overPool.x - bot.entity.position.x, overPool.z - bot.entity.position.z) <= 16) {
    log.skill(`${why}: standing above remembered ${overPool.name} at ${overPool.x},${overPool.y},${overPool.z} - digging here instead of walking away`);
    return false;
  }
  // The pinned value is a MEASUREMENT (recover_surface stood there and called it dry), so it outranks my
  // fixed 68 guess. With dl.y=66 the old check failed by two blocks and the bot, holding 1 diamond and no
  // pick, spent three rounds (21:30, 21:36, 21:40) surfacing onto that same dry land and then roaming
  // away from it instead of digging the shaft - which is how "get the pick back" never started.
  if (dl && dl.y >= MIN_HIGH_Y - 4) {
    log.skill(`${why}: at sea level - moving to known high ground ${dl.x},${dl.y},${dl.z} before digging`);
    const w = await reg.get('walk_to').run(bot, { x: dl.x, y: dl.y, z: dl.z, tolerance: 8 });
    // Arrival is "got onto the pinned column", not "crossed my arbitrary height line" - the walk target
    // IS dl, so standing within a few blocks of its y means the relocation did its job.
    if (Math.abs(bot.entity.position.y - dl.y) <= 4) return true;
    log.skill(`${why}: high-ground hop said (${String(w.observation).slice(0, 140)})`);
  }
  // No upland on file (recover_surface pins whatever is dry AND low enough to feed a hungry bot, and
  // on this coast that was y=63 - still sea level, still floods). Probe a few directions and keep
  // whichever one actually gains height, instead of roaming to another random puddle.
  const tProbe = Date.now();
  for (const [dx, dz] of [[90, 0], [-90, 0], [0, 90], [0, -90]]) {
    // A probe is not allowed to eat the expedition: four directions with a stalled leg each would
    // spend the whole 720 s round walking instead of digging.
    if (Date.now() - tProbe > 90000) { log.skill(`${why}: high-ground probe out of time (${Math.round((Date.now() - tProbe) / 1000)}s)`); break; }
    const f = bot.entity.position.floored();
    await reg.get('walk_to').run(bot, { x: f.x + dx, y: f.y, z: f.z + dz, tolerance: 6 });
    if (bot.entity.position.y >= MIN_HIGH_Y) {
      log.skill(`${why}: climbed to y=${Math.round(bot.entity.position.y)} heading ${dx},${dz}`);
      bot._dryLand = bot.entity.position.floored();
      return true;
    }
  }
  try { await reg.get('roam').run(bot, { distance: 140 }); } catch {}
  return bot.entity.position.y >= MIN_HIGH_Y;
}

reg.define('deep_shaft', {
  desc: 'Bounded SAFE descent toward Y=toY (call repeatedly; it is incremental). Never tight-loops. Returns current Y.',
  params: { toY: 'int default -53', max: 'int default 25' },
  async run(bot, a) {
    const toY = a.toY ?? -53; const max = a.max ?? 25; let dug = 0, stuck = 0, moved = 0;
    // A column that has already flooded is not "dry rock one more dig down" - it is the trap that
    // killed this bot six times. Refuse on entry, before any digging, so the caller walks away.
    const p0 = bot.entity.position.floored();
    if (nearFlood(bot, p0.x, p0.z)) {
      // Re-derive from the world before obeying a memory. Live 22:29: the bot stood 2 blocks from the open
      // End portal at -216,15,1500, `deep_shaft` was the next dig, and this veto fired on a FLOODED mark for
      // column -215,1501 - sending it to "walk to fresh ground and start elsewhere", i.e. away from the only
      // column that has a door on it. A mark that is wrong at the goal costs the whole night, so on the goal
      // column the flood must be MEASURED (water or lava within reach of the next digs), not recalled.
      // Measure the WHOLE column down to the destination, not the 3 cells underfoot: live 00:08 the override
      // printed "the cells underfoot read dry - digging anyway" and eleven blocks later the shaft met an
      // aquifer (`WATER below at Y=47`). And a flooded column at the door is not a reason to leave the door -
      // the portal ROOM is a ~25x25 stone floor, so the player answer is to shift a few blocks and dig THERE.
      let roomRec = null;
      try {
        const rec = require('../portalRecord').current();
        if (rec && rec.ringComplete && Number.isFinite(rec.x) && Math.hypot(p0.x - rec.x, p0.z - rec.z) <= 8) roomRec = rec;
      } catch { roomRec = null; }
      const scanColumn = (cx, cz) => {
        const span = Math.max(2, p0.y - (toY - 1));
        for (let dy = 1; dy <= span; dy++) {
          let b = null;
          try { b = bot.blockAt(new Vec3(cx, p0.y - dy, cz)); } catch { b = null; }
          if (b && /water/.test(b.name)) return { fluid: 'water', dy };
          if (b && /lava/.test(b.name)) return { fluid: 'lava', dy };
          // Unloaded rock is UNKNOWN, not dry - but it must not be treated as fluid either, or a bot
          // standing at y=65 could never dig toward y=15 because nothing down there is loaded yet. The
          // honest consequence: this scan can only move a column when the water is already visible, and the
          // real protection belongs where the dig actually measures it (see WATER below in the dig loop).
          if (!b) continue;
        }
        return null;
      };
      let wet = null;
      if (roomRec) {
        const offs = [[0, 0], [3, 0], [-3, 0], [0, 3], [0, -3], [3, 3], [-3, -3], [3, -3], [-3, 3],
          [6, 0], [-6, 0], [0, 6], [0, -6], [5, 3], [-5, -3], [4, -4], [-4, 4]];
        const hereWet = scanColumn(p0.x, p0.z);
        const dry = offs.find(([ox, oz]) => !scanColumn(p0.x + ox, p0.z + oz));
        if (!hereWet && dry && dry[0] === 0 && dry[1] === 0) {
          log.warn(`deep_shaft: column ${p0.x},${p0.z} is marked FLOODED but the scan down to y=${toY} is dry - digging (the mark only holds where fluid is measurable)`);
          try { const SR = require('../shaftRecord'); if (typeof SR.clearFlood === 'function') SR.clearFlood(p0.x, p0.z); } catch {}
        } else if (dry) {
          log.warn(`deep_shaft: this column meets ${String((hereWet || { fluid: 'an unseen block' }).fluid)} ${String((hereWet || { dy: '?' }).dy)} blocks below, but the column offset ${dry[0]},${dry[1]} is dry all the way to y=${toY} - the portal room is a wide floor, so shifting ${Math.round(Math.hypot(dry[0], dry[1]))} blocks and digging there instead of abandoning the open door`);
          await capped(bot.pathfinder.goto(new (GN())(p0.x + dry[0], p0.y, p0.z + dry[1], 1)), 12000, 'shift to the dry column').catch(() => null);
        } else {
          wet = `${String((hereWet || { fluid: 'fluid' }).fluid)} measured ${String((hereWet || { dy: '?' }).dy)} blocks below, and every column within 6 blocks is wet too`;
        }
      } else {
        wet = 'recorded';
      }
      if (wet) {
        return { ok: false, observation: `column ${p0.x},${p0.z} is FLOODED (${wet === 'recorded' ? 'recorded from an earlier collapse' : wet}) - do not dig straight down here; step 4-6 blocks aside to dry rock and dig there, the portal room is a wide floor, not this one cell` };
      }
    }
    // Hunger is the one resource you cannot recover underground: regen needs food >18 and there is
    // nothing to eat in a shaft. Refuse new descents before it becomes a starvation death.
    if (bot.food < 10 && p0.y < 30 && bot.game && bot.game.dimension === 'overworld') {
      return { ok: false, observation: `FOOD LOW (${bot.food}) at y=${p0.y} - surface and eat before digging any deeper` };
    }
    // ...and health is the other one, for the same structural reason: a step with a 25-minute budget
    // keeps the planner's `survive()` gate from ever running, so at 07:56:45 -> 08:00:13 this shaft sat
    // at y=-18 going hp 5.6 -> 2.5 with nothing able to take it out. Hand the step back instead.
    if (bot.health <= 8 && p0.y < 40) {
      return { ok: false, observation: `HP CRITICAL (${Math.round(bot.health * 10) / 10}) at y=${p0.y} with worn=${['helmet', 'chestplate', 'leggings', 'boots'].filter(pt => { const it = bot.inventory.slots[5 + ['helmet', 'chestplate', 'leggings', 'boots'].indexOf(pt)]; return !!it; }).length}/4 - surface and heal before digging any deeper` };
    }
    // Same self-dug-pit rule as dig_to_y: never sink the shaft in the pinned respawn column.
    const dl = bot._dryLand;
    if (dl && bot.entity.position.y > 20 && Math.abs(bot.entity.position.x - dl.x) <= 3 && Math.abs(bot.entity.position.z - dl.z) <= 3) {
      try { await bot.pathfinder.goto(new (GN())(dl.x + 18, bot.entity.position.y, dl.z - 14, 2)); } catch {}
      await sleep(500);
    }
    // A shaft is 100% stone/deepslate/dirt until an ore is in front of it, so the entry equip must
    // not take the diamond pick: at 10:01:16 it came in at 87% to grind the first block, and the
    // obsidian chain needs that pick alive. find_diamonds equips the high tier itself per ore.
    if (!(await equipBulkPick(bot)) && !(await equipPick(bot))) return { ok: false, observation: 'need a pickaxe to dig deep' };
    if (!bot._stair) bot._stair = Math.random() < 0.5 ? { x: 1, z: 0 } : { x: 0, z: 1 };
    let lastEffect = 0, lastClear = 0;
    while (bot.entity.position.y > toY && dug < max && stuck < 25 && Date.now() < (bot._stepDeadline || Infinity)) {
      const y0 = bot.entity.position.y;
      const feet = bot.entity.position.floored();
      // In water, every second spent here is air spent: refuse and let the caller escape+relocate.
      if (wetCell(bot)) {
        return { ok: false, observation: `STANDING IN WATER at ${feet.x},${feet.y},${feet.z} - this column is flooded; backfill out and pick a new one` };
      }
      // Mobs climb into the shaft and chew the bot while it is digging (hp repeatedly dropped to 7
      // and the descent cost ~9 minutes per 10 blocks). Clear whoever is inside the hole first.
      // Throttled: swapping the held item (sword/torch) mid-dig ABORTS the current dig, so this must
      // not run between every dig. Once every 20 s, and always re-equip the pickaxe afterwards.
      if (dug % 3 === 0 && Date.now() - lastClear > 20_000) {
        lastClear = Date.now();
        // Only whoever is actually in the shaft with us. The radius used to be 7, which counted a
        // zombie 7 blocks up the column as a reason to stop digging: measured 12:52-12:59, the descent
        // ran at ~25 s per deepslate block (it should be under 2 s with a 96% iron pick) because every
        // 20 s gate ended in a full pvp fight that never finished.
        const foe = bot.nearestEntity(en => en.position && ['zombie', 'zombie_villager', 'skeleton', 'spider', 'cave_spider', 'drowned', 'creeper'].includes(en.name) && bot.entity.position.distanceTo(en.position) < 4);
        if (foe) {
          try {
            const sword = bot.inventory.items().find(i => i.name.endsWith('_sword'));
            if (sword) await bot.equip(sword, 'hand');
            await Promise.race([bot.pvp.attack(foe), sleep(6000)]);
            try { bot.pvp.stop(); } catch {}
            log.skill(`deep_shaft cleared ${foe.name} at ${Math.round(bot.entity.position.distanceTo(foe.position))} blocks`);
          } catch (e) { log.skill(`deep_shaft attack ${foe.name} threw ${e.message}`); }
          try { await equipBulkPick(bot, true); } catch {}
          continue;
        }
      }
      if (process.env.MC_ASSIST !== '0' && feet.y < 25 && Date.now() - lastEffect > 100_000) {
        lastEffect = Date.now();
        try { bot.chat('/effect give @s minecraft:slow_falling 200 0 true'); } catch {}
      }
      const below = bot.blockAt(feet.offset(0, -1, 0));
      if (!below) { stuck++; await sleep(400); continue; }
      // A shaft digs its own floor away and fills the pack with the result: 20:14:44 `tidy` made 8 free
      // slots, and by 20:18:40 the pack was at `free=1` again - four minutes of digging. At one free
      // slot the next dig's drop is lost outright, and obsidian (which must be CARRIED out) cannot be
      // collected at all, so the dig itself is the right moment to drop rock rather than waiting for
      // the next planner iteration.
      if (P.freeSlots(bot) <= 3) await P.dropJunk(bot, true, 8);
      // A shaft is dug with a pick, so require the HAND, not the pack. The descent from 19:31 to 19:35
      // moved 4 blocks in 8 minutes at 37.5 s per stone block with `pick=-` because equipPick had
      // returned true for an iron pick in slot 30 that never reached the hand; dirt would have taken
      // 50 ms, which is why the threshold is on dig time and not on the block name.
      if (!handIsPick(bot.heldItem) && bot.digTime && bot.digTime(below) > 3000) {
        const wasHand = bot.heldItem ? bot.heldItem.name : 'nothing';
        const got = (await equipBulkPick(bot, true)) || (await equipPick(bot));
        if (!got || !handIsPick(bot.heldItem)) {
          return { ok: false, observation: `no pickaxe in hand at y=${feet.y} (holding ${wasHand}, ${below.name} below needs ${bot.digTime(below)}ms) - refusing to hand-dig rock` };
        }
        log.skill(`deep_shaft: hand was ${wasHand}, now ${bot.heldItem.name}`);
        // Do not feed the diamond pickaxe to ordinary rock. Its wear is the reason the obsidian chain
        // keeps restarting: 64% at 18:42 -> 10% at 19:00 -> 7% at 19:05 -> gone at 19:13, all of it cut
        // on stone/deepslate, because a stone pick (3 cobble + 2 sticks) could not be made while the
        // wood chain was failing. A hard refusal would freeze the descent, so the floor is 30%: above it
        // the dig proceeds (and says so), below it the shaft stops and names the real remedy.
        if (/diamond|netherite/.test(bot.heldItem.name) && !/obsidian|diamond_ore|deepslate_diamond|redstone_ore|deepslate_redstone|lapis|emerald|ancient_debris/.test(below.name)) {
          const max = bot.heldItem.maxDurability || 1562;
          const leftFrac = (max - (bot.heldItem.durabilityUsed || 0)) / max;
          const cheap = bot.inventory.items().some(i => /_pickaxe$/.test(i.name) && !/diamond|netherite/.test(i.name)
            && ((i.maxDurability || 999) - (i.durabilityUsed || 0)) >= 8);
          if (!cheap && leftFrac <= 0.3) {
            log.warn(`deep_shaft: ${bot.heldItem.name} at ${Math.round(leftFrac * 100)}% and no cheap pick to cut ${below.name} with - stopping rather than spending the obsidian chain's ticket`);
            return { ok: false, observation: `refusing to cut ${below.name} with the ${Math.round(leftFrac * 100)}%-wear diamond pickaxe (no stone pick exists: cobble=${countItem(bot, 'cobblestone') + countItem(bot, 'cobbled_deepslate')} sticks=${countItem(bot, 'stick')}; the wood chain is the blocker - run chop_trees/walk to trees, then craft sticks, then a stone pick)` };
          }
          if (!cheap) log.warn(`deep_shaft: spending the diamond pickaxe on ${below.name} at ${Math.round(leftFrac * 100)}% wear because no cheaper pick exists (cobble=${countItem(bot, 'cobblestone') + countItem(bot, 'cobbled_deepslate')} sticks=${countItem(bot, 'stick')})`);
        }
      }
      // bedrock cannot be broken and bot.dig() on it warns forever ("dig time for bedrock is
      // Infinity") - the bot was pinned at the bottom of the world doing exactly that.
      if (below.name.includes('bedrock')) {
        log.warn(`bedrock at Y=${feet.y - 1}; going back up instead of digging forever`);
        return { ok: false, observation: `hit bedrock at Y=${Math.round(bot.entity.position.y)} - cannot dig down here, climb out and pick another column` };
      }
      if (below.name.includes('lava')) { // never dig into lava: carve around it one step sideways
        const s = bot._stair;
        const side = bot.blockAt(feet.offset(s.x, 0, s.z));
        if (side && !isAir(side.name)) { try { await bot.dig(side); dug++; } catch { stuck++; } }
        try { await bot.pathfinder.goto(new (GN())(feet.x + s.x, feet.y, feet.z + s.z, 0)); } catch {}
        await sleep(300);
        continue;
      }
      if (below.name.includes('water')) {
        // Digging sideways into an aquifer is what drowned it three times in its own shaft at
        // (120,33..43,295): the water pours in, the bot cannot see the surface, air runs out.
        // A player abandons that column; so do we - UNLESS what sits at the bottom of this column is the
        // open End portal. Measured 00:12 -> 00:16: the "start a new column elsewhere" advice was taken
        // literally, the caller relocated across the ocean, and a bot that had been 2 blocks from the door
        // ended up 299 blocks away with zero rations. At this depth the neighbours ARE loaded, so a lateral
        // shift of a few blocks is both measurable and cheap - the portal room is a wide floor, not one cell.
        let shifted = false;
        try {
          const recW = require('../portalRecord').current();
          if (recW && recW.ringComplete && Number.isFinite(recW.x) && Math.hypot(feet.x - recW.x, feet.z - recW.z) <= 14) {
            const candW = [[3, 0], [-3, 0], [0, 3], [0, -3], [3, 3], [-3, -3], [4, 0], [-4, 0], [0, 4], [0, -4], [5, 3], [-5, -3]];
            for (const [ox, oz] of candW) {
              let wet2 = false;
              try {
                for (const dy of [1, 2, 3]) {
                  const t = bot.blockAt(new Vec3(feet.x + ox, feet.y - dy, feet.z + oz));
                  if (t && /water|lava/.test(t.name)) { wet2 = true; break; }
                }
              } catch { wet2 = true; }
              if (wet2) continue;
              log.warn(`deep_shaft: water under this cell at Y=${feet.y} with the open door ${Math.round(Math.hypot(feet.x - recW.x, feet.z - recW.z))} blocks away - shifting ${ox},${oz} at the same depth instead of abandoning the shaft`);
              await capped(bot.pathfinder.goto(new (GN())(feet.x + ox, feet.y, feet.z + oz, 1)), 10000, 'shift shaft off the water').catch(() => null);
              const mf = bot.entity.position.floored();
              if (Math.hypot(mf.x - feet.x, mf.z - feet.z) >= 1.5) { shifted = true; break; }
            }
          }
        } catch { shifted = false; }
        if (shifted) continue;
        noteFlood(bot, feet.x, feet.z, feet.y);
        return { ok: false, observation: `WATER below at Y=${feet.y} (${below.name}) - do not dig into it; climb out and start a new shaft column elsewhere` };
      }
      if (isAir(below.name)) {
        // The one-cell check above is not enough: this bot drowned four times in its own shaft
        // because the lip was air, the aquifer was 6 cells lower, and stepping down was "safe".
        // Probe the column until either solid rock (safe) or water (abandon this column).
        let flood = 0;
        for (let d = 2; d <= 10; d++) {
          const probe = bot.blockAt(feet.offset(0, -d, 0));
          if (!probe) break;
          if (probe.name.includes('water')) { flood = d; break; }
          if (probe.name.includes('lava')) { flood = d; break; }
          if (!isAir(probe.name)) break;
        }
        if (flood) {
          noteFlood(bot, feet.x, feet.z, feet.y - flood);
          return { ok: false, observation: `LIQUID ${flood} blocks below this opening (Y=${feet.y - flood}) - do not descend; column ${feet.x},${feet.z} is a trap, dig a new one elsewhere` };
        }
        // already an opening (a cave roof / the lip of our own shaft): go down it - but only a drop the
        // body can take. The comment below this block used to claim "slow falling makes the drop free";
        // slow falling is an enderman/phantom mechanic, a player takes a heart per block past three, and
        // 07:23:54 `DIED ... Numen fell from a high place` at y=40 was a 24-block step off the lip of the
        // shaft this same routine had dug. So: measure the fall, and if it is a fall, cut a staircase.
        let dropToSolid = null;
        for (let d = 1; d <= 40; d++) {
          const p = bot.blockAt(feet.offset(0, -d, 0));
          if (!p) break;
          if (!isAir(p.name)) { dropToSolid = d - 1; break; }
        }
        if (dropToSolid !== null && dropToSolid > 3) {
          const s = bot._stair || (bot._stair = { x: 1, z: 0 });
          const beside = feet.offset(s.x, 0, s.z);
          const step = feet.offset(s.x, -1, s.z);
          const bBlk = bot.blockAt(beside), sBlk = bot.blockAt(step);
          const diggable = (b) => b && !isAir(b.name) && !/lava|water|bedrock/.test(b.name);
          if (diggable(bBlk)) { try { await bot.dig(bBlk); } catch {} dug++; }
          if (diggable(sBlk)) { try { await bot.dig(sBlk); } catch {} dug++; }
          const st = await P.stepOnto(bot, { x: beside.x, y: beside.y, z: beside.z });
          log.warn(`deep_shaft: ${dropToSolid}-block free fall at ${feet.x},${feet.y},${feet.z} - not jumping down my own shaft, cutting the staircase via ${beside.x},${beside.y},${beside.z} (stepped ${st.moved})`);
          if (st.moved < 1) bot._stair = { x: s.z || -s.x, z: s.x ? 0 : 1 };   // flip to the other hand
          await sleep(250);
          continue;
        }
        const before = bot.entity.position.y;
        try { await bot.pathfinder.goto(new (GN())(feet.x, feet.y - 1, feet.z, 0)); } catch {}
        await sleep(400);
        if (before - bot.entity.position.y < 0.5) {
          // pathfinder refuses an unverified drop; look down and walk off the edge (slow
          // falling makes the drop free), which is how a human gets down a shaft lip.
          try {
            await bot.look(0, -Math.PI / 2, true);
            bot.setControlState('jump', true);
            bot.setControlState('forward', true);
            await sleep(500);
            bot.setControlState('forward', false);
            bot.setControlState('jump', false);
          } catch {}
        }
        if (before - bot.entity.position.y < 0.5) {
          // still pinned: tunnel sideways instead of freezing here
          const s = bot._stair;
          const wall = bot.blockAt(feet.offset(s.x, 0, s.z));
          const floor = bot.blockAt(feet.offset(s.x, -1, s.z));
          if (wall && !isAir(wall.name)) { try { await equipBulkPick(bot); await bot.dig(wall); dug++; } catch { stuck++; } }
          if (floor && !isAir(floor.name)) { try { await bot.dig(floor); dug++; } catch {} }
          try { await bot.pathfinder.goto(new (GN())(feet.x + s.x, feet.y, feet.z + s.z, 0)); } catch {}
          await sleep(250);
        }
        if (before - bot.entity.position.y >= 0.5) moved++; else stuck++;
        continue;
      }
      const tDig = Date.now();
      try { await equipBulkPick(bot, true); await bot.dig(below); dug++; stuck = 0; }
      catch {
        stuck++;
        // A straight dig that keeps failing is the classic pin (y=46 stalled for 7 minutes). Dig the
        // diagonal-down-forward cell and step into it: a staircase needs no fall and no reach, which
        // is how miners actually go down.
        if (stuck >= 2) {
          const s = bot._stair;
          const side = bot.blockAt(feet.offset(s.x, 0, s.z));
          const diag = bot.blockAt(feet.offset(s.x, -1, s.z));
          if (side && !isAir(side.name) && !/lava|water|bedrock/.test(side.name)) { try { await bot.dig(side); } catch {} }
          if (diag && !isAir(diag.name) && !/lava|water|bedrock/.test(diag.name)) { try { await bot.dig(diag); dug++; } catch {} }
          try { await bot.pathfinder.goto(new (GN())(feet.x + s.x, feet.y - 1, feet.z + s.z, 0)); } catch {}
          await sleep(450);
          if (y0 - bot.entity.position.y >= 0.5) { moved++; stuck = 0; continue; }
          bot._stair = { x: -s.x, z: -s.z };
          if (stuck > 8) return { ok: false, observation: `cannot dig down nor stair at Y=${Math.round(bot.entity.position.y)} (${below.name} below, light=${below.light}) - pick another column` };
        }
        await sleep(400); continue;
      }
      const dtDig = Date.now() - tDig;
      // Attribution, not a guess: the descent ran 25-37 s per block below y=15 (12:52:37 -> 12:59:06)
      // while y=68 -> y=40 took 3 s per block, and the mob-clear theory was wrong - there is no
      // `cleared zombie` line anywhere in that window. Log the slow ones so the next read says which
      // call ate the time instead of me picking a plausible culprit.
      if (dtDig > 6000) log.info(`ds slow-dig: ${dtDig}ms for ${below.name} at ${feet.x},${feet.y - 1},${feet.z} (pick=${bot.heldItem ? bot.heldItem.name : '-'} heap=${Math.round(process.memoryUsage().heapUsed / 1e6)}MB)`);
      if (y0 - bot.entity.position.y >= 0.5) moved++;
      if (dug % 8 === 1) log.info(`ds y=${Math.round(bot.entity.position.y)} dug=${dug} moved=${moved} heapMB=${Math.round(process.memoryUsage().heapUsed / 1e6)} ents=${Object.keys(bot.entities || {}).length}`);
      await sleep(200);
    }
    const y = Math.round(bot.entity.position.y);
    if (y < (bot._deepestY ?? 999)) { bot._deepestY = y; const at = bot.entity.position.floored(); bot._deepestAt = { x: at.x, y, z: at.z }; }
    // `_deepestY` lives on the bot object, so a reconnect or a timed-out step loses it. The descent is
    // longer than any step window this planner offers, so the head has to live on disk - and only for a
    // diamond-depth target, or a shallow obsidian dig would be filed as a finished shaft.
    if (moved && toY <= -25) shaftRecord.note(bot, { toY });
    return { ok: y <= toY + 3, observation: `dug ${dug}, stepped down ${moved}, stuck ${stuck}, now Y=${y}` };
  },
});
function dirV(name) { return { N: { x: 0, z: -1 }, S: { x: 0, z: 1 }, E: { x: 1, z: 0 }, W: { x: -1, z: 0 } }[name] || { x: 1, z: 0 }; }
// Mine an ore block; if it's buried/unreachable, TUNNEL toward it (dig through intervening blocks,
// e.g. deepslate) until within reach — this is what lets the bot actually reach scanned ore.
async function mineBlockHere(bot, b) {
  if (!b || !b.position) return false;
  // Only the TARGET decides the tier. Digging the rock on the way there with the best pick in the
  // pack is how the one diamond pickaxe - the only tool that drops obsidian - gets spent on soil.
  if (/obsidian|diamond_ore|deepslate_diamond|emerald|ancient_debris/.test(b.name)) await equipPick(bot);
  else if (!(await equipBulkPick(bot, true))) await equipPick(bot);
  const isLavaTarget = /lava/.test(b.name);
  const near = () => bot.entity.position.distanceTo(b.position) <= (isLavaTarget ? 3.5 : 4);
  // Per-call budget, independent of the planner's step deadline: an abandoned (timed-out) skill no
  // longer has a deadline set, so without this bound one buried ore ate 65 s of tunneling (173
  // equipPick lines in 6 s of log) and the whole branch_mine step died on a single unreachable block.
  const t0 = Date.now();
  const d0 = bot.entity.position.distanceTo(b.position);
  // Same synchronous-A* freeze as `mine`: goto computes the whole path before yielding, so a far
  // buried ore can pin the event loop at 100% CPU for minutes with no log line. Hop, then re-enter
  // the tunneling loop from closer ground.
  if (d0 > 20) {
    const k = 14 / d0;
    const hx = Math.round(bot.entity.position.x + (b.position.x - bot.entity.position.x) * k);
    const hz = Math.round(bot.entity.position.z + (b.position.z - bot.entity.position.z) * k);
    try { await capped(bot.pathfinder.goto(new (GN())(hx, Math.round(b.position.y), hz, isLavaTarget ? 3 : 1)), 15000, 'hop toward target'); } catch {}
  } else {
    try { await capped(bot.pathfinder.goto(new (GN())(b.position.x, b.position.y, b.position.z, isLavaTarget ? 3 : 1)), 15000, 'walk to target'); } catch {}
  }
  // Reset tunnel timer AFTER initial goto: previously a 15-45s failed goto exhausted the 12s budget
  // before the tunnel loop even ran iteration 0 (live 10:36:53).
  const tLoop = Date.now();
  for (let i = 0; i < 40 && !near() && Date.now() - tLoop < 25000 && Date.now() < (bot._stepDeadline || Infinity); i++) {
    const feet = bot.entity.position.floored();
    const dx = Math.round(b.position.x - feet.x), dz = Math.round(b.position.z - feet.z), dy = Math.round(b.position.y - feet.y);
    const sx = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
    const sz = sx === 0 ? Math.sign(dz) : 0;
    // Never step into or open a wall directly into lava (live 11:22:45 walked into (-19,-26,-283) lava!).
    const stepFeet = bot.blockAt(feet.offset(sx, 0, sz));
    const stepUnder = bot.blockAt(feet.offset(sx, -1, sz));
    const stepHead = bot.blockAt(feet.offset(sx, 1, sz));
    if ((stepFeet && stepFeet.name.includes('lava')) || (stepUnder && stepUnder.name.includes('lava')) || (stepHead && stepHead.name.includes('lava'))) {
      log.skill(`mineBlockHere: stopping at lava edge (${feet.x},${feet.y},${feet.z}) instead of stepping into lava`);
      break;
    }
    // clear head + feet ahead (and the step-down/up cell) so we can advance toward the target
    for (const off of [[sx, 0, sz], [sx, 1, sz], [sx, Math.sign(dy) || 0, sz]]) {
      if (off[0] === 0 && off[2] === 0 && off[1] === 0) continue;
      const blk = bot.blockAt(feet.offset(off[0], off[1], off[2]));
      if (blk && !isAir(blk.name) && !blk.name.includes('lava') && !blk.name.includes('water') && !blk.name.includes('bedrock')) {
        try { await (/obsidian|emerald_ore|ancient_debris/.test(blk.name) ? equipPick(bot) : equipBulkPick(bot, true)); await bot.dig(blk); } catch {}
      }
    }
    try { await capped(bot.pathfinder.goto(new (GN())(feet.x + sx, bot.entity.position.y + (Math.sign(dy) || 0), feet.z + sz, 0)), 5000, 'tunnel step'); }
    catch { try { await bot.setControlState('forward', true); await sleep(220); await bot.setControlState('forward', false); } catch {} }
    await sleep(100);
  }
  const cur = bot.blockAt(b.position);
  const unbreakable = !cur || isAir(cur.name) || /lava|water|bedrock/.test(cur.name);
  const inReach = bot.entity.position.distanceTo(b.position) <= 5.2;
  if (!unbreakable && cur.name === b.name && inReach) {
    try {
      const needsHigh = /obsidian|diamond_ore|deepslate_diamond|emerald|ancient_debris/.test(cur.name);
      if (needsHigh) await equipPick(bot);
      else if (!(await equipBulkPick(bot, true))) await equipPick(bot);
      await bot.dig(cur);
    } catch {}
    try { await capped(bot.pathfinder.goto(new (GN())(b.position.x, b.position.y, b.position.z, 0)), 5000, 'step onto drop'); } catch {}
    await sleep(300);
  }
  // Report honestly: for fluid targets (e.g. tunneling to a lava pool), success means we closed into reach.
  if (/lava|water/.test(b.name)) return bot.entity.position.distanceTo(b.position) <= 6;
  const end = bot.blockAt(b.position);
  return !end || end.name !== b.name;
}
reg.define('walk_to', {
  desc: 'Travel to an ABSOLUTE coordinate in short legs. pathfinder cannot route ~200 blocks in one goto (it answers "No path to the goal!" after a few seconds), so remembered lava pools and ore veins were unreachable even though their coordinates were known. Digs through a wall when a leg has no path.',
  params: { x: 'int', y: 'int', z: 'int', tolerance: 'int default 8' },
  async run(bot, a) {
    const tx = a.x, tz = a.z, tol = a.tolerance ?? 8, HOP = 28;
    const dist = () => Math.hypot(bot.entity.position.x - tx, bot.entity.position.z - tz);
    let legs = 0, blocked = 0, cancelled = 0, noRoute = 0;
    while (dist() > tol && legs++ < 40 && Date.now() < (bot._stepDeadline || Infinity)) {
      const f = bot.entity.position.floored();
      // Hunger is the one resource a long travel step cannot recover by itself, and `obsidian` declares a
      // 25-minute budget: the planner's `survive()` / `food` gate only runs BETWEEN steps, so a bot that
      // starts a 200-block crossing at food=15 arrives at 7 with nothing edible and no way to stop. That
      // is the same trap that made PROGRAM_TIMEOUT_MS be lowered from 420 s (§26ee). Hand the step back
      // early instead - except when the walk IS the food step, which would deadlock on this condition.
      const emergency = bot.health <= 8 ? `HP ${Math.round(bot.health * 10) / 10}` : (bot.food < 10 ? `food ${bot.food}` : '');
      if (emergency && !/food/i.test(String(bot._loopPhase || ''))) {
        // A crossing is not survivable at 2.5 hp: regen needs food >18 AND no mob contact, and while a
        // 25-minute step runs the planner's `survive()` gate cannot take the hand (07:56:45 -> 08:00:13
        // sat at y=-18 going 5.6 -> 2.5 hp). Hand back so the ladder can heal/wall in.
        log.warn(`walk_to: ${emergency} with ${Math.round(dist())} blocks left to ${tx},${tz} - handing the step back`);
        return { ok: false, observation: `EMERGENCY (${emergency}) ${Math.round(dist())} blocks short of ${tx},${tz} - heal/eat first, then call walk_to again` };
      }
      // Walking is not an emergency escape: in water, air runs out long before a 200-block trip ends.
      if (wetCell(bot)) {
        // ...but the guard was written for cave pools and the world spawn (14,62,16) is COASTAL WATER.
        // After a respawn it refused every route, so the site lock held a destination 700 blocks away that
        // the bot could never begin crossing (01:34-01:40, obsidian frozen at 5, position pinned at
        // 14,66,16). Wading with a dry head at or above sea level is survivable; a submerged head in a
        // flooded shaft is what actually kills it, so the refusal now keys on the head and the depth.
        const headCell = bot.blockAt(bot.entity.position.offset(0, 1, 0));
        const headWet = !!headCell && /water|kelp_plant|seagrass/.test(headCell.name);
        // Refusing is only correct when there IS something to climb onto. Mid-ocean there is not, so the
        // guard became a wall: 01:44-01:53 logged three identical `in water at 86,61,552 - get dry`
        // refusals, z frozen, hp down to 8.5, and each round `recover_surface` answered with the SPAWN
        // point (14,66,16) 700 blocks away. Standing in the water and drowning is strictly worse than
        // swimming toward the destination, so with no land within 6 cells: swim, and let the planner's
        // air watchdog preempt the step if the breath actually runs out.
        const nearLand = [[3, 0], [-3, 0], [0, 3], [0, -3], [6, 0], [-6, 0], [0, 6], [0, -6]].some(([dx, dz]) => {
          const b = bot.blockAt(new Vec3(f.x + dx, f.y, f.z + dz));
          return !!b && !isAir(b.name) && !/water|lava|kelp|seagrass/.test(b.name);
        });
        // Swimming a long crossing is what actually drowns this run: 07:01:52 `ABORTED mid-step: out of
        // air (oxygen=0)` happened while it was wading to fill the bucket. A player builds ACROSS - lay a
        // causeway at the surface and walk on it. It is tried whenever the crossing is long, NOT only
        // when no land is near: a causeway has to start from a shore, and the first version of this was
        // reachable only in the middle of the ocean, where it correctly answered
        // `nothing solid to build against ... (deep water)` and laid 0 blocks (07:17:46, 07:19:25,
        // 07:19:37 - three calls, 0 s each, then swam). If the build cannot start the leg below swims as
        // before, so this can only ever help.
        if (dist() > 60) {
          log.info(`walk_to: ${Math.round(dist())} blocks to cross from ${f.x},${f.y},${f.z} toward ${tx},${tz} - trying a causeway (swimming is the fallback)`);
          let br = null;
          try { br = await reg.get('bridge_to').run(bot, { x: tx, z: tz, max: 30 }); } catch (e) { log.warn(`walk_to: bridge_to threw ${String(e.message).slice(0, 80)} - swimming instead`); }
          if (br) log.info(`walk_to: causeway -> ${String(br.observation).slice(0, 150)}`);
        }
        if (!nearLand) {
          log.info(`walk_to: open water at ${f.x},${f.y},${f.z} with no land within 6 - swimming toward ${tx},${tz}`);
        } else if (headWet || bot.entity.position.y < 60) return { ok: false, observation: `in water at ${f.x},${f.y},${f.z} on the way to ${tx},${a.y},${tz} - get dry and call walk_to again` };
      }
      const d = dist() || 1;
      const k = Math.min(HOP, d) / d;
      const gx = Math.round(f.x + (tx - f.x) * k), gz = Math.round(f.z + (tz - f.z) * k);
      const before = d;
      let legErr = '';
      try {
        await Promise.race([
          bot.pathfinder.goto(new (GN())(gx, f.y, gz, 2)),
          new Promise((_, rej) => setTimeout(() => rej(new Error('no path')), 30000)),
        ]);
      } catch (e) {
        legErr = e && e.message ? e.message.slice(0, 40) : String(e);
        // Do NOT stop() when the rejection IS the stop/cancel. mineflayer delivers a stop() against the
        // goal that starts immediately after it, so stop-then-retry manufactured exactly the storm this
        // was meant to survive: 21:10-21:11 logged eight `leg cancelled by Object.run
        // (endgame.js:483)` retries 1.2 s apart, and line 483 is this very call.
        // No stop() at all here. A new `goto` supersedes the current goal on its own (that is exactly
        // what the old promise reports as "The goal was changed"), while stop() lands on the goal issued
        // NEXT - which is how 21:10 and again 23:19-23:20 got eight "leg cancelled by Object.run
        // (this very line)" retries 1.2 s apart. Letting the abandoned path finish pointing the same way
        // is harmless; stopping it is not.
        // A CANCELLED leg is not terrain. mineflayer-pvp calls pathfinder.stop() the moment it engages a
        // mob, and the previous step's teardown does the same, so a mob sighting 40 blocks from a lake
        // was being counted toward the 7-strike give-up (21:02:47: `blocked 7 legs short of 127,62,858
        // (at 87,66,864, 40 away)`). Hand the path over cleanly and retry, with a cap so a real fight
        // cannot spin here.
        if (/goal was changed|Path was stopped/i.test(legErr) && cancelled < 8) {
          cancelled++;
          const who = bot._lastPathStop ? ` by ${bot._lastPathStop.where}` : '';
          log.info(`walk_to: leg cancelled${who} - retry ${cancelled}/8`);
          await sleep(1200);
          continue;
        }
      }
      if (before - dist() >= 2) { blocked = 0; noRoute = 0; continue; }
      // Two legs in a row that produced no route AND no motion, below the open air, is not a bad goal -
      // it is rock. pathfinder answers `Took to long to decide path to goal!` when the goal sits 200
      // blocks away inside the deepslate (its node budget is spent on walls it cannot pass), and the
      // hop/dig fallback below then spends the rest of the window on 12-second hops into cells that do
      // not exist: 21:10-21:22 measured 219 blocks to an OPEN End door and one block closed. Hand the
      // crossing to the corridor cutter - a sequential await, so no second worker outrides this step.
      // The discriminator is the CELL IN FRONT, not the altitude. Live 22:36-22:39: the bot sat at y=63 -
      // above the first version's `y < 58` gate, which was my guess and not a measurement - with A* answering
      // `Took to long to decide path to goal!` and a stone wall in front, so it neither walked nor dug and
      // the door went from 44 to 50 blocks AWAY. Rock ahead with no route is a digging problem; air ahead is
      // a gap or a ledge and keeps the hop behaviour below (you do not dig air).
      const ahx = f.x + Math.sign(tx - f.x), ahz = f.z + Math.sign(tz - f.z);
      const rockAhead = [0, 1].every((oy) => { const b = bot.blockAt(new Vec3(ahx, f.y + oy, ahz)); return !!b && !isAir(b.name); });
      if (/Took to long|No path/i.test(legErr) && rockAhead && ++noRoute >= 2) {
        log.warn(`walk_to: ${noRoute} legs with no route and ROCK ahead at ${f.x},${f.y},${f.z}, ${Math.round(dist())} blocks still to go - cutting a corridor instead of counting strikes`);
        const tn = await reg.get('tunnel_to').run(bot, { x: tx, z: tz, tolerance: tol });
        return { ok: dist() <= tol, observation: `rock ahead with no route, so this crossed by corridor: ${String(tn && tn.observation || 'tunnel cut short').slice(0, 200)}` };
      }
      // No path around it, so cut through it - the way a miner walks to a known vein instead of
      // circling the hill. Two cells: chest height and underfoot, because a stair is often the only
      // way to keep the same level.
      const sx = Math.sign(tx - f.x), sz = Math.sign(tz - f.z);
      // Dig directly instead of mineBlockHere(): that helper calls equipPick(), which takes the
      // DIAMOND pick - the one the obsidian chain needs - to cut ordinary stone.
      await equipBulkPick(bot, true);
      // Air ahead is a gap or a ledge, and you do not dig air. At 21:02 the lake was 40 blocks away with
      // `ahead=air/air`, and all 7 strikes were spent trying to cut a cell that does not exist - that is
      // how a shoreline got reported as "blocked". Step across/down (pathfinder permits short falls),
      // then sidestep along the edge, and only count a strike if none of that moved us.
      const airCell = (oy) => { const b = bot.blockAt(new Vec3(f.x + sx, f.y + oy, f.z + sz)); return !b || isAir(b.name); };
      if (airCell(0) || airCell(1)) {
        for (const [ox, oz, oy] of [[sx, sz, -1], [sx, sz, -2], [sx, sz, 0], [sz, -sx, 0], [-sz, sx, 0], [sx, 0, -1], [0, sz, -1]]) {
          const gx2 = f.x + ox, gz2 = f.z + oz, gy2 = f.y + oy;
          let hop = false;
          try {
            await Promise.race([bot.pathfinder.goto(new (GN())(gx2, gy2, gz2, 0)),
              new Promise((_, rej) => setTimeout(() => rej(new Error('ledge hop')), 12000))]);
            hop = true;
          // No stop() on a rejected hop: the rejection means that goal is already dead, and a stop()
          // lands on the goal issued next (see the note in the leg handler) - which would poison the
          // very next hop attempt.
          } catch { /* the abandoned goto resolves on its own */ }
          if (hop && before - dist() >= 1) { blocked = 0; log.info(`walk_to: hopped the ledge to ${gx2},${gy2},${gz2} (${Math.round(dist())} left)`); break; }
        }
        if (before - dist() >= 1) continue;
        // The hop list only reaches two blocks down. At 18:10-18:12 the fill lake sat 52 blocks away and
        // 29 BELOW (the bot stood on a mesa at 113,91,807): every hop was refused, `blocked 7 legs short`
        // fired, and the code cooled the LAKE for 25 minutes for a fault standing under its own feet -
        // then walked 173 blocks to another station. A player walks off the edge, and the freefall guard
        // already grants slow_falling for exactly that (proven at 18:13:51 `freefall v.y=-0.84 at
        // (24,69,702) -> slow_falling`, the bot landed wet but alive).
        const down = f.y - Math.round((a && typeof a.y === 'number') ? a.y : f.y);
        if (down >= 6 && !wetCell(bot)) {
          log.info(`walk_to: target is ${down} blocks BELOW the shelf and hops stop at -2 - stepping off the edge instead of cooling a good station`);
          try { bot.setControlState('forward', true); await sleep(900); bot.setControlState('forward', false); } catch {}
          await sleep(800);
          if (before - dist() >= 1) {
            blocked = 0;
            log.info(`walk_to: stepped off the ledge to y=${Math.round(bot.entity.position.y)} (${Math.round(dist())} left)`);
            continue;
          }
          log.warn(`walk_to: stepping off the edge moved nothing (y=${Math.round(bot.entity.position.y)}, target ${down} below) - this really is a wall, count the strike`);
          // "count the strike" was a promise this line never kept, so the branch re-ran once per leg
          // forever: 22:06:55 -> 22:07:20 logged it twelve times in 25 s while the bot's y went 77 -> 86
          // (climbing AWAY from a target 67 blocks below) and the whole obsidian round burned on a
          // mountain. Three of these and the leg loop exits with its own honest verdict.
          blocked += 3;
        }
      }
      const front = bot.blockAt(new Vec3(f.x + sx, f.y + 1, f.z + sz));
      const floor = bot.blockAt(new Vec3(f.x + sx, f.y, f.z + sz));
      let cut = false;
      if (front && !isAir(front.name) && !/lava|water|bedrock/.test(front.name)) { try { await bot.dig(front); cut = true; } catch {} }
      if (!cut && floor && !isAir(floor.name) && !/lava|water|bedrock/.test(floor.name)) { try { await bot.dig(floor); cut = true; } catch {} }
      if (cut) { try { await bot.pathfinder.goto(new (GN())(f.x + sx, f.y, f.z + sz, 0)); } catch { /* no stop(): it lands on the next goal */ } blocked = 0; }
      else if (++blocked >= 7) {
        const wn = bot.blockAt(new Vec3(f.x + sx, f.y, f.z + sz));
        const wa = bot.blockAt(new Vec3(f.x + sx, f.y + 1, f.z + sz));
        return { ok: false, observation: `blocked ${blocked} legs short of ${tx},${a.y},${tz} (at ${f.x},${f.y},${f.z}, ${Math.round(dist())} away; ahead=${wn ? wn.name : 'NULL'}/${wa ? wa.name : 'NULL'}, last leg said "${legErr}") - report the terrain, do not blame the destination` };
      }
      else await sleep(600);
    }
    const near = Math.round(dist());
    // Horizontal-only distance would say "arrived" while the pool sits 118 blocks underfoot
    // (measured at 10:17:38), so report the vertical gap in the caller's own terms.
    const dy = Math.round((a.y ?? bot.entity.position.y) - bot.entity.position.y);
    const vert = dy <= -8 ? `${-dy} blocks BELOW me - dig down from here` : dy >= 8 ? `${dy} blocks above me` : 'same level';
    return { ok: near <= tol, observation: `walked ${legs} legs to ${near} blocks of ${tx},${a.y},${tz} (I am at y=${Math.round(bot.entity.position.y)}; target is ${vert})` };
  }
});

// A 219-block crossing at y=30 is not a routing problem, it is a digging problem. Live 21:10-21:22 the End
// door stood OPEN with the ring complete and the bot 219 blocks away inside the deepslate: every `walk_to`
// leg answered `Took to long to decide path to goal!` (A* spends its whole node budget on rock it cannot
// pass) or was cancelled by the no-progress path guard, and the ledge-hop fallback then ate the rest of the
// 240-second window on 12-second attempts into cells that do not exist. Twelve minutes, ONE block closed.
// This is the miner's answer: point at the bearing, cut a 2-high corridor, step, repeat. The only path ever
// asked for is the block in front of the nose, so progress cannot depend on a solver.
reg.define('tunnel_to', {
  desc: 'Cross long distance UNDERGROUND by cutting a 2-high corridor toward an absolute (x,z) instead of asking pathfinder to route through rock. Use when walk_to keeps answering "Took to long to decide path to goal!" or "No path to the goal" - that is what solid deepslate sounds like. Each call keeps digging from where the last corridor ended, so repeated calls stack into one continuous advance.',
  params: { x: 'int', z: 'int', tolerance: 'int default 8 - how close in (x,z) counts as arrived', max: 'int default 300 - blocks to cut before handing the step back' },
  budgetMs: 300000,
  async run(bot, a) {
    const tx = Math.round(a.x), tz = Math.round(a.z), tol = a.tolerance ?? 8;
    const cap = Math.max(4, Math.min(400, a.max || 300));
    const dist = () => Math.hypot(bot.entity.position.x - tx, bot.entity.position.z - tz);
    const cellAt = (f, ox, oy, oz) => { try { return bot.blockAt(new Vec3(f.x + ox, f.y + oy, f.z + oz)); } catch { return null; } };
    const rock = b => !!b && !isAir(b.name);
    const hot = b => !!b && /lava/.test(b.name);
    if (!(await equipBulkPick(bot))) {
      const pk = bot.inventory.items().filter(i => /_pickaxe$/.test(i.name)).map(i => i.name).join(',') || 'none';
      return { ok: false, observation: `tunnel_to cannot cut rock without a pickaxe (pack has ${pk}, held=${bot.heldItem ? bot.heldItem.name : 'empty'}) - ensure_tools, then call tunnel_to again` };
    }
    let cut = 0, steps = 0, stuck = 0, forced = 0, lastErr = '', why = 'loop budget used up';
    const moved = p0 => Math.abs(bot.entity.position.x - p0.x) + Math.abs(bot.entity.position.z - p0.z);
    for (let i = 0; i < cap && dist() > tol; i++) {
      // Every long loop tests the step deadline: withTimeout abandons the AWAIT, not this worker, and a
      // tunnel that keeps digging after its step expired collides with the next step's goto. Hand back
      // 20 s early so the hand is actually free when the next step starts.
      if (bot._stepDeadline && bot._stepDeadline - Date.now() < 20000) { why = 'step deadline (handing back so the next step can own the hand)'; break; }
      steps++;
      if (bot.health <= 6 || bot.food <= 4) {
        const p0 = bot.entity.position.floored();
        return { ok: false, observation: `EMERGENCY hp=${Math.round(bot.health * 10) / 10} food=${bot.food} at ${p0.x},${p0.y},${p0.z} after cutting ${cut} blocks (${Math.round(dist())} left to ${tx},${tz}) - the corridor is already open, so eat or heal and call tunnel_to again with the same x,z: walking back down it costs nothing` };
      }
      const f = bot.entity.position.floored();
      const dx = tx - f.x, dz = tz - f.z;
      // Two candidate headings: the dominant axis first, the other axis as the detour. `forced` is the
      // detour counter - a cell that will not break (bedrock, or a dig the server refused) sends the next
      // two steps down the other axis instead of hammering the same wall five times.
      const cand = Math.abs(dx) >= Math.abs(dz)
        ? [[Math.sign(dx), 0], [0, Math.sign(dz)]]
        : [[0, Math.sign(dz)], [Math.sign(dx), 0]];
      if (forced > 0) { forced--; cand.reverse(); }
      const pick = cand.find(([sx, sz]) => (sx || sz) && !hot(cellAt(f, sx, 0, sz)) && !hot(cellAt(f, sx, 1, sz)));
      if (!pick) {
        const p1 = bot.entity.position.floored();
        return { ok: false, observation: `tunnel_to stopped at ${p1.x},${p1.y},${p1.z} with LAVA in both candidate headings (${Math.round(dist())} blocks left to ${tx},${tz}) - do not open a corridor into a lava pocket: seal it (water bucket / place a block over it) or start the tunnel from a different column` };
      }
      const [sx, sz] = pick;
      for (const oy of [1, 0]) {
        const b = cellAt(f, sx, oy, sz);
        if (!rock(b)) continue;
        try { await equipBulkPick(bot); await bot.dig(b); cut++; } catch (e) { lastErr = `${b.name}: ${String((e && e.message) || e).slice(0, 60)}`; }
        if (rock(cellAt(f, sx, oy, sz))) lastErr = lastErr || `dig ${b.name} left the cell solid`;
      }
      // Step into the cell just cleared. A 1-block goto is the same call branch_mine has always used
      // inside its own tunnels, so it is proven in a corridor; the hand-walk is the fallback for a bot the
      // solver will not move (feet in water, a ledge it judges too far).
      const before = bot.entity.position.clone();
      try { await capped(bot.pathfinder.goto(new (GN())(f.x + sx, f.y, f.z + sz, 0)), 9000, 'tunnel step'); } catch { /* no stop(): it lands on the next goal */ }
      if (moved(before) < 0.5) {
        try {
          await bot.lookAt(new Vec3(f.x + sx, bot.entity.position.y + 1, f.z + sz));
          bot.setControlState('forward', true); await sleep(1100); bot.setControlState('forward', false);
        } catch { /* the measurement below is the verdict */ }
        await sleep(120);
      }
      if (moved(before) >= 0.5) {
        stuck = 0;
        if (steps % 10 === 0) { const p = bot.entity.position.floored(); log.info(`tunnel_to: ${cut} blocks cut, ${Math.round(dist())} left to ${tx},${tz} (now ${p.x},${p.y},${p.z})`); }
        continue;
      }
      // Nothing moved with the cells cleared. Name what is actually in front rather than counting a
      // phantom strike: an unbreakable wall and a pick that just broke look identical from here.
      stuck++;
      const wb = cellAt(f, sx, 0, sz), wa = cellAt(f, sx, 1, sz);
      if (wb && /bedrock/.test(wb.name)) { forced = 2; continue; }
      if (stuck >= 4) {
        const p = bot.entity.position.floored();
        why = `four steps in a row moved nothing at ${p.x},${p.y},${p.z} (ahead=${wb ? wb.name : 'NULL'}/${wa ? wa.name : 'NULL'}, last dig said "${lastErr}")`;
        break;
      }
      forced = 2;
    }
    const left = Math.round(dist());
    const p = bot.entity.position.floored();
    if (left <= tol) return { ok: true, observation: `tunnelled to within ${left} blocks of the column ${tx},${tz} (at ${p.x},${p.y},${p.z}, ${cut} blocks cut) - the target column is reached, now work the vertical gap` };
    return { ok: false, observation: `cut ${cut} blocks toward ${tx},${tz} and handed back ${left} blocks short at ${p.x},${p.y},${p.z} (${why}) - call tunnel_to with the SAME x,z again: the corridor is already dug, so this continues it instead of re-planning a route` };
  }
});

// The shaft-continuation step. Its only job is to spend the window going DOWN the column already on
// file, with none of find_diamonds' preamble - measured 20:57:58 -> 20:58:19, 21 s of a 59 s window went
// on pick-tier checks and craft attempts before a single dig. That is what lets a 70 s plan window
// STACK: ten of these in a row is one continuous descent, where ten find_diamonds calls were ten
// restarts that each deleted the previous depth.
// Who owns "the diamond pickaxe broke". The ladder's `diamond_pick` milestone closes on
// `countItem(diamond_pickaxe) >= 1` and stays sticky, so once the pick wears out nothing re-opens it:
// measured 02:56 -> 03:01, three different callers correctly reported `no diamond-tier pickaxe (have
// stone_pickaxe@64%, wooden_pickaxe@7%)` and the model answered each time by going to smelt MORE IRON -
// which cannot cut obsidian either. Obsidian drops only from a diamond/netherite pick, and that pick is
// 3 diamonds + 2 sticks at a crafting table, so the missing step has to be the whole chain, in order.
reg.define('ensure_diamond_pick', {
  desc: 'Get a diamond pickaxe into the hand: 3 diamonds (recorded shaft or remembered vein), sticks, a reachable table, craft, then verify the hand holds it. Obsidian and ancient debris need this tier - iron and stone drop nothing.',
  params: {},
  budgetMs: 600000,
  async run(bot) {
    const held = () => bot.inventory.items().find(i => i.name === 'diamond_pickaxe' || i.name === 'netherite_pickaxe');
    const p = held();
    if (p && ((p.maxDurability || 1) - (p.durabilityUsed || 0)) >= 20) {
      const ok = await equipPick(bot);
      return { ok: !!ok, observation: ok ? `the pack already holds ${p.name} and it is in hand` : `pack has ${p.name} but it will not come to the hand` };
    }
    if (countItem(bot, 'diamond') < 3) {
      const fd = await reg.get('find_diamonds').run(bot, { count: 3 });
      log.skill(`ensure_diamond_pick: find_diamonds -> (${String(fd.observation).slice(0, 170)})`);
    }
    if (countItem(bot, 'diamond') < 3) {
      return { ok: false, observation: `diamonds=${countItem(bot, 'diamond')} of the 3 a pickaxe needs and the vein/shaft run did not deliver (${String(fd.observation).slice(0, 120)}) - obsidian cannot be collected until this is solved, and NO number of iron picks will help` };
    }
    if (countItem(bot, 'stick') < 2) {
      const st = await reg.get('grid_craft').run(bot, { item: 'stick', count: 4 });
      log.skill(`ensure_diamond_pick: sticks -> (${String(st.observation).slice(0, 110)})`);
      if (countItem(bot, 'stick') < 2) {
        const ct = await reg.get('chop_trees').run(bot, {});
        log.skill(`ensure_diamond_pick: no sticks, wood run -> (${String(ct.observation).slice(0, 110)})`);
        const st2 = await reg.get('grid_craft').run(bot, { item: 'stick', count: 4 });
        if (countItem(bot, 'stick') < 2) return { ok: false, observation: `have 3 diamonds but only ${countItem(bot, 'stick')} sticks (need 2) - the wood chain is now the blocker: ${String(st2.observation).slice(0, 120)}` };
      }
    }
    const c = await craft(bot, 'diamond_pickaxe', 1);
    log.skill(`ensure_diamond_pick: craft diamond_pickaxe -> ${c.ok ? 'ok' : 'failed'} (${String(c.observation).slice(0, 130)})`);
    const after = held();
    if (!after) return { ok: false, observation: `had diamonds=${countItem(bot, 'diamond')} sticks=${countItem(bot, 'stick')} and the craft still produced no pickaxe: ${String(c.observation).slice(0, 150)}` };
    const inHand = await equipPick(bot);
    return { ok: !!inHand, observation: `diamond_pickaxe crafted (wear ${ob.wear(bot, after)}%); hand ${inHand ? 'holds it' : 'did NOT take it - callers must not dig on this answer'}` };
  },
});

reg.define('resume_shaft', {
  desc: 'Go back to the shaft on file (runs/shaft.json) and dig it deeper toward its target Y. Use this instead of opening a new column.',
  params: { max: 'int default 30' },
  budgetMs: 240000,
  async run(bot, a) {
    const r = shaftRecord.current();
    if (!r) return { ok: false, observation: 'no shaft on file - start one (find_diamonds or dig_to_y) and it gets recorded, then this continues it' };
    const toY = Number.isFinite(r.toY) ? r.toY : -53;
    const here = bot.entity.position.floored();
    if (r.y <= toY) return { ok: true, observation: `the shaft at ${r.x},${r.z} already reaches y=${r.y} (target ${toY}) - stop descending and MINE: find_diamonds scans from here` };
    if (!(await equipBulkPick(bot)) && !(await equipPick(bot))) {
      return { ok: false, observation: `no pickaxe to continue the shaft at ${r.x},${r.z} head y=${r.y} (holding ${bot.heldItem ? bot.heldItem.name : 'nothing'})` };
    }
    const horiz = Math.hypot(r.x - here.x, r.z - here.z);
    // Walking back to a recorded column is only worth it while the column is closer than a fresh shaft.
    // 02:57 the head sat at -17,784 while the bot was at 584,36,732 - 600 blocks of open ocean to cross,
    // and the same "the recovery move costs more than the problem" shape that already bit me twice with
    // recover_surface's teleport. Hand the round back and let a NEW column be sunk from where it stands.
    if (horiz > 6 && horiz > 180) {
      return { ok: false, observation: `the recorded shaft ${r.x},${r.z} (head y=${r.y}) is ${Math.round(horiz)} blocks away - further than digging a fresh column costs. Sink a new shaft here (dig_to_y / find_diamonds will file it), do not cross the map for the old one` };
    }
    if (horiz > 6) {
      const w = await reg.get('walk_to').run(bot, { x: r.x, y: Math.max(r.y, 60), z: r.z, tolerance: 4 });
      const off = Math.hypot(r.x - bot.entity.position.x, r.z - bot.entity.position.z);
      log.skill(`resume_shaft: walked back to the recorded column ${r.x},${r.z} (${Math.round(off)} off now, ${String(w.observation).slice(0, 110)})`);
      if (off > 12) {
        return { ok: false, observation: `cannot get back onto the shaft column ${r.x},${r.z} (${Math.round(off)} blocks off; it said: ${String(w.observation).slice(0, 90)}) - the head is on file, keep calling resume_shaft rather than sinking a parallel hole` };
      }
    }
    const y0 = Math.round(bot.entity.position.y);
    const ds = await reg.get('deep_shaft').run(bot, { toY, max: a.max ?? 30 });
    const y1 = Math.round(bot.entity.position.y);
    if (y1 < y0) {
      shaftRecord.note(bot, { toY });
    } else if (/FLOOD|WATER|LIQUID|bedrock|trap|STANDING IN/i.test(ds.observation || '')) {
      const g = shaftRecord.abandon(bot, ds.observation);
      log.warn(`SHAFT GIVEN BACK: abandoned ${g ? g.was : 'the unrecorded head'} on physical evidence (${String(ds.observation).slice(0, 80)}) - column ${g ? g.given : 1} discarded this run`);
    }
    return { ok: y1 <= toY, observation: `shaft ${r.x},${r.z}: y=${y0} -> ${Math.round(bot.entity.position.y)} (target ${toY}, ${Math.max(0, Math.round(bot.entity.position.y) - toY)} blocks to go) ${String(ds.observation).slice(0, 140)}` };
  },
});

// The bucket the pour depends on, re-made.
// Why this exists: 2026-10-31 01:22 -> 01:45, `obsidian_farm` warned
//   `no bucket in the pack - the site cannot be worked`   (71 times in 23 min)
// and every one of those warnings just returned false. Nothing in the ladder could go and MAKE a
// bucket, so the whole obsidian chain - pickaxe in hand, sites chosen, stations remembered - sat
// blocked on one 3-iron-ingot item. That is the pattern the user keeps asking me to kill: a detected
// stall with no capability attached to it. A player who loses the bucket mines iron and forges
// another one.
reg.define('ensure_bucket', {
  desc: 'Make sure the pack holds a bucket (crafting 3 iron ingots if it does not), then fill it from the nearest water source. Use when a pour reports "no bucket in the pack".',
  params: {},
  budgetMs: 300000,
  async run(bot) {
    const have = (n) => countItem(bot, n);
    if (have('water_bucket') > 0) return { ok: true, observation: 'the pack already holds a filled water bucket' };
    if (have('bucket') === 0) {
      let need = 3 - have('iron_ingot');
      if (need > 0 && have('raw_iron') >= need) {
        const sm = await reg.get('smelt').run(bot, { item: 'raw_iron', count: need });
        log.skill(`ensure_bucket: smelted raw_iron -> (${String(sm.observation).slice(0, 90)})`);
        need = 3 - have('iron_ingot');
      }
      if (need > 0) {
        const om = await reg.get('mine').run(bot, { names: ['iron_ore', 'deepslate_iron_ore'], count: need + 1 });
        log.skill(`ensure_bucket: mined iron for a bucket -> (${String(om.observation).slice(0, 110)})`);
        if (have('raw_iron') > 0) {
          const sm2 = await reg.get('smelt').run(bot, { item: 'raw_iron', count: need });
          log.skill(`ensure_bucket: smelted it -> (${String(sm2.observation).slice(0, 90)})`);
        }
      }
      if (have('raw_iron') === 0 && have('iron_ingot') < 3) {
        // The shallow mine returned nothing three times in a row (02:21:04, 02:23:33, 02:26:52 all say
        // `mined 0 of ["iron_ore","deepslate_iron_ore"]`) while the bot stood at y=49-64 - iron is
        // plentiful below the sea floor, and the run already owns a shaft down to y=-54. Digging where
        // the ore actually is beats re-asking the surface, so go to remembered ore first (cheapest),
        // then down the recorded column.
        const known = oreCache.nearest(['iron_ore', 'deepslate_iron_ore'], bot.entity.position);
        if (known && known.dist <= 300) {
          log.skill(`ensure_bucket: no iron in sight - walking to remembered ${known.name} at ${known.x},${known.y},${known.z} (${Math.round(known.dist)} away)`);
          try { await reg.get('walk_to').run(bot, { x: known.x, y: known.y, z: known.z, tolerance: 6 }); } catch {}
          const om2 = await reg.get('mine').run(bot, { names: ['iron_ore', 'deepslate_iron_ore'], count: need + 1, maxDistance: 24 });
          log.skill(`ensure_bucket: at the remembered vein -> (${String(om2.observation).slice(0, 110)})`);
        } else if (shaftRecord.current() && bot.entity.position.y > 0) {
          const sh = shaftRecord.current();
          log.skill(`ensure_bucket: no remembered iron near and no vein in sight - dropping down the recorded shaft column ${sh.x},${sh.z} (head y=${sh.y}) to look for ore`);
          try { await reg.get('walk_to').run(bot, { x: sh.x, y: Math.max(sh.y, 60), z: sh.z, tolerance: 6 }); } catch {}
          const dz = await reg.get('dig_to_y').run(bot, { toY: -12, max: 40 });
          log.skill(`ensure_bucket: descended to y=${Math.round(bot.entity.position.y)} (${String(dz.observation).slice(0, 90)})`);
          const om3 = await reg.get('mine').run(bot, { names: ['iron_ore', 'deepslate_iron_ore'], count: need + 1, maxDistance: 24 });
          log.skill(`ensure_bucket: mined at depth -> (${String(om3.observation).slice(0, 110)})`);
        }
      }
      if (have('raw_iron') > 0 && have('iron_ingot') < 3) {
        const sm3 = await reg.get('smelt').run(bot, { item: 'raw_iron', count: 3 - have('iron_ingot') });
        log.skill(`ensure_bucket: smelted the fresh raw iron -> (${String(sm3.observation).slice(0, 90)})`);
      }
      if (have('iron_ingot') < 3) {
        return { ok: false, observation: `cannot forge a bucket yet: iron_ingot=${have('iron_ingot')} raw_iron=${have('raw_iron')} of the 3 needed (looked at the surface, then the remembered vein and the recorded shaft column - obsidian cannot be poured without the bucket)` };
      }
      const c = await P.craft(bot, 'bucket', 1);
      log.skill(`ensure_bucket: craft bucket -> ${c.ok ? 'ok' : 'failed'} (${String(c.observation).slice(0, 110)})`);
      if (have('bucket') === 0 && have('water_bucket') === 0) return { ok: false, observation: `crafted a bucket and it is not in the pack (${c.observation})` };
    }
    // Empty bucket in hand: fill it from a real source, at the site first, then anywhere close.
    const fillFrom = async (radius) => {
      const bs = bot.inventory.items().find(i => i.name === 'bucket');
      if (!bs) return false;
      const cells = [];
      for (let d = 1; d <= radius; d++) {
        for (const [dx, dy, dz] of [[d, 0, 0], [-d, 0, 0], [0, 0, d], [0, 0, -d], [d, -1, 0], [-d, -1, 0], [0, -1, d], [0, -1, -d]]) {
          const p = bot.entity.position.floored().offset(dx, dy, dz);
          let b = null; try { b = bot.blockAt(p); } catch { continue; }
          if (b && b.name === 'water') cells.push({ p, src: isFluidSource(b) });
        }
        if (cells.some(c => c.src)) break;
      }
      if (!cells.length) return false;
      const src = cells.filter(c => c.src)[0];
      if (!src) { log.warn(`ensure_bucket: ${cells.length} water cell(s) near, none is a source - a bucket only fills from a source`); return false; }
      try { await bot.equip(bs, 'hand'); } catch {}
      try { await bot.lookAt(src.p.offset(0.5, 0.5, 0.5), true); } catch {}
      try { await bot.activateItem(); } catch {}
      await sleep(700);
      if (countItem(bot, 'water_bucket') > 0) { log.skill(`ensure_bucket: filled the bucket at ${src.p.x},${src.p.y},${src.p.z}`); return true; }
      log.warn(`ensure_bucket: aimed the bucket at ${src.p.x},${src.p.y},${src.p.z} and it stayed empty`);
      try { await equipPick(bot); } catch {}
      return false;
    };
    if (await fillFrom(6)) return { ok: true, observation: 'bucket made and filled - the site can be worked again' };
    const st = oreCache.nearest(['water'], bot.entity.position);
    if (st && st.dist <= 400) {
      log.skill(`ensure_bucket: no source within 6 - walking to remembered water at ${st.x},${st.y},${st.z} (${Math.round(st.dist)} away)`);
      try { await reg.get('walk_to').run(bot, { x: st.x, y: st.y, z: st.z, tolerance: 6 }); } catch {}
      if (await fillFrom(8)) return { ok: true, observation: `walked ${Math.round(st.dist)} blocks to a remembered water source and filled the bucket` };
    }
    // Scan loaded surface/nearby water up to 40 blocks (remembering it for future runs) and break covering ice in frozen biomes.
    try {
      const wPts = bot.findBlocks({ matching: blockIds(bot, ['water']), maxDistance: 40, count: 20 }) || [];
      const wCands = wPts.map(pt => bot.blockAt(pt))
        .filter(b => b && b.name === 'water' && isFluidSource(b))
        .sort((a, b) => {
          const ao = (() => { const ab = bot.blockAt(a.position.offset(0, 1, 0)); return !ab || isAir(ab.name) ? 0 : (ab.name === 'ice' ? 1 : 2); })();
          const bo = (() => { const ab = bot.blockAt(b.position.offset(0, 1, 0)); return !ab || isAir(ab.name) ? 0 : (ab.name === 'ice' ? 1 : 2); })();
          return ao - bo || bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position);
        })
        .slice(0, 4);
      for (const wc of wCands) {
        if (countItem(bot, 'water_bucket') > 0) break;
        if (bot.entity.position.distanceTo(wc.position) > 4) {
          try { await capped(bot.pathfinder.goto(new (GN())(wc.position.x, wc.position.y + 1, wc.position.z, 2)), 20000, 'ensure_bucket walk to water'); } catch {}
        }
        if (bot.entity.position.distanceTo(wc.position) > 4.5) continue;
        let tgt = wc;
        const cov = bot.blockAt(wc.position.offset(0, 1, 0));
        if (cov && cov.name === 'ice') {
          try { await equipBulkPick(bot, false); await bot.dig(cov); await sleep(250); } catch {}
          const th = bot.blockAt(cov.position);
          if (th && th.name === 'water' && isFluidSource(th)) tgt = th;
        }
        const bs = bot.inventory.items().find(i => i.name === 'bucket');
        if (!bs) break;
        try { await bot.equip(bs, 'hand'); } catch {}
        try { await bot.lookAt(tgt.position.offset(0.5, 0.5, 0.5), true); } catch {}
        try { await bot.activateItem(); } catch {}
        await sleep(800);
        if (countItem(bot, 'water_bucket') > 0) {
          if (tgt.position.y >= 56) { try { oreCache.remember('water', tgt.position.x, tgt.position.y, tgt.position.z); } catch {} }
          log.skill(`ensure_bucket: walked to and filled bucket at ${tgt.position.x},${tgt.position.y},${tgt.position.z}`);
          return { ok: true, observation: `filled water_bucket at ${tgt.position.x},${tgt.position.y},${tgt.position.z}` };
        }
      }
    } catch {}
    return { ok: false, observation: `the pack has a bucket but no water source in reach (searched 40 blocks and the remembered lake) - obsidian needs one filled bucket` };
  },
});

reg.define('find_diamonds', {
  desc: 'At diamond depth (~Y -53): scan loaded chunks for visible diamond ore, else branch-mine corridors and mine diamonds directly. Returns diamond count.',
  params: { count: 'int default 4', length: 'int default 22' },
  async run(bot, a) {
    // Diamonds do not generate in the Nether, and this skill owns a shaft record that belongs to the
    // Overworld. Called from `blaze_rods` at 07:18:39 it overwrote runs/shaft.json with the bot's Nether
    // position ({"x":-53,"z":209,"toY":-53}) and then spent every later round "resuming" a column that
    // cannot contain ore - and digging to the Nether floor is a lava/bedrock problem, not a diamond one.
    // Refuse BEFORE touching the record.
    if (bot.game && bot.game.dimension && bot.game.dimension !== 'overworld') {
      return { ok: false, observation: `diamonds do not generate in ${bot.game.dimension}, and the shaft record on file belongs to the Overworld - running here would only overwrite it with Nether coordinates. This rung needs a Nether fortress and blaze rods (search_nether_fortress), not a pickaxe.` };
    }
    const need = a.count ?? 4; const len = a.length ?? 22;
    log.info(`fd enter y=${Math.round(bot.entity.position.y)} haveDiamond=${countItem(bot, 'diamond')}`);
    if (!(await equipPick(bot))) {
      // Self-heal a missing pick deterministically before burning an LLM reflect cycle.
      if (reg.get('ensure_tools')) {
        try { await reg.get('ensure_tools').run(bot, {}); } catch {}
      }
    }
    if (!(await equipPick(bot))) {
      // A four-word dead end is unroutable: 07:45:34 `need pickaxe` in 2 ms told the stage lock
      // nothing, and its `vein` route then called this same function and got the same 2 ms answer -
      // a route that can never succeed. Name the pack state so both the dossier and the route choice
      // can tell "no pick exists" from "a pick exists but would not reach the hand".
      const pkNow = bot.inventory.items().filter(i => /_pickaxe$/.test(i.name))
        .map(i => `${i.name}@${i.maxDurability ? i.maxDurability - (i.durabilityUsed || 0) : '?'}digs`).join(',') || 'none';
      return { ok: false, observation: `need pickaxe (pack has ${pkNow}; held=${bot.heldItem ? bot.heldItem.name : 'empty'} y=${Math.round(bot.entity.position.y)})` };
    }
    // Diamonds need an IRON pick: a stone one breaks the block and drops NOTHING, which reads as
    // "there are no diamonds here" rather than "wrong tool" - §21's obsidian lesson in the other
    // function that digs. find_diamonds goes through mineBlockHere/equipPick, and equipPick sorts by
    // WEAR only, so a 97% stone pick outranks a 40% iron one. Require the tier the ore needs here,
    // while the pack still has ingots to pay for it.
    {
      const T = n => ({ wooden: 0, golden: 0, stone: 1, iron: 2, diamond: 3, netherite: 4 }[n.split('_')[0]] || 0);
      const digs = i => (i.maxDurability ? i.maxDurability - (i.durabilityUsed || 0) : 999);
      const picks = bot.inventory.items().filter(i => i.name.endsWith('_pickaxe'));
      // Tier AND uses left: the diamond pick died at 12:31 (2% = ~31 digs), and a mere `some(tier>=2)`
      // test passes on an iron pick with three digs left, which equipPick then refuses and quietly
      // falls back to a stone pick - and a stone pick on diamond ore reads as "no diamonds here".
      if (!picks.some(i => T(i.name) >= 2 && digs(i) >= 8)) {
        // The iron pick broke in the deepslate descent at ~13:06 and the pack is now stone-only.
        // Nothing else in the ladder will ever ask for iron again (iron_ore/iron_ingots/armor are all
        // closed and sticky), so this is the only place that can pay for the tier the ore needs:
        // mine the ore, smelt it, craft the pick. A stone pick on diamond ore looks like an empty vein.
        if (countItem(bot, 'iron_ingot') < 3) {
          // Only mine the ACTUAL deficit: with iron_ingot=2 and raw_iron=2 the pack already holds
          // 4 iron (enough for an iron pickaxe after a 10s smelt). Checking `raw_iron < 3` sent the
          // bot climbing caves for 180s to mine 4 more iron ore instead of smelting 1 raw_iron.
          const shortIron = 3 - countItem(bot, 'iron_ingot');
          if (countItem(bot, 'raw_iron') < shortIron) {
            // Ensure at least one healthy stone/iron pickaxe before tunneling to iron_ore, otherwise
            // mov.canDig stays false when all picks have <8 uses left (live 09:31:56 stuck 9.9m from iron).
            const hasMiningPick = bot.inventory.items().some(i => /^(stone|iron|diamond|netherite)_pickaxe$/.test(i.name)
              && ((i.maxDurability || 999) - (i.durabilityUsed || 0)) >= 12);
            if (!hasMiningPick && countItem(bot, 'cobblestone') + countItem(bot, 'cobbled_deepslate') >= 3 && countItem(bot, 'stick') >= 2) {
              try {
                const sp = await P.craft(bot, 'stone_pickaxe', 1);
                log.info(`fd: crafted fresh stone_pickaxe before mining iron (${String(sp && sp.observation || '').slice(0, 80)})`);
              } catch {}
            }
            const needOre = Math.max(2, shortIron - countItem(bot, 'raw_iron') + 1);
            const om = await reg.get('mine').run(bot, { names: ['iron_ore', 'deepslate_iron_ore'], count: needOre });
            log.info(`fd: mining iron for a pick (need ${needOre}) -> (${String(om.observation).slice(0, 120)})`);
          }
          if (countItem(bot, 'raw_iron') > 0 && countItem(bot, 'iron_ingot') < 3) {
            const sm = await reg.get('smelt').run(bot, { item: 'raw_iron', count: Math.min(countItem(bot, 'raw_iron'), Math.max(shortIron, 3)) });
            log.info(`fd: smelted raw_iron to pay for an iron pick -> (${String(sm.observation).slice(0, 100)})`);
          }
        }
        const c = await P.craft(bot, 'iron_pickaxe', 1);
        log.info(`fd: no iron+ pick (diamonds drop nothing on stone) -> craft iron_pickaxe: ${c.ok ? 'ok' : 'failed'} (${String(c.observation).slice(0, 90)})`);
        if (!c.ok) return { ok: false, observation: `diamond ore needs an iron pickaxe or better (stone drops nothing); have=[${picks.map(p => `${p.name}@${digs(p)}digs`).join(',')}] ingot=${countItem(bot, 'iron_ingot')} raw_iron=${countItem(bot, 'raw_iron')} and iron_pickaxe craft failed: ${c.observation}` };
      }
    }
    log.info(`fd post-equip y=${Math.round(bot.entity.position.y)} heapMB=${Math.round(process.memoryUsage().heapUsed / 1e6)}`);
    // A flooded column kills faster than any mob. Escaping here (and not only at the planner top)
    // matters: a running skill is never preempted, so the bot drowned twice inside this loop while
    // dry_escape sat one call away unused. After backfilling it walks off the dead column so the
    // next dive is a fresh one rather than the same aquifer.
    const escapeWater = async () => {
      if (!wetCell(bot)) return false;
      const before = bot.entity.position.floored();
      log.warn(`fd: in water at ${before.x},${before.y},${before.z} - escaping (backfill where possible, else dig out upward)`);
      try { await reg.get('dry_escape').run(bot, { max: 6 }); } catch (e) { log.warn('dry_escape threw:', e.message); }
      if (wetCell(bot)) { try { await reg.get('recover_surface').run(bot, {}); } catch {} }
      try { await reg.get('roam').run(bot, { distance: 70 }); } catch {}
      return true;
    };
    await escapeWater();
    // Depth already paid for outranks a fresh column. Without this the round fell through to the
    // relocate branch below, which surfaced the bot and walked it away - 25 rounds in a row on
    // 2026-10-30, each one deleting the descent the previous one had dug (a round that reached y=45
    // started the next at y=63). Continue the recorded shaft first; only a column that is dead on
    // evidence (flood/bedrock, handled by resume_shaft's abandon) gets replaced.
    {
      const r = shaftRecord.current();
      const rHoriz = r ? Math.hypot(r.x - bot.entity.position.x, r.z - bot.entity.position.z) : Infinity;
      if (r && rHoriz > 180) {
        const g = shaftRecord.abandon(bot, `recorded shaft is ${Math.round(rHoriz)} blocks away; sinking a fresh column here`);
        log.info(`fd: recorded shaft ${g.was} is ${Math.round(rHoriz)} blocks away - releasing it to sink a fresh column here`);
      } else if (r && bot.entity.position.y > -25 && (r.stall || 0) < 4) {
        log.info(`fd: shaft on file at ${r.x},${r.y},${r.z} (target ${r.toY}, stall=${r.stall || 0}) - continuing it instead of opening a column`);
        let lastRs = null;
        for (let rHop = 0; rHop < 4 && bot.entity.position.y > -25; rHop++) {
          if (bot._stepDeadline && Date.now() > bot._stepDeadline - 25000) break;
          const yPre = Math.round(bot.entity.position.y);
          const rs = await reg.get('resume_shaft').run(bot, { max: 35 });
          lastRs = rs;
          log.info(`fd: resume_shaft hop ${rHop + 1} (${String(rs.observation).slice(0, 200)})`);
          const yPost = Math.round(bot.entity.position.y);
          if (yPost <= -25 || rs.ok) break;
          if (!shaftRecord.current()) break; // abandoned due to water/bedrock -> fall through to fresh shaft
          if (yPost >= yPre - 1) break;
        }
        if (bot.entity.position.y > -25 && lastRs && !lastRs.ok && shaftRecord.current() && /no pickaxe|cannot get back/i.test(lastRs.observation || '')) {
          return lastRs;
        }
      } else if (r && (r.stall || 0) >= 4) {
        const g = shaftRecord.abandon(bot, `${r.stall} rounds with no new depth`);
        log.warn(`SHAFT GIVEN BACK: ${g.was} released after ${g.given} discards - ${r.stall} rounds spent at the same head, so this column is the problem, not the clock`);
      }
    }
    // A shaft dug from an ocean-floor column is a drowning lesson, not a mining lesson - see
    // relocateToHighGround. Only applies near the surface, so a dry cave at y=40 keeps its dig.
    if (bot.entity.position.y >= 60 && bot.entity.position.y < MIN_HIGH_Y) await relocateToHighGround(bot, 'fd');
    // If a vein is on file, start the shaft above IT. Diving at a random column and then scanning for
    // ore is how two remembered veins (24 min old at 13:43) stayed unreachable: the hop that uses them
    // only runs after the dive, and the dive kept picking wet coastal ground.
    {
      // Ranked, not nearest. The nearest remembered vein is on this coastal shelf almost every time,
      // and a shaft here meets an aquifer within ~20 blocks - the record shows the bounce repeating at
      // 07:49:34 (y=45, 71,62,89) and again at 08:16:44 (y=52, 60,52,96), each time costing the descent
      // that had already been paid. The flood list is the bot's own knowledge of which columns are wet,
      // so a vein sitting over one of them is deprioritised rather than chosen.
      const vcs = oreCache.list(['diamond_ore', 'deepslate_diamond_ore'], bot.entity.position);
      let vd = null;
      if (vcs.length) {
        const rankOf = (v) => Math.hypot(v.x - bot.entity.position.x, (v.y - bot.entity.position.y) * 1.6, v.z - bot.entity.position.z)
          + (nearFlood(bot, v.x, v.z, 16) ? 900 : 0);
        const best = vcs.slice().sort((a, b) => rankOf(a) - rankOf(b))[0];
        if (best !== vcs[0]) log.info(`fd: nearest remembered vein ${vcs[0].x},${vcs[0].y},${vcs[0].z} sits over a recorded flooded column - using ${best.x},${best.y},${best.z} instead`);
        vd = Object.assign({}, best, { dist: Math.round(Math.hypot(best.x - bot.entity.position.x, (best.y - bot.entity.position.y) * 1.6, best.z - bot.entity.position.z)) });
      }
      const horiz = vd ? Math.hypot(vd.x - bot.entity.position.x, vd.z - bot.entity.position.z) : Infinity;
      if (vd && vd.dist <= 320 && horiz > 14 && bot.entity.position.y > vd.y + 25) {
        log.info(`fd: remembered ${vd.name} at ${vd.x},${vd.y},${vd.z} (${Math.round(vd.dist)} away) - starting the shaft above it`);
        const w = await reg.get('walk_to').run(bot, { x: vd.x, y: bot.entity.position.y, z: vd.z, tolerance: 8 });
        log.info(`fd: vein-column hop (${String(w.observation).slice(0, 150)})`);
      }
    }
    // deep_shaft is incremental (max digs per call); diamonds only generate below y=16 and
    // mostly in deepslate under y=0, so descending once is never enough from the surface.
    for (let hop = 0, wetBounce = 0; hop < 6 && bot.entity.position.y > -40; hop++) {
      const yBefore = Math.round(bot.entity.position.y);
      log.info(`fd -> deep_shaft y=${yBefore}`);
      const ds = await reg.get('deep_shaft').run(bot, { toY: -53, max: 30 });
      await escapeWater();
      const yNow = Math.round(bot.entity.position.y);
      log.info(`fd <- deep_shaft y=${yNow} ${ds.observation}`);
      if (yNow < yBefore) wetBounce = 0;
      // Refusing to dig a trap column only helps if the bot then leaves the area; otherwise the
      // next hop starts at the same lip and drowns again.
      if (/FLOOD|LIQUID|WATER/i.test(ds.observation || '')) {
        // Two refusals in a row without a single dig means the loop is re-reading the same per-column
        // flood record, not making progress: at 21:48:35 it fired four times inside 7 ms and the round
        // ended having dug nothing. Bounce once to fresh ground, then hand the round back honestly.
        if (++wetBounce >= 3) { log.warn(`fd: ${wetBounce} flood bounces at y=${yNow} with no dig - leaving this area for the next round`); break; }
        log.warn('fd: column flagged as a water trap - digging out upward, then walking away');
        try { await reg.get('recover_surface').run(bot, {}); } catch (e) { log.warn('recover_surface threw:', e.message); }
        await relocateToHighGround(bot, 'fd');
        // A flood record is per-column, so the next dive has to be a DIFFERENT column.
        {
          const f = bot.entity.position.floored();
          const off = [[30, 10], [-24, -18], [12, -30], [-30, 24]][hop % 4];
          log.info(`fd: stepping to fresh ground ${f.x + off[0]},${f.z + off[1]} before the next dive`);
          try { await reg.get('walk_to').run(bot, { x: f.x + off[0], y: Math.max(f.y, 64), z: f.z + off[1], tolerance: 6 }); } catch {}
        }
        continue;
      }
      // two hopless rounds means we are pinned; stop burning 2 minutes on descent and let
      // the model see the reason
      if (yNow >= yBefore - 1 && !ds.ok) {
        const s2 = [{ x: 1, z: 0 }, { x: 0, z: 1 }, { x: -1, z: 0 }, { x: 0, z: -1 }][(hop + 1) % 4];
        bot._stair = s2;
        if (hop > 0) { log.warn(`deep_shaft pinned at y=${yNow}`); break; }
      }
    }
    if (bot.entity.position.y > -25) {
      // This exit used to run recover_surface + roam(200) UNCONDITIONALLY, so a round that had dug from
      // y=63 to y=45 was lifted back to the surface and walked away, and the next round started at the
      // top of a different column. Measured 2026-10-30: 25 of 25 rounds read `surfaced and relocated
      // ... y=6x` and the diamond count never left 1 - the recovery action WAS the plateau. The column
      // is now kept; only the stall gate at the top of this skill (4 rounds that ended above the own
      // head) is allowed to give it back, and it says so out loud.
      const before = bot.entity.position.floored();
      const r = shaftRecord.note(bot, { toY: -53 });
      log.warn(`SHAFT KEPT: round ended at y=${before.y} while the head is ${r.x},${r.y},${r.z} (stall ${r.stall || 0}/4, ${r.given || 0} columns discarded) - the pre-fix code surfaced and roamed 200 blocks right here`);
      return { ok: false, observation: `SHAFT OPEN at ${r.x},${r.z}: head y=${r.y}, target ${r.toY}, ${Math.max(0, Math.round(r.y - r.toY))} blocks of descent to go (round ${r.stall + 1} at this head). Diamonds need y<=-25 and this window ran out on the descent, not on the search - call resume_shaft to continue THIS column. Do not open a new shaft while one is on file.` };
    }
    const diamondIds = blockIds(bot, ['diamond_ore', 'deepslate_diamond_ore']);
    for (let attempt = 0; attempt < 3 && countItem(bot, 'diamond') < need; attempt++) {
      log.info(`find_diamonds attempt=${attempt} y=${Math.round(bot.entity.position.y)} heapMB=${Math.round(process.memoryUsage().heapUsed / 1e6)} ents=${Object.keys(bot.entities || {}).length} inv=${bot.inventory.items().length}`);
      let spots = [];
      try { spots = bot.findBlocks({ matching: diamondIds, maxDistance: 48, count: 6 }); } catch { spots = []; }
      if (spots.length) {
        // Remember the veins. A round that floods or times out otherwise loses every cell it had
        // itself reported, and the next round starts scanning blind (12:01: the pack held 2 diamonds
        // while the veins that produced them had been forgotten one round earlier).
        try { for (const p of spots) { const bb = bot.blockAt(p); if (bb) oreCache.remember(bb.name, p.x, p.y, p.z); } } catch {}
        // only mine ore that is actually exposed (has an adjacent air face) -> reachable
        const exposed = spots.map(p => bot.blockAt(p)).filter(b => b && /diamond_ore$/.test(b.name) &&
          [b.position.offset(1,0,0), b.position.offset(-1,0,0), b.position.offset(0,0,1), b.position.offset(0,0,-1), b.position.offset(0,1,0), b.position.offset(0,-1,0)].some(pp => { const nb = bot.blockAt(pp); return !nb || isAir(nb.name); }));
        if (exposed.length) { await mineBlockHere(bot, exposed[0]); continue; }
        // none exposed: dig toward the nearest one (it's nearby), then rescan next loop
        const p = spots[0]; { const g = await capped(bot.pathfinder.goto(new (GN())(p.x, p.y, p.z, 2)), 9000, 'fd approach vein'); /* no stop(): 23:40:39 shows it aborting the DIG that followed the timed-out approach */ }
        const front = bot.blockAt(new Vec3(p.x, bot.entity.position.y, p.z)); if (front) { try { await equipPick(bot); await bot.dig(front); } catch {} }
        continue;
      }
      // Nothing in sight here, but a previous round may have seen a vein: walk back to it instead of
      // tunnelling a new branch and hoping. (This is how the 2 diamonds already in the pack were found
      // at all - by eye, at y=-40, and then lost.)
      const known = oreCache.nearest(['diamond_ore', 'deepslate_diamond_ore'], bot.entity.position);
      if (known && known.dist <= 200) {
        log.info(`find_diamonds: no vein in sight at y=${Math.round(bot.entity.position.y)} - walking to remembered ${known.name} at ${known.x},${known.y},${known.z} (${Math.round(known.dist)} blocks)`);
        const w = await reg.get('walk_to').run(bot, { x: known.x, y: known.y, z: known.z, tolerance: 6 });
        log.info(`find_diamonds hop: ${w.observation}`);
        // Deliberately no oreCache.forget() here: `blocked` says the PATH failed, not that the vein is
        // gone - that is exactly the 2D-verification-of-3D-memory mistake that deleted the lava pools.
        continue;
      }
      const d = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }][attempt % 4];
      for (let i = 0; i < len && countItem(bot, 'diamond') < need && Date.now() < (bot._stepDeadline || Infinity); i++) {
        const f = bot.entity.position.floored().offset(d.x, 0, d.z);
        for (const hh of [1, 2]) { const b = bot.blockAt(f.offset(0, hh, 0)); if (b && /diamond_ore$/.test(b.name)) { await mineBlockHere(bot, b); break; } }
        for (const sx of [[d.z, d.x], [-d.z, -d.x]]) { for (const hh of [1, 2]) { const sb = bot.blockAt(bot.entity.position.floored().offset(sx[0], hh, sx[1])); if (sb && /diamond_ore$/.test(sb.name)) { await mineBlockHere(bot, sb); break; } } }
        const front = bot.blockAt(f.offset(0, 1, 0)); if (front) { try { await equipPick(bot); await bot.dig(front); } catch {} }
        const frontTop = bot.blockAt(f.offset(0, 2, 0)); if (frontTop) { try { await bot.dig(frontTop); } catch {} }
        // Capped: an abandoned goto keeps walking and cancels the next leg, and the hunt loop had no
        // deadline either - that is the 9 minutes of silence at 13:21-13:30 inside attempt=0.
        { const g = await capped(bot.pathfinder.goto(new (GN())(f.x, bot.entity.position.y, f.z, 0)), 9000, 'fd tunnel leg'); /* no stop(): it lands on the next goal, see the approach-vein note above */ }
      }
    }
    const have = countItem(bot, 'diamond');
    return { ok: have >= need, observation: `at Y=${Math.round(bot.entity.position.y)}; diamonds=${have} (need ${need})` };
  },
});
function oreDrop(n) {
  if (n.includes('diamond')) return 'diamond';
  if (n.includes('emerald')) return 'emerald';
  if (n.includes('lapis')) return 'lapis_lazuli';
  if (n.includes('redstone')) return 'redstone';
  if (n.includes('coal')) return 'coal';
  if (n.includes('iron')) return 'raw_iron';
  if (n.includes('gold')) return 'raw_gold';
  if (n.includes('copper')) return 'raw_copper';
  return n.replace(/_ore$/, '');
}
// Generalized branch miner: dig 2-high tunnels at current depth, collecting exposed target ore.
reg.define('branch_mine', {
  desc: 'Dig 2-high branch tunnels at the bot depth, collecting exposed `names` ore (iron/diamond/etc). Returns collected count.',
  params: { names: 'array of ore block names', count: 'int default 8', length: 'int default 22' },
  async run(bot, a) {
    const names = a.names || ['iron_ore', 'deepslate_iron_ore'];
    const need = a.count || 8; const len = a.length || 22;
    const results = [...new Set(names.map(oreDrop))];
    const countHave = () => results.reduce((s, n) => s + countItem(bot, n), 0);
    if (!(await equipPick(bot))) {
      // Self-heal a missing pick deterministically before burning an LLM reflect cycle.
      if (reg.get('ensure_tools')) {
        try { await reg.get('ensure_tools').run(bot, {}); } catch {}
      }
    }
    if (!(await equipPick(bot))) {
      // A four-word dead end is unroutable: 07:45:34 `need pickaxe` in 2 ms told the stage lock
      // nothing, and its `vein` route then called this same function and got the same 2 ms answer -
      // a route that can never succeed. Name the pack state so both the dossier and the route choice
      // can tell "no pick exists" from "a pick exists but would not reach the hand".
      const pkNow = bot.inventory.items().filter(i => /_pickaxe$/.test(i.name))
        .map(i => `${i.name}@${i.maxDurability ? i.maxDurability - (i.durabilityUsed || 0) : '?'}digs`).join(',') || 'none';
      return { ok: false, observation: `need pickaxe (pack has ${pkNow}; held=${bot.heldItem ? bot.heldItem.name : 'empty'} y=${Math.round(bot.entity.position.y)})` };
    }
    if (bot.food < 10 && bot.entity.position.y < 30 && bot.game && bot.game.dimension === 'overworld') {
      return { ok: false, observation: `FOOD LOW (${bot.food}) at y=${Math.round(bot.entity.position.y)} - no branch tunneling until it has eaten` };
    }
    const ids = blockIds(bot, names);
    // First: go straight for ore visible in loaded chunks (far more efficient than blind digging).
    try {
      const spots = bot.findBlocks({ matching: ids, maxDistance: 48, count: 16 });
      for (const p of spots) {
        if (countHave() >= need) break;
        const b = bot.blockAt(p);
        if (b && ids.includes(b.type)) await mineBlockHere(bot, b);
      }
    } catch {}
    let dug = 0;
    const dirs = [{ x: 1, z: 0 }, { x: -1, z: 0 }, { x: 0, z: 1 }, { x: 0, z: -1 }];
    for (const d of dirs) {
      if (countHave() >= need || Date.now() >= (bot._stepDeadline || Infinity)) break;
      for (let i = 0; i < len && countHave() < need && Date.now() < (bot._stepDeadline || Infinity); i++) {
        const f = bot.entity.position.floored().offset(d.x, 0, d.z);
        for (const hh of [1, 2]) { const b = bot.blockAt(f.offset(0, hh, 0)); if (b && ids.includes(b.type)) await mineBlockHere(bot, b); }
        for (const sx of [[d.z, d.x], [-d.z, -d.x]]) { for (const hh of [1, 2]) { const sb = bot.blockAt(bot.entity.position.floored().offset(sx[0], hh, sx[1])); if (sb && ids.includes(sb.type)) await mineBlockHere(bot, sb); } }
        const up = bot.blockAt(f.offset(0, 1, 0)); if (up && !isAir(up.name)) { try { await equipBulkPick(bot); await bot.dig(up); dug++; } catch {} }
        const up2 = bot.blockAt(f.offset(0, 2, 0)); if (up2 && !isAir(up2.name)) { try { await bot.dig(up2); } catch {} }
        // Capped: an abandoned goto keeps walking and cancels the next leg, and the hunt loop had no
        // deadline either - that is the 9 minutes of silence at 13:21-13:30 inside attempt=0.
        { const g = await capped(bot.pathfinder.goto(new (GN())(f.x, bot.entity.position.y, f.z, 0)), 9000, 'fd tunnel leg'); /* no stop(): it lands on the next goal, see the approach-vein note above */ }
      }
    }
    return { ok: countHave() >= need, observation: `dug ${dug}, have ${countHave()}/${need} (${results.join(',')})` };
  },
});
// Recover from being stuck deep (fell into a hole) by teleporting back to world-spawn surface.
// Uses OP; harmless if not OP. Lets the bot mine iron in the fast stone layer instead of slow deepslate.
// No-OP escape from a hole: dig upward through the ceiling and pillar up on blocks we already
// carry. This exists because recover_surface otherwise teleports (OP), which would quietly make the
// "assist-free" acceptance run not assist-free at all.
async function climbOut(bot, targetY) {
  const Vec3 = require('vec3');
  const goal = targetY || 62;
  // Paving material comes from the SAME test as every other builder: the item must resolve to a block in
  // the registry, and it must not be something worth more than a column. The old local filter was a name
  // deny-list that could not express either rule - `/food/` matches no 1.21 item name (`cooked_beef`), and
  // nothing in it matched `raw_iron`, so the biggest stack in the pack became the pillar. Measured
  // 02:42:52 `climbOut pillar: Server refused to place beef at (-753,80,1150)`; and when the biggest stack
  // IS raw iron the server does not refuse - it places `raw_iron_block`, which is the floating ore the
  // player saw hanging in the sky over the island, built one climb at a time out of armour iron.
  const stackable = () => P.cheapFill(bot, 2);
  let lastY = bot.entity.position.y, stalled = 0, blocked = 0;
  // Every long loop in this project has to test the step deadline: `withTimeout` cancels the AWAIT but
  // not this worker, and an abandoned climb that keeps placing blocks outrides the step that replaced it.
  let why = '200-round loop budget used up';
  for (let i = 0; i < 200 && bot.entity.position.y < goal && Date.now() < (bot._stepDeadline || Infinity); i++) {
    const f = bot.entity.position.floored();
    // Embedded? Dig the cell we are standing in first. A block placed into our own body (the
    // pillar case) leaves the player inside solid rock, and from then on every login is rejected
    // ~0.5 s later - nothing else in this loop can ever run again.
    const body = bot.blockAt(f);
    const headB = bot.blockAt(f.offset(0, 1, 0));
    for (const b of [body, headB]) {
      if (b && !isAir(b.name) && !/water|lava|bedrock/.test(b.name)) {
        try { await equipBulkPick(bot); await bot.dig(b); log.skill(`climbOut: dug out of our own cell ${b.name} at ${b.position.x},${b.position.y},${b.position.z}`); } catch (e) { log.skill(`climbOut self-dig: ${e.message}`); }
      }
    }
    // Dig with the PICKAXE. The old order dug while still holding the block it had placed last
    // iteration (deepslate with cobblestone in hand), which is why "climbing out" gained one block
    // per 33 s: the bot starved at y=-6 with food 4 while recover_surface ran for three minutes.
    if (!(await equipBulkPick(bot, false))) await equipPick(bot);
    for (const b of [bot.blockAt(f.offset(0, 1, 0)), bot.blockAt(f.offset(0, 2, 0))]) {
      if (b && !isAir(b.name) && !/water|lava|bedrock/.test(b.name)) {
        try { if (bot.pathfinder.isMoving()) bot.pathfinder.stop(); } catch {}
        try { await bot.dig(b); } catch (e) { log.skill(`climbOut dig ${b.name}: ${e.message}`); }
      }
    }
    await sleep(150);
    const headroom = bot.blockAt(f.offset(0, 1, 0));
    if (!headroom || !isAir(headroom.name)) {
      // no vertical room: staircase sideways-up instead of hammering the ceiling
      let moved = false;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cell = bot.blockAt(f.offset(dx, 1, dz));
        const floor = bot.blockAt(f.offset(dx, 0, dz));
        if (!cell || !isAir(cell.name) || !floor || isAir(floor.name) || /water|lava/.test(floor.name)) continue;
        try { await bot.dig(floor); } catch {}
        try { await bot.pathfinder.goto(new (GN())(f.x + dx, f.y + 1, f.z + dz, 1)); moved = true; } catch {}
        break;
      }
      if (!moved) await sleep(400);
      const y2 = bot.entity.position.y;
      if (y2 > lastY + 0.5) { lastY = y2; stalled = 0; }
      continue;
    }
    const blk = stackable();
    if (!blk) { why = 'no stackable block left in the pack'; break; }
    // Wait briefly to land if mid-jump before sampling underfoot; if overhanging an edge, step 1 block onto solid ground.
    for (let g = 0; g < 12 && bot.entity && !bot.entity.onGround; g++) await sleep(50);
    const fLand = bot.entity.position.floored();
    let below = bot.blockAt(fLand.offset(0, -1, 0));
    if (!below || isAir(below.name)) {
      let steppedSolid = false;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nf = bot.blockAt(fLand.offset(dx, -1, dz));
        const nFeet = bot.blockAt(fLand.offset(dx, 0, dz));
        const nHead = bot.blockAt(fLand.offset(dx, 1, dz));
        if (nf && !isAir(nf.name) && !/water|lava/.test(nf.name)
          && (!nFeet || isAir(nFeet.name)) && (!nHead || isAir(nHead.name))) {
          try { await capped(bot.pathfinder.goto(new (GN())(fLand.x + dx, fLand.y, fLand.z + dz, 0)), 4000, 'climbOut step solid'); steppedSolid = true; break; } catch {}
        }
      }
      below = bot.blockAt(bot.entity.position.floored().offset(0, -1, 0));
      if (!steppedSolid && (!below || isAir(below.name))) { why = `nothing solid under my feet to build on (reads ${below ? below.name : 'NULL'})`; break; }
    }
    // Pillar up through our own shaft. Two rules, each learned by breaking the run:
    // (1) measure the rise against the PRE-JUMP height - a player's own floored cell rises with it,
    //     so "fraction above my current cell" stays small and the placement was attempted far too
    //     early ("Server refused to place cobblestone ... the block is still air" x6 at y=7);
    // (2) never place while we are still inside the target cell: that builds a block around the
    //     body, and an embedded player is rejected on every subsequent login - the wedge that cost
    //     two worlds. If the jump did not clear the cell, claw a step into the wall instead, which
    //     needs no jump/place timing at all.
    const target = below.position.plus(new Vec3(0, 1, 0));
    const stillInside = (p) => {
      const live = bot.entity.position;
      return Math.floor(live.x) === p.x && Math.floor(live.z) === p.z
        && Math.floor(live.y) <= p.y && Math.floor(live.y + 1.75) >= p.y;
    };
    let placedCell = false;
    try {
      await bot.equip(blk, 'hand');
      if (!bot.heldItem || bot.heldItem.name !== blk.name) {
        const onBar = (bot.inventory.slots || []).slice(36, 45).find(it => it && it.name === blk.name);
        if (onBar) { try { await bot.setQuickBarSlot(onBar.slot - 36); } catch {} }
      }
      if (!bot.heldItem || bot.heldItem.name !== blk.name) {
        log.skill(`climbOut: equip ${blk.name} did not land in hand (held=${bot.heldItem ? bot.heldItem.name : 'empty'}) - skipping jump-place`);
      } else {
        const y0 = bot.entity.position.y;
        bot.setControlState('jump', true);
        // Poll every 25ms (was 80ms) so we catch the ~150ms jump apex cleanly above y0 + 1.02 before
        // falling back into the target cell's hitbox on Paper 1.21.1.
        for (let w = 0; w < 28 && (bot.entity.position.y < y0 + 1.02 || stillInside(target)); w++) await sleep(25);
        if (stillInside(target)) {
          log.skill(`climbOut: jump did not clear ${target.x},${target.y},${target.z} (y=${bot.entity.position.y.toFixed(2)}, physicsEnabled=${bot.physicsEnabled})`);
        } else {
          await bot.placeBlock(below, new Vec3(0, 1, 0));
          placedCell = true;
        }
        await sleep(180);
        bot.setControlState('jump', false);
      }
    } catch (e) {
      bot.setControlState('jump', false);
      log.skill(`climbOut pillar: ${e.message}`);
      // 20:04:05 现场：`Server refused to place cobblestone at (1, 61, -12): the block is still air` 之后连
      // 三段 0 长进，塔永远起不来，龙血因此冻结在 173.444。背包放置既要邻接面、又要和跳跃时序对上，而
      // /setblock 两样都不问（罩子的最后一格早就用同一条办法补过）。仍然只在【人已经离开这一格】时放：
      // 把自己埋进方块那笔债已经付过两个世界。
      if (process.env.MC_ASSIST !== '0' && (bot._opPillarCells || 0) < 150 && !stillInside(target)) {
        try { bot.chat(`/setblock ${target.x} ${target.y} ${target.z} minecraft:cobblestone`); } catch {}
        await sleep(650);
        let landed = null;
        try { landed = bot.blockAt(target); } catch {}
        if (landed && landed.boundingBox === 'block') {
          bot._opPillarCells = (bot._opPillarCells || 0) + 1;
          if (bot._opPillarCells === 1 || bot._opPillarCells % 10 === 0) log.warn(`climbOut: /setblock cobblestone at ${target.x},${target.y},${target.z} (disclosed, ${bot._opPillarCells} cell(s) this dive) - the pack placement was refused`);
          placedCell = true;
        }
      }
    }
    if (placedCell) blocked = 0;
    else if (++blocked >= 2) {
      blocked = 0;
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const stand = bot.blockAt(f.offset(dx, 0, dz));
        // A staircase step up to (f.x+dx, f.y+1, f.z+dz) requires a SOLID support block at (dx,0,dz)
        // (previously checked `isAir(stand.name)`, stepping off ledges into pits instead of climbing solid rock!).
        if (!stand || isAir(stand.name) || /water|lava/.test(stand.name)) continue;
        const step = bot.blockAt(f.offset(dx, 1, dz));
        const stepHead = bot.blockAt(f.offset(dx, 2, dz));
        if ((step && /water|lava|bedrock/.test(step.name)) || (stepHead && /water|lava|bedrock/.test(stepHead.name))) continue;
        try { if (!(await equipBulkPick(bot, false))) await equipPick(bot); } catch {}
        if (step && !isAir(step.name)) { try { await bot.dig(step); } catch {} }
        if (stepHead && !isAir(stepHead.name)) { try { await bot.dig(stepHead); } catch {} }
        try { await capped(bot.pathfinder.goto(new (GN())(f.x + dx, f.y + 1, f.z + dz, 0)), 5000, 'climbOut stair step'); break; } catch {}
      }
      await sleep(250);
    }
    const y = bot.entity.position.y;
    if (y > lastY + 0.5) { lastY = y; stalled = 0; }
    else if (++stalled >= 6) { why = `6 rounds with no height gain`; log.warn(`climbOut stalled at y=${Math.round(y)} after 6 rounds with no height gain`); break; }
  }
  const y = Math.round(bot.entity.position.y);
  // The two exits that are not a `break` still need a reason, or the verdict reads a stale one.
  if (bot.entity.position.y >= goal) why = 'reached the target height';
  else if (Date.now() >= (bot._stepDeadline || Infinity)) why = 'the step deadline - this climb was abandoned mid-way';
  return { ok: y >= goal - 1, observation: `climbed (no OP) to y=${y}, blocks left=${(stackable() || {}).count || 0} - stopped: ${why}` };
}

// Escape a waterlogged shaft WITHOUT commands, and without pathfinder or control-state movement
// (both of which send self-computed packets the server rejects while we are in water - see the
// physics guard in bot.js). A player in this spot bails or backfills the column and stands on it:
// we place a carried solid block into the water cell we occupy (replaceable target, so the server
// accepts it) which pushes us up one cell, and repeat until feet and head are dry.
// The answer to "wet at sea level" is usually not stone underfoot but rock already above the water a
// few blocks away. The scan lives in primitives.nearestHeadland now (roam's island verdict needs the
// same answer); this is the alias the dry_escape branch reads.
const nearestHeadland = (bot) => P.nearestHeadland(bot);

reg.define('dry_escape', {
  desc: 'Get out of a flooded shaft/column by backfilling the water we stand in with carried stone. No commands, no swimming.',
  params: { max: 'int default 40' },
  async run(bot, a) {
    const max = a.max ?? 40;
    const wetAt = (p) => { const b = bot.blockAt(p); return !!b && b.name.includes('water'); };
    const solid = (b) => !!b && b.boundingBox === 'block';
    const filler = () => bot.inventory.items()
      // 必须带结尾锚：原来写成 `^(...|stone|...)` 没有 `$`，`stone_sword`/`stone_pickaxe` 都匹配上了"石头"
      // (16:0x 现场 `Server refused to place stone_sword at (-14, 61, -15)`)——拿着剑往水里放方块，永远放不下去。
      .filter(i => /^(cobblestone|cobbled_deepslate|stone|smooth_stone|stone_bricks|mossy_stone_bricks|cracked_stone_bricks|cobblestone_wall|dirt|gravel|andesite|diorite|granite|tuff|blackstone|netherrack|dripstone_block|mossy_cobblestone|end_stone|deepslate|basalt|sand)$/.test(i.name))
      .sort((x, y) => y.count - x.count)[0];
    const isWet = bot.blockAt(bot.entity.position.floored());
    if (!(wetAt(bot.entity.position.floored()) || wetAt(bot.entity.position.floored().offset(0, 1, 0))))
      return { ok: true, observation: `not in water (standing on ${isWet ? isWet.name : 'unknown'}) - nothing to escape` };
    // Legit player-first escape (works identically under MC_ASSIST=0): before trying to place a
    // block into our own water cell (which Paper refuses) or jump-pillaring underwater (which stalls
    // at y=.75), walk or swim straight onto the nearest dry standable ledge within 12 blocks!
    try {
      const f0 = bot.entity.position.floored();
      const scanNear = findStandable(bot, f0, 12, 5);
      const cand = scanNear && scanNear.cell;
      if (cand && cand.p) {
        const tgt = cand.p;
        log.skill(`dry_escape: dry ledge ${cand.d}m away at ${tgt.x},${tgt.y},${tgt.z} - walking/swimming out first`);
        try {
          await capped(bot.pathfinder.goto(new (GN())(tgt.x, tgt.y, tgt.z, 0)), 7000, 'dry_escape goto dry');
        } catch {}
        let nowF = bot.entity.position.floored();
        if (wetAt(nowF) || wetAt(nowF.offset(0, 1, 0))) {
          // Pathfinder can stall against a 1-block stream lip; swim/hop directly onto the dry block.
          try {
            await bot.lookAt(new Vec3(tgt.x + 0.5, tgt.y + 1.0, tgt.z + 0.5), true);
            bot.setControlState('forward', true);
            bot.setControlState('jump', true);
            await sleep(2200);
          } catch {} finally {
            try { bot.setControlState('forward', false); bot.setControlState('jump', false); } catch {}
          }
          nowF = bot.entity.position.floored();
        }
        if (!wetAt(nowF) && !wetAt(nowF.offset(0, 1, 0))) {
          bot._wetStrikes = null;
          bot._wetClimbs = {};
          bot._wet = false;
          return { ok: true, observation: `walked/swam out of water onto dry cell ${nowF.x},${nowF.y},${nowF.z} (was ${f0.x},${f0.y},${f0.z})` };
        }
      }
      // If no close ledge succeeded (or in a deeper cavern pool), swim upward toward open air/wider shore.
      const scanWide = cand ? scanNear : findStandable(bot, f0, 20, 8);
      const wideDry = scanWide && scanWide.cell && scanWide.cell.p;
      if (wideDry) {
        try {
          await bot.lookAt(new Vec3(wideDry.x + 0.5, wideDry.y + 1.2, wideDry.z + 0.5), true);
          bot.setControlState('forward', true);
          bot.setControlState('jump', true);
          await sleep(2000);
        } catch {} finally {
          try { bot.setControlState('forward', false); bot.setControlState('jump', false); } catch {}
        }
        const nowF = bot.entity.position.floored();
        if (!wetAt(nowF) && !wetAt(nowF.offset(0, 1, 0))) {
          bot._wetStrikes = null;
          bot._wetClimbs = {};
          bot._wet = false;
          return { ok: true, observation: `swam out of water onto dry cell ${nowF.x},${nowF.y},${nowF.z}` };
        }
      }
    } catch (e) {
      log.warn('dry_escape dry-ledge walk threw:', String(e && e.message || e).slice(0, 80));
    }
    let placed = 0, noRef = 0, fail = 0, handedOff = false;
    for (let i = 0; i < max; i++) {
      const f = bot.entity.position.floored();
      const inWater = wetAt(f) || wetAt(f.offset(0, 1, 0));
      const floor = bot.blockAt(f.offset(0, -1, 0));
      if (!inWater && solid(floor)) {
        bot._wetStrikes = null;   // 落地干了就把"同格连拒"的账清掉，下次进水重新计数
        return { ok: true, observation: `dry at y=${f.y} (${floor.name} underfoot) after filling ${placed} water cell(s)` };
      }
      const blk = filler();
      if (!blk) return { ok: false, observation: `still wet at y=${f.y}, no filler blocks left (placed ${placed})` };
      // The cell we fill must touch a real block: prefer the floor beneath us, else a shaft wall.
      let ref = null, face = null;
      if (solid(floor)) { ref = floor; face = new Vec3(0, 1, 0); }
      else {
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const w = bot.blockAt(f.offset(dx, 0, dz));
          if (solid(w)) { ref = w; face = new Vec3(-dx, 0, -dz); break; }
        }
        if (!ref) for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const w = bot.blockAt(f.offset(dx, -1, dz));
          if (solid(w)) { ref = w; face = new Vec3(-dx, 0, -dz); break; }
        }
      }
      if (!ref) {
        // A fully open water body (lake/ocean) is not a shaft: filling it is pointless. Report so
        // the caller roams to dry ground instead of quietly spending the whole stack.
        if (++noRef >= 3) return { ok: false, observation: `wet at ${f.x},${f.y},${f.z} with no block nearby to place against - needs a swim/roam, not a backfill` };
        await sleep(600); continue;
      }
      try { await bot.equip(blk, 'hand'); } catch {}
      if (!bot.heldItem || bot.heldItem.name !== blk.name) {
        // The 1.21 `set_slot` ack is what usually fails here, but a filler that is ALREADY on the hotbar
        // does not need a window transaction at all - only the selected slot has to move. Measured at
        // 17:47:10 in the portal-room water column at -211,7,1507: `hand keeps wooden_pickaxe` three times
        // and `dry_escape` gave up on a pack full of cobblestone, because this path had no hotbar fallback
        // while the diamond-pick paths (2444, 3076) do.
        const onBar = (bot.inventory.slots || []).slice(36, 45).find(it => it && it.name === blk.name);
        if (onBar) { try { await bot.setQuickBarSlot(onBar.slot - 36); } catch {} }
      }
      // Verify the hand before spending a placement on it. 20:03:32:
      // `dry_escape place failed: Server refused to place diamond_pickaxe at (95,60,475): the block is
      // still water` - the equip silently kept the pickaxe (the 1.21 `set_slot` ack problem again), so
      // right-clicking swung a tool instead of placing a block, and the refusal text was about a pickaxe.
      // Naming it here turns three wasted attempts into one honest line.
      if (!bot.heldItem || bot.heldItem.name !== blk.name) {
        log.warn(`dry_escape: hand holds ${bot.heldItem ? bot.heldItem.name : 'nothing'}, not ${blk.name} - the equip never landed, dropping this cell instead of swinging a tool`);
        if (++fail >= 3) return { ok: false, observation: `the pack's filler (${blk.name}) never comes to hand - hand keeps ${bot.heldItem ? bot.heldItem.name : 'empty'}, so backfilling is impossible here (equip acks are not landing)` };
        await sleep(350);
        continue;
      }
      try {
        await bot.placeBlock(ref, face);
        placed++;
        fail = 0;
        log.skill(`dry_escape filled water at ${f.x},${f.y},${f.z} (total ${placed}, ${blk.name} left ${blk.count - 1})`);
      } catch (e) {
        // The server refuses to place a block into the cell the player is standing in, so filling
        // our own column is impossible in a 1-wide shaft - the escape there is swimming, not stone.
        if (++fail >= 3) {
          // DEEP water is a third shape, and it was the loop that drowned the run 16 times on
          // 2026-10-30 (`ABORTED mid-step: out of air (oxygen=2) in phase "step:obsidian"`, last at
          // 16:54): the bot stands in the submerged pool at (112,10,772), every fill is refused, and the
          // old answer was "needs a swim out" - at y=10 inside a lava cavern, swimming out is exactly
          // what it cannot do. Hand the move to recover_surface, which digs/climbs (or, on the assisted
          // instance, lands it on dry ground), instead of re-drowning in place.
          // DEEP water is a third shape. My first fix for it was WRONG and the log caught me: at
          // 17:10:41 the hand-off to `recover_surface` teleported the bot from (150,62,517) to the
          // remembered dry land at (199,67,343) - ~430 blocks AWAY from the site it was crossing to -
          // which is the same fault §26dd recorded for `arrive()`. So the deep branch now climbs with the
          // blocks it carries (`climbOut`, local, no teleport) and reports the distance it moved, so a
          // future regression of this kind is visible in one line instead of costing an hour.
          // 跨调用也要记账：外层 watchdog 每 ~2.7 秒重新调用 dry_escape，`fail` 每次都从 0 开始，所以
          // 3 次上限永远到不了那个补救分支 —— 16:08-16:35 它在末地 (-14,61,-15) 泡了 76 分钟、氧气掉到 3，
          // 就是靠这个循环活活淹死的。按"同一格连续失败次数"记账，与调用次数无关。
          const cellKey = `${f.x},${f.y},${f.z}`;
          bot._wetStrikes = (bot._wetStrikes && bot._wetStrikes.cell === cellKey)
            ? { cell: cellKey, n: bot._wetStrikes.n + 1 } : { cell: cellKey, n: 1 };
          const stuckSameCell = bot._wetStrikes.n >= 3;
          // 原来的补救只在 y<58 才生效（那是 Overworld 熔岩海下面的形状），末地岛面本身就在 y=60-67，
          // 所以末地泡水永远走不到补救分支。改成：末地、或已经同一格连拒 3 次，就本地爬出去（climbOut 不带
          // 传送，保留 §26dd 那条"不许把 actor 搬到地图另一头"的教训）。
          if ((f.y < 58 || stuckSameCell || inEnd(bot)) && !handedOff) {
            handedOff = true;
            const before0 = bot.entity.position.floored();
            // 跨调用记账：单次调用只会失败 2 次就 return，所以 `fail >= 3` 那道门永远开不了
            // （17:55 现场每 22 秒一轮：外层 search walk 超时 -> 我们 climbOut -> 外层重新发 goto 把我们
            // 取消 -> 又超时）。按"同一格被爬过几次"记，第二次起先试 /tp 横移 —— 横移不碰 pathfinder，
            // 任何一方的 goto 都取消不了它，正好破掉这个互杀。
            bot._wetClimbs = bot._wetClimbs || {};
            const ck = `${before0.x},${before0.y},${before0.z}`;
            const nClimbs = (bot._wetClimbs[ck] = (bot._wetClimbs[ck] || 0) + 1);
            if (nClimbs >= 2 && process.env.MC_ASSIST !== '0') {
              for (const [sx, sz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [3, 0], [0, 3], [2, 2]]) {
                const nx = before0.x + sx, nz = before0.z + sz;
                const under = bot.blockAt(new Vec3(nx, before0.y - 1, nz));
                if (!solid(under)) continue;
                if (wetAt(new Vec3(nx, before0.y, nz)) || wetAt(new Vec3(nx, before0.y + 1, nz))) continue;
                try { bot.chat(`/tp @s ${nx + 0.5} ${before0.y} ${nz + 0.5}`); } catch { break; }
                await sleep(1500);
                const nf = bot.entity.position.floored();
                if (!wetAt(new Vec3(nf.x, nf.y, nf.z)) && !wetAt(new Vec3(nf.x, nf.y + 1, nf.z))) {
                  bot._wetStrikes = null; bot._wetClimbs = {};
                  log.warn(`dry_escape: OP SIDE-STEP (disclosed) - stepped out of ${ck} onto dry ${nf.x},${nf.y},${nf.z} after ${nClimbs} climbs that got cancelled (a /tp cannot be cancelled by anyone's goto)`);
                  return { ok: true, observation: `side-stepped out of water at ${ck} to ${nf.x},${nf.y},${nf.z}` };
                }
              }
              log.warn(`dry_escape: no dry neighbour of ${ck} in 9 candidate cells - climbing anyway`);
            }
            const before = bot.entity.position.floored();
            log.warn(`dry_escape: submerged at y=${before.y} with no placeable face -> climbOut (deliberately not recover_surface, whose remembered dry land is a teleport across the map)`);
            try { await climbOut(bot, Math.max(62, before.y + 8)); } catch (e) { log.warn(`dry_escape: climbOut threw ${String(e.message).slice(0, 50)}`); }
            const af = bot.entity.position.floored();
            let dryNow = !wetAt(new Vec3(af.x, af.y, af.z)) && !wetAt(new Vec3(af.x, af.y + 1, af.z));
            // 16:41:41-16:41:44 现场：补救分支终于跑了，但 climbOut 在水里也做不了事（要爬就得往自己脚下
            // 放方块，而那一格正是它站着的），于是位置一动不动，氧气又掉到 3。最后一档不是"爬"而是"横向挪
            // 一两格"：末地这滩水通常是它自己给末影人泼的一格源，旁边就是干的岛面。
            if (!dryNow && process.env.MC_ASSIST !== '0') {
              for (const [sx, sz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [3, 0], [0, 3]]) {
                const nx = af.x + sx, nz = af.z + sz;
                const under = bot.blockAt(new Vec3(nx, af.y - 1, nz));
                if (!solid(under)) continue;
                if (wetAt(new Vec3(nx, af.y, nz)) || wetAt(new Vec3(nx, af.y + 1, nz))) continue;
                try { bot.chat(`/tp @s ${nx + 0.5} ${af.y} ${nz + 0.5}`); } catch { break; }
                await sleep(1500);
                const nf = bot.entity.position.floored();
                if (!wetAt(new Vec3(nf.x, nf.y, nf.z)) && !wetAt(new Vec3(nf.x, nf.y + 1, nf.z))) {
                  bot._wetStrikes = null;
                  log.warn(`dry_escape: OP SIDE-STEP (disclosed) - stepped out of the water cell ${af.x},${af.y},${af.z} onto dry ${nf.x},${nf.y},${nf.z} (climbOut cannot place a block into the cell the bot stands in)`);
                  dryNow = true;
                  break;
                }
              }
            }
            return {
              ok: dryNow,
              observation: `submerged at ${before.x},${before.y},${before.z} with no placeable face -> climbed to y=${af.y} (${dryNow ? 'DRY' : 'still wet'}), lateral move ${Math.round(Math.hypot(af.x - before.x, af.z - before.z))} blocks, no teleport`,
            };
          }
          // Two shapes look identical from here and need opposite answers. A flooded SHAFT has solid
          // walls all the way up and backfilling works; an ocean headland is one deep over rock and
          // every cell worth standing on is submerged, so the only move is to walk to the rock whose
          // top is already above the waterline. 09:17 on 2026-10-30 proved the second shape: three
          // refusals of `the block is still water` at (117,61,22) while (117,62,22) sat dry 3 blocks away.
          const land = nearestHeadland(bot);
          if (f.y >= 58 && f.y <= 66) {
            return { ok: !!land, observation: land
              ? `filling the sea is refused at ${f.x},${f.y},${f.z} (${fail}x ${String(e.message).slice(0, 50)}) - dry standing rock at ${land.x},${land.y},${land.z} (${land.d} blocks): walk there, do not backfill`
              : `filling the sea is refused at ${f.x},${f.y},${f.z} (${String(e.message).slice(0, 50)}) and no rock with its top above y=62 within 24 blocks - this needs a swim or a causeway, not stone underfoot` };
          }
          return { ok: false, observation: `cannot place into our own water cell at ${f.x},${f.y},${f.z} (${e.message}) - needs a swim out, not a backfill` };
        }
        log.skill(`dry_escape place failed: ${e.message}`);
      }
      await sleep(350);
    }
    const fy = Math.round(bot.entity.position.y);
    return { ok: !wetAt(bot.entity.position.floored()) && !wetAt(bot.entity.position.floored().offset(0, 1, 0)), observation: `gave up at y=${fy} after ${placed} placements` };
  },
});

// A cell the bot could physically occupy: solid non-fluid floor, and both body cells free of rock and of
// fluid. Written as a bounded blockAt scan rather than findBlocks - the lesson of §29v is that a scan over
// the loaded chunk map is a synchronous cost, and a few thousand dictionary lookups is not one.
function findStandable(bot, from, maxR, maxUp) {
  const cands = [];
  let seen = 0;
  const hi = maxUp || 20;
  for (let dy = -4; dy <= hi; dy++) {
    for (let dx = -maxR; dx <= maxR; dx++) {
      for (let dz = -maxR; dz <= maxR; dz++) {
        const p = from.offset(dx, dy, dz);
        const feet = bot.blockAt(p);
        const head = bot.blockAt(p.offset(0, 1, 0));
        const floor = bot.blockAt(p.offset(0, -1, 0));
        if (!feet || !head || !floor) continue;
        seen++;
        if (/lava|water/.test(feet.name) || /lava|water/.test(head.name) || /lava|water/.test(floor.name)) continue;
        if (feet.boundingBox === 'block' || head.boundingBox === 'block') continue;
        if (floor.boundingBox !== 'block') continue;
        cands.push({ p: new Vec3(p.x, p.y, p.z), d: Math.abs(dx) + Math.abs(dy) + Math.abs(dz) });
      }
    }
  }
  cands.sort((a, b) => a.d - b.d);
  // `seen` is the honesty guard: an empty chunk map (nothing loaded) would otherwise read as "sealed" and
  // hand an unloaded world to an OP teleport.
  return { cell: cands[0] || null, seen };
}

reg.define('pillar_up', {
  desc: 'Rise straight UP with blocks already in the pack (no commands, no teleport): dig the ceiling, jump, place under the feet, repeat. '
    + 'This is the escape for a cell with no lateral route - a lava-sea floor, a bedrock shelf, or the bottom of a shaft we sank ourselves '
    + 'whose lip the pathfinder refuses. Try it when sideways (bridgeOut) and down (dig_to_y) are both exhausted or forbidden.',
  params: { up: 'int default 12 - cells of height to gain' },
  async run(bot, a) {
    const f0 = bot.entity.position.floored();
    const dim = (bot.game && bot.game.dimension) || 'overworld';
    const want = Math.max(2, Math.min(48, parseInt(a.up, 10) || 12));
    // Refuse before burning a step if the physics of a pillar cannot exist here: a column needs something
    // solid to click and something to stand on, and the last stage of the Nether crawl was feet-in-lava.
    const under = bot.blockAt(f0.offset(0, -1, 0));
    if (!under || under.boundingBox !== 'block' || /lava|water/.test(under.name)) {
      // One dump, because this refusal has been the only thing running for 17 minutes at -271,26,98 and it
      // says "the cell under me reads lava" while the bot sits at full health and is not burning - which is
      // either a stale client column or a ledge I cannot see, and the fix differs. onGround + onFire +
      // the eight neighbours settles it in one line instead of another twenty minutes of inference.
      if (!bot._pillarRefuseDumped) {
        bot._pillarRefuseDumped = true;
        const nm = (q) => { try { const b = bot.blockAt(q); return b ? `${b.name}${b.boundingBox === 'block' ? '' : '(non-solid)'}` : 'NULL'; } catch { return 'ERR'; } };
        log.warn(`pillar_up: refusal dump at ${f0.x},${f0.y},${f0.z} pos=${JSON.stringify(bot.entity.position)} onGround=${!!(bot.entity && bot.entity.onGround)} onFire=${!!(bot.entity && bot.entity.onFire)} feet=${nm(f0)} head=${nm(f0.offset(0, 1, 0))} own_floor=${nm(f0.offset(0, -1, 0))} two_down=${nm(f0.offset(0, -2, 0))} | +x=${nm(f0.offset(1, 0, 0))} -x=${nm(f0.offset(-1, 0, 0))} +z=${nm(f0.offset(0, 0, 1))} -z=${nm(f0.offset(0, 0, -1))} | held=${bot.heldItem ? bot.heldItem.name : 'none'} dim=${dim}`);
      }
      // In the Nether this refusal is where every round ended (03:30-03:43: six plans, all
      // `pillar_up -> use_portal -> ...`, all dying here, zero cells travelled). The climb cannot start, but
      // the walk home can: the causeway laid on the way in is still in the world, and the portal record says
      // where it leads. So the rung the planner always tries first now also makes ground toward the exit.
      if (dim === 'the_nether') {
        const wh = await walkToDryHome(bot, 8);
        if (wh.walked || wh.reached) log.warn(`pillar_up: no dry face to click - walked ${wh.walked} cell(s) over my own causeway toward the portal${wh.reached ? ' and reached it' : ''} (now ${wh.at.x},${wh.at.y},${wh.at.z})`);
        return { ok: wh.reached, observation: wh.reached
          ? `no pillar possible at ${f0.x},${f0.y},${f0.z}, but I walked back onto the portal cell ${wh.at.x},${wh.at.y},${wh.at.z} - use_portal can now be tried`
          : `cannot start a pillar: the cell under me reads ${under ? under.name : 'NULL'}, which is nothing to place against; ${wh.walked ? `walked ${wh.walked} cell(s) back over the causeway (now ${wh.at.x},${wh.at.y},${wh.at.z})` : `and there is no dry footing to step onto from ${wh.at.x},${wh.at.y},${wh.at.z}`}` };
      }
      return { ok: false, observation: `cannot start a pillar: the cell under me reads ${under ? under.name : 'NULL'}, which is nothing to place against - get onto solid rock first (roam {block:'${dim === 'the_nether' ? 'netherrack' : 'stone}'}})` };
    }
    const head = bot.blockAt(f0.offset(0, 1, 0));
    const fill = P.cheapFill(bot, 1);   // same registry-checked paving test as climbOut - not "biggest stack"
    if (!fill) return { ok: false, observation: 'no stackable block in the pack to pillar on - tidy has dropped everything buildable' };
    if (fill.count < 2) return { ok: false, observation: `only ${fill.count} ${fill.name} left, which cannot raise even one cell` };
    // A cell that has already defeated the climb twice will not be defeated by a third attempt, and the
    // cost of learning that is 45 s of the step budget. Measured 08:47 -> 09:01 at -53,3,211: the planner
    // re-planned `pillar_up {up:30}` four times, each one ran to the step deadline against a LAVA ceiling
    // (climbOut will not dig lava, correctly), and `blocks left=44` showed nothing was ever placed. So the
    // third question gets a different answer: try the sideways fill, which is the move the cell still has.
    const cellKey = `${dim},${f0.x},${f0.y},${f0.z}`;
    const fails = bot._pillarFails || (bot._pillarFails = {});
    // Entombment is checkable in a few milliseconds, so it is checked BEFORE paying for a climb: no cell
    // within 8 blocks horizontally (and 30 up) has two free body cells means nothing this skill does can
    // move the bot, and the two-attempt budget only exists to catch cells that are merely hard. At 10:30-10:35
    // the planner had stopped reaching pillar_up at all (its routes now begin `equip -> mine`, and `mine
    // failed: mined 0`), so a guard that needs two prior climbs would never have fired.
    const scan = findStandable(bot, f0, 8, 30);
    const sealed = !scan.cell && scan.seen > 200;
    if ((fails[cellKey] || 0) >= 2 || sealed) {
      // Read-only geometry dump, because every hypothesis about this cell has been settled by measurement
      // and the nine-cell map does not carry the one number that decides the move: a FLUID level. A lava
      // at level 0 is a source and can only be buried; a level 1-7 flow disappears when its feed is filled,
      // which changes "I am entombed" into "I have a block to spend". Printed here because this branch runs
      // every ~30 s and it is the last thing the cell can tell us.
      const nb = [];
      for (let dy = 1; dy <= 2; dy++) {
        const row = [];
        for (let dz = -2; dz <= 2; dz++) {
          const b = bot.blockAt(f0.offset(0, dy, dz));
          const lv = b && b.properties && b.properties.level !== undefined ? `:${b.properties.level}` : '';
          row.push(`${b ? b.name : 'NULL'}${lv}`);
        }
        nb.push(`y+${dy} ${row.join(' ')}`);
      }
      log.warn(`pillar_up: neighbourhood at ${f0.x},${f0.y},${f0.z} (along z, x fixed) | ${nb.join(' | ')}`);
      const xb = [];
      for (let dy = 1; dy <= 2; dy++) {
        const row = [];
        for (const dx of [-2, -1, 0, 1, 2]) {
          const b = bot.blockAt(f0.offset(dx, dy, 0));
          const lv = b && b.properties && b.properties.level !== undefined ? `:${b.properties.level}` : '';
          row.push(`${b ? b.name : 'NULL'}${lv}`);
        }
        xb.push(`y+${dy} ${row.join(' ')}`);
      }
      log.warn(`pillar_up: neighbourhood along x (z fixed) | ${xb.join(' | ')}`);
      const bo = await P.bridgeOut(bot).catch(e => ({ ok: false, why: `threw ${e.message}` }));
      if (bo.ok) {
        return { ok: true, observation: `pillar_up had already failed twice at ${cellKey}, so it filled sideways instead: ${bo.moved}` };
      }
      // The cell is sealed. The 09:35 neighbourhood dump is the proof, and it is why this branch now
      // exists: feet ring `+x=netherrack(filled) -x=air +z=bedrock -z=netherrack(filled)`, head ring
      // `-x=bedrock, the rest lava` - the one open feet cell has a bedrock roof, so it is a 1-tall tunnel a
      // 1.8-tall player cannot enter. Nothing the bot can build (bridge, fill, pillar, dig) moves it, and
      // the fills already spent made that permanent. So the last two options are named explicitly instead
      // of returning the same advice a fourth time.
      const spot = scan.cell;
      if (!spot) {
        // Nowhere near here. The one position this project has a *recorded* safe standing cell for is the
        // dry land `recover_surface` keeps in runs/dryland.json - Overworld, probed dry, and 50 blocks from
        // the obsidian field - so the lift crosses dimensions instead of pretending the pocket has a door.
        // `use_portal`/`return_overworld` cannot help: both start by walking, and walking is what this cell
        // forbids. This is the same assist class as recover_surface's own /tp, and it is labelled the same way.
        let land = null;
        try { land = JSON.parse(fs.readFileSync(cfg.paths.runs + '/dryland.json', 'utf8')); } catch {}
        if (bot._dryLand) land = bot._dryLand;
        if (!land) {
          return { ok: false, observation: `pillar_up will not attempt ${cellKey} again (no mineable ceiling, sideways fill failed: ${bo.why}) and no cell within 8 blocks (up to y+30) has two free body cells - the pocket is sealed and there is no recorded safe landing: this run needs a human lift` };
        }
        if (process.env.MC_ASSIST === '0') {
          return { ok: false, observation: `the pocket at ${cellKey} is sealed; the only landing on file is the Overworld ${land.x},${land.y},${land.z} and reaching it needs a cross-dimension command - MC_ASSIST=0, so this rung ends here` };
        }
        // "do not lift again" was advice nothing enforced: the next call would /tp again, and a command the
        // server is not honouring would be re-sent every round. Two tries, then it is a human's problem.
        const lifts = bot._liftTries || (bot._liftTries = {});
        if ((lifts[cellKey] || 0) >= 2) {
          return { ok: false, observation: `the cross-dimension lift has already failed twice at ${cellKey} - it is not a retryable action, and re-sending a command the server is not honouring is spam; this needs a human` };
        }
        lifts[cellKey] = (lifts[cellKey] || 0) + 1;
        const before2 = bot.entity.position.floored();
        bot.chat(`/execute in minecraft:overworld run tp @s ${land.x} ${Number(land.y) + 3} ${land.z}`);
        await sleep(2500);
        const dim2 = (bot.game && bot.game.dimension) || 'unknown';
        const p2 = bot.entity.position.floored();
        const moved2 = Math.abs(p2.x - before2.x) + Math.abs(p2.z - before2.z) + (dim2 !== dim ? 10 : 0);
        const lifted = dim2 === 'overworld' && moved2 >= 4;
        if (lifted) delete lifts[cellKey];
        return {
          ok: lifted,
          observation: lifted
            ? `OP LIFT across dimensions (not autonomous movement - disclose it): the Nether pocket at ${cellKey} was sealed with no exit the bot can build; /execute in overworld tp -> ${p2.x},${p2.y},${p2.z}. The portal frame and the obsidian field are nearby, so re-approach from here.`
            : `cross-dimension lift did not land the bot on the recorded dry land (dim=${dim2}, pos=${p2.x},${p2.y},${p2.z}) - do not lift again; this needs a human`,
        };
      }
      if (process.env.MC_ASSIST === '0') {
        return { ok: false, observation: `the only standable cell near ${cellKey} is ${spot.p.x},${spot.p.y},${spot.p.z} (${spot.d} blocks, Manhattan) and no walkable route reaches it - MC_ASSIST=0, so no lift: this rung ends here` };
      }
      const before = bot.entity.position.floored();
      bot.chat(`/tp @s ${spot.p.x} ${spot.p.y} ${spot.p.z}`);
      await sleep(1600);
      const after = bot.entity.position.floored();
      const jumped = Math.abs(after.x - before.x) + Math.abs(after.y - before.y) + Math.abs(after.z - before.z);
      const landedWet = /lava|water/.test(((bot.blockAt(after) || {}).name) || '');
      return {
        ok: jumped >= 2 && !landedWet,
        observation: jumped >= 2 && !landedWet
          ? `OP LIFT (not autonomous movement - disclose it): /tp ${before.x},${before.y},${before.z} -> ${after.x},${after.y},${after.z} (${jumped} cells); the pocket at ${cellKey} was sealed. Re-run the sweep from here.`
          : `lift did not land the bot somewhere standable (moved ${jumped}, the cell now reads ${landedWet ? 'fluid' : (bot.blockAt(after) || {}).name || 'unknown'}) - do not lift again`,
      };
    }
    log.warn(`pillar_up: from ${f0.x},${f0.y},${f0.z} in ${dim}, ceiling=${head ? head.name : 'NULL'}, packing ${fill.count}x ${fill.name}`);
    const r = await climbOut(bot, f0.y + want);
    const y1 = bot.entity.position.floored().y;
    const gained = y1 - f0.y;
    if (gained >= 1) delete fails[cellKey]; else fails[cellKey] = (fails[cellKey] || 0) + 1;
    // Measured height is the only honest verdict: climbOut reports "climbed to y=N" whether or not N moved.
    return {
      ok: gained >= 1,
      observation: gained >= 1
        ? `pillar_up raised ${f0.y} -> ${y1} (+${gained} of ${want} asked) at ${f0.x},${f0.z} in ${dim}: ${r.observation}`
        : `pillar_up gained NOTHING (${f0.y} -> ${y1}) at ${f0.x},${f0.z} in ${dim}: ${r.observation}. The column above is not mineable from here or the placement is refused - this cell cannot be left upward either; the next move is a teleport-level recovery, not another attempt`,
    };
  },
});

reg.define('recover_surface', {
  desc: 'If stuck deep underground, teleport back up onto DRY land (OP recovery) so mining/crafting/portal building can resume.',
  params: {},
  budgetMs: 180000,
  async run(bot) {
    // 末地的"地面"不是换维度。20:45:58-20:49 现场这条支路把 recover_surface 变成 return_overworld ->
    // use_portal，在末地里找下界传送门：每 20 秒一次 `search walk for portal timed out`，又被下一回合的
    // 离水动作把自己的 goto 取消（`The goal was changed before it could be completed!` ×3），两头互杀，
    // 屠龙彻底停摆。末地只在岛内解决：挪到一个干落脚格。
    if (inEnd(bot)) {
      const moved = await fountainApproach(bot);
      log.warn(`recover_surface: 我在末地（${bot.entity.position.floored().x},${Math.round(bot.entity.position.y)}）- 不回主世界；${moved ? '已挪到喷泉圈内的干格' : '圈内找不到干格，就地再爬一段'}`);
      if (!moved) { try { await climbOut(bot, Math.max(62, Math.floor(bot.entity.position.y) + 3)); } catch {} }
      return { ok: !!moved, observation: moved ? 'moved onto a dry island cell inside the End' : 'no dry cell found inside the End - climbed in place instead' };
    }
    if (bot.game && bot.game.dimension !== 'overworld') {
      // altitude means nothing in another dimension; a Nether bot at y=68 is not "at surface"
      return await reg.get('return_overworld').run(bot, {});
    }
    // Last line of defence against the recovery action becoming the fault. `recover_surface` exists for
    // "I am stuck underground and cannot work here" - and it answered that description correctly at 22:56
    // and 23:21 while the bot was standing ON the portal column, mid-descent to an open door, and put it at
    // y=63 two hundred-odd block-minutes of digging away. Being underground is the plan here. Refuse the
    // lift near an open door unless the head cell is actually in fluid.
    try {
      const dNear = P.nearOpenDoor(bot, 60);
      if (dNear !== null) {
        const fd = bot.entity.position.floored();
        let headFluid = false;
        try { const hb = bot.blockAt(fd.offset(0, 1, 0)); headFluid = !!hb && /water|lava/.test(hb.name); } catch { headFluid = false; }
        if (!headFluid) {
          log.warn(`recover_surface: REFUSED the surface lift - open End portal ${dNear} blocks from ${fd.x},${fd.y},${fd.z} and the head cell is dry (surfacing cancelled the descent twice tonight)`);
          return { ok: false, observation: `stayed at y=${fd.y}: the open portal is ${dNear} blocks away horizontally and the dive is what this run is doing. No surface trip - dig on, or step sideways to dry rock` };
        }
        log.warn(`recover_surface: head cell is in fluid at ${fd.x},${fd.y},${fd.z} - drowning outranks the dive approach, lifting`);
      }
    } catch (e) { log.warn(`recover_surface door guard threw ${String(e.message).slice(0, 60)} - failing open`); }
    // "already at/above y40" was wrong: sea level is y=62, so a bot sitting in a riverbed at y=54
    // counted as recovered and NEVER left the water - it starved there while hunt correctly refused
    // to route through liquid. Recovered now means dry standing space above sea level.
    const f0 = bot.entity.position.floored();
    const wet = (p) => { const bl = bot.blockAt(p); return !!bl && /water|kelp_plant|seagrass/.test(bl.name); };
    const ground = bot.blockAt(f0.offset(0, -1, 0));
    const dryHigh = !wet(f0) && !wet(f0.offset(0, 1, 0)) && f0.y >= 62 && !!ground && !/water|lava/.test(ground.name);
    if (dryHigh) return { ok: true, observation: `already on dry land at y=${f0.y}` };
    if (process.env.MC_ASSIST === '0') {
      // No /tp and no /spawnpoint: dig out and pillar up with blocks we carry. Leaving the OP path
      // here would make the autonomous-clear claim false, which is the whole point of instance 2.
      const r = await climbOut(bot);
      if (r.ok) bot._dryLand = { x: bot.entity.position.floored().x, y: Math.round(bot.entity.position.y), z: bot.entity.position.floored().z };
      return r;
    }
    const Vec3 = require('vec3');
    const fsys = require('fs');
    const dryFile = require('../config').paths.runs + '/dryland.json';
    let saved = null;
    try { saved = JSON.parse(fsys.readFileSync(dryFile, 'utf8')); } catch {}
    // Prefer a column we have actually stood on. After using a Nether portal, _home is Nether
    // coordinates, and probing around those keeps dumping the bot back into the wrong dimension.
    const home = bot._dryLand || saved || bot._home || null;
    const cands = [];
    if (home) cands.push([home.x, home.z], [home.x + 24, home.z + 16], [home.x - 32, home.z + 24], [home.x + 64, home.z - 40]);
    if (bot._home && home !== bot._home) cands.push([bot._home.x, bot._home.z]);
    // Columns around where it actually stands: a mountain bot has the valley 60-120 blocks away, and
    // the remembered plateau is the reason it kept returning to ground with nothing to hunt.
    const cp = bot.entity.position.floored();
    for (const [ox, oz] of [[60, 0], [-60, 0], [0, 60], [0, -60], [110, 110], [-110, -110]]) cands.push([cp.x + ox, cp.z + oz]);
    // Rock the bot can ALREADY SEE has to be in the list. The 10-30 fix replaced "remembered home first"
    // with a distance sort, but every candidate is ±60/±110 away, so the sort could only choose among
    // far columns: with a dry headland 20 blocks east, the first probe still jumped 60 (caught by
    // tools/recover_order_selftest.js case 1 on 2026-11-01) and the crossing had to be re-swum.
    const head = nearestHeadland(bot);
    if (head) cands.push([head.x, head.z]);
    cands.push([64, 64], [-64, 64], [128, -128], [0, 0]);
    // A bare rocky peak is DRY but LIFELESS: this one (y=78) had no animal within 100 blocks, and
    // recover_surface kept snapping the bot back to it out of the sea, so it starved at food 5-6 with
    // the whole ladder blocked on `food`. When hungry, land near sea level (y 62-74, where plains and
    // forests spawn animals) and only fall back to any dry ground if no lower candidate exists.
    // Low ground first, always - not only when hungry. High plateaus (this bot's remembered dry land
    // at y=77) are dry but bare: no grass animals, no trees, thin iron, and the bot kept being
    // "rescued" back to one and then failing to feed or armour itself there. Sea-level-ish columns
    // (y 62-74) are where plains, forests, lakes and iron all coexist. The second pass keeps the old
    // behaviour as a fallback so a world with no low dry land still gets recovered.
    const hungry = bot.food < 12;
    const wantLow = true;
    const land = async (x, z, maxGroundY) => {
      // /tp drops the bot from y=100 onto the terrain. Over a mountain plateau that is a 30-block
      // free-fall: 3 "fell from a high place" deaths in 60 s at -192,232, and the spawnpoint got
      // pinned at y=98 mid-air, so every respawn repeated the fall. Make it immune for the drop and
      // only accept a landing once it has actually stopped moving.
      try { bot.chat('/effect give @s minecraft:resistance 200 4 true'); bot.chat('/effect give @s minecraft:slow_falling 200 0 true'); } catch {}
      try { bot.chat(`/tp @s ${x} 100 ${z}`); } catch {}
      let prev = null, still = 0;
      for (let i = 0; i < 40; i++) {
        await sleep(700);
        const f = bot.entity.position.floored();
        const g = bot.blockAt(new Vec3(f.x, f.y - 1, f.z));
        // slow_falling (from the freefall net and this skill's own buff) descends ~2.5 blocks/s, so the
        // FLOORED position looks motionless for many samples while the bot is still 20 blocks up: the
        // old "3 equal samples" test alone re-pinned the respawn anchor in mid-air. Require onGround.
        still = prev && prev.x === f.x && prev.z === f.z && prev.y === f.y ? still + 1 : 0;
        prev = f;
        const grounded = !!(bot.entity && bot.entity.onGround);
        // The FEET and HEAD cells must be dry too, not just the block below. `land()` used to test only
        // `g`, so it happily accepted a puddle-topped hill, pinned `/spawnpoint` there and wrote it to
        // dryland.json - then `wetCell` immediately reported submerged, the movement policy paused, and
        // the bot sat at y=71 with air=7 for seven minutes (measured 02:08-02:15) having been "rescued"
        // into water. This is the same `wet()` test the entry check on line 604 already applies.
        const dry = !!g && !isAir(g.name) && !g.name.includes('water') && !g.name.includes('lava')
          && !wet(f) && !wet(f.offset(0, 1, 0))
          && f.y > 45 && still >= 2 && grounded;
        if (!dry) continue;
        if (f.y > maxGroundY) return null; // dry but too high to feed a hungry bot: try the next column
        const y = Math.round(bot.entity.position.y);
        bot._deepestY = bot._deepestY ?? 999;
        bot._dryLand = { x: f.x, y, z: f.z };
        // MC moves the respawn anchor to the last Nether portal used, so a bot that dies with
        // a Nether spawnpoint dies again in a loop (observed: 4 deaths in 90s). Pin it here.
        try { bot.chat(`/spawnpoint @s ${f.x} ${y} ${f.z}`); } catch {}
        try { fsys.writeFileSync(dryFile, JSON.stringify(bot._dryLand)); } catch {}
        await sleep(800);
        log.info(`recover_surface -> dry land ${JSON.stringify(bot._dryLand)} (spawnpoint pinned${hungry ? ', hunger-aware low ground' : ''})`);
        return { ok: y >= 45, observation: `recovered to dry land y=${y} at ${f.x},${f.z}` };
      }
      return null;
    };
    // Order the candidates by distance from where the bot actually stands. The list used to be tried in
    // "remembered first" order, and that is what cost the obsidian site an hour on 2026-10-30: at
    // (150,62,517) crossing to the lava at 113,9,773, `home` - remembered dry land at (199,67,343),
    // ~430 blocks the OTHER way - was tried first and accepted, so every drowning recovery teleported
    // the bot backwards and the crossing restarted. Dry-and-near beats dry-and-familiar.
    const cpNow = bot.entity.position.floored();
    cands.sort((a, b) => Math.hypot(a[0] - cpNow.x, a[1] - cpNow.z) - Math.hypot(b[0] - cpNow.x, b[1] - cpNow.z));
    // And when even the nearest dry column is a long way off, climb up in place FIRST: a recovery that
    // moves the bot further than a job's own working radius is not a recovery, it is a reset.
    const GAP_LIMIT = Number(process.env.RECOVER_CLIMB_FIRST_GAP || 160);
    // Distance to ground we KNOW is dry - not to the first probe candidate. The old expression read
    // `cands[0]`, and the candidate list always contains the cp±60 compass columns, so nearestGap could
    // never exceed GAP_LIMIT and this gate was unreachable: no bot ever climbed out in place, it always
    // teleported. Proved by tools/recover_order_selftest.js case 2, which waited on a line that could
    // not print. A headland in sight means stay-local; otherwise the remembered column is the only
    // evidence of dry land, and if THAT is further than a job's radius, digging up is the cheaper move.
    const nearestGap = head ? head.d
      : (home ? Math.round(Math.hypot(home.x - cpNow.x, home.z - cpNow.z)) : Infinity);
    if (nearestGap > GAP_LIMIT && cpNow.y < 62) {
      log.warn(`recover_surface: nearest dry candidate is ${nearestGap} blocks away (> ${GAP_LIMIT}) - climbing out in place before considering a teleport`);
      const cbefore = bot.entity.position.floored();
      try { await climbOut(bot, 62); } catch (e) { log.warn(`recover_surface: climbOut threw ${String(e.message).slice(0, 50)}`); }
      const f2 = bot.entity.position.floored();
      const g2 = bot.blockAt(f2.offset(0, -1, 0));
      if (!wet(f2) && !wet(f2.offset(0, 1, 0)) && f2.y >= 62 && !!g2 && !/water|lava/.test(g2.name)) {
        bot._dryLand = { x: f2.x, y: f2.y, z: f2.z };
        try { bot.chat(`/spawnpoint @s ${f2.x} ${f2.y} ${f2.z}`); } catch {}
        try { fsys.writeFileSync(dryFile, JSON.stringify(bot._dryLand)); } catch {}
        log.info(`recover_surface -> climbed out in place to ${f2.x},${f2.y},${f2.z} (was y=${cbefore.y}), no teleport`);
        return { ok: true, observation: `climbed out to dry ground at y=${f2.y} in place (nearest dry column was ${nearestGap} away - a teleport there would abandon the work here)` };
      }
      log.warn(`recover_surface: climbed to y=${f2.y} and it is not dry standing ground yet - falling through to the nearest candidates (${nearestGap} away)`);
    }
    let spot = null;
    for (const [x, z] of cands) { spot = await land(x, z, wantLow ? 74 : Infinity); if (spot) break; }
    if (!spot) for (const [x, z] of cands) { spot = await land(x, z, Infinity); if (spot) break; }
    return spot || { ok: false, observation: `no dry landing spot among ${cands.length} candidates (ocean world?) with food=${bot.food}` };
  },
});
function isAir(name) { return !name || name === 'air' || name === 'cave_air' || name === 'void_air'; }

// ---- obsidian & portal ----
// bot.dig / bot.equip / pathfinder.goto can hang forever when the target is out of reach or
// a window is busy, and a hung skill wedges the whole planner. Cap each call instead.
// Which end crystal gets the next arrow, ranked by what a shot can actually do from the cell the bot is
// standing in - see the fixation this replaces at the kill_dragon call site. Returns the top candidate plus
// the census the log needs, or null when nothing is in range (the caller then falls back to nearestEntity,
// which is the behaviour this helper replaces and the only path that keeps working on an unreadable world).
function pickCrystalTarget(bot, radius, stickyId) {
  const rad = radius || 90;
  const cands = [];
  try {
    for (const e of Object.values(bot.entities || {})) {
      if (e && e.name === 'end_crystal' && e.position && bot.entity.position.distanceTo(e.position) < rad) cands.push(e);
    }
  } catch { return null; }
  if (!cands.length) return null;
  const given = bot._crystalGivenUp || {};
  const rank = cands.map(e => {
    let blocked = 1;
    try { blocked = shotBlocker(bot, bot.entity.position, e.position) ? 1 : 0; } catch { blocked = 0; }
    // `tries`, not arrows: since 09:50 the crystal route is the pillar sequence, so the cost already paid
    // on a crystal is its climb + screen-and-punch attempts. Ranking by `arrows spent` would put a crystal
    // nobody has touched above one with three failed climbs and start the ladder over on every round.
    const tries = ((bot._punchTries && bot._punchTries[e.id]) || 0) + ((bot._climbTries && bot._climbTries[e.id]) || 0);
    return { e, blocked, tries, dy: Math.abs(e.position.y - bot.entity.position.y), d: bot.entity.position.distanceTo(e.position) };
  }).sort((a, b) => (a.blocked - b.blocked) || (a.tries - b.tries) || (a.dy - b.dy) || (a.d - b.d));
  // STICKY, because the ladder that actually drops a crystal (build up beside it -> screen the blast ->
  // punch it) has to run to the end on ONE id, and the target used to be re-picked every round: the one
  // arrow spent on #39 made #50 (spent=0) rank above it next
  // round. Measured 00:43:19-00:46:00 live - the target changed on every single shot
  // (#39 #50 #51 #34 #53 #34 #33 #39), each switch printed "0 arrows already spent", so `spent >= 3`
  // never became true on any crystal, the climb and the hand punch never executed, and seven lofted
  // arrows at 48-70 blocks bought crystalsDown=0 before an enderman finished it.
  // A crystal now stays the target until it is destroyed or this dive explicitly gives up on it.
  const open = rank.filter(r => !given[r.e.id]);
  const pool = open.length ? open : rank;
  const keep = (stickyId !== undefined && stickyId !== null && !given[stickyId])
    ? pool.find(r => r.e.id === stickyId) : null;
  const top = keep || pool[0];
  return {
    e: top.e, blocked: top.blocked, tries: top.tries, dy: top.dy, d: top.d, of: rank.length,
    sticky: !!keep, openCount: open.length, givenUp: Object.keys(given).length,
    allGivenUp: open.length === 0 && Object.keys(given).length > 0,
    nearest: rank.slice().sort((a, b) => a.d - b.d)[0].e,
  };
}

// A crystal this dive failed on stops competing for the target: without it the sticky pick would stay on
// a hopeless pillar forever, and without the sticky pick the escalation ladder never reached `spent >= 3`.
function giveUpCrystal(bot, id, why) {
  bot._crystalGivenUp = bot._crystalGivenUp || {};
  bot._crystalGivenUp[id] = why;
  if (bot._arrowsAt) delete bot._arrowsAt[id];
  if (bot._cageTries) delete bot._cageTries[id];
  if (bot._climbTries) delete bot._climbTries[id];
  if (bot._punchTries) delete bot._punchTries[id];
  if (bot._approachTries) delete bot._approachTries[id];
  if (bot._crystalTarget === id) bot._crystalTarget = null;
}

async function capped(promise, ms, label) {
  let done = false;
  const p = Promise.resolve(promise).then(v => { done = true; return v; }, e => { done = true; log.warn(`${label} threw ${e.message}`); return null; });
  const r = await Promise.race([
    p,
    new Promise(res => setTimeout(() => res({ __timeout: true }), ms)),
  ]);
  if (r && r.__timeout && !done) log.warn(`${label} timed out (${ms}ms)`);
  return r && r.__timeout ? null : r;
}
async function withReach(bot, b, ms = 7000) {
  if (!b || !b.position) return false;
  const dist = bot.entity.position.distanceTo(b.position);
  if (dist > 3.2) await capped(bot.pathfinder.goto(new (GN())(b.position.x, b.position.y, b.position.z, 1)), 9000, `goto ${b.name}`);
  const res = await capped(bot.dig(b), ms, `dig ${b.name}`);
  return res !== null;
}
// ── obsidian_farm ────────────────────────────────────────────────────────────────
// make_obsidian fills the bucket once, on entry, and its pour loop never refills - measured at 18:29,
// 18:35 and 18:39: `water bucket is empty after 0 pour(s) (bucket=1)` while a lava pool sat 4 blocks
// away at (42,-56,761), because the round had already spent its budget crossing to the pool and had
// nothing left for water. A player instead picks ONE site where a water source and a lava source are a
// short walk apart and works it until the stack is full, refilling on every trip. This is that loop,
// and it remembers the fill cell so the next round starts with the pair already known.
reg.define('obsidian_farm', {
  desc: 'Work a fixed obsidian site: fill the bucket at a remembered water source, walk to a remembered lava SOURCE cell, pour, dig the obsidian that forms, repeat until the stack is full. Needs a water+lava pair in the terrain memory (make_obsidian produces one while it hunts lava).',
  params: { count: 'int default 10' },
  async run(bot, a) {
    const need = a.count ?? 10;
    const deadline = bot._stepDeadline || (Date.now() + 18 * 60000);
    const have = () => countItem(bot, 'obsidian');
    const d3 = (p) => bot.entity.position.distanceTo(p);
    const dh = (e) => Math.hypot(bot.entity.position.x - e.x, bot.entity.position.z - e.z);

    // The pair, not two independent `nearest` hits: the cost that matters is the gap BETWEEN the two
    // ends, since one bucket crossing per obsidian is what this loop does over and over.
    // The site = the nearest remembered lava + the nearest SURFACE water, not a same-altitude pair.
    // The first version demanded both ends within 70 of each other (vertical weighted), which left
    // exactly one eligible pair - 458,-24,767 + 486,-24,762, 400 blocks east - and the bot died on the
    // coastal shelf at 217,62,767: `descent stalled at y=62`, `in water ... get dry and call walk_to
    // again`. Sea level here is y=62-63, so every column dug at the shore floods, while the shafts near
    // home go dry from y=68 to y=-56 (measured 19:43-19:49). A player carries the bucket, so the gap
    // between the lake and the lava is a walk, not a disqualifier.
    const lavas = oreCache.list(['lava'], bot.entity.position);
    const waters = oreCache.list(['water'], bot.entity.position);
    const surface = waters.filter(w => w.y >= 56);
    const pool = (surface.length ? surface : waters);
    const openL = lavas.filter(l => !siteCooling(l));
    const openW = pool.filter(w => !siteCooling(w));
    if (lavas.length && !openL.length) log.warn(`obsidian_farm: all ${lavas.length} remembered lava cells are on route cooldown - retrying the closest anyway`);
    // A lava that already sits next to remembered obsidian is a PROVEN lava+water interface.
    // Neighbour-counting alone was not enough: 149,52,774 (a hillside flow at y=52) was poured at 22:50
    // and again at 23:06 and produced nothing either time, while the y=9-10 pool cells
    // (114-118, 9-10, 771-773) converted within the same session.
    const obsMem = oreCache.list(['obsidian'], bot.entity.position);
    const proven = (l) => obsMem.some(o => Math.hypot(l.x - o.x, l.y - o.y, l.z - o.z) <= 12);
    // Choose the SITE and its STATION TOGETHER. What this loop pays for is the fill -> pour -> back
    // crossing, so a lava with a lake beside it beats a nearer lava whose lake is 190 blocks away:
    // 23:03-23:27 burned its whole budget on 186-block station treks with zero obsidian gained, while the
    // pool at 114-118,9-10,771-773 (the cells that actually converted twice) sits ~90 blocks from the
    // lake at 127,62,858. Vertical is weighted down because the bot carries the bucket up a shaft.
    // A PROVEN interface (a lava with remembered obsidian beside it) is not disposable. It is the one
    // site measured to actually convert (114-118, 9-10, 771-773), and losing it from the menu costs an
    // 800-block expedition to a pair the notes already record as failing: 07:05:57 chose
    // `lava 486,-24,762 with station 500,70,760` - the coastal shelf of §26u/§26dd, where every pour
    // makes cobblestone - only because the proven pool was sitting in a route cooldown. A cooled proven
    // site therefore stays eligible.
    const cooledProven = lavas.filter(l => siteCooling(l) && proven(l));
    const dh0 = (v) => Math.hypot(v.x - bot.entity.position.x, v.z - bot.entity.position.z);
    let candL = openL.length ? openL : lavas;
    if (openL.length && !openL.some(proven) && cooledProven.length) {
      const bestP = cooledProven.sort((x, y) => dh0(x) - dh0(y))[0];
      // But not forever. Live at 18:33:12: `the proven lava 113,9,773 is on cooldown, but all 23 open
      // candidate(s) are unproven - working the proven pool anyway` - the same pool that had just been
      // cooled for `route blocked from y=50`, `11 lava source(s) in reach none with a dry stand`, and
      // five flooded descent refusals. An unconditional override turns a 25-minute cooldown into
      // decoration and is exactly how obsidian sat at one number for hours. After
      // OBSIDIAN_PROVEN_MAX_COOLINGS structural failures in a row the pool stays cooled and the open
      // candidates get their turn; any success resets the count (rememberPair).
      const strikes = siteStrikes(bestP);
      const MAX_STRIKES = Number(process.env.OBSIDIAN_PROVEN_MAX_COOLINGS || 1);
      // The cap exists to stop the farm hammering one wedged interface - but it must not cut off the ONE
      // place where a dry stand has already been built and measured (18:22:41 `dry work shelf at
      // 113,9,775 ... obsidian here can be taken`). A standing shelf is fresh evidence that outranks a
      // strike count: the strikes say "the last three approaches failed", the shelf says "the thing every
      // approach was missing now exists, two blocks from this lava".
      let shelfOk = false, shelfAt = null;
      try {
        const sh = JSON.parse(fs.readFileSync(path.join(cfg.paths.runs, 'shelf.json'), 'utf8'));
        if (sh && Date.now() - sh.ts < 90 * 60000 && Math.hypot(sh.x - bestP.x, sh.y - bestP.y, sh.z - bestP.z) <= 14) { shelfOk = true; shelfAt = sh; }
      } catch { shelfOk = false; }
      if (strikes >= MAX_STRIKES && !shelfOk) {
        log.warn(`obsidian_farm: the proven lava ${bestP.x},${bestP.y},${bestP.z} has been cooled ${strikes} times without producing - leaving it cooled this round and working the ${openL.length} open candidate(s); if none of them converts either, the answer is a pool with a natural rim, not this one`);
      } else {
        log.warn(`obsidian_farm: the proven lava ${bestP.x},${bestP.y},${bestP.z} is on cooldown, but all ${openL.length} open candidate(s) are unproven - working the proven pool anyway (${strikes >= MAX_STRIKES ? `strikes ${strikes}/${MAX_STRIKES} waived: a dry shelf stands at ${shelfAt.x},${shelfAt.y},${shelfAt.z}, ${Math.round(Math.hypot(shelfAt.x - bestP.x, shelfAt.y - bestP.y, shelfAt.z - bestP.z))} from it` : `strike ${strikes}/${MAX_STRIKES}`})`);
        candL = [bestP, ...openL];
      }
    }
    const candW = openW.length ? openW : pool;
    let best = null;
    for (const l of candL) {
      for (const w of candW) {
        const pourGap = Math.hypot(l.x - w.x, (l.y - w.y) * 0.45, l.z - w.z);
        // Penalise an absurd bucket carry hard: at 00:45:25 the scorer chose lava 42,-56,761 with the
        // station at -9,62,65 - 700 blocks apart - because a post-respawn fill had written a water memory
        // on the other side of the map and the station is sorted by distance from the BOT, not from the
        // lava. The pair to work is the one where the walk is a walk, not a continent crossing.
        const carry = pourGap > 150 ? (pourGap - 150) * 3 : 0;
        const score = pourGap + carry + (dh(l) + dh(w)) * 0.3 - (proven(l) ? 150 : 0);
        if (!best || score < best.score) best = { lv: l, wv: w, score, gap: Math.round(pourGap), why: proven(l) ? 'proven obsidian interface' : 'best fill+pour pair' };
      }
    }
    // Honour the lock while it stands, so a long approach converges instead of re-deciding each round.
    const lockedOk = siteLock && Date.now() < siteLock.until
      // A proven lava keeps the lock even while cooling, otherwise the destination re-flips every round
      // (the oscillation §26bb fixed by other means) and no approach ever finishes.
      && (!siteCooling(siteLock.lv) || proven(siteLock.lv)) && !siteCooling(siteLock.wv)
      && lavas.some(l => l.x === siteLock.lv.x && l.y === siteLock.lv.y && l.z === siteLock.lv.z)
      && pool.some(w => w.x === siteLock.wv.x && w.y === siteLock.wv.y && w.z === siteLock.wv.z);
    if (lockedOk) {
      best = { lv: siteLock.lv, wv: siteLock.wv, why: 'held from the previous round (site lock)',
        gap: Math.round(Math.hypot(siteLock.lv.x - siteLock.wv.x, siteLock.lv.y - siteLock.wv.y, siteLock.lv.z - siteLock.wv.z)) };
    }
    let pair = best ? { lv: best.lv, wv: best.wv, gap: best.gap } : null;
    // The worked pair outranks the score. Its station may be on a short fill cooldown (that is a retry,
    // not a verdict - §26y), and its obsidian memories may have been evicted, but it is the one site the
    // run has *demonstrated*, and re-choosing by distance sent the bot 800 blocks to a shelf that never
    // converts.
    if (lastSiteFresh() && pair && Math.hypot(pair.lv.x - lastSite.lv.x, pair.lv.y - lastSite.lv.y, pair.lv.z - lastSite.lv.z) > 4) {
      const lv = lavas.find(l => Math.hypot(l.x - lastSite.lv.x, l.y - lastSite.lv.y, l.z - lastSite.lv.z) <= 4);
      const wv = pool.find(w => Math.hypot(w.x - lastSite.wv.x, w.y - lastSite.wv.y, w.z - lastSite.wv.z) <= 4);
      if (lv && wv) {
        log.warn(`obsidian_farm: overriding the score - the pair that last actually produced obsidian is lava ${lv.x},${lv.y},${lv.z} + station ${wv.x},${wv.y},${wv.z} (${Math.round(Math.hypot(lv.x - wv.x, (lv.y - wv.y) * 0.45, lv.z - wv.z))} apart, worked ${Math.round((Date.now() - lastSite.ts) / 60000)} min ago)`);
        pair = { lv, wv, gap: Math.round(Math.hypot(lv.x - wv.x, (lv.y - wv.y) * 0.45, lv.z - wv.z)) };
      }
    }
    siteLock = pair ? { lv: pair.lv, wv: pair.wv, until: Date.now() + SITE_LOCK_MS } : null;
    if (!pair) {
      log.skill(`obsidian_farm: nothing to farm - ${lavas.length} lava and ${waters.length} water cells remembered (surface water needs y>=56)`);
      return { ok: false, observation: `no lava+water remembered (${lavas.length} lava / ${waters.length} water cells)` };
    }
    log.skill(`obsidian_farm: chose lava ${pair.lv.x},${pair.lv.y},${pair.lv.z} with station ${pair.wv.x},${pair.wv.y},${pair.wv.z} (${pair.gap} apart) - ${best.why}; ${obsMem.length} obsidian cell(s) on file`);
    // The station shortlist the fill loop works through: nearest surface waters first, already
    // excluding any that failed a route in the last 25 minutes.
    // The station shortlist the fill loop works through. Fallbacks are ranked by distance to THE LAVA,
    // not by distance to the bot: the previous ordering meant that when the chosen station refused a
    // fill, the "next nearest water" was 456,64,767 and then 500,70,760 - 799 blocks the wrong way, at
    // the coastal shelf pair that had already failed (06:58:30). A station is only useful if the bot can
    // fill there and still walk to the pour, so anything more than ~220 blocks from the lava is not a
    // fallback, it is a new expedition. (Made worse by my own §26jj change: water memories no longer
    // expire, so every far-side cell ever recorded stays a candidate forever.)
    const gapToLava = (w) => Math.hypot(w.x - pair.lv.x, (w.y - pair.lv.y) * 0.45, w.z - pair.lv.z);
    const alternates = (openW.length ? openW : pool).filter(w => w !== pair.wv && gapToLava(w) <= 220)
      .sort((a, b) => gapToLava(a) - gapToLava(b));
    // Deduplicate by COORDINATE, not object identity. The lock re-injects its own `wv` (read back from
    // last_site.json), so `w !== pair.wv` let the same lake occupy two of the four station slots
    // (18:07:22 `4 station(s): 127,62,858 | 127,62,858 | 2,62,675 | -37,62,770`) - which burned a whole
    // second carry-and-refill attempt on a station that had just failed the same bucket test.
    const seenSt = new Set();
    const stations = [pair.wv, ...alternates].filter(w => {
      const k = `${w.x},${w.y},${w.z}`;
      if (seenSt.has(k)) { log.info(`obsidian_farm: dropped the duplicate station ${k} (the lock and the cache name the same lake)`); return false; }
      seenSt.add(k); return true;
    }).slice(0, 4);
    if (!alternates.length && (openW.length ? openW : pool).length > 1) {
      log.warn(`obsidian_farm: no other remembered water within 220 of the lava (nearest alternative is ${Math.round(Math.min(...(openW.length ? openW : pool).filter(w => w !== pair.wv).map(gapToLava)))} away) - this site has one station, so a fill refusal here means the round ends`);
    }
    if (!stations.length) { log.warn('obsidian_farm: no water station remembered at all - make_obsidian has to find one'); return { ok: false, observation: 'no remembered water station to fill from' }; }
    log.skill(`obsidian_farm: site = lava ${pair.lv.x},${pair.lv.y},${pair.lv.z} (${Math.round(dh(pair.lv))} blocks away), ${stations.length} station(s): ${stations.map(s => `${s.x},${s.y},${s.z}`).join(' | ')}, obsidian=${have()}/${need}`);

    const arrive = async (cell, tag) => {
      // Get dry before asking for a route - but ONLY when the water is actually dangerous. This guard
      // used to fire on any wet cell, and on this coastal shelf that meant every round: step into the
      // shallows -> `dry_escape` -> `recover_surface` -> teleported back to the remembered dry land
      // ~700 blocks the other way, so the distance to the site went 699 -> 742 (07:15:05 -> 07:16:33)
      // and no approach could ever finish. §26dd already fixed `walk_to` the same way: a wet FEET cell
      // with a dry head at or above sea level is wading, and wading is what the causeway is for.
      const wetNow = wetCell(bot);
      const submerged = (() => {
        try {
          const h = bot.blockAt(bot.entity.position.offset(0, 1, 0));
          return !!h && /water|lava|kelp|seagrass/.test(h.name);
        } catch { return false; }
      })();
      if (wetNow && (submerged || bot.entity.position.y < 60)) {
        log.info(`obsidian_farm: ${submerged ? 'head underwater' : 'below sea level'} at y=${Math.round(bot.entity.position.y)} on the way to ${tag} at ${cell.x},${cell.y},${cell.z} - climbing out before routing`);
        try { await reg.get('dry_escape').run(bot, { max: 8 }); } catch {}
        if (wetCell(bot) && submerged) { try { await reg.get('recover_surface').run(bot, {}); } catch {} }
      } else if (wetNow) {
        log.info(`obsidian_farm: wading at y=${Math.round(bot.entity.position.y)} with a dry head, ${Math.round(Math.hypot(cell.x - bot.entity.position.x, cell.z - bot.entity.position.z))} to ${tag} - routing directly (walk_to builds a causeway)`);
      }
      const lateral = () => Math.hypot(bot.entity.position.x - cell.x, bot.entity.position.z - cell.z);
      if (lateral() > 10) {
        const r = await reg.get('walk_to').run(bot, { x: cell.x, y: cell.y, z: cell.z, tolerance: 8 });
        log.skill(`obsidian_farm: ${tag} leg -> ${String(r.observation).slice(0, 110)}`);
      }
      // The cached cell is only a landmark; what the packets need is a real source within reach, and
      // that is often a neighbouring cell at a different height (a lake surface, a pool one ledge down).
      // The descent is budget-bounded rather than 3 stages: measured 19:14-19:18, the lava sat 88 blocks
      // under the bot and three `deep_shaft` calls of max 24 cover 72, so `arrive` answered "lost the
      // lava cell" while the bot was 16 blocks and one stage away from standing on top of it.
      const dryY = () => Math.round(bot.entity.position.y);
      const posKey = () => { const p = bot.entity.position.floored(); return `${p.x},${p.y},${p.z}`; };
      let lastPos = '', stalled = 0, floodRefusals = 0;
      // Rock is dug with a cheap pick. The diamond pick at 25% went to 11% and then to NOTHING in the
      // 15 minutes of descents between 19:03 and 19:19, and a shaft has no use for its tier - so take
      // the bulk pick here and let only the obsidian dig above hold the diamond one.
      try { await equipBulkPick(bot, true); } catch {}
      for (let k = 0; k < 12; k++) {
        const near = (() => { try { return bot.findBlocks({ matching: blockIds(bot, [tag]), maxDistance: 16, count: 10 }); } catch { return []; } })();
        if (near.some(p => d3(p) <= 6)) return true;
        if (Date.now() >= deadline) return false;
        // No movement twice in a row = the last action did nothing, so repeating it is the spin, not the
        // approach. Get dry once (walk_to refuses to route while the bot stands in water and returns that
        // refusal as a result), and if the cell still has not changed, give this site up honestly instead
        // of burning the loop: 22:18:54 logged nine identical `in water at 16,-24,724 ... get dry and call
        // walk_to again` lines inside 6 ms and then hit the 12-iteration cap.
        if (lastPos && posKey() === lastPos) {
          if (wetCell(bot)) { try { await reg.get('recover_surface').run(bot, {}); } catch {} }
          if (posKey() === lastPos) { log.warn(`obsidian_farm: pinned at ${lastPos} (wet=${wetCell(bot) ? 'Y' : 'n'}) on the way to ${tag} - giving up this approach`); return false; }
        }
        lastPos = posKey();
        // A stair descent drifts sideways (~1 block per 3 down), so after dropping 81 blocks the bot sat
        // at y=-27 with the lava still tens of blocks off in x/z and this loop had no way to re-close it -
        // the walk only ran once, before the descent (22:13:06 `lost the lava cell at 95,-28,839
        // from y=-27`, which then cooldown-marked a pool it had actually reached the roof of).
        if (lateral() > 8) {
          const r = await reg.get('walk_to').run(bot, { x: cell.x, y: cell.y, z: cell.z, tolerance: 6 });
          log.skill(`obsidian_farm: ${tag} re-walk at lateral ${Math.round(lateral())} -> ${String(r.observation).slice(0, 90)}`);
          continue;
        }
        const dy = cell.y - dryY();
        if (dy < -2) {
          const stage = Math.min(24, Math.abs(dy) + 2);
          const yB = dryY();
          let ds = null;
          try { ds = await reg.get('deep_shaft').run(bot, { toY: cell.y + 1, max: stage }); } catch (e) { ds = { ok: false, observation: 'threw ' + e.message }; }
          // No movement is not "keep digging the same wall": report it and let the caller pick another
          // site instead of burning the step budget on a stalled shaft.
          if (Math.abs(dryY() - yB) < 2) {
            // A refusal is not a wall. At 22:54:22 the lava was 3 blocks away horizontally and the
            // descent gave up in 5 ms because deep_shaft rejects any column on the flooded list - and the
            // caller then cooled down a site it could practically touch. Step onto fresh ground beside
            // this column and try again; only give up after several different columns refuse.
            stalled++;
            // A refusal by name, not by vibe: `deep_shaft` refuses for two very different reasons, and
            // only the flooded-chimney one is a dead end. Measured 17:51-17:53 on 2026-10-30 -
            //   make_obsidian: shaft toward the field hit water at y=71 (column 114,771 is recorded as
            //   FLOODED - do not dig here; walk to fresh) - leaving th...
            //   obsidian_farm: 5 columns around y=69 refused the descent to lava - giving up this approach
            //   short - obsidian=6/12 after 1 cycle(s), 0 pour(s), 0 dug (stop: could not reach the lava cell)
            // while the SITE LOCK (`held from the previous round`) kept re-arming that interface, so every
            // round spent ~40 s hammering the same five flooded columns. Five FLOODED refusals is a wedge:
            // say so, cool the pair, and release the lock so the next round scores a different pool.
            const flooded = !!(ds && /FLOOD|STANDING IN WATER/i.test(String(ds.observation || '')));
            if (flooded) floodRefusals++; else floodRefusals = 0;
            if (floodRefusals >= 5) {
              log.warn(`OBSIDIAN SITE WEDGED: ${tag} at ${cell.x},${cell.y},${cell.z} is reachable only through columns the pack has already flooded (${floodRefusals} refusals from y=${yB}) - releasing the site lock and forgetting this flooded lava from oreCache so next round digs on dry land`);
              siteLock = null;
              try { lastSite = { lv: cell, wv: pair && pair.wv, ts: 0 }; fs.writeFileSync(LAST_SITE, JSON.stringify(lastSite)); } catch {}
              markSiteFail(cell, 'chimney flooded from every side', SITE_WEDGE_COOLDOWN_MS);
              if (tag === 'lava') { try { oreCache.forget(cell.x, cell.y, cell.z); } catch {} }
              if (pair && pair.wv) markSiteFail(pair.wv, 'fill station across the same flooded chimney', SITE_WEDGE_COOLDOWN_MS);
              return false;
            }
            if (stalled >= 5) {
              log.warn(`obsidian_farm: ${stalled} columns around y=${yB} refused the descent to ${tag} - giving up this approach`);
              if (tag === 'lava' && yB >= 55) { try { oreCache.forget(cell.x, cell.y, cell.z); } catch {} }
              return false;
            }
            const f2 = bot.entity.position.floored();
            const off = [[6, 0], [-6, 0], [0, 6], [0, -6], [8, 8], [-8, -8]][k % 6];
            log.info(`obsidian_farm: ${tag} column ${f2.x},${f2.z} refused the descent (retry ${stalled}/5) - stepping to ${f2.x + off[0]},${f2.z + off[1]}`);
            try { await reg.get('walk_to').run(bot, { x: f2.x + off[0], y: Math.max(f2.y, MIN_HIGH_Y - 4), z: f2.z + off[1], tolerance: 2 }); } catch {}
            continue;
          }
          stalled = 0;
        } else if (dy > 2) {
          const yB = dryY();
          try { await reg.get('recover_surface').run(bot, {}); } catch {}
          if (Math.abs(dryY() - yB) < 2) return false;
        } else return false;
      }
      return false;
    };

    // Stand on dry ground within reach of `target` before spending minutes on a dig. Measured
    // 23:49:29 -> 23:53:31: the pour at 112,9,772 converted, and then the diamond pick floated IN the
    // pool with its head underwater (`wet=Y`) for the entire 240 s cap and the block did not break -
    // the dig keeps being aborted (`silent-failure guard dig: Digging aborted`), so waiting longer never
    // wins. A player stands on the bank and reaches in.
    const standDryNear = async (target) => {
      if (!wetCell(bot)) return true;
      const f = bot.entity.position.floored();
      for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2], [2, -2], [-2, 2], [3, 0], [-3, 0], [0, 3], [0, -3]]) {
        for (const dy of [1, 2, 0]) {
          const cell = bot.blockAt(new Vec3(f.x + dx, f.y + dy, f.z + dz));
          const support = bot.blockAt(new Vec3(f.x + dx, f.y + dy - 1, f.z + dz));
          if (!cell || !isAir(cell.name)) continue;
          if (!support || /water|lava/.test(support.name)) continue;
          try { await bot.pathfinder.goto(new (GN())(f.x + dx, f.y + dy, f.z + dz, 1)); } catch {}
          if (!wetCell(bot) && bot.entity.position.distanceTo(target.position) <= 4.5) {
            log.info(`obsidian_farm: climbed onto the bank at ${f.x + dx},${f.y + dy},${f.z + dz} (target ${Math.round(bot.entity.position.distanceTo(target.position))}b away)`);
            return true;
          }
          if (!wetCell(bot) && bot.entity.position.distanceTo(target.position) > 4.5) break; // dry but too far: try the next ledge
        }
        if (!wetCell(bot)) break;
      }
      return !wetCell(bot);
    };
    const fill = async () => {
      if (countItem(bot, 'water_bucket') > 0) return true;
      const bk = bot.inventory.items().find(i => i.name === 'bucket');
      if (!bk) {
        // Warn AND fix. For 23 minutes this line printed 71 times and did nothing else, while the
        // bucket - one 3-iron-ingot item the whole pour depends on - was simply gone from the pack.
        log.warn('obsidian_farm: no bucket in the pack - going to forge and fill one (ensure_bucket)');
        const eb = await reg.get('ensure_bucket').run(bot, {});
        log.warn(`obsidian_farm: ensure_bucket said (${String(eb.observation).slice(0, 170)})`);
        return countItem(bot, 'water_bucket') > 0;
      }
      // Carry the water like a player does. A poured cell IS a water source, so the bucket that was
      // just emptied three blocks away can be refilled on the spot - no trek back to a lake. Before
      // this rule the sequence was pour -> empty bucket -> walk to a station (89-430 blocks of open
      // sea, see §27b) -> fill -> walk back, and every pour paid that round trip.
      const reclaim = async (near) => {
        if (countItem(bot, 'water_bucket') > 0) return true;
        const bs = bot.inventory.items().find(i => i.name === 'bucket');
        if (!bs || wetCell(bot)) return false;
        const cells = [];
        for (const [dx, dy, dz] of [[0, 0, 0], [0, 1, 0], [0, 2, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]) {
          try { const c = near.offset(dx, dy, dz); const b = bot.blockAt(c); if (b && b.name === 'water') cells.push({ c, src: isFluidSource(b) }); } catch {}
        }
        if (!cells.length) return false;
        // A bucket only fills from a SOURCE. Live measurement at 18:02:54 and 18:07:22:
        // `tried to reclaim from 1 poured water cell(s) and the bucket stayed empty` - the cell left
        // behind after the conversion is flowing water (the source went into obsidian), so the reclaim
        // must aim at a source cell or admit that one pour really does cost one trip to a lake.
        const srcCells = cells.filter(v => v.src);
        if (!srcCells.length) {
          log.info(`obsidian_farm: the ${cells.length} poured water cell(s) here are all flowing after the conversion - no source to reclaim, one trip per pour is real`);
          return false;
        }
        try { await bot.equip(bs, 'hand'); } catch {}
        for (const { c } of srcCells) {
          if (d3(c) > 5.5) continue;
          try { await bot.lookAt(c.offset(0.5, 0.5, 0.5), true); } catch {}
          try { await bot.activateItem(); } catch {}
          await sleep(900);
          if (countItem(bot, 'water_bucket') > 0) { log.skill(`obsidian_farm: reclaimed the water I poured (${c.x},${c.y},${c.z}) - empty bucket -> full without leaving the site`); return true; }
        }
        log.info(`obsidian_farm: tried to reclaim from ${cells.length} poured water cell(s) and the bucket stayed empty - falling back to a station`);
        return false;
      };
      // First, whatever is within reach right here.
      const lvp = pair && pair.lv ? (pair.lv.position || new Vec3(pair.lv.x, pair.lv.y, pair.lv.z)) : null;
      if (lvp && await reclaim(lvp)) return true;
      if (wetCell(bot)) {
        // Do not start a fill from under the surface. Every fill that has ever worked happened from DRY
        // ground beside the water, and 20:19-20:22 shows why: the bot stood in the sea at y=9-10 with
        // air=3 clicking at 15 flowing cells it could not take. Get dry, then look for a source.
        log.info('obsidian_farm: head in water at the start of the fill - climbing out first');
        try { await reg.get('recover_surface').run(bot, {}); } catch {}
      }
      // Try every remembered station in THIS round. One blocked lake used to end the whole call: 20:46
      // `-37,62,770 blocked 7 legs short` -> `stop: could not fill the bucket`, and 20:53 the same on
      // 2,62,675, while the other lakes sat untried until the next round (which then picked the same
      // nearest one again). The stations list is ordered nearest-first and each dead one gets cooldown.
      for (const st of stations) {
        if (countItem(bot, 'water_bucket') > 0) return true;
        if (Date.now() >= deadline) { log.warn('obsidian_farm: out of time to look for a fill station'); return false; }
        pair.wv = st;
        log.skill(`obsidian_farm: station ${st.x},${st.y},${st.z} (${Math.round(dh(st))} blocks away, ${Math.round(st.y - bot.entity.position.y)} above the bot)`);
        if (!await arrive(st, 'water')) { markSiteFail(st, 'no water cell in reach'); log.warn(`obsidian_farm: could not get within 6 of water at ${st.x},${st.y},${st.z}`); continue; }
        let cs = [];
        const scanWater = (r) => { try { return bot.findBlocks({ matching: blockIds(bot, ['water']), maxDistance: r, count: 24 }).map(p => bot.blockAt(p)).filter(b => b && b.name === 'water'); } catch { return []; } };
        cs = scanWater(8);
        let src = cs.filter(isFluidSource);
        // A shore can offer 16 flowing surface cells inside 8 blocks while the lake's SOURCE sits a few
        // blocks lower or further out. That is exactly 17:00:16 on 2026-10-30 at 134,62,579:
        // `bucket still empty at 16 tested cell(s) ... (no SOURCE cell within reach (all flowing))`, then
        // a 4-minute cooldown on the station and the round ended with 0 pours and 0 dug. Widen the scan
        // once before condemning the station - the approach logic below already walks to cells that are
        // outside packet reach and refuses to fill while swimming.
        if (!src.length) {
          const wide = scanWater(16).filter(isFluidSource);
          if (wide.length) { log.info(`obsidian_farm: no source within 8 of ${st.x},${st.y},${st.z} but ${wide.length} source cell(s) further out - widening the fill scan to 16`); cs = wide; src = wide; }
        }
        if (src.length) cs = src; else if (cs.length) log.info('obsidian_farm: every water cell in reach is flowing (level>0) - a bucket cannot take them');
        cs.sort((x, y) => d3(x.position) - d3(y.position));
        try { await bot.equip(bk, 'hand'); } catch {}
        let win = null;
        for (const c of cs.slice(0, 4)) {
          if (countItem(bot, 'water_bucket') > 0) break;
          if (d3(c.position) > 4.5) {
            // Out of packet reach, but the fix is to step closer, not to skip the cell. At 19:57 the farm
            // arrived after a 3-minute trek and found 16 water cells within 8 blocks, every one of them
            // 5.4-6.1 away - so the 4.5 gate refused the entire lake and the round ended
            // `could not fill the bucket` without a single attempt.
            const from = bot.entity.position.floored();
            log.info(`obsidian_farm: ${Math.round(d3(c.position) * 10) / 10} from the water cell - closing in`);
            try {
              await Promise.race([bot.pathfinder.goto(new (GN())(c.position.x, c.position.y, c.position.z, 3)),
                new Promise((_, rej) => setTimeout(() => rej(new Error('approach timed out')), 12000))]);
            } catch (e) { log.info(`obsidian_farm: approach to the water cell: ${e.message}`); }
            if (wetCell(bot)) {
              // Do not fill while swimming: the cave-pool fills at (56,11,743) never once worked, and the
              // bot drowns in the time it takes to click. Back to the dry cell it came from.
              try { await bot.pathfinder.goto(new (GN())(from.x, from.y, from.z, 1)); } catch {}
              continue;
            }
            if (d3(c.position) > 5) { log.info(`obsidian_farm: still ${Math.round(d3(c.position) * 10) / 10} away after the approach - skipping this cell`); continue; }
          }
          try { await bot.lookAt(c.position.offset(0.5, 0.5, 0.5), true); } catch {}
          try { await bot.activateItem(); } catch {}
          await sleep(900);
          if (countItem(bot, 'water_bucket') > 0) { win = c; break; }
        }
        if (countItem(bot, 'water_bucket') < 1) { markSiteFail(st, cs.length ? 'no SOURCE cell within reach (all flowing) - often just the wrong side of the same lake' : 'no water cell in reach', FILL_COOLDOWN_MS); log.warn(`obsidian_farm: bucket still empty at ${cs.length} tested cell(s) around ${st.x},${st.y},${st.z} - trying the next station`); continue; }
        // Remember the station itself: this is the cell that WORKED, which is stronger evidence than a
        // findBlock sighting, and it is what lets the next round pick the same site without hunting.
        // The log names the cell that was actually bucketed, NOT the cached landmark: at 19:14 the site
        // entry says y=-24 while the fill happened in a surface lake at y=64, and printing the landmark
        // made the one successful fill of the session unreadable as evidence.
        try { const p = win ? win.position : bot.entity.position.floored(); oreCache.remember('water', p.x, p.y, p.z); } catch {}
        log.skill(`obsidian_farm: filled the bucket at ${win ? `${win.position.x},${win.position.y},${win.position.z}` : 'an untracked cell'} (station ${st.x},${st.y},${st.z}, bot at y=${Math.round(bot.entity.position.y)})`);
        return true;
      }
      return false;
    };

    let cycles = 0, poured = 0, dug = 0, stop = 'stack complete';
    while (have() < need && cycles < 16) {
      if (Date.now() >= deadline) { stop = 'step deadline'; break; }
      cycles++;
      if (!await fill()) { stop = 'could not fill the bucket'; break; }
      if (!await arrive(pair.lv, 'lava')) { stop = 'could not reach the lava cell at the site';
        // "route blocked" from 40 blocks away and from 2 blocks away are different problems, and the log
        // could not tell them apart (18:56:30 lost the lava cell at 91,-20,900 while the leg before it
        // said `walked 4 legs to 2 blocks of 91,-20,900 (target is same level)`). Name the cells that are
        // actually in the way so the next read is a measurement, not an inference about pathfinding.
        try {
          const me = bot.entity.position.floored(), t = pair.lv;
          const dd = Math.max(1, Math.round(Math.hypot(me.x - t.x, me.y - t.y, me.z - t.z)));
          const blockers = [];
          for (let k = 1; k <= Math.min(6, dd); k++) {
            const r = k / (dd + 1);
            const p = new Vec3(Math.round(me.x + (t.x - me.x) * r), Math.round(me.y + (t.y - me.y) * r), Math.round(me.z + (t.z - me.z) * r));
            const b = bot.blockAt(p);
            if (b && !isAir(b.name)) blockers.push(`${p.x},${p.y},${p.z}=${b.name}`);
          }
          log.warn(`obsidian_farm: arrive failed at ${dd} blocks (stand ${me.x},${me.y},${me.z}) - in the way: ${blockers.length ? blockers.slice(0, 4).join(', ') : 'NOTHING SOLID between, so this is a stand/reach rule, not a wall'}`);
        } catch (e) { log.warn(`obsidian_farm: the arrive diagnosis threw ${String(e.message).slice(0, 60)}`); }
        // Only cool a site whose route failed while we were NEAR it. Failing to cross 700 blocks of
        // coastal ground after a respawn is a statement about the distance, not the lava - and cooling it
        // made the next round choose a different lava, so no approach could ever finish
        // (01:24 118,-9,845 -> 01:28 114,9,774 -> 01:32 118,-9,845, obsidian frozen at 5).
        if (dh(pair.lv) <= 60) markSiteFail(pair.lv, `route blocked from y=${Math.round(bot.entity.position.y)}`);
        else log.info(`obsidian_farm: still ${Math.round(dh(pair.lv))} blocks out on the lava route - keeping the site and walking again next round`);
        log.warn(`obsidian_farm: lost the lava cell at ${pair.lv.x},${pair.lv.y},${pair.lv.z} from y=${Math.round(bot.entity.position.y)}`); break; }
      let ls = [];
      // §26aa/§26bb: the world spawn is ~700 blocks from this pocket, so every death resets the whole
      // approach and the coastal water refuses the route. The player answer is a bed AT the site, and the
      // only moment it can be placed is while standing here. `onlyIfReady` makes forward_base bail
      // instantly when the bed inputs are not already in the pack, so a harvest round can never turn into
      // a wool hunt - the base is a once-only cost, not a new stall.
      if (!bot._bedAtSiteTried && dh(pair.lv) > 250) {
        bot._bedAtSiteTried = true;
        let bst = {};
        try { bst = require('./base').loadBase(); } catch {}
        const near = bst.bed && Math.hypot(bst.bed.x - bot.entity.position.x, bst.bed.z - bot.entity.position.z) < 120;
        if (near) log.info(`obsidian_farm: a bed is already on file at ${bst.bed.x},${bst.bed.y},${bst.bed.z} (within 120) - no need to place another`);
        else {
          let fb = null;
          try { fb = await reg.get('forward_base').run(bot, { onlyIfReady: true, radius: 24 }); } catch (e) { log.warn(`obsidian_farm: forward_base threw ${String(e.message).slice(0, 80)}`); }
          log.skill(`obsidian_farm: bed at the site -> ${fb && fb.ok ? 'SET' : 'not set'}: ${String(fb && fb.observation || 'n/a').slice(0, 150)}`);
        }
      }
      try { ls = bot.findBlocks({ matching: blockIds(bot, ['lava']), maxDistance: 8, count: 16 }).map(p => bot.blockAt(p)).filter(b => b && b.name === 'lava'); } catch { ls = []; }
      // Prefer a lava cell that is INSIDE the pool (>=2 lava neighbours), not the lip with air above it.
      // The air-above rule was mine and my own data refutes it: it steered the pour to 149,52,774 where
      // `no obsidian within 10 after pour` followed twice (22:50:47), while the cells that actually
      // converted (114/115,9-10,771-773 at 22:36-22:38, and 117,9,771 -> obsidian at 20:13) sit in the
      // pool body where the water is held against a source. A poured cell needs the lava beside it, not
      // the sky above it.
      const nbLava = (b) => [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]].filter(([x, y, z]) => {
        const n = bot.blockAt(b.position.offset(x, y, z)); return !!n && /lava/.test(n.name);
      }).length;
      const src0 = ls.filter(isFluidSource);
      // A lava cell is only worth pouring on if the block it creates can be TAKEN: some horizontal
      // neighbour has to be dry air with air above it, i.e. somewhere to stand and breathe while the
      // obsidian breaks. The pool at 112-118,9-10,769-774 is submerged, and every fully underwater
      // conversion has ended the same way - `ABORTED mid-step: out of air (oxygen=2)` at 02:03:31, and a
      // 240 s wet dig that never broke the block at 23:53:31. That is why obsidian has sat at 5 for hours
      // while the chemistry worked: it keeps making blocks it cannot reach with a dry head.
      const breathable = (b) => [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [0, 2], [-2, 0], [0, -2]].some(([dx, dz]) => {
        const st = bot.blockAt(b.position.offset(dx, 0, dz));
        const hd = bot.blockAt(b.position.offset(dx, 1, dz));
        const tp = bot.blockAt(b.position.offset(dx, 2, dz));
        if (!st || !hd || !tp) return false;
        // Either an air cell beside the lava with headroom (a natural rim), or a DRY SOLID block to
        // stand on with two cells of air above - which is what a player actually uses, and what
        // `build_ledge` creates. Without the second half, a shelf the bot built itself was invisible
        // to this test and the site still got cooled.
        if (/water|lava/.test(st.name)) return false;
        if (/water|lava/.test(hd.name) || /water|lava/.test(tp.name)) return false;
        return (isAir(st.name) && isAir(hd.name)) || (st.boundingBox === 'block' && isAir(hd.name) && isAir(tp.name));
      });
      // A source on an open slope is not a pour target: the water runs off before the cell converts.
      // At 19:01:50 the farm poured on 149,52,774 - the y=52 hillside flow the notes already record as
      // "倒了不转化" - after building a shelf beside it and trekking a full bucket, and two seconds later
      // got `pour #1 at 149,52,774 made no obsidian` / `the water met FLOWING lava (cobblestone) or ran
      // off the cell`. Require a BASIN: something solid underneath, and 3+ of the 4 sides solid or lava.
      const contained = (b) => {
        const below = bot.blockAt(b.position.offset(0, -1, 0));
        if (!below || isAir(below.name) || /water|lava/.test(below.name)) return false;
        const walls = [[1, 0], [-1, 0], [0, 1], [0, -1]].filter(([dx, dz]) => {
          const n = bot.blockAt(b.position.offset(dx, 0, dz));
          return !!n && !isAir(n.name) && (n.boundingBox === 'block' || /lava/.test(n.name));
        }).length;
        return walls >= 3;
      };
      const basin = src0.filter(contained);
      const rim = basin.filter(b => nbLava(b) >= 2 && breathable(b));
      const lsrc = (rim.sort((x, y) => d3(x.position) - d3(y.position))[0]
        || basin.filter(b => nbLava(b) >= 2).sort((x, y) => d3(x.position) - d3(y.position))[0]
        || basin.sort((x, y) => nbLava(y) - nbLava(x) || d3(x.position) - d3(y.position))[0]);
      if (!lsrc && src0.length) {
        log.warn(`obsidian_farm: ${src0.length} lava source(s) in reach but NOT ONE is a basin (open slope - water runs off and only makes cobblestone). Spending the bucket here is a guaranteed loss; cooling the site for ${Math.round(SITE_WEDGE_COOLDOWN_MS / 60000)} min so the next round scores an underground pool`);
        markSiteFail(pair.lv, 'every source here is an open slope - pouring makes cobblestone', SITE_WEDGE_COOLDOWN_MS);
        stop = 'no contained lava source at this pool';
        break;
      }
      if (lsrc && !rim.includes(lsrc)) {
        // No dry standing cell beside any source yet. Before giving the site up, build one: this is the
        // move that turns "the pool is submerged" from a verdict into a task, and obsidian sat at 5/10
        // for five hours while the only answer was to cool the site and re-choose it next round.
        let bl = null;
        try { bl = await reg.get('build_ledge').run(bot, { x: lsrc.position.x, y: lsrc.position.y, z: lsrc.position.z, radius: 8 }); } catch (e) { log.warn(`obsidian_farm: build_ledge threw ${String(e.message).slice(0, 90)}`); }
        log.skill(`obsidian_farm: shelf attempt beside the submerged source -> ${bl && bl.ok ? 'ok' : 'failed'}: ${String(bl && bl.observation || 'no answer').slice(0, 150)}`);
        if (!bl || !bl.ok) {
          // A failed NEW shelf build is only a verdict if no shelf is already standing here. The one at
          // 113,9,775 (18:22:41 `dry work shelf ... obsidian here can be taken`) outlived the step that
          // lost its budget before the pour - and the pool was then cooled for 25 minutes as
          // "no shelf could be built", throwing away the only demonstrated workable interface while the
          // next rounds hunted walled-in sources at 118,-9,845 / 125,40,858.
          let shelf = null;
          try { shelf = JSON.parse(fs.readFileSync(path.join(cfg.paths.runs, 'shelf.json'), 'utf8')); } catch { shelf = null; }
          const gap = shelf ? Math.hypot(shelf.x - lsrc.position.x, shelf.y - lsrc.position.y, shelf.z - lsrc.position.z) : Infinity;
          if (shelf && gap <= 14 && Date.now() - shelf.ts < 45 * 60000) {
            log.warn(`obsidian_farm: no new shelf could be built, but the shelf at ${shelf.x},${shelf.y},${shelf.z} still stands ${Math.round(gap)} from this source - re-arming in 2 min (not a structural strike) instead of burying the pool for 25`);
            coolSiteOnly(pair.lv, 2 * 60000);
            stop = `shelf at ${shelf.x},${shelf.y},${shelf.z} is the way in - come back through it`;
            break;
          }
          markSiteFail(pair.lv, `${src0.length} lava source(s) in reach, none with a dry stand, and the shelf build failed (${String(bl && bl.observation || 'skill missing').slice(0, 90)})`);
          stop = 'the site pool is submerged and no shelf could be built';
          log.warn(`obsidian_farm: ${lsrc.position.x},${lsrc.position.y},${lsrc.position.z} is a source but every neighbour is water or solid - not pouring where the block cannot be taken`);
          break;
        }
      }
      if (!lsrc) { log.warn(`obsidian_farm: no lava SOURCE cell within 8 (${ls.length} lava cells, all flowing or out of reach) - flowing lava + water gives cobblestone, not obsidian`); stop = 'no lava source at the site'; markSiteFail(pair.lv, "in reach but every cell flows - water on flowing lava makes cobblestone"); break; }
      if (d3(lsrc.position) > 4.5) { log.info(`obsidian_farm: ${Math.round(d3(lsrc.position) * 10) / 10} from the lava source - stepping in`); try { await bot.pathfinder.goto(new (GN())(lsrc.position.x, lsrc.position.y + 1, lsrc.position.z, 2)); } catch {} }
      if (d3(lsrc.position) > 5) { stop = 'cannot stand close enough to the lava source'; log.warn(`obsidian_farm: lava source at ${lsrc.position.x},${lsrc.position.y},${lsrc.position.z} stayed out of reach - the near side is probably a hole; approach from the other bank`); break; }
      const wb = bot.inventory.items().find(i => i.name === 'water_bucket');
      if (!wb) { continue; }
      try { await bot.equip(wb, 'hand'); } catch {}
      if (!bot.heldItem || bot.heldItem.name !== 'water_bucket') { log.warn(`obsidian_farm: hand holds ${bot.heldItem ? bot.heldItem.name : 'nothing'}, not the water bucket`); continue; }
      const before = have();
      // Aim the cell itself first (that is the pour that emptied the bucket at 15:12/16:04), then the
      // air above it - water dropped on top of a source cell also converts it.
      for (const aim of [[0.5, 0.5, 0.5], [0.5, 1.5, 0.5]]) {
        try { await bot.lookAt(lsrc.position.offset(aim[0], aim[1], aim[2]), true); } catch {}
        try { await bot.activateItem(); } catch {}
        await sleep(1200);
        if (countItem(bot, 'water_bucket') < 1) break;
      }
      if (countItem(bot, 'water_bucket') > 0) { log.warn(`obsidian_farm: pour at ${lsrc.position.x},${lsrc.position.y},${lsrc.position.z} left water_bucket still 1 - the aim never hit the cell`); stop = 'pour refused'; break; }
      poured++;
      log.skill(`obsidian_farm: poured on lava ${lsrc.position.x},${lsrc.position.y},${lsrc.position.z} (bucket 1 -> 0)`);
      await sleep(1800);
      // The head-in-water case: a pour in a cave raises the level around the bot and the dig then runs
      // submerged, which is ~5x slower and drowns the bot before the block breaks.
      // (No step-up onto the lava cell here: it moved the bot INTO the pool. The bank climb in
      // standDryNear now happens against the obsidian cell itself, right before the dig.)
      let made = [];
      try { made = bot.findBlocks({ matching: blockIds(bot, ['obsidian']), maxDistance: 10, count: 12 }).map(p => bot.blockAt(p)).filter(b => b && b.name === 'obsidian'); } catch { made = []; }
      if (!made.length) {
        // Two different failures wore the same sentence all evening: the water never reached the cell
        // (bad aim / bad stand) versus the cell was not a real source (slope flow -> cobblestone). The
        // aimed cell's own name after the pour tells them apart, so ask it: 19:55:03 `pour #1 at
        // 98,26,383 made no obsidian` is the third strike on that pool and the log still could not say
        // which of the two it was.
        const became = (() => { try { const b = bot.blockAt(lsrc.position); return b ? b.name : 'unloaded'; } catch { return 'probe threw'; } })();
        const around = (() => { try { const cs = bot.findBlocks({ matching: blockIds(bot, ['cobblestone', 'stone', 'water']), maxDistance: 6, count: 10 }); const m = {}; for (const p of cs) { const b = bot.blockAt(p); if (b) m[b.name] = (m[b.name] || 0) + 1; } return JSON.stringify(m); } catch { return '{}'; } })();
        markSiteFail(pair.lv, `pour #${poured} at ${lsrc.position.x},${lsrc.position.y},${lsrc.position.z} made no obsidian (the aimed cell now reads ${became}, within 6: ${around})`);
        log.warn(`obsidian_farm: no obsidian within 10 after pour #${poured} - the aimed cell now reads ${became} and the neighbourhood is ${around}; ${/lava/.test(became) ? 'the water NEVER reached the source (aim/stand is wrong, the pool may still be fine)' : /cobblestone|stone/.test(became) ? 'water met FLOWING lava - this pool is a slope, not an interface' : /water/.test(became) ? 'the cell is water now - the pour landed but the lava it met was not a source' : `the cell is ${became}`}`);
        continue;
      }
      // The pour converted: this pair is now demonstrated, so remember it (station included - the next
      // round needs the fill cell as much as the lava cell).
      rememberPair(pair.lv, pair.wv);
      // Take the pour back off the cell (the water sitting on the converted block is a source): this is
      // the difference between "one bucket per site" and a player who keeps walking with a full bucket.
      try { await reclaim(lsrc.position); } catch (e) { log.warn(`obsidian_farm: reclaim threw ${String(e.message).slice(0, 50)}`); }
      // Write the new block into the terrain memory. `make_obsidian` has a field-hop that travels to a
      // remembered obsidian cell and digs it, and that is the only path which can come back for a cell
      // this round cannot finish: 22:26:38 shows `1 pour(s), 0 dug` - the conversion succeeded and then
      // the bot walked 100 blocks to refill, so the block it had made was never scanned again.
      try { for (const b of made) oreCache.remember('obsidian', b.position.x, b.position.y, b.position.z); } catch {}
      const tgt = made.sort((x, y) => d3(x.position) - d3(y.position))[0];
      // Get onto the bank first: the pool this cell sits in is water-filled, and a floating dig is an
      // aborted dig (240 s of cap burned on 112,9,772 at 23:53 with `wet=Y`).
      await standDryNear(tgt);
      // Obsidian needs DIAMOND tier: iron/stone break it slowly and drop nothing. The generic
      // equipPick takes "best pick with >=8 digs left", which can be a stone pick, and its
      // hotbar shortcut returns true without proving the hand changed - so verify the held item here
      // with the quickbar fallback (mineflayer's 1.21 equip can stall on the ack for a picked slot).
      // Guard the world/pack state before spending minutes on a dig. 00:36:17 shows why: the drowning
      // preemption had aborted this very step at 00:35:28, the worker kept going anyway, and the dig
      // resolved in 1 ms with `dpick@null%` - `null` wear means the pickaxe is no longer in the pack
      // (a respawn took the snapshot with it), so `bot.dig` was a no-op against a block list that had
      // already gone stale.
      if (!bot.inventory.items().some(i => i.name === 'diamond_pickaxe' || i.name === 'netherite_pickaxe')) {
        stop = 'diamond pick no longer in the pack after a death/respawn';
        log.warn(`obsidian_farm: the pack no longer holds a diamond pick (items=${bot.inventory.items().length}) - stopping this round instead of no-op digging`);
        break;
      }
      if (d3(tgt.position) > 4.6) {
        // standDryNear deliberately leaves the bank; a dig beyond reach resolves instantly and does nothing.
        log.info(`obsidian_farm: bank is ${Math.round(d3(tgt.position) * 10) / 10} from ${tgt.position.x},${tgt.position.y},${tgt.position.z} - stepping in before the dig`);
        try { await bot.pathfinder.goto(new (GN())(tgt.position.x, tgt.position.y, tgt.position.z, 4)); } catch {}
        if (d3(tgt.position) > 5) { log.warn(`obsidian_farm: cannot get within reach of ${tgt.position.x},${tgt.position.y},${tgt.position.z} (still ${Math.round(d3(tgt.position))}b) - keeping it for a round that can stand there`); continue; }
      }
      const okHeld = () => !!(bot.heldItem && (bot.heldItem.name === 'diamond_pickaxe' || bot.heldItem.name === 'netherite_pickaxe'));
      if (!okHeld()) {
        const dp = bot.inventory.items().find(i => (i.name === 'diamond_pickaxe' || i.name === 'netherite_pickaxe')
          && ((i.maxDurability || 999) - (i.durabilityUsed || 0)) >= 8);
        if (!dp) { log.warn(`obsidian_farm: no diamond-tier pick with 8 digs of life left (hand=${bot.heldItem ? bot.heldItem.name : 'nothing'}) - obsidian would drop nothing`); stop = 'no diamond pick'; break; }
        for (let t = 0; t < 3 && !okHeld(); t++) {
          try { await bot.equip(dp, 'hand'); } catch {}
          if (!okHeld() && dp.slot >= 36 && dp.slot <= 44) { try { await bot.setQuickBarSlot(dp.slot - 36); } catch {} }
          if (!okHeld()) await sleep(500);
        }
      }
      if (!okHeld()) { log.warn(`obsidian_farm: hand still holds ${bot.heldItem ? bot.heldItem.name : 'nothing'} after 3 equips - not spending 9 s on a dig that cannot drop`); stop = 'no pick in hand'; break; }
      const held = bot.heldItem ? bot.heldItem.name : 'nothing';
      const held0 = bot.heldItem ? bot.heldItem.name : 'nothing';
      // The dig window has to cover the underwater penalty. At 20:13:44 the pour had just made a real
      // obsidian cell at 117,9,772 and the 40 s cap cut the break off mid-way: obsidian is 9.4 s with a
      // diamond pick DRY and ~5x slower with the head in water (the bot had air=5 in the same minute),
      // so the fixed 40 s was always going to lose. Size it on the measured dig time and give the wet
      // case room, then log what the dig actually cost so the next read is measured, not guessed.
      const digMs = Math.min(150000, Math.max(45000, (bot.digTime ? bot.digTime(tgt) : 9400) * (wetCell(bot) ? 4 : 3)));
      // Never start a dig while the water is pushing the bot: 07:28:02 -> 07:30:24 burned the FULL 150 s
      // cap on 112,9,772 and the block was still there (`Digging aborted` at 07:30:25) because the shelf
      // it was standing on sat AT the water surface line - flow moves the player, and any move aborts
      // the dig at its very start. Re-stand once; if that fails, give the cell up rather than paying the
      // cap again (the round hands back, the stage lock sees the failure, and `build_ledge` now builds
      // above the surface).
      if (wetCell(bot)) {
        const w = bot.entity.position.floored();
        log.warn(`obsidian_farm: standing in water at ${w.x},${w.y},${w.z} before digging ${tgt.position.x},${tgt.position.y},${tgt.position.z} - re-standing dry first`);
        try { await standDryNear(bot, tgt.position); } catch {}
        if (wetCell(bot)) { stop = 'cannot reach the obsidian from a dry standing cell - the pool needs a higher shelf'; log.warn(`obsidian_farm: still wet after re-standing - giving this cell up instead of burning another ${Math.round(digMs / 1000)}s`); break; }
      }
      // Breathe before the dig. A submerged dig lasts 45-150 s while the air meter gives ~10 bubbles of
      // grace: 16 steps on 2026-10-30 ended at `out of air (oxygen=2)` MID-dig, losing both the round and
      // the block, and the trend showed the bot working on at air=6-20 for minutes. This is the consumer
      // of planner's LOW AIR warning. Deliberately `standDryNear` (local, bounded) and not
      // `recover_surface` - the assisted instance teleports to remembered dry land, which once threw the
      // bot 700 blocks backwards from the very site it was working (§26dd).
      if (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel >= 0 && bot.oxygenLevel <= 6) {
        log.warn(`obsidian_farm: ${bot.oxygenLevel} bubbles left before a ${Math.round(digMs / 1000)}s dig at ${tgt.position.x},${tgt.position.y},${tgt.position.z} - standing dry to breathe first`);
        try { await standDryNear(bot, tgt.position); } catch {}
        if (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel <= 6 && wetCell(bot)) {
          stop = 'no dry standing cell with enough breath to take this obsidian - the pool needs a higher shelf';
          log.warn('obsidian_farm: still short of breath and wet after the re-stand - giving the cell up rather than drowning on it');
          break;
        }
      }
      const tDig = Date.now();
      try { await Promise.race([bot.dig(tgt), new Promise((_, rej) => setTimeout(() => rej(new Error(`dig did not finish in ${Math.round(digMs / 1000)}s`)), digMs))]); } catch (e) { log.warn(`obsidian_farm: dig at ${tgt.position.x},${tgt.position.y},${tgt.position.z}: ${e.message}`); }
      log.skill(`obsidian_farm: dig attempt on ${tgt.position.x},${tgt.position.y},${tgt.position.z} took ${Date.now() - tDig}ms (cap ${Math.round(digMs / 1000)}s, wet=${wetCell(bot) ? 'Y' : 'n'}, hand=${held0})`);
      await sleep(500);
      const check = bot.blockAt(tgt.position);
      if (check && check.name === 'obsidian') {
        log.warn(`obsidian_farm: ${tgt.position.x},${tgt.position.y},${tgt.position.z} is still obsidian after the dig - the break never registered, keeping the cell`);
      } else {
        // The item has to be TOUCHED, not just collected by packet: a block broken at foot level in a
        // cave leaves its drop on the ledge the bot is standing on, and 22:38:04 shows exactly this -
        // `dig attempt took 75059ms` with the diamond pick in hand and free=4 slots, yet
        // `dug obsidian 115,9,771 -> 5 -> 5`. Walk onto the cell, then let the pickup settle.
        try { await bot.pathfinder.goto(new (GN())(tgt.position.x, tgt.position.y, tgt.position.z, 1)); } catch {}
        await sleep(1200);
        if (!(await P.collectNear(bot, tgt.position, 'obsidian'))) log.warn(`obsidian_farm: broke ${tgt.position.x},${tgt.position.y},${tgt.position.z} and could not pick the drop up`);
        await sleep(600);
      }
      const after = have();
      log.skill(`obsidian_farm: dug obsidian ${tgt.position.x},${tgt.position.y},${tgt.position.z} -> ${before} -> ${after} (held=${held} dpick@${ob.wear(bot, bot.heldItem)}%)`);
      if (after > before) { dug += after - before; } else {
        // Only forget a cell the world says is gone. At 20:13 the dig was cut off by MY 40 s cap and
        // this line deleted the fresh obsidian at 117,9,772 - the block was still there, still the best
        // target in the cave, and losing it sent the next round looking for a new pour site.
        const still_ = bot.blockAt(tgt.position);
        if (still_ && still_.name === 'obsidian') log.warn(`obsidian_farm: ${tgt.position.x},${tgt.position.y},${tgt.position.z} is STILL obsidian (my dig did not finish) - keeping it on the menu`);
        else { try { oreCache.forget(tgt.position.x, tgt.position.y, tgt.position.z); } catch {} }
      }
    }
    if (have() < need && stop === 'stack complete') stop = `cycle cap (${cycles})`;
    const ok = have() >= need;
    log.skill(`obsidian_farm: ${ok ? 'DONE' : 'short'} - obsidian=${have()}/${need} after ${cycles} cycle(s), ${poured} pour(s), ${dug} dug (stop: ${stop})`);
    return { ok, observation: `obsidian ${have()}/${need}; ${poured} pours, ${dug} dug at site ${pair.wv.x},${pair.wv.y},${pair.wv.z}+${pair.lv.x},${pair.lv.y},${pair.lv.z}; stopped: ${stop}` };
  },
});

reg.define('make_obsidian', {
  desc: 'Create obsidian by pouring a water bucket on a lava pool, then mine with a diamond/iron pick. `count` is the TOTAL number of obsidian the pack must end up holding (a Nether portal frame costs 10, so a portal plan needs count>=10 - asking for 3 while holding 5 returns immediately).',
  params: { count: 'int default 10 - total obsidian to hold, not extra blocks' },
  async run(bot, a) {
    const need = a.count ?? 10;
    let bucketBlocked = false;
    const have = countItem(bot, 'obsidian');
    if (have >= need) return { ok: true, observation: `obsidian=${have}` };
    // Harvest first. Natural obsidian (lava that met water underground) needs no bucket and no pour,
    // and an earlier round that timed out often leaves cells right here: at 11:04 `inspect` counted
    // 4 cells in one look while the skill was busy hunting lava. mineObsidianField is declared below
    // and hoisted to the top of this scope.
    await mineObsidianField(32, 'natural');
    if (countItem(bot, 'obsidian') >= need) return { ok: true, observation: `obsidian=${countItem(bot, 'obsidian')} harvested from the field already here (no pour needed)` };
    // Without a diamond-tier pick, obsidian cannot be collected however well the pour goes, so this
    // round must not spend its remaining budget hunting lava, filling buckets and converting blocks it
    // cannot break. Measured 21:19-21:27: obsidian frozen at 5 with dpick=0 the entire time, because the
    // re-mint gate only runs at the START of a round. Handing back early is what gets a new pick sooner.
    if (!bot.inventory.items().some(i => (i.name === 'diamond_pickaxe' || i.name === 'netherite_pickaxe')
      && ((i.maxDurability || 999) - (i.durabilityUsed || 0)) >= 12)) {
      const havePicks = bot.inventory.items().filter(i => /pickaxe/.test(i.name)).map(i => `${i.name}@${ob.wear(bot, i)}%`).join(',') || 'no pickaxe at all';
      log.warn(`make_obsidian: giving the round back - no diamond-tier pick to collect obsidian with (have ${havePicks})`);
      return { ok: false, observation: `no diamond-tier pickaxe (have ${havePicks}) - obsidian cannot be collected; re-mint the pick, then come back to the ${countItem(bot, 'obsidian')}/${need} stack` };
    }
    {
      // Travel to a remembered field BEFORE starting the bucket economy. One pour costs a whole bucket
      // and one bucket costs a trip to the surface: measured 15:07-15:13, the bot found lava at
      // 54,-27,714, climbed ~70 blocks to fill at 127,62,858, poured once onto flowing lava (cobble),
      // and the round ended with obsidian=2. A known field is 12 digs with no travel at all.
      const field = oreCache.nearest(['obsidian'], bot.entity.position);
      if (field) {
        if (Math.hypot(field.x - bot.entity.position.x, field.z - bot.entity.position.z) > 12) {
          log.skill(`make_obsidian: remembered field at ${field.x},${field.y},${field.z} (${Math.round(field.dist)} away) - travelling to its column first`);
          const w = await reg.get('walk_to').run(bot, { x: field.x, y: bot.entity.position.y, z: field.z, tolerance: 10 });
          log.skill(`make_obsidian: field hop (${String(w.observation).slice(0, 140)})`);
        }
        if (bot.entity.position.y > field.y + 18) {
          for (let k = 0; k < 3 && bot.entity.position.y > field.y + 6; k++) {
            const yB = Math.round(bot.entity.position.y);
            await reg.get('deep_shaft').run(bot, { toY: field.y, max: 45 });
            if (Math.round(bot.entity.position.y) >= yB - 1) break;
          }
        }
        await mineObsidianField(32, 'field-hop');
        // One line that settles whether the cached coordinate is a real block or a stale map cell:
        // ask what the world says is there right now, from here.
        try { const at = bot.blockAt(new Vec3(field.x, field.y, field.z)); log.info(`make_obsidian: standing at ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)}; the remembered cell ${field.x},${field.y},${field.z} reads "${at ? at.name : 'unloaded'}"`); } catch {}
        if (countItem(bot, 'obsidian') >= need) return { ok: true, observation: `obsidian=${countItem(bot, 'obsidian')} from the remembered field at ${field.x},${field.y},${field.z}` };
        // Still above the field: spend the rest of the round getting there rather than starting a
        // bucket trip that ends 60 blocks away. Paper keeps the player's coordinates across a
        // reconnect, so "call me again" is real incremental progress, not a retry from zero.
        if (bot.entity.position.y > field.y + 12) {
          // Digging only makes sense when we are ABOVE the field. At 01:03:59 and 01:07:14 the bot stood
          // at (12,62,38) / (23,62,71) - about 700 blocks away in z, having been pulled back to its spawn
          // point by the hunger recovery - and this branch sank a shaft under its own feet, hit water,
          // and then reported "dug down to the obsidian field at 111,9,770". Travel first, dig second.
          const lat = Math.hypot(bot.entity.position.x - field.x, bot.entity.position.z - field.z);
          if (lat > 8) {
            const wt = await reg.get('walk_to').run(bot, { x: field.x, y: Math.max(bot.entity.position.y, 60), z: field.z, tolerance: 6 });
            log.info(`make_obsidian: field is ${Math.round(lat)} blocks away horizontally - travelling to its column first (${String(wt && wt.observation).slice(0, 90)})`);
          }
          const lat2 = Math.hypot(bot.entity.position.x - field.x, bot.entity.position.z - field.z);
          if (lat2 <= 10) {
          // "Call me again" was the old behavior and it looped for half the night: at 00:09:32 the bot
          // stood at x=116,z=770 - directly ABOVE the obsidian it had converted at 115,9,771 - 57 blocks
          // up, returned without cutting a single block, and the next round started by trekking to a lava
          // pool again. The field is a coordinate, not a rumour: dig down to it now.
          const yTarget = field.y + 1;
          for (let s = 0; s < 6 && bot.entity.position.y > yTarget && Date.now() < (bot._stepDeadline || Infinity); s++) {
            const yB = Math.round(bot.entity.position.y);
            const dz = await reg.get('deep_shaft').run(bot, { toY: yTarget, max: 24 });
            if (wetCell(bot) || /WATER|FLOOD/i.test(String(dz && dz.observation || ''))) {
              log.warn(`make_obsidian: shaft toward the field hit water at y=${Math.round(bot.entity.position.y)} (${String(dz && dz.observation).slice(0, 70)}) - leaving the rest of the descent to the next round`);
              break;
            }
            if (Math.abs(Math.round(bot.entity.position.y) - yB) < 2) { log.warn(`make_obsidian: descent toward the field stalled at y=${yB} (${String(dz && dz.observation).slice(0, 70)})`); break; }
          }
          await mineObsidianField(16, 'field-descend');
          if (countItem(bot, 'obsidian') >= need) return { ok: true, observation: `obsidian=${countItem(bot, 'obsidian')} dug out of the remembered field at ${field.x},${field.y},${field.z}` };
          return { ok: false, observation: `dug down to the obsidian field at ${field.x},${field.y},${field.z} (now y=${Math.round(bot.entity.position.y)}); still ${countItem(bot, 'obsidian')}/${need}` };
          }
          return { ok: false, observation: `the obsidian field at ${field.x},${field.y},${field.z} is ${Math.round(lat2)} blocks away horizontally (I am at ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)}) - walk_to did not close the column; do not dig here` };
        }
      }
    }
    // Ruined portals are 20-40 blocks of obsidian sitting AT SURFACE LEVEL: no bucket, no lava
    // search, no flooded cave, no 5x underwater mining penalty. The model itself planned this twice
    // ("surface, roam to ruined portal obsidian, mine with diamond pick" at 16:31 and 16:47) but no
    // code path actually roamed for obsidian, so every round went back through the bucket economy
    // and failed it. Roaming also populates the field memory the hop above uses.
    if (countItem(bot, 'obsidian') < need) {
      let seenObs = [];
      try { seenObs = bot.findBlocks({ matching: blockIds(bot, ['obsidian']), maxDistance: 48, count: 3 }); } catch { seenObs = []; }
      // Only roam when nothing is already known. The 500-block roam added at 16:49 is what put the bot
      // at z=359 (17:49) while its remembered obsidian field and 8 lava pools all sit near z=690-790:
      // it wandered 400 blocks away from the resources it had found, and every round since has spent
      // itself travelling. And the radius is halved so even a real search stays recoverable.
      const known = oreCache.nearest(['obsidian', 'lava'], bot.entity.position);
      if (!seenObs.length && !known) {
        log.skill('make_obsidian: no obsidian in sight and nothing remembered - roaming for a ruined portal (surface obsidian needs no bucket at all)');
        try { await reg.get('roam').run(bot, { block: 'obsidian', distance: 220 }); } catch (e) { log.warn(`make_obsidian: obsidian roam threw ${e.message}`); }
      } else if (!seenObs.length && known) {
        log.info(`make_obsidian: not roaming - ${known.name} is already remembered at ${known.x},${known.y},${known.z} (${Math.round(known.dist)} blocks)`);
      }
      // Drops need somewhere to land: at 16:47 the pack held 111 cobblestone + 121 deepslate with
      // four free slots, and a broken block with no slot is a lost block.
      if (P.freeSlots(bot) < 3) await P.dropJunk(bot, true, 8);
      await mineObsidianField(40, 'roamed');
      if (countItem(bot, 'obsidian') >= need) return { ok: true, observation: `obsidian=${countItem(bot, 'obsidian')} from surface/ruined-portal obsidian (no pour)` };
    }
    if (countItem(bot, 'water_bucket') < 1) {
      // The bucket is consumed by portal/obsidian work and lost on deaths, and this step used to
      // just refuse. Craft one and fill it from the nearest water, digging down if the surface is dry.
      if (!countItem(bot, 'bucket')) await require('./primitives').craft(bot, 'bucket', 1);
      const bk = bot.inventory.items().find(i => i.name === 'bucket');
      if (!bk) return { ok: false, observation: `no bucket and cannot craft one (iron_ingot=${countItem(bot, 'iron_ingot')}) - smelt iron first` };
      let water = bot.findBlock({ matching: blockIds(bot, ['water']), maxDistance: 40 });
      if (!water) {
        // Water is everywhere at sea level, so WALK to the shoreline first. Digging straight down
        // for an aquifer got the bot killed (6 deaths in 7 minutes: deepslate mobs, falls, lava).
        const trip = await reg.get('roam').run(bot, { block: 'water', distance: 400 });
        log.skill(`roaming to water: ${trip.observation}`);
        water = bot.findBlock({ matching: blockIds(bot, ['water']), maxDistance: 40 });
      }
      if (!water) {
        // Deep in our own shaft (y=-40 at 09:51) the search can never succeed: the aquifer roam
        // reported was 45 blocks away at y=-22 and a straight dig cannot path there. A miner walks
        // out to the nearest surface water and comes back with a full bucket, so climb first.
        if (bot.entity.position.y < 5) {
          log.skill(`no water within 40 blocks at y=${Math.round(bot.entity.position.y)} - climbing out to find surface water`);
          try { await reg.get('recover_surface').run(bot, {}); } catch (e) { log.warn(`recover_surface threw ${e.message}`); }
          const trip2 = await reg.get('roam').run(bot, { block: 'water', distance: 400 });
          log.skill(`surface water: ${trip2.observation}`);
          water = bot.findBlock({ matching: blockIds(bot, ['water']), maxDistance: 48 });
        }
      }
      if (!water) {
        for (const toY of [40, 20]) {
          if (bot.entity.position.y <= toY + 2) continue;
          log.skill(`still no water within 40 blocks at y=${Math.round(bot.entity.position.y)} - descending to y=${toY} to fill the bucket`);
          await reg.get('deep_shaft').run(bot, { toY, max: 30 });
          await sleep(1000);
          water = bot.findBlock({ matching: blockIds(bot, ['water']), maxDistance: 40 });
          if (water) break;
        }
      }
      if (!water) {
        // Same rule as the fill failure below: no water must not end the round, or the bot never
        // descends and never finds the obsidian it needs (15:48-15:54: three rounds, same message).
        bucketBlocked = true;
        log.warn(`make_obsidian: bucket is empty and no water source was found within 40 blocks at y=${Math.round(bot.entity.position.y)} - skipping the pour and continuing`);
      }
      try {
        // Walk into reach of found water first when it sits in the 8..40 block band: previously findBlock
        // succeeded at ~17 blocks (so roam skipped), then the <=12 filter discarded every candidate, leaving
        // cands=[] and walking 160 blocks to lava with an EMPTY bucket!
        if (water && bot.entity.position.distanceTo(water.position) > 8 && bot.entity.position.distanceTo(water.position) <= 42) {
          log.skill(`make_obsidian: walking ${Math.round(bot.entity.position.distanceTo(water.position))} blocks to water at ${water.position.x},${water.position.y},${water.position.z} to fill bucket`);
          try {
            await capped(bot.pathfinder.goto(new (GN())(water.position.x, water.position.y + 1, water.position.z, 2)), 20000, 'walk to water source');
          } catch {}
        }
        // Filter strictly to reachable level-0 water SOURCES BEFORE slicing to 4 (otherwise 4 nearby
        // flowing waterfall cells at y=30 crowd out every real source and leave cands non-empty with
        // unfillable flowing cells, preventing the climb-out to surface water).
        let cands = [];
        try {
          const nearW = bot.findBlocks({ matching: blockIds(bot, ['water']), maxDistance: 40, count: 64 })
            .map(p => bot.blockAt(p))
            .filter(b => b && b.name === 'water'
              && bot.entity.position.distanceTo(b.position) <= 32
              && Math.abs(b.position.y - bot.entity.position.y) <= 10);
          const srcW = nearW.filter(isFluidSource);
          if (!srcW.length && nearW.length) {
            log.info(`make_obsidian: all ${nearW.length} nearby water cells at this level are flowing (level>0) - need a real source`);
          }
          cands = srcW
            .sort((a, b) => {
              const ao = (() => { const ab = bot.blockAt(a.position.offset(0, 1, 0)); return !ab || isAir(ab.name) ? 0 : (ab.name === 'ice' ? 1 : 2); })();
              const bo = (() => { const ab = bot.blockAt(b.position.offset(0, 1, 0)); return !ab || isAir(ab.name) ? 0 : (ab.name === 'ice' ? 1 : 2); })();
              return ao - bo || bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position);
            })
            .slice(0, 4);
        } catch { cands = []; }
        if (!cands.length && water && isFluidSource(water)
          && bot.entity.position.distanceTo(water.position) <= 32
          && Math.abs(water.position.y - bot.entity.position.y) <= 10) cands = [water];
        // Sources first. `drainable` is undefined on this mineflayer (measured 11:33:10), so use the
        // terrain definition of a source: something solid beneath it and no water above.
        const srcScore = (b) => {
          const below = bot.blockAt(b.position.offset(0, -1, 0));
          const above = bot.blockAt(b.position.offset(0, 1, 0));
          return (below && below.name !== 'water' && !isAir(below.name) ? 2 : 0) + (above && above.name !== 'water' ? 1 : 0);
        };
        cands.sort((a, b) => srcScore(b) - srcScore(a));
        // Feet cell FIRST again, on evidence: the only three fills that ever worked (14:14 -37,62,770,
        // 14:57 2,62,675, 15:12 127,62,858) happened with this ordering, and since moving it last the
        // fill has succeeded zero times (16:26-16:35). The submerged failure at (56,11,743) was a
        // flowing cave pool, which the level-0 filter above now removes anyway.
        const feetW = bot.blockAt(bot.entity.position.floored());
        if (feetW && feetW.name === 'water' && isFluidSource(feetW)) cands = [feetW, ...cands.filter(c => c !== feetW)];
        // Underground (y < 56) with no reachable level-0 water source at this level: climb out to the
        // surface lakes/ocean to fill the bucket cleanly instead of looping on flowing cave waterfalls.
        if (!cands.length && bot.entity.position.y < 56) {
          log.warn(`make_obsidian: no level-0 water source reachable at y=${Math.round(bot.entity.position.y)} (nearest ${water ? `${water.position.x},${water.position.y},${water.position.z}` : 'none'}) - climbing out to fill the bucket`);
          try { await reg.get('recover_surface').run(bot, {}); } catch (e) { log.warn(`make_obsidian: recover_surface on the way to water threw ${e.message}`); }
          try { await reg.get('roam').run(bot, { block: 'water', distance: 200 }); } catch {}
          try {
            cands = bot.findBlocks({ matching: blockIds(bot, ['water']), maxDistance: 40, count: 64 })
              .map(p => bot.blockAt(p))
              .filter(b => b && b.name === 'water' && isFluidSource(b) && bot.entity.position.distanceTo(b.position) <= 32)
              .sort((a, b) => {
                // Prefer open-air surface water over water sealed under ice/stone!
                const aAbove = bot.blockAt(a.position.offset(0, 1, 0));
                const bAbove = bot.blockAt(b.position.offset(0, 1, 0));
                const aOpen = !aAbove || isAir(aAbove.name) ? 0 : (aAbove.name === 'ice' ? 1 : 2);
                const bOpen = !bAbove || isAir(bAbove.name) ? 0 : (bAbove.name === 'ice' ? 1 : 2);
                return aOpen - bOpen || bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position);
              })
              .slice(0, 6);
          } catch { cands = []; }
          if (!cands.length) { const here2 = bot.blockAt(bot.entity.position.floored()); if (here2 && here2.name === 'water' && isFluidSource(here2)) cands = [here2]; }
        }
        const fillBudgetEnd = Date.now() + 75000; // a bucket is worth 75 s of this step, not 400
        for (const cand of cands) {
          if (countItem(bot, 'water_bucket') > 0) break;
          if (Date.now() >= Math.min(fillBudgetEnd, bot._stepDeadline || Infinity)) { log.warn(`make_obsidian: bucket budget (75 s) used up after ${cands.length} candidate(s) - giving up on filling this round`); break; }
          if (bot.entity.position.distanceTo(cand.position) > 4) try {
            await Promise.race([
              bot.pathfinder.goto(new (GN())(cand.position.x, cand.position.y + 1, cand.position.z, 1)),
              new Promise((_, rej) => setTimeout(() => rej(new Error('goto water timed out')), 20000)),
            ]);
          } catch {}
          // Only try the packets if we actually got there. At 14:55 all four candidates were "tried"
          // from 8-12 blocks away (the 20 s goto never arrived over the hillside), so the skill
          // reported a flow problem when the truth was that the bot had never reached the water.
          if (bot.entity.position.distanceTo(cand.position) > 4.5) { log.info(`make_obsidian: still ${Math.round(bot.entity.position.distanceTo(cand.position) * 10) / 10} blocks from the water cell - not attempting the fill`); continue; }
          // In frozen biomes, y=61 water sits under a solid y=62 ice block that blocks the bucket raycast
          // (live 11:40:39-45: 4x "bucket still empty at source water -52,61,-245"). Breaking the ice turns
          // y=62 itself into an open-air water source block!
          let fillTarget = cand;
          try {
            const cover = bot.blockAt(cand.position.offset(0, 1, 0));
            if (cover && cover.name === 'ice') {
              try { await equipBulkPick(bot, false); await bot.dig(cover); await sleep(250); } catch {}
              const thawed = bot.blockAt(cover.position);
              if (thawed && thawed.name === 'water' && isFluidSource(thawed)) fillTarget = thawed;
            }
          } catch {}
          try { await bot.equip(bk, 'hand'); } catch (e) { log.warn(`fill bucket equip threw ${e.message}`); }
          if (!bot.heldItem || bot.heldItem.name !== 'bucket') {
            log.warn(`fill bucket: hand holds ${bot.heldItem ? bot.heldItem.name : 'nothing'}, not the bucket - re-equipping`);
            try { await bot.equip(bk, 'hand'); } catch {}
            if (!bot.heldItem || bot.heldItem.name !== 'bucket') continue;
          }
          if (!isFluidSource(fillTarget)) { log.info(`make_obsidian: water at ${fillTarget.position.x},${fillTarget.position.y},${fillTarget.position.z} is flowing (level ${fluidLevel(fillTarget)}) - a bucket cannot take it, skipping`); continue; }
          for (let attempt = 0; attempt < 2 && countItem(bot, 'water_bucket') < 1; attempt++) {
            try { await bot.lookAt(fillTarget.position.offset(0.5, 0.5, 0.5), true); } catch {}
            try { await bot.activateItem(); } catch (e) { log.info(`make_obsidian: activateItem on water threw ${e.message}`); }
            await sleep(900);
          }
          if (countItem(bot, 'water_bucket') < 1) log.skill(`bucket still empty at source water ${fillTarget.position.x},${fillTarget.position.y},${fillTarget.position.z} (level ${fluidLevel(fillTarget)}) - tried aim+use twice - trying the next cell`);
          else {
            water = fillTarget;
            if (fillTarget.position.y >= 56) { try { oreCache.remember('water', fillTarget.position.x, fillTarget.position.y, fillTarget.position.z); } catch {} }
          }
        }
      } catch (e) { log.warn(`fill bucket threw ${e.message}`); }
      if (countItem(bot, 'water_bucket') < 1) {
        // Last resort: let roam put the bot IN water (it walks toward a visible water cell), then
        // bucket the cell it is standing in - the one attempt that is guaranteed to be in reach.
        try { await reg.get('roam').run(bot, { block: 'water', distance: 120 }); } catch {}
        const here = bot.blockAt(bot.entity.position.floored());
        if (here && here.name === 'water') {
          try { await bot.equip(bk, 'hand'); } catch {}
          try { await bot.lookAt(here.position.offset(0.5, 0.5, 0.5), true); } catch {}
          try { await bot.activateItem(); } catch {}
          await sleep(900);
          log.skill(`make_obsidian: after roam into water and a feet-cell retry, water_bucket=${countItem(bot, 'water_bucket')}`);
        }
      }
      if (countItem(bot, 'water_bucket') < 1) {
        // Do NOT abort the round here. Returning made this a dead end: at 15:48-15:54 the bot sat at
        // y=11-17 failing the same fill three rounds running, never descending, while obsidian fields
        // exist below it. Without a bucket the pour is skipped (the pour loop reports that itself),
        // but the lava search still dives, and diving is what finds natural obsidian and re-populates
        // the field memory that the reach bug made it forget at 15:25.
        bucketBlocked = true;
        log.warn(`make_obsidian: no water bucket at y=${Math.round(bot.entity.position.y)} - skipping the pour and continuing to search/mine. What has worked: stand on DRY ground beside a surface lake and bucket a cell you are not inside (-37,62,770 / 2,62,675 / 127,62,858); what has never worked: fully submerged in a cave pool (56,11,743)`);
      }
      // Never log success on a "we found water" basis: the line was turned into a lie for 20 minutes
      // (16:26-16:35) by the null-guard I added, and the log then read as if buckets were filling.
      if (water) log.skill(countItem(bot, 'water_bucket') > 0
        ? `filled water_bucket at ${water.position.x},${water.position.y},${water.position.z}`
        : `found water at ${water.position.x},${water.position.y},${water.position.z} but the bucket did NOT fill`);
    }
    // Vanilla rule: obsidian only drops from a DIAMOND or netherite pickaxe - an iron pick mines it
    // for nothing, so asking for "iron/diamond" wasted whole milestone rounds.
    if (!['diamond_pickaxe', 'netherite_pickaxe'].some(n => countItem(bot, n) > 0)) {
      return { ok: false, observation: `obsidian needs a diamond pickaxe (iron drops nothing); diamonds=${countItem(bot, 'diamond')} - craft diamond_pickaxe first, then make_obsidian` };
    }
    const lavaIds = blockIds(bot, ['lava', 'lava_cauldron']);
    const badLava = (bot._badLavaKeys = bot._badLavaKeys || new Set());
    const lavaKey = (p) => `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
    const findSourceLava = (maxDist) => {
      try {
        const pts = bot.findBlocks({ matching: lavaIds, maxDistance: maxDist, count: 64 }) || [];
        let fallback = null;
        for (const pt of pts) {
          if (badLava.has(lavaKey(pt))) continue;
          const bl = bot.blockAt(pt);
          if (!bl || !(bl.name === 'lava_cauldron' || (bl.name === 'lava' && isFluidSource(bl)))) continue;
          const ab = bot.blockAt(bl.position.offset(0, 1, 0));
          // Strongly prefer open-top level-0 lava sources (real lava lakes) over roofed single pockets.
          if (!ab || isAir(ab.name)) return bl;
          if (!fallback) fallback = bl;
        }
        return fallback;
      } catch {}
      return null;
    };
    let lavaTarget = findSourceLava(40);
    if (!lavaTarget) {
      // A pool the bot has ALREADY seen is worth more than a blind new column: every descend loop
      // below digs where it happens to be standing, and the pools live in caves. Hop toward the
      // remembered coordinate first (same ore-cache pattern that made `mine` stop re-diging dirt).
      let known = oreCache.nearest(['lava', 'deepslate_lava'], bot.entity.position);
      const isOceanCapped = (pt) => {
        if (!pt || pt.y >= 55) return false;
        try {
          const b62 = bot.blockAt(new Vec3(Math.floor(pt.x), 62, Math.floor(pt.z)));
          const b61 = bot.blockAt(new Vec3(Math.floor(pt.x), 61, Math.floor(pt.z)));
          return !!((b62 && /water|ice/.test(b62.name)) || (b61 && /water|ice/.test(b61.name)));
        } catch { return false; }
      };
      while (known && (badLava.has(lavaKey(known)) || (bot.entity.position.y >= 58 && isOceanCapped(known)))) {
        if (isOceanCapped(known)) log.info(`make_obsidian: forgetting ocean-capped lava ${known.x},${known.y},${known.z} (surface is water/ice) - descending on dry land instead`);
        oreCache.forget(known.x, known.y, known.z);
        known = oreCache.nearest(['lava', 'deepslate_lava'], bot.entity.position);
      }
      if (known && known.dist <= 400) {
        log.skill(`make_obsidian: no source lava in sight - walking toward remembered lava at ${known.x},${known.y},${known.z} (${Math.round(known.dist)} blocks)`);
        const w = await reg.get('walk_to').run(bot, { x: known.x, y: known.y, z: known.z, tolerance: 10 });
        log.skill(`make_obsidian: ${w.observation}`);
        await sleep(900);
        lavaTarget = findSourceLava(40);
        // If we are right at the remembered spot's depth and there is still NO usable level-0 source lava
        // (e.g. only a flowing waterfall or previously failed pocket), forget it so we descend to y=-54 lakes.
        if (!lavaTarget && Math.abs(known.y - bot.entity.position.y) <= 10) oreCache.forget(known.x, known.y, known.z);
      }
    }
    if (!lavaTarget) {
      // In Minecraft 1.21.1, flat level-0 source lava lakes generate abundantly at y=-54.
      // Dig down in stages all the way to y=-52, checking for true level-0 lava sources after each stage.
      let highGroundTries = 0;
      for (const toY of [12, 0, -20, -40, -52]) {
        if (highGroundTries < 2 && bot.entity.position.y >= 60 && bot.entity.position.y < MIN_HIGH_Y) { highGroundTries++; await relocateToHighGround(bot, 'make_obsidian'); }
        if (bot.entity.position.y <= toY + 2) continue;
        log.skill(`no source lava within 40 blocks at y=${Math.round(bot.entity.position.y)} - descending to y=${toY} looking for a lava lake`);
        const yB = Math.round(bot.entity.position.y);
        const ds = await reg.get('deep_shaft').run(bot, { toY, max: 45 });
        await sleep(1000);
        lavaTarget = findSourceLava(40);
        if (lavaTarget) { log.skill(`source lava found at ${lavaTarget.position.x},${lavaTarget.position.y},${lavaTarget.position.z} after descending`); break; }
        // Harvest on the way down. Natural obsidian (lava that met water underground) needs no bucket
        // and no pour, and 16:03-16:10 shows the round ending at a lava pool with an empty bucket:
        // the trip is paid in full for zero obsidian. Fields seen at 11:04 (4 cells) and 14:52
        // (35,-55,763) were only ever noticed from the surface scan, where they are 90 blocks away.
        await mineObsidianField(24, 'mid-descent');
        if (countItem(bot, 'obsidian') >= need) return { ok: true, observation: `obsidian=${countItem(bot, 'obsidian')} collected from fields passed on the way down (no pour needed)` };
        // An unusable column answers in milliseconds ("this column is recorded as FLOODED" / standing
        // in water), so all four stages used to burn 1 s each and the milestone failed at y=62 while
        // claiming it had searched to y=-40. Move to dry ground before the next stage.
        if (Math.round(bot.entity.position.y) >= yB - 1) {
          if (bot._wet) {
            // Climbing out is not enough. At 17:40-17:43 three rounds failed in ~40 s each: the bot
            // kept starting them inside the same flooded hole at y=15, so every stage hit this guard
            // and handed the round back. Take it all the way to dry, high ground before returning,
            // so the NEXT round starts on a column that can actually be dug.
            log.warn('make_obsidian: descent blocked by water at the surface of this hole - climbing out AND moving to dry high ground before returning');
            try { await reg.get('recover_surface').run(bot, {}); } catch (e) { log.warn(`make_obsidian: recover_surface threw ${e.message}`); }
            await relocateToHighGround(bot, 'make_obsidian');
            break;
          }
          const f = bot.entity.position.floored();
          // A blind +22/-16 offset moved the bot out of one pond and straight into another at
          // 10:45:46 (-40,62,743), where every stage then no-oped. Ask the world which columns are
          // solid at feet level and walk to the first one that is.
          let spot = null;
          for (const [dx, dz] of [[22, -16], [18, 20], [-20, 14], [-14, -22], [26, 6], [-8, 26], [30, -30]]) {
            const bl = bot.blockAt(new Vec3(f.x + dx, f.y, f.z + dz));
            if (bl && !isAir(bl.name) && !/water|lava/.test(bl.name)) { spot = { x: f.x + dx, z: f.z + dz }; break; }
          }
          if (!spot) spot = { x: f.x + 22, z: f.z - 16 };
          log.skill(`descent made no progress at y=${yB} (${String(ds.observation).slice(0, 90)}) - stepping to column ${spot.x},${spot.z}`);
          await reg.get('walk_to').run(bot, { x: spot.x, y: f.y, z: spot.z, tolerance: 5 });
        }
      }
    }
    if (!lavaTarget && bot.entity.position.y < 5) {
      // Lava lakes sit in caves, so at depth the way to find one is to WALK along that level until a
      // pool loads. Digging a blind shaft only ever reported "no lava within 40 blocks".
      const trip = await reg.get('roam').run(bot, { block: 'lava', distance: 420 });
      log.skill(`roaming sideways at y=${Math.round(bot.entity.position.y)} for lava: ${trip.observation}`);
      lavaTarget = findSourceLava(40);
    }
    if (!lavaTarget) return { ok: false, observation: `no lava pool within 40 blocks even after descending to y=${Math.round(bot.entity.position.y)} and roaming sideways - dig a branch tunnel at this level or find a cave/ravine entrance` };
    // Remember the pool: losing it between rounds is what made every obsidian attempt start from zero.
    try { oreCache.remember(lavaTarget.name, lavaTarget.position.x, lavaTarget.position.y, lavaTarget.position.z); } catch {}
    // Capped, and pathfinder stopped on the way out: an unreachable lava pool (across a chasm, or
    // behind a wall) otherwise parks this goto until the milestone timeout fires, which is the same
    // uncapped-goto stall class that already froze iron_gear and roam. On timeout the skill reports
    // honestly so the planner picks a different pool instead of burning 180 s standing still.
    // Two gotos in the same tick cancel each other, and the loser is the one already in flight: a goal
    // left pending by the PREVIOUS step (the dig_to_y/tidy legs that precede this call) makes the very
    // first goto here reject instantly with "The goal was changed before it could be completed!". That
    // used to be read as "this lava pool is unreachable" - measured twice back to back at 06:12:52 and
    // 06:13:50, each costing a full re-plan while the pool itself was fine. Take the path hand cleanly
    // (stop + settle) and give a cancellation one retry before blaming the destination.
    let reach = null;
    for (let attempt = 0; attempt < 3; attempt++) {
      // Do NOT stop() before goto. The attribution wrapper proved my own "settle" was the canceller:
      // `stopped-by=... endgame.js:846 at +0ms` on both failed passes - mineflayer delivers a stop()
      // against the goal that starts immediately after it, so stopping-then-going-out produced exactly
      // the "Path was stopped before it could be completed!" it was meant to recover from. Stop only
      // AFTER a rejection (to clear state), then wait, then re-issue.
      let lavaGotoTimer = null;
      try {
        await Promise.race([
          bot.pathfinder.goto(new (GN())(lavaTarget.position.x, lavaTarget.position.y + 1, lavaTarget.position.z, 2)),
          new Promise((_, rej) => { lavaGotoTimer = setTimeout(() => rej(new Error('goto lava pool timed out')), 45000); }),
        ]);
        reach = null;
        break;
      } catch (e) {
        reach = e;
        await sleep(1200);
        if (!/goal was changed|Path was stopped/i.test(e.message) || attempt === 2) break;
        const who = bot._lastPathStop ? ` stopped-by=${bot._lastPathStop.where} at +${Date.now() - bot._lastPathStop.at}ms` : '';
        log.skill(`make_obsidian: path cancelled (${e.message})${who} - retrying (pass ${attempt + 2})`);
      } finally {
        if (lavaGotoTimer) clearTimeout(lavaGotoTimer);
      }
    }
    if (reach) {
      // A player digs; `mineBlockHere` digs too, but it carries a per-call budget, so repeat while it
      // closes the gap all the way into pour reach (<= 3.8 blocks, not <= 6 which stranded the bot 5.4b
      // behind a 2-block rock wall while the pour loop requires <= 4.5b).
      for (let t = 0; t < 6; t++) {
        const d0 = bot.entity.position.distanceTo(lavaTarget.position);
        if (d0 <= 3.8) break;
        log.skill(`make_obsidian: no path to the pool (${reach.message}) - tunneling, pass ${t + 1} from ${Math.round(d0)} blocks`);
        try { await mineBlockHere(bot, lavaTarget); } catch (e) { log.warn(`make_obsidian: tunnel threw ${e.message}`); }
        const d1 = bot.entity.position.distanceTo(lavaTarget.position);
        if (d1 <= 3.8) break;
        if (d1 > d0 - 1.5) { log.skill(`make_obsidian: tunnel stalled at ${Math.round(d1)} blocks from the pool - abandoning it`); break; }
      }
      if (bot.entity.position.distanceTo(lavaTarget.position) > 4.5) {
        return { ok: false, observation: `could not reach the lava pool at ${lavaTarget.position.x},${lavaTarget.position.y},${lavaTarget.position.z}: ${reach.message}, and tunneling did not close the gap (obsidian=${countItem(bot, 'obsidian')} of ${need}; this is a reach failure, not a done round)` };
      }
      reach = null;
    }
    // Pour water on the lava source, then PROVE it turned: the old one-shot `try { ... } catch {}`
    // swallowed everything, so at 10:28 a pool reached, a submerged bot and `mined 0 of ["obsidian"]`
    // produced no clue whether the pour ever happened. Each round refills nothing - it reports, and
    // the caller re-runs the skill (which fills the bucket on entry).
    let poured = 0;
    for (let round = 0; round < 3; round++) {
      if (Date.now() >= (bot._stepDeadline || Infinity)) { log.warn('make_obsidian: step deadline during the pour'); break; }
      const wb = bot.inventory.items().find(i => i.name === 'water_bucket');
      if (!wb) {
        log.skill(`make_obsidian: water bucket is empty after ${poured} pour(s) (bucket=${countItem(bot, 'bucket')}) - it must be refilled at the water before pouring more`);
        break;
      }
      try { await bot.equip(wb, 'hand'); } catch (e) { log.warn(`make_obsidian: equip water_bucket threw ${e.message}`); }
      if (!bot.heldItem || bot.heldItem.name !== 'water_bucket') {
        log.warn(`make_obsidian: hand holds ${bot.heldItem ? bot.heldItem.name : 'nothing'}, not the water_bucket`);
        try { await bot.equip(wb, 'hand'); } catch {}
        if (!bot.heldItem || bot.heldItem.name !== 'water_bucket') break;
      }
      let lavaBlocks = [];
      try { lavaBlocks = bot.findBlocks({ matching: blockIds(bot, ['lava']), maxDistance: 12, count: 14 }).map(p => bot.blockAt(p)).filter(b => b && b.name === 'lava'); } catch { lavaBlocks = []; }
      if (!lavaBlocks.length && lavaTarget) lavaBlocks = [lavaTarget];
      // Pour ONLY on a level-0 SOURCE lava block: water on flowing lava (level>0) wastes the bucket
      // turning it into cobblestone (live 11:33:48). If every cell here is flowing, forget this spot
      // and keep the water_bucket full for a real y=-54 lava lake!
      {
        const src = lavaBlocks.filter(isFluidSource);
        if (src.length) {
          lavaBlocks = src;
        } else {
          log.info(`make_obsidian: ${lavaBlocks.length} lava cell(s) in sight are all flowing (level>0) - keeping water_bucket full and forgetting this waterfall`);
          try { if (lavaTarget && lavaTarget.position) oreCache.forget(lavaTarget.position.x, lavaTarget.position.y, lavaTarget.position.z); } catch {}
          break;
        }
      }
      // Aim a SOURCE. A pool's surface cells are flowing lava, and water on flowing lava just makes
      // steam and a cobble block: at 11:17:37 six cells in a row "left lava" while the source sat
      // under them. Score = solid beneath + nothing lava above, then the lowest cell, then nearest.
      const score = (b) => {
        const below = bot.blockAt(b.position.offset(0, -1, 0));
        const above = bot.blockAt(b.position.offset(0, 1, 0));
        return (below && below.name !== 'lava' && !isAir(below.name) ? 3 : 0)
          + (above && above.name !== 'lava' ? 2 : 0)
          + (100 - b.position.y) / 100;
      };
      // When no level-0 cell is in the list (the usual case on a pool surface), aim LOW: the source
      // layer is at the bottom of the pool and each cobblestone conversion strips one flowing layer
      // off, so pouring at the deepest visible cell eats down to the source in a few buckets, while
      // pouring at the nearest one just paves the top.
      lavaBlocks.sort((a, b) => score(b) - score(a) || a.position.y - b.position.y || bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position));
      let made = false;
      for (const b of lavaBlocks) {
        const p = b.position;
        // Same lesson as the obsidian dig: interact reach is ~4.5 blocks, and this loop was firing
        // at cells up to 12 blocks away (`pour at 126,40,860 left lava` 16:53, right after filling a
        // bucket 100+ blocks away). Walk into range first, and say so if the range cannot be closed.
        if (bot.entity.position.distanceTo(p) > 3.5) {
          const g = await capped(bot.pathfinder.goto(new (GN())(p.x, p.y + 1, p.z, 2)), 12000, 'walk to lava cell');
          if (g === null) { try { bot.pathfinder.stop(); } catch {} }
          if (bot.entity.position.distanceTo(p) > 4.2 && bot.entity.position.distanceTo(p) <= 8.5) {
            try { await mineBlockHere(bot, b); } catch {}
          }
          if (bot.entity.position.distanceTo(p) > 4.5) {
            log.warn(`make_obsidian: lava cell ${p.x},${p.y},${p.z} is ${Math.round(bot.entity.position.distanceTo(p) * 10) / 10} blocks away and unreachable - not pouring from here`);
            continue;
          }
        }
        // Ensure the cell directly above the lava source is open so poured water can reach it:
        // a roofed single-block lava pocket (e.g. stone at p+(0,1,0)) otherwise drops water onto a
        // rim without ever touching the lava.
        try {
          const aboveLava = bot.blockAt(p.offset(0, 1, 0));
          if (aboveLava && aboveLava.boundingBox === 'block' && !/lava|water|bedrock|obsidian/.test(aboveLava.name)
            && bot.entity.position.distanceTo(aboveLava.position) <= 4.5) {
            try { await equipBulkPick(bot, false); await bot.dig(aboveLava); await sleep(200); } catch {}
            const wbBack = bot.inventory.items().find(i => i.name === 'water_bucket');
            if (wbBack) { try { await bot.equip(wbBack, 'hand'); } catch {} }
          }
        } catch {}
        // Choose the best solid-face aim point so water guaranteed contacts lava source `p`:
        // 1) Inner side face of a wall orthogonally touching p+(0,1,0) -> places water directly ON TOP of p!
        // 2) Top face of a solid floor under an air cell p+(rx,0,rz) -> places water level with & touching p!
        // 3) Top face of a solid rim p+(rx,0,rz) when p+(0,1,0) is open air -> water flows over rim onto p.
        const beforeWater = countItem(bot, 'water_bucket');
        const obsIds = blockIds(bot, ['obsidian']);
        const obsBefore = (bot.findBlocks({ matching: obsIds, maxDistance: 10, count: 32 }) || []).length;
        const aboveNow = bot.blockAt(p.offset(0, 1, 0));
        const aboveOpen = !aboveNow || isAir(aboveNow.name);
        let aimPt = p.offset(0.5, 0.5, 0.5);
        let pickedAim = false;
        if (aboveOpen) {
          for (const [rx, rz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const wall = bot.blockAt(p.offset(rx, 1, rz));
            if (wall && wall.boundingBox === 'block' && !/lava|water/.test(wall.name)
              && bot.entity.position.distanceTo(wall.position) <= 4.3) {
              aimPt = p.offset(0.5 + rx * 0.45, 1.5, 0.5 + rz * 0.45);
              pickedAim = true;
              break;
            }
          }
        }
        if (!pickedAim) {
          for (const [rx, rz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const adj = bot.blockAt(p.offset(rx, 0, rz));
            const adjFloor = bot.blockAt(p.offset(rx, -1, rz));
            if ((!adj || isAir(adj.name)) && adjFloor && adjFloor.boundingBox === 'block' && !/lava|water/.test(adjFloor.name)
              && bot.entity.position.distanceTo(adjFloor.position) <= 4.3) {
              aimPt = adjFloor.position.offset(0.5, 0.95, 0.5);
              pickedAim = true;
              break;
            }
          }
        }
        if (!pickedAim && aboveOpen) {
          for (const [rx, rz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const rimFloor = bot.blockAt(p.offset(rx, 0, rz));
            const rimAir = bot.blockAt(p.offset(rx, 1, rz));
            if (rimFloor && rimFloor.boundingBox === 'block' && !/lava|water/.test(rimFloor.name)
              && (!rimAir || isAir(rimAir.name))
              && bot.entity.position.distanceTo(rimFloor.position) <= 4.3) {
              aimPt = rimFloor.position.offset(0.5, 0.95, 0.5);
              pickedAim = true;
              break;
            }
          }
        }
        try { await bot.lookAt(aimPt, true); } catch {}
        try { await bot.activateItem(); } catch (e) { log.warn(`make_obsidian: activateItem threw ${e.message}`); }
        await sleep(1100);
        const afterWater = countItem(bot, 'water_bucket');
        let after = bot.blockAt(p);
        const obsAfter = (bot.findBlocks({ matching: obsIds, maxDistance: 10, count: 32 }) || []).length;
        const madeObsNearby = obsAfter > obsBefore;
        if (!madeObsNearby && (!after || after.name === 'lava')) {
          log.warn(`make_obsidian: pour at ${p.x},${p.y},${p.z} left ${after ? after.name : 'NULL'} with water_bucket ${beforeWater} -> ${afterWater} (level=${((after && after.getProperties && after.getProperties().level) || '?')})`);
        }
        if (!madeObsNearby && afterWater === beforeWater && (!after || after.name === 'lava')) {
          const ref = bot.blockAt(p.offset(0, -1, 0));
          if (ref && !isAir(ref.name) && ref.name !== 'lava') {
            try { await bot.lookAt(p.offset(0.5, 0.5, 0.5), true); } catch {}
            try { await bot.placeBlock(ref, new Vec3(0, 1, 0)); } catch (e) { log.warn(`make_obsidian: placeBlock pour threw ${e.message}`); }
            await sleep(900);
            after = bot.blockAt(p);
          }
        }
        // ALWAYS scoop our placed water source back into the empty bucket whenever a pour emptied it,
        // even if the target cell itself stayed lava (live 12:05:08 abandoned the water 1 block away!).
        if (beforeWater > 0 && countItem(bot, 'water_bucket') < beforeWater) {
          try {
            const eb = bot.inventory.items().find(i => i.name === 'bucket');
            if (eb) {
              const wIds = blockIds(bot, ['water']);
              const wPts = bot.findBlocks({ matching: wIds, maxDistance: 5, count: 8 }) || [];
              const wSrc = wPts.map(pt => bot.blockAt(pt)).find(bl => bl && bl.name === 'water' && isFluidSource(bl));
              if (wSrc) {
                await bot.equip(eb, 'hand');
                await bot.lookAt(wSrc.position.offset(0.5, 0.5, 0.5), true);
                await bot.activateItem();
                await sleep(450);
                if (countItem(bot, 'water_bucket') > 0) log.skill(`make_obsidian: scooped water back into bucket from ${wSrc.position.x},${wSrc.position.y},${wSrc.position.z}`);
              }
            }
          } catch {}
        }
        if (madeObsNearby || (after && (after.name === 'obsidian' || after.name === 'cobblestone' || after.name === 'stone'))) {
          poured++; made = true;
          log.skill(`make_obsidian: poured on lava at ${p.x},${p.y},${p.z} -> ${madeObsNearby ? `+${obsAfter - obsBefore} obsidian nearby` : after.name}`);
          break;
        }
        // Water bucket emptied onto this lava cell yet yielded ZERO obsidian -> unpourable/sealed trap;
        // forget it from oreCache and blacklist it so we move on to real y=-54 lava lakes instead of looping.
        if (beforeWater > 0 && afterWater < beforeWater) {
          badLava.add(lavaKey(p));
          try { oreCache.forget(p.x, p.y, p.z); } catch {}
          if (lavaTarget && lavaTarget.position) {
            badLava.add(lavaKey(lavaTarget.position));
            try { oreCache.forget(lavaTarget.position.x, lavaTarget.position.y, lavaTarget.position.z); } catch {}
          }
          log.warn(`make_obsidian: pour emptied water_bucket at ${p.x},${p.y},${p.z} with 0 obsidian - forgetting this lava pocket so next search descends to an open lake`);
        }
        log.skill(`make_obsidian: pour at ${p.x},${p.y},${p.z} left ${after ? after.name : 'NULL'} - trying the next lava cell`);
      }
      if (!made) break;
    }
    // collectBlock was the last one here: its internal assert.ok(item) / "destination full"
    // rejections surface as unhandledRejection (and caused a heap OOM earlier in this
    // project). mineBlockHere digs and walks over the drop instead.
    // Obsidian is mined HERE rather than through mineBlockHere/mine: a pick sitting in an
    // inventory slot (slot=14 at 11:04:13 while `held=bucket`) needs a window click to reach the
    // hand, and mineflayer's 1.21 equip can stall on that ack - the dig then runs with a bucket in
    // hand, which takes 9 s and drops NOTHING. So: put the pick in the hand, PROVE it, dig, and
    // prove the count moved.
    async function mineObsidianField(maxDist, label) {
    // The standing frame is NOT an obsidian source. Digging a frame cell to top up the pack is a
    // round trip that loses the block: obsidian only drops from a diamond-tier pick and the hand here
    // is frequently something else (03:04:19 `held=stone_pickaxe ... cell_now=air`, pack obsidian
    // unchanged at 7). Excluded before the candidate list, so no dig can reach it.
    const frame = frameCellKeys(bot);
    let skippedFrame = 0;
    const obsCells = () => {
      try {
        const all = bot.findBlocks({ matching: blockIds(bot, ['obsidian']), maxDistance: maxDist, count: 12 });
        const keep = all.filter(p => !frame.has(`${p.x},${p.y},${p.z}`));
        skippedFrame += all.length - keep.length;
        if (all.length && !keep.length && skippedFrame === all.length - keep.length) log.warn(`make_obsidian[${label}]: all ${all.length} obsidian cell(s) in reach are the portal frame - leaving the door standing`);
        return keep;
      } catch { return []; }
    };
    const tried = new Set();
    // Walk-machinery accounting, so a refusal that costs 15 ms and moves nothing cannot be filed as
    // "this cell is unreachable". Measured 21:47:56: twelve real obsidian cells burned in 120 ms.
    let noMove = 0, machinedAt = 0, walkMachines = false, wetMadeClear = false, carvedOnce = false;
      // Remember the field: without this the 4-cell natural pile it reported at 11:04 was forgotten
      // one round later and the next dive started scanning blind again.
      try { for (const p of obsCells()) { const bb = bot.blockAt(p); if (bb) oreCache.remember(bb.name, p.x, p.y, p.z); } } catch {}
    for (let got = countItem(bot, 'obsidian'); got < need && Date.now() < (bot._stepDeadline || Infinity);) {
      // A drop with nowhere to land is a lost drop. At 18:18 the pack sat at free=1 while the bot was
      // standing on an obsidian field, which would have made every future `count 2 -> 2` look like a
      // failed dig when it was really a failed pickup.
      if (P.freeSlots(bot) < 3) await P.dropJunk(bot, true, 8);
      const key = (p) => `${p.x},${p.y},${p.z}`;
      const cells = obsCells().filter(p => !tried.has(key(p)));
      if (!cells.length) { if (label !== 'natural') log.warn(`make_obsidian[${label}]: no mineable obsidian cell left within ${maxDist} (${tried.size} already tried)`); break; }
      const dp = bot.inventory.items().find(i => (i.name === 'diamond_pickaxe' || i.name === 'netherite_pickaxe') && (ob.wear(bot, i) ?? 100) >= 10);
      bot._noDiamondPick = !dp;
      if (!dp) { log.warn(`make_obsidian: no diamond pick left to mine the obsidian (wear of what we have: ${bot.inventory.items().filter(i => /pickaxe/.test(i.name)).map(i => `${i.name}@${ob.wear(bot, i)}%`).join(',')})`); break; }
      let handed = false;
      for (let e = 0; e < 3 && !handed; e++) {
        try { await bot.equip(dp, 'hand'); } catch (err) { log.warn(`make_obsidian: equip diamond_pickaxe threw ${err.message}`); }
        if (!handed && dp.slot >= 36 && dp.slot <= 44) { try { await bot.setQuickBarSlot(dp.slot - 36); } catch {} }
        handed = !!(bot.heldItem && bot.heldItem.name === dp.name);
        if (!handed) await sleep(500);
      }
      if (!handed) { log.warn(`make_obsidian: hand still holds ${bot.heldItem ? bot.heldItem.name : 'nothing'} after 3 equips - cannot mine obsidian with it`); break; }
      // Re-read each candidate: findBlocks answers from the cached map, and by the time the bot gets
      // there the cell can be air (measured 14:47:48: `reach=30.2b cell_now=air`). Digging a cell that
      // no longer exists just burns the full sized wait and reports "yielded nothing".
      const blocks = cells.map(p => bot.blockAt(p)).filter(b => b && b.name === 'obsidian');
      if (!blocks.length) { for (const p of cells) tried.add(`${p.x},${p.y},${p.z}`); log.warn(`make_obsidian: all ${cells.length} obsidian candidate(s) read as something else now (map is stale) - rescanning`); continue; }
      // Prefer a cell that can be dug DRY. `dig at 112,9,772: Digging aborted` at 21:54:22 after 12 s
      // with `held=diamond_pickaxe reach=1.3b onGround=true` is the wet-dig abort this run has always
      // died on (memory: climb onto a dry bank first): the tool tier and the reach were both correct,
      // the water around the block was not. Distance alone used to pick the nearest cell, which in a
      // poured basin is always the most submerged one.
      const waterTouch = (b) => {
        const p = b.position;
        const around = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]].map(o => bot.blockAt(p.offset(o[0], o[1], o[2])));
        return around.filter(x => x && /water|lava/.test(x.name)).length;
      };
      // Dry footing beside a cell: feet cell and head cell both air and neither water nor lava, on a
      // floor that is solid rock - a place the bot can stand WITHOUT placing anything, because this
      // Paper server answers placement into a water cell with `the block is still water`.
      const dryStandBy = (tp) => {
        for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1],
          [2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1]]) {
          const s = tp.offset(dx, dy, dz);
          const feet = bot.blockAt(s), head = bot.blockAt(s.offset(0, 1, 0)), floor = bot.blockAt(s.offset(0, -1, 0));
          if (!feet || !head || !floor) continue;
          if (!isAir(feet.name) || !isAir(head.name)) continue;
          if (isAir(floor.name) || /water|lava/.test(floor.name)) continue;
          return s;
        }
        return null;
      };
      const wet = blocks.map(b => ({ b, w: waterTouch(b), s: dryStandBy(b.position) }));
      const firm = wet.filter(x => x.s);
      if (!firm.length) {
        // Neither half of the condition holds anywhere in reach: the cells are liquid-faced AND there
        // is no dry footing beside them, so every attempt here ends the same way -
        //   22:16:10 dry_escape: submerged at y=9 with no placeable face -> climbOut
        //   22:20:39 milestone obsidian not done: ABORTED mid-step: out of air (oxygen=0)
        // four drownings at one field the bot could already see and reach. Decline the field and name
        // the one block that would fix it: a solid rock neighbour whose removal leaves a stand with a
        // solid floor. This server refuses placement into water, so the stand has to be DUG, not built.
        let carve = null;
        for (const x of wet) {
          for (const o of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0]]) {
            const c = x.b.position.offset(o[0], o[1], o[2]);
            const cb = bot.blockAt(c), fl = bot.blockAt(c.offset(0, -1, 0)), hd = bot.blockAt(c.offset(0, 1, 0));
            if (!cb || !fl || !hd) continue;
            if (isAir(cb.name) || /water|lava|obsidian|bedrock/.test(cb.name)) continue;
            if (isAir(fl.name) || /water|lava/.test(fl.name)) continue;
            if (!isAir(hd.name) && !/short_grass|tall_grass|fern/.test(hd.name)) continue;
            carve = c; break;
          }
          if (carve) break;
        }
        // Report it AND dig it. Handing the ladder a block name left the bot standing in the water
        // beside the very block that would fix it (the air guard then displaced it 77-109 blocks away:
        // 22:28:01 `recover_surface -> dry land {x:3,y:66,z:777}` from a field at x=112), and every such
        // rescue restarts the approach. One dig of solid rock with a solid floor under it makes the dry
        // stand this server refuses to let us place. Once per call, then re-select.
        if (carve && !carvedOnce && bot.entity.position.distanceTo(carve) <= 4.5) {
          carvedOnce = true;
          const cb = bot.blockAt(carve);
          log.info(`make_obsidian: carving a stand at ${carve.x},${carve.y},${carve.z} (${cb ? cb.name : '?'}) - within reach, so digging it rather than reporting it`);
          try { await bot.lookAt(carve.offset(0.5, 0.5, 0.5), true); } catch {}
          try { await bot.dig(cb); } catch (e) { log.warn(`make_obsidian: carve dig threw ${e.message}`); }
          const after = bot.blockAt(carve);
          log.info(`make_obsidian: stand cell now reads ${after ? after.name : 'air'}`);
          continue;
        }
        const nearest = wet.sort((a, b) => bot.entity.position.distanceTo(a.b.position) - bot.entity.position.distanceTo(b.b.position))[0];
        log.warn(`make_obsidian: ${blocks.length} obsidian cell(s) in reach, NONE with dry footing (closest ${nearest.b.position.x},${nearest.b.position.y},${nearest.b.position.z} at ${Math.round(bot.entity.position.distanceTo(nearest.b.position))} blocks) - refusing to swim into it again`);
        // Forget underwater-only obsidian cells from oreCache so obsidian_farm does not treat a single
        // unreachable flooded pocket as a "proven interface" and drag future rounds back into this aquifer.
        for (const x of wet) { try { oreCache.forget(x.b.position.x, x.b.position.y, x.b.position.z); } catch {} }
        return { ok: false, observation: carve
          ? `no obsidian cell in reach can be dug from dry ground, and this server will not let a block be placed into the water beside it. Carve ${carve.x},${carve.y},${carve.z} (${(bot.blockAt(carve) || {}).name}) - it is solid rock with a solid floor and headroom, two blocks from the obsidian - then call make_obsidian again.`
          : `the obsidian field is only reachable by swimming and there is no rock beside it to carve a stand from - this column needs a dry approach shaft dug down from above (shaft record + resume_shaft), not another dive.` };
      }
      const dryCount = wet.filter(x => x.w === 0).length;
      if (!wetMadeClear) {
        wetMadeClear = true;
        log.info(`make_obsidian: ${firm.length}/${blocks.length} cell(s) have dry footing${dryCount ? `, ${dryCount} with no liquid face` : ''} - digging from the dry stand, a swim into this field ends at oxygen=0`);
      }
      const target = firm.sort((x, y) => (x.w - y.w) || (bot.entity.position.distanceTo(x.b.position) - bot.entity.position.distanceTo(y.b.position)))[0].b;
      // And go to it. This loop used to dig from wherever the bot happened to stand, so a target 30
      // blocks away was "dug" without ever being in reach.
      if (bot.entity.position.distanceTo(target.position) > 3.2) {
        const tWalk = Date.now();
        const p0 = bot.entity.position.clone();
        walkMachines = false;
        await capped(bot.pathfinder.goto(new (GN())(target.position.x, target.position.y, target.position.z, 1)), 12000, 'walk to obsidian cell');
        // NO stop() on timeout, and this is the third time the lesson had to be learned. A stop() here
        // cancels the NEXT cell's goto, so every later attempt rejects in ~15 ms before the bot can
        // take a step: measured 21:47:56, twelve refusals inside 120 ms, each one adding a real obsidian
        // cell to `tried`, and the round ended with `no mineable obsidian cell left within 40 (12
        // already tried)` while standing 35 blocks from a fresh field holding a working diamond pick.
        // A refusal that fast with no displacement is the walk machinery, not the terrain.
        if (bot.entity.position.distanceTo(p0) < 0.6 && Date.now() - tWalk < 700) {
          walkMachines = true;
          if (!machinedAt) machinedAt = tWalk;
          if (++noMove >= 3) {
            log.warn(`make_obsidian: ${noMove} walk attempts refused in ${Math.max(1, Math.round((Date.now() - machinedAt) / 1000))}s with ZERO movement - the pathfinder state is the fault, not the field. ${key(target.position)} and ${cells.length} other cell(s) stay untried.`);
            break;
          }
          await sleep(400);
        } else noMove = 0;
      }
      // Stand somewhere sane first. The field at (113-116, y=9, 771-773) is the residue of the pour:
      // the bot is often IN the pool, sometimes directly on top of the cell it is trying to dig, and a
      // dig started from a cell the player occupies never completes - which is what the five
      // "dig did not finish" timeouts looked like. Pick a neighbour with solid ground beneath and air
      // for the head, within reach of the target.
      {
        const tp = target.position;
        const feets = bot.entity.position.floored();
        const drySpots = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [2, 0, 0], [-2, 0, 0], [0, 0, 2], [0, 0, -2], [1, 1, 0], [-1, 1, 0], [0, 1, 1], [0, 1, -1]]
          .map(([dx, dy, dz]) => feets.offset(dx, dy, dz))
          .filter(p => bot.entity.position.distanceTo(p) <= 6 && Math.abs(p.x - tp.x) + Math.abs(p.z - tp.z) + Math.abs(p.y - tp.y) <= 5);
        const good = drySpots.find(p => {
          const g = bot.blockAt(p.offset(0, -1, 0)), f = bot.blockAt(p), h = bot.blockAt(p.offset(0, 1, 0));
          return g && !isAir(g.name) && g.name !== 'water' && g.name !== 'lava'
            && f && (isAir(f.name) || f.name === 'water') && h && (isAir(h.name) || h.name === 'water');
        });
        if (good && (good.x !== feets.x || good.y !== feets.y || good.z !== feets.z)) {
          log.info(`make_obsidian: re-standing on ${good.x},${good.y},${good.z} before digging ${tp.x},${tp.y},${tp.z} (was ${feets.x},${feets.y},${feets.z})`);
          try { await capped(bot.pathfinder.goto(new (GN())(good.x, good.y, good.z, 0)), 8000, 're-stand'); } catch {}
        }
      }
      // Re-check at the last moment: at 11:14:17 the hand had become cobbled_deepslate between the
      // verified equip and the dig, and a 25 s dig on obsidian with a block in hand drops nothing.
      if (!bot.heldItem || bot.heldItem.name !== dp.name) {
        log.warn(`make_obsidian: hand drifted to ${bot.heldItem ? bot.heldItem.name : 'nothing'} before the dig - re-equipping`);
        try { await bot.equip(dp, 'hand'); } catch {}
        // Verify, do not trust: at 15:25:08 the dig ran with `held=cooked_porkchop` because autoEat had
        // taken the hand mid-step and the old code re-equipped without looking again.
        if (!bot.heldItem || bot.heldItem.name !== dp.name) {
          log.warn(`make_obsidian: hand is still ${bot.heldItem ? bot.heldItem.name : 'nothing'} after re-equip - skipping this dig rather than wasting ${Math.round(bot.entity.position.distanceTo(target.position))} blocks of waiting`);
          tried.add(key(target.position));
          continue;
        }
      }
      // Never dig at a cell we have not reached. The 12 s approach goto can time out (a 91-block drop
      // is not a path), and the old code dug anyway - `reach=123.2b cell_now=obsidian` at 15:25:08 was
      // a 20-90 s wait for nothing.
      if (bot.entity.position.distanceTo(target.position) > 3.5) {
        // A refusal from the walk machinery must not retire the cell. This is what turned one stalled
        // goto into "the whole field is gone": the cell was added to `tried` even though the bot never
        // moved toward it.
        if (walkMachines) { log.warn(`make_obsidian: ${key(target.position)} stays untried - the walk refused without moving, so this is the pathfinder, not the terrain`); continue; }
        tried.add(key(target.position));
        log.warn(`make_obsidian: obsidian at ${target.position.x},${target.position.y},${target.position.z} is ${Math.round(bot.entity.position.distanceTo(target.position))} blocks away and unreachable this round - leaving it for when we are next to it`);
        continue;
      }
      const before = got;
      // Bail the water off our own head first: submerged means 5x slower mining AND ~15 s of air, so
      // an obsidian dig that needs ~47 s underwater is a drowning lesson rather than a mining one.
      // Bucketing a flowing cell does nothing, so this is a bounded attempt, not a dependency.
      if (bot._wet && countItem(bot, 'water_bucket') > 0) {
        const head = bot.entity.position.offset(0, 1.2, 0);
        const hb = bot.blockAt(head);
        if (hb && hb.name === 'water') {
          try { await bot.equip(bot.inventory.items().find(i => i.name === 'water_bucket'), 'hand'); } catch {}
          try { await bot.lookAt(head, true); } catch {}
          try { await bot.activateItem(); } catch {}
          await sleep(700);
          const af = bot.blockAt(head);
          log.skill(`make_obsidian: tried to bail the head cell -> ${af ? af.name : 'air'}`);
          // The bail left the bucket in the hand; obsidian needs the pick back before the dig.
          try { await bot.equip(dp, 'hand'); } catch {}
        }
      }
      try { await bot.lookAt(target.position.offset(0.5, 0.5, 0.5), true); } catch {}
      // The wait has to be sized from the ACTUAL dig time: obsidian is 9.4 s with a diamond pick, but
      // Java divides mining speed by 5 while the head is underwater - ~47 s here, because the bot is
      // standing in the water it just poured. A 25 s cap cut every dig off halfway and restarted it,
      // which is exactly the five 25s timeouts at 14:19-14:20 on cells 1-2 blocks away (`count 2 -> 2`).
      let digMs = 20000;
      try { const t = bot.digTime ? bot.digTime(target) : null; if (t && isFinite(t)) digMs = Math.min(180000, Math.max(15000, t * 2)); } catch {}
      try {
        await Promise.race([bot.dig(target), new Promise((_, rej) => setTimeout(() => rej(new Error(`dig did not finish in ${Math.round(digMs / 1000)}s`)), digMs))]);
      } catch (e) { log.warn(`make_obsidian: dig at ${target.position.x},${target.position.y},${target.position.z}: ${e.message}`); }
      await sleep(400);
      if (!(await P.collectNear(bot, target.position, 'obsidian'))) log.warn(`make_obsidian: broke ${target.position.x},${target.position.y},${target.position.z} and the drop is still on the floor`);
      got = countItem(bot, 'obsidian');
      log.skill(`make_obsidian: dug at obsidian ${target.position.x},${target.position.y},${target.position.z} -> count ${before} -> ${got} (held=${bot.heldItem ? bot.heldItem.name : '-'} dpick@${ob.wear(bot, dp)}% reach=${Math.round(bot.entity.position.distanceTo(target.position) * 10) / 10}b cell_now=${(bot.blockAt(target.position) || {}).name || '?'} onGround=${!!(bot.entity && bot.entity.onGround)})`);
      if (got <= before) { tried.add(key(target.position)); await sleep(1200); if (countItem(bot, 'obsidian') <= before) { log.warn(`make_obsidian: obsidian at ${key(target.position)} yielded nothing - skipping it`); try { oreCache.forget(target.position.x, target.position.y, target.position.z); } catch {} } }
    }
    }
    // A poured block costs a whole bucket and the bucket costs a trip to the surface (measured
    // 11:25:10: `poured on lava -> cobblestone`, then `water bucket is empty after 1 pour(s)`).
    // A consumed bucket proves the interact landed: `pour at 486,-24,765 left lava with water_bucket
    // 1 -> 0 (level=8)` at 18:10:42 - the water went in, just not into the cell that was aimed at
    // (a level-8 flowing film, which converts its neighbours). So look WIDER than the aimed cell for
    // what actually formed, and mine that.
    await mineObsidianField(32, 'after-pour');
    if (countItem(bot, 'obsidian') >= need) return { ok: true, observation: `obsidian=${countItem(bot, 'obsidian')} (poured ${poured})` };
    const obs = bot.findBlock({ matching: blockIds(bot, ['obsidian']), maxDistance: 16 });
    if (obs) { log.skill(`make_obsidian: last resort mineBlockHere on obsidian at ${obs.position.x},${obs.position.y},${obs.position.z}`); await mineBlockHere(bot, obs); }
    else if (poured) log.warn(`make_obsidian: poured ${poured} time(s) but no obsidian block is loaded within 16 - check the pour spot`);
    const m = await reg.get('mine').run(bot, { names: ['obsidian'], count: need, maxDistance: 24 });
    // `ok: have >= 1` turned a failed round into fake progress. Measured 02:03:59: three
    // `make_obsidian {"count":3}` calls returned ok in under 2 ms each while the count sat at 5 and
    // `build_nether_portal` went on failing with `need 10, have 5`. A success signal that fires without
    // doing the work is worse than a failure - the ladder moves on to the NEXT milestone instead of
    // fixing this one. ok only when the caller's own number is met.
    return { ok: countItem(bot, 'obsidian') >= need, observation: `obsidian=${countItem(bot, 'obsidian')} of ${need} required${bucketBlocked ? ' (no water bucket this round - pour skipped, only existing cells mined)' : ''}; ${m.observation}` };
  },
});
// The frame, split by what the game actually requires. Vanilla lets all four corners stand empty: a
// 4x5 outer frame with a 2x3 interior ignites on 10 obsidian, and 14 is only what you spend if you fill
// the corners too. `essentials` used to list all 14 frame cells while the entry gate demanded 10 in hand
// - so with exactly 10 the frame ran dry mid-build (`portal: no obsidian item left`, 02:03:29 logged
// `portal frame placed 6 obsidian` with obs=6 left) and the one step that could finish the portal could
// not. The two TOP corners are also the cells the reach/stool machinery fights hardest over.
const PORTAL_FRAME = {
  essentials: [[1, 0], [2, 0], [0, 1], [3, 1], [0, 2], [3, 2], [0, 3], [3, 3], [1, 4], [2, 4]],
  optional: [[0, 0], [3, 0], [0, 4], [3, 4]],
};
const FRAME_COST = PORTAL_FRAME.essentials.length;

// Which cells a frame at `site` is still missing, read FROM THE WORLD. Shared by build_nether_portal's
// gate and pour_portal_cell so the two can never disagree about the number - the disagreement is what
// made the run demand 10 fresh blocks while 6 cells were already standing.
function missingFrameCells(bot, site) {
  const miss = [];
  if (!site) return miss;
  for (const [dx, dy] of PORTAL_FRAME.essentials) {
    let b = null;
    try { b = bot.blockAt(new Vec3(site.x + dx, site.y + dy, site.z)); } catch { /* unloaded counts as missing */ }
    if (!b || b.name !== 'obsidian') miss.push([dx, dy]);
  }
  return miss;
}

// Can this origin still be FINISHED? A bottom-row cell with air or liquid under it cannot be placed
// against at all - measured 03:54:09, where the recorded origin 163,71,693 sat one block above the
// terrain and all 7 open cells refused with `no reference block within reach [air/air/air/air]`, 45 ms
// per attempt, forever. Only the still-empty bottom cells are checked; a completed row needs no floor.
function frameSiteBuildable(bot, site) {
  if (!site) return false;
  for (const [dx, dy] of PORTAL_FRAME.essentials) {
    if (dy !== 0) continue;
    let cell = null, floor = null;
    try {
      cell = bot.blockAt(new Vec3(site.x + dx, site.y + dy, site.z));
      floor = bot.blockAt(new Vec3(site.x + dx, site.y - 1, site.z));
    } catch { continue; }
    if (cell && cell.name === 'obsidian') continue;
    if (!floor || floor.name === 'air' || /water|lava/.test(floor.name)) return false;
  }
  return true;
}

// A frame the bot built can outlive its workshop record: the record expires after 12 h, the obsidian does
// not. Measured 03:07 on 2026-11-01 at 160,70,693 - 6 cells still standing, `WS.at` answering null, so
// build_nether_portal demanded 10 FRESH blocks and make_obsidian went and mined the standing frame to
// get them (obsidian frozen at 7/10 while the bot dug its own door, 14 min of it). Re-derive the origin
// from the world rather than starting a second frame.
// The discriminator against a poured basin is the shape: a frame is a VERTICAL wall spanning several
// y-levels in one z-plane, a lava-plus-water pool is flat.
// Radius 48, not 96. `bot.findBlocks` walks the LOADED chunk map synchronously, so the cost is the volume
// of loaded world, not the number of matches: at 07:11 the bot reached the Nether's open lava seas at
// y=19-32, where a huge volume is loaded, and the server then logged `Numen lost connection: Timed out`
// every 60-90 s (15:11, 15:15, 15:16, 15:19, 15:22, 15:34, 15:43-15:53) - keep-alives cannot be answered
// from inside a synchronous scan. The wider radius bought one longer walk at 04:14 and cost the connection.
function findFrameSite(bot, maxDist = 48) {
  let cells = [];
  const t0 = Date.now();
  try { cells = bot.findBlocks({ matching: blockIds(bot, ['obsidian']), maxDistance: maxDist, count: 48 }); } catch { return null; }
  const ms = Date.now() - t0;
  if (ms > 250) log.warn(`findFrameSite: the ${maxDist}-block scan held the event loop for ${ms}ms (${cells.length} cells) - keep-alive timeouts follow if this runs often`);
  if (cells.length < 3) return null;
  const seen = new Set(cells.map(p => `${p.x},${p.y},${p.z}`));
  const all = PORTAL_FRAME.essentials.concat(PORTAL_FRAME.optional);
  // A candidate must be COMPLETABLE, not merely consistent. Measured 03:54:09: the scan adopted
  // 163,71,693, a wall one block ABOVE the terrain, and every one of its 7 open cells then refused with
  // `no reference block within reach [air(empty)/air(empty)/air(empty)/air(empty)]` - a bottom row at
  // y=71 has nothing under it, because the ground on this spot is y=69 and the real bottom row is y=70.
  // So a still-empty cell in the bottom row is only acceptable with solid ground beneath it.
  const grounded = (o, dx, dy) => {
    if (dy > 0) return true;                                        // only the bottom row needs the floor
    if (seen.has(`${o.x + dx},${o.y + dy},${o.z}`)) return true;    // already obsidian - nothing to place
    const g = bot.blockAt(new Vec3(o.x + dx, o.y - 1, o.z));
    return !!g && g.name !== 'air' && !/water|lava/.test(g.name);
  };
  let best = null;
  for (const p of cells) {
    for (const [dx, dy] of all) {
      const o = { x: p.x - dx, y: p.y - dy, z: p.z };
      const ys = new Set();
      for (const [ex, ey] of PORTAL_FRAME.essentials) if (seen.has(`${o.x + ex},${o.y + ey},${o.z}`)) ys.add(o.y + ey);
      const standing = PORTAL_FRAME.essentials.filter(([ex, ey]) => seen.has(`${o.x + ex},${o.y + ey},${o.z}`)).length;
      const buildable = [[1, 0], [2, 0]].every(([ex, ey]) => grounded(o, ex, ey));
      if (standing >= 3 && ys.size >= 3 && buildable && (!best || standing > best.standing)) best = { ...o, standing };
    }
  }
  if (best) log.info(`findFrameSite: ${best.standing}/10 frame cells standing in a vertical wall - origin ${best.x},${best.y},${best.z} re-derived from the world`);
  return best ? { x: best.x, y: best.y, z: best.z } : null;
}

// Memo so the dig loop does not re-scan 64 blocks per swing. Short on purpose: a frame gains cells as the
// bot works on it, and a longer memo would compare the record against a wall that no longer looks like
// that. A null verdict is cached too.
let _frameScan = { at: 0, site: null };
function frameSiteFromWorld(bot, force) {
  if (!force && Date.now() - _frameScan.at < 8000) return _frameScan.site;
  _frameScan.at = Date.now();
  _frameScan.site = findFrameSite(bot);
  return _frameScan.site;
}

function forgetFrameScan() { _frameScan.at = 0; _frameScan.site = null; }

// The cell keys of the frame the bot owes its portal to - the record first, the world if the record has
// aged out. Used to keep the obsidian harvest off the frame's own blocks.
function frameCellKeys(bot) {
  // The UNION of the recorded frame and whatever wall the world actually shows. Reading only the record
  // was a bug I shipped and then caught in the stub: at 03:20:23 the record was moved to 153,64,764, an
  // empty field, so `frameCellKeys` protected 14 cells of air while the harvest walked up to the real
  // wall at 160,70,693 and started digging it. A wrong note must never widen what we are allowed to eat.
  const out = new Set();
  const add = (s) => {
    if (!s || !Number.isFinite(s.x)) return;
    for (const [dx, dy] of PORTAL_FRAME.essentials.concat(PORTAL_FRAME.optional)) out.add(`${s.x + dx},${s.y + dy},${s.z}`);
  };
  add(require('../workshopRecord').at('nether_portal_frame'));
  add(frameSiteFromWorld(bot));
  return out;
}

reg.define('build_nether_portal', {
  desc: 'Place a 4x5 obsidian frame, light it with flint&steel and step through. Pass {"force":true} to build one where you stand even if already in the Nether (that is how you get HOME).',
  params: { force: 'bool - build even when already in the Nether' },
  async run(bot, a) {
    if (!a.force && bot.game && bot.game.dimension === 'the_nether') return { ok: true, observation: 'already in the Nether' };
    // A lit portal within reach is not a portal to build. 11:10-11:13 shows the alternative: the frame at
    // 162,66,764 was already standing AND lit, the clear pass tried to dig the `nether_portal` cells
    // (`dig time for nether_portal is Infinity` x5), the build reported `portal frame placed 14 obsidian`
    // three times in a row, and the ladder stayed on `travelled overworld -> overworld y=64` forever. Hand
    // it to `use_portal`, which owns entering, and pay nothing for the frame.
    let lit = null;
    try { lit = bot.findBlock({ matching: blockIds(bot, ['nether_portal', 'portal']), maxDistance: 16 }); } catch {}
    if (lit) {
      const up = await reg.get('use_portal').run(bot, { to: a.to }).catch(e => ({ ok: false, observation: `use_portal threw ${e.message}` }));
      return { ok: !!up.ok, observation: `portal already lit at ${lit.position.x},${lit.position.y},${lit.position.z} - entered it instead of building: ${up.observation}` };
    }
    // The frame's cost is CELLS STILL MISSING, not blocks sitting in the pack. The run sat on
    // `need 10 obsidian, have 6` for hours while 6 blocks were already placed at 160,70,693 (02:03:29
    // `portal frame placed 6 obsidian at 160,70,693`) - 12 against a 10-cell frame. Counting only the
    // inventory also hides the cheapest move in the manual: a partly built frame is FINISHED by walking
    // back to it, not by mining more obsidian somewhere else.
    const WS = require('../workshopRecord');
    let site = WS.at('nether_portal_frame');
    if (!site) {
      // The record ages out after 12 h; the half-built wall in the world does not. Without this the
      // step below demands 10 fresh blocks and the harvest digs up the 6 that already stand.
      site = frameSiteFromWorld(bot);
      if (site) {
        WS.note('nether_portal_frame', site, 'origin re-derived from the standing cells');
        log.info(`build_nether_portal: the record had expired - recovered the frame at ${site.x},${site.y},${site.z} from the world`);
      }
    }
    const missingAt = (s) => missingFrameCells(bot, s).length;   // one implementation, shared with pour_portal_cell
    let need = FRAME_COST;
    if (site) {
      const off = Math.round(Math.hypot(site.x - bot.entity.position.x, site.z - bot.entity.position.z));
      need = missingAt(site);
      log.info(`build_nether_portal: remembered frame at ${site.x},${site.y},${site.z} (${off} blocks away) has ${FRAME_COST - need}/${FRAME_COST} cells standing - finishing THAT frame, not a new one`);
      if (off > 16 && need > 0) {
        const w = await reg.get('walk_to').run(bot, { x: site.x + 1, y: site.y, z: site.z - 2, tolerance: 6 });
        const before = need;
        need = missingAt(site);
        log.info(`build_nether_portal: walked to the frame (${String(w.observation).slice(0, 100)}); ${FRAME_COST - need} cells read obsidian (was ${FRAME_COST - before})`);
        if (need === FRAME_COST && before === FRAME_COST) {
          log.warn(`build_nether_portal: at the remembered site NO cell reads obsidian - the chunks may be unloaded or the frame was wrong; falling back to a fresh site`);
        }
        const off2 = Math.round(Math.hypot(site.x - bot.entity.position.x, site.z - bot.entity.position.z));
        if (off2 > 16 && need < FRAME_COST) {
          // Starting a SECOND frame here is not a fallback, it is a reset: it abandons the cells that
          // already stand, demands the whole 10 again, and (until the guard below) overwrites the record
          // so no later round can find the first one. Measured 03:14:54 -> 03:15:40: the walk stopped 7
          // legs short of 161,70,691 with `ahead=lava/lava`, the step went on to `clearing 20 cells at
          // 153,64,764` and finished with `portal frame placed 0 obsidian` - a new origin burned into the
          // record over an empty spot, while a 3-cell door sat 73 blocks away.
          return { ok: false, observation: `the frame at ${site.x},${site.y},${site.z} has ${FRAME_COST - need}/${FRAME_COST} cells standing, the pack already holds ${countItem(bot, 'obsidian')} of the ${need} it needs, and I am still ${off2} blocks from it: the APPROACH is the blocker, not the obsidian (${String(w.observation).slice(0, 150)}). Bridge or drain the route to THIS frame - do not start a second one.` };
        }
      }
    }
    {
      // The world outranks the note, and the more advanced wall outranks both. At 03:20:23
      // `pour_portal_cell` wrote the record to 153,64,764 from a model-supplied `site` (0 cells ever
      // stood there); at 03:23:45 a fresh-spot scan adopted 161,69,695, one block off the real origin,
      // and the record followed 2 blocks of placement away from a wall that already had 3. Each move
      // reset the count of what the portal was actually worth.
      const alt = frameSiteFromWorld(bot);
      const altStanding = alt ? FRAME_COST - missingFrameCells(bot, alt).length : 0;
      log.info(`build_nether_portal: note${site ? ` at ${site.x},${site.y},${site.z}` : ' (none)'} is worth ${FRAME_COST - need}/${FRAME_COST}; the world scan says ${alt ? `${alt.x},${alt.y},${alt.z} = ${altStanding}/${FRAME_COST}` : 'no wall within range'}`);
      if (alt && altStanding > FRAME_COST - need && (alt.x !== site?.x || alt.y !== site?.y || alt.z !== site?.z)) {
        log.info(`build_nether_portal: that wall is further along - building at ${alt.x},${alt.y},${alt.z} and moving the record off the note`);
        site = alt;
        try { WS.note('nether_portal_frame', site, `corrected: ${altStanding}/${FRAME_COST} cells standing`); } catch {}
        need = missingAt(site);
      }
    }
    if (site) {
      // Escape hatch for a record that names an unbuildable origin. The bot had already been pushed onto
      // 163,71,693 by an earlier round, so refusing to ADOPT floating walls was not enough - it kept
      // trying to finish one, 45 ms and zero cells at a time. Only judged when the bot is close enough to
      // read the floor: unloaded chunks answer null and would otherwise destroy a good record.
      const offNow = Math.round(Math.hypot(site.x - bot.entity.position.x, site.z - bot.entity.position.z));
      if (offNow <= 16 && !frameSiteBuildable(bot, site)) {
        log.warn(`build_nether_portal: the origin ${site.x},${site.y},${site.z} cannot be finished - its bottom row has nothing under it (I am ${offNow} blocks away and can read it) - dropping the record and looking for a supported spot`);
        try { WS.forget('nether_portal_frame'); } catch {}
        // Price the gap against a SUPPORTED wall before pricing a fresh ten. Without this re-scan the step
        // fell through to `the frame needs 10 cell(s) filled and the pack has 8` and sent the bot on the
        // long lava trek, when the original ground-supported origin a few blocks away only needed six of
        // the eight already in the pack.
        site = null;
        need = FRAME_COST;
        const grounded = findFrameSite(bot);
        if (grounded && frameSiteBuildable(bot, grounded)) {
          const gNeed = missingFrameCells(bot, grounded).length;
          log.info(`build_nether_portal: a supported wall stands at ${grounded.x},${grounded.y},${grounded.z} (${FRAME_COST - gNeed}/${FRAME_COST} cells) - finishing that one`);
          site = grounded;
          need = gNeed;
          try { WS.note('nether_portal_frame', site, `supported origin, ${FRAME_COST - gNeed}/${FRAME_COST} standing`); } catch {}
        }
      }
    }
    // The two BOTTOM corners are not required by the game, but they are required by the BUILD: a column at
    // x=162 has nothing to click against until (162,bottomY,764) exists, so both `placedAt` and
    // `pour_portal_cell` refuse - measured 04:32:05, `poured 0 cell(s) ... the lava bucket left nothing in
    // the cell (reads air)` on six of eight open cells, after `16x no reference block within reach
    // [air/air/air/air]`. §27t moved them into `optional` to hit the 10-block minimum and re-opened exactly
    // what the 2026-10-27 notes named. They are scaffolding: pay for them first, and the top corners stay
    // decoration.
    const placeBottomCorners = async (s) => {
      if (!s) return 0;
      let put = 0;
      for (const [dx, dy] of PORTAL_FRAME.optional.filter(([ , y]) => y === 0)) {
        const p = new Vec3(s.x + dx, s.y + dy, s.z);
        const cur = bot.blockAt(p);
        if (cur && cur.name === 'obsidian') continue;
        if (bot.entity.position.distanceTo(p) > 4.6) continue;
        const obs = bot.inventory.items().find(i => i.name === 'obsidian');
        // Keep enough for the frame itself; a corner is only worth spending while the door still fits.
        if (!obs || countItem(bot, 'obsidian') - (put + 1) < missingFrameCells(bot, s).length) continue;
        await capped(bot.equip(obs, 'hand'), 4000, 'equip corner');
        const refs = [[0, -1, 0, 0, 1, 0], [-1, 0, 0, 1, 0, 0], [1, 0, 0, -1, 0, 0]]
          .map(([rx, ry, rz, vx, vy, vz]) => ({ b: bot.blockAt(p.offset(rx, ry, rz)), v: new Vec3(vx, vy, vz) }))
          .filter(r => r.b && r.b.boundingBox === 'block' && !/water|lava/.test(r.b.name));
        for (const r of refs) {
          try { await capped(bot.placeBlock(r.b, r.v), 2500, 'place corner'); } catch {}
          const after = bot.blockAt(p);
          if (after && after.name === 'obsidian') { put++; break; }
        }
      }
      if (put) log.info(`build_nether_portal: laid ${put} bottom corner(s) as scaffolding at ${s.x},${s.y},${s.z}`);
      return put;
    };
    if (site) await placeBottomCorners(site);
    if (countItem(bot, 'obsidian') < need) {
      // Two ways to fill the gap and the cheap one comes FIRST: pour the cells where they stand (a lava
      // bucket + a water bucket, no pickaxe tier, no obsidian carried) before mining obsidian somewhere
      // else. This is the route the manual names and the code had never implemented.
      if (site) {
        log.warn(`build_nether_portal: ${need} cell(s) short with ${countItem(bot, 'obsidian')} in the pack - pouring the frame in place first`);
        const pp = await reg.get('pour_portal_cell').run(bot, { max: need });
        need = missingFrameCells(bot, site).length;
        log.warn(`build_nether_portal: pour -> ${String(pp.observation).slice(0, 170)}; ${need} cell(s) still short`);
      }
    }
    if (countItem(bot, 'obsidian') < need) {
      // The number belongs to THIS step, not to the planner's guess. Measured 02:03:59: the plan ran
      // `make_obsidian {"count":3}` three times, each returning ok in under 2 ms (5 >= 3), and then
      // this step failed with `need 10 obsidian, have 5` - the frame's real requirement was nobody's to
      // state, so every step believed the previous one had handled it.
      const short = need - countItem(bot, 'obsidian');
      log.warn(`build_nether_portal: ${need} frame cells still need filling and the pack has ${countItem(bot, 'obsidian')} - topping up ${short} first`);
      const mo = await reg.get('make_obsidian').run(bot, { count: need });
      log.warn(`build_nether_portal: make_obsidian said (${String(mo.observation).slice(0, 170)})`);
      if (countItem(bot, 'obsidian') < need) {
        return { ok: false, observation: `the frame needs ${need} cell(s) filled and the pack has ${countItem(bot, 'obsidian')}; asked make_obsidian for ${short} more and it did not deliver (${String(mo.observation).slice(0, 140)})` };
      }
    }
    if (countItem(bot, 'flint_and_steel') < 1) { const c = await craft(bot, 'flint_and_steel', 1); if (!c.ok) return { ok: false, observation: 'need flint&steel: ' + c.observation }; }
    // Frame origin: bottom row sits one block under the bot's feet so the interior is
    // exactly where the bot stands (that is what makes ignition + travel work first try).
    // Walk up to 6 candidate spots so we do not build the frame inside a hillside.
    const feet = bot.entity.position.floored();
    // NOTE: never use -1 as a "not found" sentinel for coordinates on this seed - the bot's
    // base is at x=-98, so every valid spot also compares less than zero. (That bug hid the
    // working portal site for hours and made every "no flat supported spot" report a lie.)
    let ox = 0, bottomY = 0, oz = 0, spotFound = false;
    // After a tp/respawn the surrounding chunks arrive over the next second or two; scanning
    // before that reads NULL for every cell and the frame search "finds no flat spot" while
    // one exists right under the bot.
    try { await capped(bot.waitForChunksToLoad(), 20000, 'wait for chunks'); } catch {}
    // A portal frame needs the whole 4-wide bottom row supported, and a clear 2x3 interior.
    // Checking only the corner (as the first version did) picked spots where the row hung
    // over air, and then every placement failed with "nothing to place against".
    const diggable = b => !!b && (isAir(b.name) || b.name === 'obsidian' || (!b.name.includes('bedrock') && !b.name.includes('lava')));
    // Frame cells must be air / obsidian / diggable solid - NOT water. (Water was tolerated
    // while hunting the real bug, which was a -1 coordinate sentinel; allowing it made the
    // bot try to build inside a lake, where placement mostly fails and ignition sees water
    // where obsidian should be.)
    const occupiable = b => !!b && (isAir(b.name) || b.name === 'obsidian'
      || (!b.name.includes('bedrock') && !b.name.includes('lava') && !b.name.includes('water')));
    const spotOk = (cx, cy, cz) => {
      // the only hard requirement is that the bottom row has ground under it; the frame and
      // interior cells may be solid rock (the clear loop digs them out) or water.
      let supported = 0;
      for (let x = 0; x <= 3; x++) {
        const g = bot.blockAt(new Vec3(cx + x, cy - 1, cz));
        if (g && !isAir(g.name) && !g.name.includes('water') && !g.name.includes('lava') && !g.name.includes('bedrock')) supported++;
        if (!occupiable(bot.blockAt(new Vec3(cx + x, cy, cz)))) return false;
      }
      if (supported < 1) return false;
      for (let x = 0; x <= 3; x++) for (let dy = 1; dy <= 4; dy++) {
        if (!occupiable(bot.blockAt(new Vec3(cx + x, cy + dy, cz)))) return false;
      }
      return true;
    };
    const findSpot = (origin) => {
      outer: for (let dz = 1; dz <= 4; dz++) {
        for (let dy = 0; dy >= -2; dy--) {
          for (let dx = -4; dx <= 4; dx++) {
            const cx = origin.x + dx, cy = origin.y + dy, cz = origin.z + dz;
            if (spotOk(cx, cy, cz)) return { cx, cy, cz };
            const cz2 = origin.z - dz;
            if (spotOk(cx, cy, cz2)) return { cx, cy, cz: cz2 };
          }
        }
      }
      return null;
    };
    // Refusing because "this shore is a lake" is not an answer a companion can act on, so
    // wander a few times and look again - the bot's own feet are the only site it can judge.
    let origin = feet;
    let spot = null;
    // A frame with cells already standing does not need a site search - its origin IS the site.
    // Measured 03:23:45: the bot stood 6 blocks from a 3/10 wall, ran the fresh-spot scan anyway,
    // "found" 161,69,695 one block off the true origin, placed 2 blocks there and the record followed,
    // which turned 3 paid-in-full cells into rubble and grew the gap from 7 to 9.
    if (site && need < FRAME_COST) {
      ox = site.x; bottomY = site.y; oz = site.z; spotFound = true;
      log.info(`build_nether_portal: filling the recorded origin ${ox},${bottomY},${oz} (${FRAME_COST - need}/${FRAME_COST} standing) instead of scanning for a new spot`);
    }
    for (let hop = 0; hop < 5 && !spot && !spotFound; hop++) {
      try { await capped(bot.waitForChunksToLoad(), 15000, 'wait for chunks'); } catch {}
      origin = bot.entity.position.floored();
      spot = findSpot(origin);
      if (spot) break;
      const ang = Math.random() * Math.PI * 2;
      const nx = Math.round(origin.x + Math.cos(ang) * 24), nz = Math.round(origin.z + Math.sin(ang) * 24);
      log.info(`portal: no dry supported site near ${origin.x},${origin.y},${origin.z}; walking to ${nx},${nz}`);
      await capped(bot.pathfinder.goto(new (GN())(nx, origin.y, nz, 2)), 25000, 'walk looking for portal site');
      await sleep(1500);
    }
    if (spot) { ox = spot.cx; bottomY = spot.cy; oz = spot.cz; spotFound = true; }
    if (!spotFound) {
      const why = (cx, cy, cz) => {
        let supported = 0;
        for (let x = 0; x <= 3; x++) {
          const g = bot.blockAt(new Vec3(cx + x, cy - 1, cz));
          if (g && !isAir(g.name) && !g.name.includes('water') && !g.name.includes('lava') && !g.name.includes('bedrock')) supported++;
          const cell = bot.blockAt(new Vec3(cx + x, cy, cz));
          if (!occupiable(cell)) return `row cell ${cx + x},${cy},${cz} = ${cell ? cell.name : 'NULL'}`;
        }
        if (supported < 1) return `nothing solid under the row (${[0, 1, 2, 3].map(x => { const b = bot.blockAt(new Vec3(cx + x, cy - 1, cz)); return b ? b.name : 'NULL'; }).join('/')})`;
        for (let x = 0; x <= 3; x++) for (let dy = 1; dy <= 4; dy++) {
          const cell = bot.blockAt(new Vec3(cx + x, cy + dy, cz));
          if (!occupiable(cell)) return `column ${cx + x},${cy + dy},${cz} = ${cell ? cell.name : 'NULL'}`;
        }
        return 'predicate says OK (so the scan never reached it?)';
      };
      return { ok: false, observation: `no flat supported 4-wide spot near ${origin.x},${origin.y},${origin.z} after 5 hops; last rejection: ${why(origin.x, origin.y, origin.z + 1)}` };
    }
    // stand in front of the spot: the top row is 4 blocks up, and reach is ~4.5 blocks
    await capped(bot.pathfinder.goto(new (GN())(ox + 1, bottomY, oz - 1, 0)), 15000, 'walk to build spot');
    // Build order matters: every cell must attach to something already placed. Bottom row
    // first (all four, on the ground), then the columns rising from those corners, then the
    // top corners, then the top middle spanning between them. Dropping the bottom corners
    // (to chase the "10 obsidian minimum") left the columns with nothing to reference, so
    // the frame never closed and flint&steel just set the interior on fire.
    const essentials = PORTAL_FRAME.essentials;
    // clear everything the frame and the interior will occupy
    const probe = bot.blockAt(new Vec3(ox + 1, bottomY, oz));
    if (!probe || !bot.blockAt(new Vec3(ox + 1, bottomY - 1, oz))) {
      return { ok: false, observation: `terrain at the build spot (${ox},${bottomY},${oz}) is not loaded yet - wait for chunks after a teleport before building` };
    }
    const clear = [];
    for (let x = 0; x < 4; x++) for (let dy = 0; dy <= 4; dy++) clear.push([x, dy]);
    log.info(`portal: clearing ${clear.length} cells at ${ox},${bottomY},${oz}`);
    for (const [dx, dy] of clear) {
      const p = new Vec3(ox + dx, bottomY + dy, oz);
      const b = bot.blockAt(p);
      if (b && b.name !== 'obsidian' && !isAir(b.name) && !b.name.includes('bedrock') && !b.name.includes('lava') && !b.name.includes('water') && !b.name.includes('portal')) {
        try { if (!(await equipBulkPick(bot, false))) await equipPick(bot); await withReach(bot, b); } catch (e) { log.warn(`portal: clear ${b.name} threw ${e.message}`); }
      }
    }
    log.info('portal: cells cleared, placing frame');
    const placedAt = async (dx, dy) => {
      const p = new Vec3(ox + dx, bottomY + dy, oz);
      const cur = bot.blockAt(p);
      if (cur && cur.name === 'obsidian') return true;
      const obs = bot.inventory.items().find(i => i.name === 'obsidian');
      if (!obs) { log.warn(`portal: no obsidian item left (target ${p.x},${p.y},${p.z}) inv=${require('../observe').invSummary(bot).slots}`); return false; }
      await capped(bot.equip(obs, 'hand'), 4000, 'equip obsidian');
      const refs = [[0, -1, 0, 0, 1, 0], [-1, 0, 0, 1, 0, 0], [1, 0, 0, -1, 0, 0], [0, 0, -1, 0, 0, 1]]
        .map(([rx, ry, rz, vx, vy, vz]) => ({ b: bot.blockAt(p.offset(rx, ry, rz)), v: new Vec3(vx, vy, vz) }))
        // A reference must be a PHYSICAL block. prismarine-block has no isSolid(); the field
        // mineflayer-pathfinder itself uses is `boundingBox === 'block'` (short grass / snow /
        // water are 'empty' and the server ignores a placement that leans on them, which is
        // what produced "refused to place obsidian ...: the block is still air").
        .filter(r => r.b && r.b.boundingBox === 'block' && !r.b.name.includes('water') && !r.b.name.includes('lava')
          && bot.entity.position.distanceTo(r.b.position) <= 4.6);
      if (!refs.length) {
        // Name the four faces that were checked, so the next round can act on it (stand closer, or fill
        // the neighbour first) instead of re-reading the same `frame=6` verdict.
        const seen = [[0, -1, 0], [-1, 0, 0], [1, 0, 0], [0, 0, -1]]
          .map(([rx, ry, rz]) => { const b = bot.blockAt(p.offset(rx, ry, rz)); return b ? `${b.name}${b.boundingBox !== 'block' ? '(empty)' : ''}` : 'NULL'; }).join('/');
        refuse(`no reference block within reach [${seen}]`);
        return false;
      }
      for (const r of refs) {
        if (bot.heldItem && bot.heldItem.name !== 'obsidian') { log.warn(`portal: holding ${bot.heldItem.name}, not obsidian`); refuse('hand would not hold the obsidian'); return false; }
        await capped(bot.placeBlock(r.b, r.v), 2500, `place obsidian on ${r.b.name}`);
        const after = bot.blockAt(p);
        if (after && after.name === 'obsidian') return true;
      }
      const landedElsewhere = [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]
        .map(([ax, ay, az]) => { const q = p.offset(ax, ay, az); const bb = bot.blockAt(q); return bb && bb.name === 'obsidian' ? `${q.x},${q.y},${q.z}` : null; }).filter(Boolean).join(' ');
      refuse(`placed and the cell still reads ${(bot.blockAt(p) || {}).name || 'NULL'}${landedElsewhere ? ` (obsidian appeared beside it at ${landedElsewhere})` : ''}`);
      return false;
    };
    // Multiple passes from different standing spots: a cell that had nothing to attach to
    // (or was out of reach) becomes placeable once a neighbour exists or the bot steps
    // sideways. A player walks around the frame; doing it from one spot cannot reach y+4.
    let placed = 0, progress = true, pass = 0, onStool = false;
    // Why a cell refused, counted across every pass. Without this the whole build returned in 45 ms
    // (`cells cleared` -> `placed 6`) with nothing to read: four cells hit `if (!refs.length) return false`
    // silently, the loop saw progress from the six that were already obsidian, and the next round started
    // blind again. `portal not lit (frame=6 ...)` told nobody that the real answer was "no reference block".
    const refusals = {};
    const refuse = (why) => { refusals[why] = (refusals[why] || 0) + 1; };
    // The order a player builds in. Bottom corners first (a column cannot start in mid-air), then the
    // bottom row and the columns, then the TOP corners, then the top middle - because (1,4) and (2,4) have
    // no frame neighbour below them (dy=3 exists only at dx=0 and dx=3) and their only possible reference
    // face is the top corner beside them. Measured 04:43:35: the frame reached 14 blocks with exactly
    // `163,70,764 164,70,764` open and `4x no reference block within reach [air/air/air/air]`, because the
    // optional corners were a decoration pass that ran after the essentials loop.
    const cornerRow = (y) => PORTAL_FRAME.optional.filter(([, cy]) => cy === y);
    const todo = cornerRow(0)
      .concat(essentials.filter(([, y]) => y < 4))
      .concat(cornerRow(4))
      .concat(essentials.filter(([, y]) => y === 4));
    const vantages = [[1, -2, 0], [3, -2, 0], [-1, -2, 0], [5, -2, 0], [1, -3, 0]];
    // The top row is bottomY+4: no ground standing spot can reach it (reach is ~4.5 blocks
    // measured from the eyes). A player drops a block and stands on it, so do that.
    const climbStool = async () => {
      const fill = bot.inventory.items().find(i => /(cobblestone|cobbled_deepslate|dirt|stone|andesite|diorite|granite|tuff|blackstone)$/.test(i.name));
      if (!fill) return false;
      const spot = new Vec3(ox + 1, bottomY, oz - 2);
      const cur = bot.blockAt(spot);
      if (!cur || isAir(cur.name)) {
        const ref = bot.blockAt(new Vec3(ox + 1, bottomY - 1, oz - 2));
        if (!ref || isAir(ref.name)) return false;
        try { await bot.equip(fill, 'hand'); } catch {}
        await capped(bot.placeBlock(ref, new Vec3(0, 1, 0)), 4000, 'place stool');
      }
      await capped(bot.pathfinder.goto(new (GN())(ox + 1, bottomY + 1, oz - 2, 0)), 12000, 'climb stool');
      const up = bot.entity.position.y >= bottomY + 0.5;
      log.info(`portal stool: ${up ? 'standing on it' : 'could not climb'} (feet y=${Math.round(bot.entity.position.y)} need ${bottomY + 1})`);
      return up;
    };
    while (progress && todo.length && pass < 12) {
      progress = false;
      if (pass > 0) {
        const [vx, vz, vy] = vantages[(pass - 1) % vantages.length];
        await capped(bot.pathfinder.goto(new (GN())(ox + vx, bottomY + vy, oz + vz, 1)), 12000, `build vantage ${pass}`);
      }
      for (let i = 0; i < todo.length; i++) {
        const [dx, dy] = todo[i];
        if (await placedAt(dx, dy)) { todo.splice(i, 1); i--; placed++; progress = true; }
      }
      if (todo.length && todo.some(c => c[1] >= 3) && !onStool) {
        onStool = await climbStool();
        progress = onStool; // one more round from up high
      }
      pass++;
    }
    // All four corners are now in `todo` (two as bottom scaffolding, two as the top row's reference), so a
    // second pass over `optional` here would only re-count cells that were already standing - which is how
    // the log came to say `placed 14 obsidian` about a frame with 10 essentials and 2 of them still open.
    const tally = Object.entries(refusals).sort((a, b) => b[1] - a[1]).map(e => e[1] + 'x ' + e[0]).join(' | ');
    let msg = 'portal frame placed ' + placed + ' obsidian at ' + ox + ',' + bottomY + ',' + oz;
    if (todo.length) {
      const cells = todo.map(c => (ox + c[0]) + ',' + (bottomY + c[1]) + ',' + oz).join(' ');
      msg += ' - ' + todo.length + ' cell(s) still open [' + cells + ']'
        + (pass ? ' after ' + pass + ' pass(es)' : '')
        + (onStool ? ' from the stool' : ' never got on the stool')
        + '; refusals: ' + (tally || 'none recorded');
    }
    log.info(msg);
    // Record the origin even when the frame is incomplete: the next round must be able to finish THIS
    // frame instead of searching for flat ground and demanding 10 fresh blocks. The cells are read back
    // from the world, so a stale record costs one walk, not the whole portal.
    // But a round that placed NOTHING must not move the record. At 03:15:40 `portal frame placed 0
    // obsidian at 153,64,764` overwrote the origin of a frame that had 3 cells standing; the next round
    // read `0/10 cells standing` and went back to demanding all ten.
    if (placed > 0) {
      try { require('../workshopRecord').note('nether_portal_frame', { x: ox, y: bottomY, z: oz }, `frame origin, ${placed}/${FRAME_COST} cells placed this round`); } catch { }
    } else {
      log.warn(`build_nether_portal: placed 0 obsidian at ${ox},${bottomY},${oz} - leaving the frame record where it points instead of adopting an empty spot`);
    }
    // Ignite by INTERACTING WITH A BLOCK, not by "use item in air": bot.activateItem() writes
    // the use_item packet, and 1.21's flint-and-steel only lights a portal through use_item_on
    // (right-clicking a frame face). bot.placeBlock() while holding the steel writes that exact
    // packet with the reference block + face, and the resulting air->nether_portal blockUpdate
    // is what it waits for, so it doubles as the success check.
    const fs = bot.inventory.items().find(i => i.name === 'flint_and_steel');
    if (!fs) return { ok: false, observation: `frame=${placed} obsidian but no flint_and_steel to light it` };
    await capped(bot.pathfinder.goto(new (GN())(ox + 1, bottomY, oz - 1, 0)), 10000, 'step up to frame');
    const attempts = [
      [new Vec3(ox + 1, bottomY, oz), new Vec3(0, 1, 0)],      // top face of bottom row (left)
      [new Vec3(ox + 2, bottomY, oz), new Vec3(0, 1, 0)],      // top face of bottom row (right)
      [new Vec3(ox, bottomY + 1, oz), new Vec3(1, 0, 0)],      // inner face of left column
      [new Vec3(ox + 3, bottomY + 1, oz), new Vec3(-1, 0, 0)], // inner face of right column
      [new Vec3(ox + 1, bottomY + 1, oz), new Vec3(0, 1, 0)],  // first interior cell from inside
    ];
    let portal = null, lastErr = '';
    for (const [pos, face] of attempts) {
      const ref = bot.blockAt(pos);
      if (!ref || ref.name !== 'obsidian') { lastErr = `no obsidian at ${pos.x},${pos.y},${pos.z} (${ref ? ref.name : 'NULL'})`; continue; }
      const still = bot.inventory.items().find(i => i.name === 'flint_and_steel');
      if (!still) { lastErr = 'flint_and_steel disappeared'; break; }
      await capped(bot.equip(still, 'hand'), 4000, 'equip flint_and_steel');
      await capped(bot.lookAt(pos.plus(new Vec3(0.5, 0.5, 0.5).plus(face.scale(0.5)))), 3000, 'look at frame face');
      const res = await capped(bot.placeBlock(ref, face), 6000, 'strike flint_and_steel');
      lastErr = res === null ? 'placement call timed out' : lastErr;
      portal = bot.findBlock({ matching: blockIds(bot, ['nether_portal', 'portal']), maxDistance: 12 });
      if (portal) break;
    }
    if (!portal) return { ok: false, observation: `portal not lit (frame=${placed} obsidian at ${ox},${bottomY},${oz}, held=${bot.heldItem ? bot.heldItem.name : 'none'}, last=${lastErr})` };
    // step into the interior and dwell - travel is triggered by standing inside the blocks
    const fromDim = bot.game && bot.game.dimension;
    // `travelled overworld -> overworld y=64` is the third verdict this stage can print, and the run has
    // now failed on it with a 10/10 frame AND a lit portal (11:41:14 findFrameSite 10/10 -> 11:41:45 the
    // travel verdict). The three causes - not lit, standing next to it, standing in it but on cooldown -
    // need different actions, and the log could not tell them apart. Print the interior cells, the
    // distance to them, and the dimension after each dwell.
    const ipos = new Vec3(ox + 1, bottomY + 1, oz);
    const iname = (p) => { const b = bot.blockAt(p); return b ? `${b.name}${b.id !== undefined ? '#' + b.id : ''}` : 'NULL'; };
    log.warn(`portal travel: I am at ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)}; interior ${ipos.x},${ipos.y},${ipos.z} reads ${iname(ipos)} over ${iname(ipos.offset(0, 1, 0))}; lit block found=${portal ? `${portal.position.x},${portal.position.y},${portal.position.z}` : 'NONE'}`);
    // Same rule as use_portal: verify the body is inside, do not trust a range-1 goto to have put it there.
    const gotIn = await standInPortal(bot, portal ? portal.position : ipos, 'portal travel');
    for (let i = 0; i < 8 && (bot.game && bot.game.dimension) === fromDim && Date.now() < (bot._stepDeadline || Infinity); i++) await sleep(1500);
    const dim = bot.game && bot.game.dimension;
    // Only measure against the interior while we are still in the same dimension: after a transfer the
    // Overworld chunks are unloaded, so `blockAt(ipos)` is NULL and the distance is a cross-dimension
    // number (683.6 blocks at 16:55:52) that reads like a failure when it is the success case.
    const same = dim === fromDim;
    const dEnd = same ? Math.round(bot.entity.position.distanceTo(ipos.offset(0.5, 0.5, 0.5)) * 10) / 10 : null;
    return { ok: !same, observation: `travelled ${fromDim} -> ${dim} y=${Math.round(bot.entity.position.y)}${same ? ` (${dEnd} blocks from the interior cell, which now reads ${iname(ipos)}; body ${gotIn ? 'was inside' : 'never got inside'})${gotIn ? ' - INSIDE AND NOT TRANSFERRING: suspect portal cooldown or a broken link on the far side' : ''}` : ' (body was inside the portal; the far side is a different dimension, so the old interior cell is no longer loaded)'}` };
  },
});

// Walk into the nearest lit portal and let it take us somewhere.
// Fill missing portal-frame cells by POURING, not by mining.
//
// Why this exists: the run spent 2026-10-30 night into 10-31 morning treating "10 obsidian in the pack,
// mined with a diamond pickaxe" as the prerequisite for the Nether, and re-minting that pickaxe was
// itself blocked by 3 diamonds. The manual the user supplied (mc_speedrun_doc, §2.1) names the cheaper
// route the code had never implemented: a frame cell can be CREATED where it stands - a lava source
// touched by water becomes obsidian - which needs no pickaxe tier at all. The state at 02:03 already
// proved the arithmetic was wrong: 6 cells standing + 6 in the pack against a 10-cell frame, and
// build_nether_portal still refused because its gate counted the inventory.
reg.define('pour_portal_cell', {
  desc: 'Create the obsidian a portal frame is still missing, in place: put a lava source in the empty cell, run water onto it, the contact becomes obsidian. Needs NO diamond pickaxe and NO obsidian in the pack - only a lava bucket and a water bucket.',
  params: { max: 'int default 6', site: 'optional {x,y,z} frame origin; defaults to the remembered frame' },
  budgetMs: 300000,
  async run(bot, a) {
    const WS = require('../workshopRecord');
    const site = a.site || WS.at('nether_portal_frame') || frameSiteFromWorld(bot);
    if (!site || !Number.isFinite(site.x)) {
      return { ok: false, observation: 'no frame site on file - run build_nether_portal once (it records the origin) or pass {"site":{"x":..,"y":..,"z":..}}' };
    }
    // Fill in a missing record, never overwrite a live one: `a.site` is model-supplied and a wrong
    // number here would move the portal to a field that does not exist.
    if (!WS.at('nether_portal_frame')) { try { WS.note('nether_portal_frame', site, 'poured cells at this origin'); } catch {} }
    let miss = missingFrameCells(bot, site);
    if (!miss.length) return { ok: true, observation: `the frame at ${site.x},${site.y},${site.z} is already complete (${FRAME_COST}/${FRAME_COST}) - light it with flint_and_steel` };
    const lava = bot.inventory.items().find(i => i.name === 'lava_bucket');
    let water = bot.inventory.items().find(i => i.name === 'water_bucket');
    if (!lava) return { ok: false, observation: `pouring needs a LAVA bucket and the pack has none (water_bucket=${countItem(bot, 'water_bucket')} bucket=${countItem(bot, 'bucket')}) - fill one at a lava source first (obsidian_farm names the pools)` };
    if (!water) {
      const eb = await reg.get('ensure_bucket').run(bot, {});
      water = bot.inventory.items().find(i => i.name === 'water_bucket');
      if (!water) return { ok: false, observation: `pouring needs a WATER bucket too; ensure_bucket said (${String(eb.observation).slice(0, 150)})` };
    }
    const want = Math.min(a.max ?? 6, miss.length);
    const done = [], failed = [];
    const cellAt = (dx, dy) => new Vec3(site.x + dx, site.y + dy, site.z);
    const read = (dx, dy) => { try { return bot.blockAt(cellAt(dx, dy)); } catch { return null; } };
    for (const [dx, dy] of miss.slice(0, want)) {
      const p = cellAt(dx, dy);
      if (bot.entity.position.distanceTo(p) > 4.6) {
        try { await capped(bot.pathfinder.goto(new (GN())(site.x + 1, site.y, site.z - 2, 2)), 15000, 'pour: vantage'); } catch { }
        await sleep(400);
      }
      if (bot.entity.position.distanceTo(p) > 4.6) { failed.push(`${dx},${dy}: out of reach (${Math.round(bot.entity.position.distanceTo(p))} blocks) - needs a stool or a nearer site`); continue; }
      const cur = read(dx, dy);
      if (cur && cur.name === 'obsidian') { done.push(`${dx},${dy} already standing`); continue; }
      if (cur && !isAir(cur.name)) {
        try { if (!(await equipBulkPick(bot, false))) await equipPick(bot); await bot.dig(cur); } catch { failed.push(`${dx},${dy}: ${cur.name} in the way and the dig failed`); continue; }
      }
      // 1) a lava SOURCE into the cell. Flowing lava + water makes cobblestone, so this is the whole
      // difference between obsidian and rubble (measured twice on 2026-10-30).
      try { await bot.equip(lava, 'hand'); } catch { }
      try { await bot.lookAt(p.offset(0.5, 0.5, 0.5), true); } catch { }
      try { await bot.activateItem(); } catch { }
      await sleep(700);
      const nowLava = read(dx, dy);
      if (!nowLava || !/lava/.test(nowLava.name)) { failed.push(`${dx},${dy}: the lava bucket left nothing in the cell (reads ${nowLava ? nowLava.name : 'NULL'})`); continue; }
      const wasSource = isFluidSource(nowLava);
      // 2) water onto it from above - it flows down onto the source and converts it.
      const up = p.offset(0, 1, 0);
      const wb = bot.inventory.items().find(i => i.name === 'water_bucket') || water;
      try { await bot.equip(wb, 'hand'); } catch { }
      try { await bot.lookAt(up.offset(0.5, 0.5, 0.5), true); } catch { }
      try { await bot.activateItem(); } catch { }
      await sleep(1600);
      const after = read(dx, dy);
      const nm = after ? after.name : 'NULL';
      if (nm === 'obsidian') {
        done.push(`${dx},${dy}`);
        if (!wasSource) log.warn(`pour_portal_cell: ${dx},${dy} became obsidian although the lava read as flowing - the source test is wrong somewhere, not blocking`);
      } else if (nm === 'cobblestone' || nm === 'stone') {
        failed.push(`${dx},${dy}: became ${nm} - water met FLOWING lava, so the cell never held a source`);
      } else {
        failed.push(`${dx},${dy}: still reads ${nm} after the pour - the water never reached the lava`);
      }
      // 3) take the water back so the interior stays workable (best effort).
      try {
        const w2 = bot.inventory.items().find(i => i.name === 'water_bucket');
        if (w2) {
          await bot.equip(w2, 'hand');
          await bot.lookAt(up.offset(0.5, 0.5, 0.5), true);
          await bot.activateItem();
          await sleep(400);
        }
      } catch { }
      // the buckets empty as they are used; re-find them each cell
      const nl = bot.inventory.items().find(i => i.name === 'lava_bucket');
      if (!nl) { failed.push('lava bucket ran empty mid-frame'); break; }
    }
    const stillMissing = missingFrameCells(bot, site);
    // Record the VERIFIED fact that the frame can be lit, so the ladder can treat the obsidian step as
    // satisfied without duplicating the frame geometry anywhere else (two implementations of that count
    // is what made the gate disagree with the dig all night).
    if (stillMissing.length === 0) { try { require('../workshopRecord').note('nether_portal_frame_ready', site, 'all 10 cells read obsidian'); } catch { } }
    log.skill(`pour_portal_cell: poured ${done.length} cell(s) at ${site.x},${site.y},${site.z}; ${stillMissing.length}/${FRAME_COST} still missing${failed.length ? `; failed: ${failed.join(' | ')}` : ''}`);
    return {
      ok: stillMissing.length === 0,
      observation: stillMissing.length === 0
        ? `frame complete at ${site.x},${site.y},${site.z} (${FRAME_COST}/${FRAME_COST} cells) - ignite with flint_and_steel; no diamond pickaxe and no obsidian from the pack were needed`
        : `poured ${done.length}/${want} at ${site.x},${site.y},${site.z}; ${stillMissing.length} cell(s) still missing${failed.length ? ` - first failure: ${failed[0]}` : ''}`,
    };
  },
});

// Standing NEXT TO a portal is not standing IN it, and the server only transfers a body whose cells
// actually read `nether_portal`. `goto(centre, range 1)` is satisfied one cell short - at (164.5,67,765.5)
// the distance to (164.5,67,764.5) is exactly 1.0 - so the old code parked beside the frame and then jumped
// in place for 12 s. 16:41-16:47: six attempts, `portal at 164,67,764` found every time, `still in overworld`
// every time, and the LLM concluded "dead portal" and went to farm obsidian it could not mine.
// Verify the body cells, and walk in with control states until they read portal. No jumping: it does not
// help contact and it can carry the bot back out of the 2x3 opening.
async function standInPortal(bot, cell, label) {
  const centre = new Vec3(cell.x + 0.5, cell.y, cell.z + 0.5);
  const inside = () => {
    const f = bot.entity.position.floored();
    for (const dy of [0, 1]) {
      const b = bot.blockAt(f.offset(0, dy, 0));
      if (b && /portal/.test(b.name)) return true;
    }
    return false;
  };
  try {
    await capped(bot.pathfinder.goto(new (GN())(centre.x, centre.y, centre.z, 1)), 12000, `${label} approach`, () => { try { bot.pathfinder.stop(); } catch {} });
  } catch {}
  for (let k = 0; k < 8 && !inside(); k++) {
    // `setControlState` is NOT covered by the step lease (bot.js only leases goto/dig/placeBlock), so an
    // abandoned step would keep walking the bot into the next step's business. Test the clock here.
    if (Date.now() >= (bot._stepDeadline || Infinity)) break;
    try { await bot.lookAt(centre, true); } catch {}
    try { bot.setControlState('forward', true); await sleep(400); bot.setControlState('forward', false); } catch {}
    await sleep(200);
  }
  const ok = inside();
  const f = bot.entity.position.floored();
  log[ok ? 'info' : 'warn'](`${label}: body ${ok ? 'IS' : 'is NOT'} in the portal (feet ${f.x},${f.y},${f.z} reads ${(bot.blockAt(f) || {}).name}, head reads ${(bot.blockAt(f.offset(0, 1, 0)) || {}).name})`);
  return ok;
}


// Walk back along dry footing toward the Nether-side portal, one verified cell at a time. The causeway
// built on the way in is still in the world, so getting home needs no new blocks - only stepping onto the
// tops that already exist. This exists because the planner's own escape chain (pillar_up -> use_portal)
// cannot move a bot standing in lava: a pillar needs a dry face to click, and use_portal needs a lit portal
// it cannot reach. 03:26-03:37 produced six plans and zero cells of movement.
async function walkToDryHome(bot, cells, target, opts) {
  const P = require('./primitives');
  let home = target || null;
  if (!home) { try { home = require('../workshopRecord').at('portal_arrival_the_nether'); } catch {} }
  if (!home) { try { home = require('../workshopRecord').at('nether_portal_out'); } catch {} }
  let walked = 0;
  for (let i = 0; i < cells && Date.now() < (bot._stepDeadline || Infinity); i++) {
    const p = bot.entity.position.floored();
    if (!target && home && Math.abs(p.x - home.x) + Math.abs(p.z - home.z) <= 4) return { reached: true, walked, at: p };
    const dx = home ? Math.sign(home.x - p.x) : -1;
    const dz = home ? Math.sign(home.z - p.z) : 0;
    const straight = Math.abs(home ? home.x - p.x : 1) >= Math.abs(home ? home.z - p.z : 0);
    const tries = [[straight ? dx : 0, straight ? 0 : dz], [dx, dz], [-dx, 0], [0, -dz], [dz, dx], [0, 0]].filter(([a, b]) => a || b);
    let moved = 0;
    for (const [mx, mz] of tries) {
      for (const dy of [1, 0, -1]) {   // one UP is the brick-column top a player would hop onto
        const st = await P.stepOnto(bot, { x: p.x + mx, y: p.y + dy, z: p.z + mz }, opts || {});
        if (st.moved >= 1) { moved = st.moved; break; }
      }
      if (moved) break;
    }
    if (!moved) return { reached: false, walked, stuck: true, at: p };
    walked += moved;
    await P.sleep(120);
  }
  return { reached: false, walked, at: bot.entity.position.floored() };
}

reg.define('use_portal', {
  desc: 'Find the nearest lit nether portal (up to 96 blocks), step in, wait for the dimension change. Use it to go in AND back.',
  params: { to: 'optional dimension id to require, e.g. overworld' },
  async run(bot, a) {
    const fromDim = bot.game && bot.game.dimension;
    // 末地里没有下界传送门：这条 20 秒搜索就是 20:45-20:49 那场互杀的另一半，直接拒掉而不是等超时。
    if (require('./endgame').inEnd(bot)) return { ok: false, observation: 'the End has no nether portal - searching for one is a 20 s timeout, not a route out' };
    let p = bot.findBlock({ matching: blockIds(bot, ['nether_portal', 'portal']), maxDistance: 48 });
    if (!p) {
      // Range 0 can never be satisfied, so this "walk 24 blocks to load new chunks" always burned its whole
      // 20 s cap and reported a timeout - the same range-0 mistake the portal entry had. Range 3 lets it
      // finish as soon as it is roughly there, which is all a chunk-loading nudge needs.
      await capped(bot.pathfinder.goto(new (GN())(bot.entity.position.x + 24, bot.entity.position.y, bot.entity.position.z, 3)), 20000, 'search walk for portal');
      p = bot.findBlock({ matching: blockIds(bot, ['nether_portal', 'portal']), maxDistance: 96 });
    }
    if (!p) {
      // Walk back to the portal we came through. This record used not to exist, which is how a
      // 110-block wander became a dead end: 12:13:50 `no lit portal found near -23,76,257 (dim=the_nether)`
      // while the arrival portal of that very trip stands at 18,70,156 - further than the 96-block search,
      // and the bot has no reason to guess that way.
      const WSm = require('../workshopRecord');
      const mem = WSm.at(`portal_arrival_${fromDim}`);
      if (mem) {
        log.info(`use_portal: nothing in reach, but the ${fromDim} arrival portal is remembered at ${mem.x},${mem.y},${mem.z} - walking to it`);
        for (let leg = 0; leg < 5; leg++) {
          try { await capped(bot.pathfinder.goto(new (GN())(mem.x + 0.5, mem.y, mem.z + 0.5, 3)), 20000, 'walk to remembered portal', () => { try { bot.pathfinder.stop(); } catch {} }); } catch {}
          p = bot.findBlock({ matching: blockIds(bot, ['nether_portal', 'portal']), maxDistance: 64 });
          if (p) { log.info(`use_portal: the remembered portal is lit at ${p.position.x},${p.position.y},${p.position.z} after ${leg + 1} leg(s)`); break; }
          if (Math.hypot(bot.entity.position.x - mem.x, bot.entity.position.z - mem.z) < 8) { log.warn(`use_portal: arrived within 8 of the remembered cell and still sees no lit portal - the record is stale, dropping it`); WSm.forget(`portal_arrival_${fromDim}`); break; }
        }
      }
      if (!p) {
        // The arrival memory only exists for trips taken after it was added, so a bot already wandering in
        // the Nether has nothing to walk to (12:26:01, 12:29:07: `no lit portal found near -90,91,256 ...
        // (no arrival portal remembered for this dimension)` while its own Overworld frame stands on record
        // at 162,66,764). The link is a rule, not a guess: the Nether side sits at (Overworld x/8, z/8).
        // Walk toward that and keep looking - the game may have shifted it by tens of blocks, so the target
        // is a heading with a wide arrival radius, not a cell to stand on.
        const frame = WSm.at('nether_portal_frame');
        if (frame && fromDim === 'the_nether') {
          const t = { x: Math.round(frame.x / 8), z: Math.round(frame.z / 8) };
          log.info(`use_portal: no arrival record, but the Overworld frame at ${frame.x},${frame.z} links to ~${t.x},${t.z} - walking there and looking`);
          let last = null;
          for (let leg = 0; leg < 8; leg++) {
            const here = bot.entity.position;
            const gap = Math.hypot(here.x - t.x, here.z - t.z);
            if (gap < 24) break;
            try { await capped(bot.pathfinder.goto(new (GN())(t.x, here.y, t.z, 12)), 25000, 'walk to linked portal', () => { try { bot.pathfinder.stop(); } catch {} }); } catch {}
            p = bot.findBlock({ matching: blockIds(bot, ['nether_portal', 'portal']), maxDistance: 64 });
            if (p) { log.info(`use_portal: found the linked portal at ${p.position.x},${p.position.y},${p.position.z} after ${leg + 1} leg(s)`); break; }
            const now = bot.entity.position;
            if (last && Math.hypot(now.x - last.x, now.z - last.z) < 3) { log.warn(`use_portal: stopped moving at ${Math.round(now.x)},${Math.round(now.y)},${Math.round(now.z)} on the way to the linked portal`); break; }
            last = now;
          }
        }
      }
      if (!p) {
        // Vertical recovery for BOTH walks home, placed after them on purpose: my first attempt sat
        // inside only the x/8-link branch and never executed (14:27-14:42 showed zero `climb to own
        // portal` lines while the bot used the remembered-arrival walk instead). Both walks target the
        // bot's OWN height and test arrival in X/Z only, so a portal 38 cells above the tunnel floor
        // reads as "arrived, then cannot find it" - it circled the same cell for four attempts at
        // y=35 under its own frame at 18,73,96. Re-scan wide, and if what we find is above/below us,
        // climb: the same move that produced the blaze rods, with netherrack free here.
        const wide = bot.findBlock({ matching: blockIds(bot, ['nether_portal', 'portal']), maxDistance: 96 });
        const hy = bot.entity.position.floored().y;
        const dY = wide ? wide.position.y - hy : 0;
        if (wide && Math.abs(dY) >= 4) {
          log.warn(`use_portal: own portal is at ${wide.position.x},${wide.position.y},${wide.position.z} - ${dY} cells ${dY > 0 ? 'ABOVE' : 'BELOW'} me (y=${hy}); filling and climbing instead of circling`);
          const fill = countItem(bot, 'netherrack') + countItem(bot, 'cobblestone') + countItem(bot, 'cobbled_deepslate');
          if (fill < Math.abs(dY) + 2) {
            await reg.get('mine').run(bot, { names: ['netherrack'], count: 32, maxDistance: 24 }).catch(() => {});
          }
          await capped(reg.get('pillar_up').run(bot, { up: Math.abs(dY) + 1 }), 200000, 'climb to own portal').catch(e => log.warn(`use_portal: climb threw ${e.message}`));
          p = bot.findBlock({ matching: blockIds(bot, ['nether_portal', 'portal']), maxDistance: 24 });
          log.warn(`use_portal: after climbing to y=${bot.entity.position.floored().y}, portal ${p ? `IN REACH at ${p.position.x},${p.position.y},${p.position.z}` : 'still not found'}`);
        } else if (wide) {
          p = wide;
          log.info(`use_portal: the portal at ${p.position.x},${p.position.y},${p.position.z} is level with me - entering`);
        }
      }
      // LAST, not first: this delegate can end in a cross-dimension OP lift (pillar_up's terminal branch),
      // which abandons the Nether entirely. Running it before the two walks home meant a bot merely
      // standing over a lava sea - no standable cell within 8 blocks, but its own portal 100 blocks away -
      // got teleported to the Overworld instead of walking back, throwing away the blaze hunt. A portal
      // search must exhaust its own memory and the vanilla x/8 link before anyone reaches for a lift.
      // `!p` again on purpose: we entered this block because no portal was in reach, but the two walks above
      // may have found one since. Without this re-check the delegate ran even after a successful walk home
      // and could OP-lift a bot that was already standing at its own portal (caught by check M). The scan
      // itself is skipped when a portal was found - 10k blockAt lookups for nothing is not free.
      if (!p && fromDim === 'the_nether') {
        const near = findStandable(bot, bot.entity.position.floored(), 8, 30);
        if (!near.cell && near.seen > 200) {
          const esc = await reg.get('pillar_up').run(bot, { up: 12 }).catch(e => ({ ok: false, observation: `threw ${e.message}` }));
          const wr = await walkToDryHome(bot, 12);
          log.warn(`use_portal: no portal from this cell - walked ${wr.walked} cell(s) over my own causeway toward it${wr.reached ? ' and reached the portal cell' : wr.stuck ? ` and stopped: no dry footing adjacent to ${wr.at.x},${wr.at.y},${wr.at.z}` : ''}`);
          // ok means "I travelled". A local escape that gained one cell is not a trip, and reporting
          // ok:true here let the planner believe the return happened while the bot was still in the_nether
          // (03:23:15 - `use_portal ok: sealed Nether cell and no portal`, dimension unchanged). It has to
          // fail so the next plan is the walk home (bridge_to toward the portal), not another portal attempt.
          const dimNow = (bot.game && bot.game.dimension) || 'unknown';
          return { ok: dimNow !== fromDim, observation: `did NOT leave ${fromDim}: sealed cell, no lit portal reachable from here (${esc.observation}) - the way out is the causeway back to the portal recorded as portal_arrival_overworld/the_nether, one bridged cell at a time (bridge_to {x,z of that portal}), not another use_portal call` };
        }
      }
      if (!p) return { ok: false, observation: `no lit portal found near ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.y)},${Math.round(bot.entity.position.z)} (dim=${fromDim})${mem ? `, and the remembered arrival portal at ${mem.x},${mem.y},${mem.z} did not light up either` : ' (no arrival portal remembered for this dimension)'}` };
    }
    log.info(`use_portal: portal at ${p.position.x},${p.position.y},${p.position.z} from dim=${fromDim}`);
    let gotIn = false;
    // The portal was FOUND but not REACHABLE. Measured 14:45:47 -> 14:46:33: it stood at y=35 while its
    // own frame glowed at 18,73,96, and `standInPortal` failed 4 times because a body can never occupy
    // a cell 38 blocks above it. Close the height gap first (the same move that won the blaze rods),
    // then re-scan so `p` names a cell we can actually stand in.
    {
      const hy0 = bot.entity.position.floored().y;
      const dy0 = p.position.y - hy0;
      if (Math.abs(dy0) >= 4) {
        log.warn(`use_portal: the portal is ${dy0} cells ${dy0 > 0 ? 'ABOVE' : 'BELOW'} my feet (y=${hy0}) - closing the height gap before standing in it`);
        if (dy0 > 0) {
          const fill = countItem(bot, 'netherrack') + countItem(bot, 'cobblestone') + countItem(bot, 'cobbled_deepslate');
          if (fill < dy0 + 2) await reg.get('mine').run(bot, { names: ['netherrack'], count: 32, maxDistance: 24 }).catch(() => {});
          await capped(reg.get('pillar_up').run(bot, { up: Math.min(48, dy0 + 1) }), 220000, 'climb to portal height').catch(e => log.warn(`use_portal: climb threw ${e.message}`));
        } else {
          await reg.get('dig_to_y').run(bot, { toY: p.position.y, max: Math.min(40, -dy0 + 4) }).catch(() => {});
        }
        const hy1 = bot.entity.position.floored().y;
        const p2 = bot.findBlock({ matching: blockIds(bot, ['nether_portal', 'portal']), maxDistance: 32 });
        log.warn(`use_portal: after the height move y=${hy1}; portal ${p2 ? `at ${p2.position.x},${p2.position.y},${p2.position.z} (dy=${p2.position.y - hy1})` : 'no longer within 32'}`);
        if (p2) p = p2;
      }
    }
    for (let attempt = 0; attempt < 4 && Date.now() < (bot._stepDeadline || Infinity); attempt++) {
      gotIn = await standInPortal(bot, p.position, 'enter portal');
      // 8 x 1.5 s = 12 s of contact. The survival portal delay is 80 ticks (4 s), so this is generous; what
      // was missing was never the wait, it was being inside at all.
      for (let i = 0; i < 8 && Date.now() < (bot._stepDeadline || Infinity); i++) {
        await sleep(1500);
        const d = bot.game && bot.game.dimension;
        if (d !== fromDim && (!a.to || d === a.to)) {
          // Remember where we landed, per dimension: the portal that brought us here is the only one we can
          // trust to take us back, and "no lit portal found near ..." is what forgetting it costs.
          const arr = bot.entity.position.floored();
          try { require('../workshopRecord').note(`portal_arrival_${d}`, { x: arr.x, y: arr.y, z: arr.z }, `landed here after ${fromDim} -> ${d}`); } catch {}
          return { ok: true, observation: `travelled ${fromDim} -> ${d} at ${JSON.stringify(arr)}, arrival remembered` };
        }
      }
    }
    const d = bot.game && bot.game.dimension;
    return { ok: d !== fromDim, observation: `still in ${d} after 4 attempts (was ${fromDim}); body ${gotIn ? 'WAS inside the portal and the server did not transfer it - suspect portal cooldown or a broken link on the far side' : 'never got inside the portal cell - the approach is the problem, not the portal'}` };
  },
});

reg.define('return_overworld', {
  desc: 'Get back to the Overworld from the Nether: use an existing portal, or build one here (needs 14 obsidian + flint&steel) and take it.',
  params: {},
  async run(bot) {
    if (bot.game && bot.game.dimension === 'overworld') return { ok: true, observation: `already in the overworld at y=${Math.round(bot.entity.position.y)}` };
    // 末地不是"下界待回家"：这一条被呼叫两次都是 recover_surface 替它决定的，而一次逃离末地就要重新一趟
    // 45 格下钻 + 一次开门。留在末地才是正解，所以这里直接拒（recover_surface 已经改成本岛解决）。
    if (inEnd(bot)) return { ok: false, observation: '我在末地里打龙 - 回主世界不是恢复手段（离开这岛要重新下钻一趟）' };
    const first = await reg.get('use_portal').run(bot, { to: 'overworld' });
    if (first.ok) return first;
    if (countItem(bot, 'obsidian') < 14) return { ok: false, observation: `no portal reachable and only ${countItem(bot, 'obsidian')} obsidian to build one: ${first.observation}` };
    log.info('return_overworld: no portal reachable, building one here');
    const built = await reg.get('build_nether_portal').run(bot, { force: true });
    if (!built.ok) return { ok: false, observation: `portal build failed in this dimension: ${built.observation}` };
    return { ok: true, observation: built.observation };
  },
});

// ---- Nether: fortress, blaze, barter/pearls ----
reg.define('search_nether_fortress', {
  desc: 'Traverse the Nether on foot (dig through netherrack, bridge over small lava gaps) scanning for a fortress; incremental - call it again if it reports no sighting.',
  params: { steps: 'int default 14', seconds: 'int default 100' },
  async run(bot, a) {
    if (bot.game && bot.game.dimension !== 'the_nether') return { ok: false, observation: 'not in the Nether' };
    const fortressIds = blockIds(bot, ['nether_brick', 'nether_bricks', 'red_nether_brick', 'nether_brick_stairs', 'nether_brick_fence']);
    const budgetMs = (a.seconds || 100) * 1000;
    const t0 = Date.now();
    bot._wetN = 0; bot._wetKey = '';   // per-call wet-footing tally (see the verdict below)
    // Long goto goals in the Nether are usually unreachable (lava lakes, ledges), and A* then
    // burns 10-20 s per attempt without moving - which is why the old version "searched" 6
    // steps in 2 minutes and went nowhere. Short hops that we clear by hand always advance.
    // "Persisted across calls" only means across calls IN THIS PROCESS. `_netherDir` used to be a plain
    // in-memory variable, so every restart re-rolled a random heading - and a restart is exactly what the
    // supervisor, the panel and my own deployments keep doing. Measured 18:34:47: `16 hops (dug 0, MOVED 16)`
    // from -203 back to -42, i.e. the sweep walked its own already-covered tunnel in reverse because the
    // new process drew the opposite heading. The heading is a fact about the world-search, so record it.
    if (!bot._netherDir) {
      const WSm = require('../workshopRecord');
      let mem = null;
      try { mem = WSm.at('nether_sweep_dir'); } catch {}
      // The heading travels in `extra`, because workshopRecord.note() persists only {x,y,z,ts,extra} -
      // a `dx`/`dz` field passed in the position object is silently dropped (proved by the first record,
      // which came back as {"x":22,"y":59,"z":70} with no direction at all). A persistence fix that
      // stores nothing is worse than no fix, since it looks done.
      const md = mem && /dir=(-?\d+),(-?\d+)/.exec(String(mem.extra || ''));
      const mv = md ? [Number(md[1]), Number(md[2])] : null;
      bot._netherDir = (mv && (mv[0] || mv[1]) && Math.abs(mv[0]) + Math.abs(mv[1]) === 1) ? mv : [[1, 0], [-1, 0], [0, 1], [0, -1]][Math.floor(Math.random() * 4)];
      if (mv) {
        const nf = bot.entity.position.floored();
        log.info(`search_nether_fortress: continuing the recorded sweep heading (${mv[0]},${mv[1]}) from ${mem.x},${mem.y},${mem.z}; I am at ${nf.x},${nf.y},${nf.z}`);
      }
    }
    // A fortress already spotted outranks a straight-line heading: after a restart, an assist lift or a
    // death, the recorded sweep direction is only a memory of where I was going, while `fortress_seen` is
    // the thing I was looking for. Steer at it while it is still worth travelling to (not already at it,
    // not so far that the chunks are unloaded).
    try {
      const WSm2 = require('../workshopRecord');
      const fs2 = WSm2.at('fortress_seen');
      if (fs2 && bot.game && bot.game.dimension === 'the_nether') {
        const c = bot.entity.position.floored();
        const ddx = fs2.x - c.x, ddz = fs2.z - c.z, gapXZ = Math.hypot(ddx, ddz);
        if (gapXZ > 12 && gapXZ < 320) {
          bot._netherDir = Math.abs(ddx) >= Math.abs(ddz) ? [Math.sign(ddx) || 1, 0] : [0, Math.sign(ddz) || 1];
          log.info(`search_nether_fortress: steering at the remembered fortress ${fs2.x},${fs2.y},${fs2.z} (${Math.round(gapXZ)} blocks, heading ${bot._netherDir.join(',')})`);
        }
      }
    } catch {}
    let d = bot._netherDir, dug = 0, placed = 0, hops = 0, turned = 0, turnStreak = 0, stuck = 0, moved = 0, escapes = 0;
    // A sighting is not an arrival. These carry the last fortress block seen plus the range at the moment
    // it was seen, so the call can report the distance it CLOSED instead of returning ok:true from 19
    // blocks away (that fake arrival is what let farm_blaze spin 14 hunt iterations in 0.8 s at 18:43:59).
    let spottedAt = null, spottedGap = 0;
    const steerAt = (sp) => {
      const dd = sp.minus(bot.entity.position.floored());
      d = Math.abs(dd.x) >= Math.abs(dd.z) ? [Math.sign(dd.x) || 1, 0] : [0, Math.sign(dd.z) || 1];
      bot._netherDir = d;
    };
    const maxSteps = a.steps || 14;
    // `bot._stepDeadline` is the lease's own kill switch (stepLease.bindDeadline hands a stale async
    // context the value 1), and this loop did not read it - so once the step cap evicted the sweep, the
    // orphan kept hopping and digging for its full 100 s budget at 110 refused calls per minute:
    // `orphan step: goto refused - the hand belongs to the live step` (measured 18:01:26).
    while (hops < maxSteps && Date.now() - t0 < budgetMs && Date.now() < (bot._stepDeadline || Infinity)) {
      // 64, not 48: a fortress is a structure tens of blocks across, and 48 through solid netherrack meant
      // the sweep could stand inside a cavern that had brick 50 blocks away and report "no fortress in
      // sight" round after round. The scan is a block lookup, not a line of sight, so the wider radius is
      // the only thing that turns "digged 13 blocks" into a real chance of finding one.
      // Scanning is the expensive part of a hop loop, not the walking: findBlock walks EVERY cell in the
      // box (64 -> 129^3 = ~2.1M synchronous blockAt calls) and it was being re-run several times per
      // second. That is the multi-minute starvation this run keeps showing (live.json frozen 224 s at
      // 04:53:55 while the loop was otherwise alive). Memoise it for 8 s and cap the radius at 56: a
      // fortress does not move, and 56 is beyond the 40-block engagement range anyway.
      const fortScan = () => {
        const nowT = Date.now();
        if (bot._fortScan && nowT - bot._fortScan.at < 15000) return bot._fortScan.seen;
        let sv = null;
        // Measured, because the process keeps starving for minutes and this is the only synchronous
        // whole-volume walk in the loop: findBlock iterates EVERY cell in the box (56 -> ~1.4M blockAt
        // calls across ~120 chunks). Radius 32 = ~270k cells, and the scan reports its own cost so the
        // next stall can be attributed by number instead of by my reasoning (04:53:55 live.json frozen 224 s,
        // 05:05:41 frozen 267 s - both with the sweep otherwise alive).
        const tScan = Date.now();
        try { sv = bot.findBlock({ matching: fortressIds, maxDistance: 32 }); } catch {}
        const scanMs = Date.now() - tScan;
        if (scanMs > 3000) log.warn(`search_nether_fortress: the fortress scan itself cost ${(scanMs / 1000).toFixed(1)}s of synchronous walk over ~${(65 ** 3)} cells - radius 32, TTL 15s`);
        bot._fortScan = { at: nowT, seen: sv, ms: scanMs };
        return sv;
      };
      const seen = fortScan();
      if (seen) {
        const sp = seen.position.floored();
        const gap = Math.round(bot.entity.position.distanceTo(seen.position));
        spottedAt = sp; spottedGap = Math.min(spottedGap || 1e9, gap);
        // Write the sighting down: it survives a restart, a lift, or a death, so "the fortress is at
        // -271,26,117" does not have to be rediscovered by a 200-block sweep from the portal again.
        try { require('../workshopRecord').note('fortress_seen', sp, `${seen.name} spotted ${gap} blocks away; the sweep heads here`); } catch {}
        if (gap <= 12) {
          await capped(bot.pathfinder.goto(new (GN())(sp.x, sp.y, sp.z, 4)), 20000, 'goto fortress');
          const g2 = Math.round(bot.entity.position.distanceTo(seen.position));
          // 2, not 12 and not 5: "arrived" has to mean standing against the structure, because blazes spawn
          // in the corridors and a stop at 5 blocks left the hunt scanning from outside the wall and firing
          // nothing (20:04:17, `blaze_rods=0 shots=0 guard=15` with the brick 5 blocks away). Anything
          // further and the hop body below runs with the heading steered at the brick - i.e. it digs in.
          if (g2 <= 2) return { ok: true, observation: `AT the fortress: ${seen.name} ${g2} blocks away at ${sp.x},${sp.y},${sp.z}; I am at ${JSON.stringify(bot.entity.position.floored())}` };
          log.warn(`search_nether_fortress: ${g2} blocks from the ${seen.name} at ${sp.x},${sp.y},${sp.z} and the router will not close it - digging toward it`);
          // Close but the router says no (a fortress wall or a lava lip is enough): keep the sweep running
          // AT the structure so the hop body digs through, instead of returning a sighting as a success.
          steerAt(sp);
          // (no `continue` - the hop body below is what digs the last dozen blocks)
        }
        // Spotted from far: spend this call closing the distance, not announcing it.
        steerAt(sp);
      }
      const p = bot.entity.position.floored();
      // A cell whose FOOT reads fluid is terminal for this skill, and the loop was not told so: at
      // 03:23:33 the "will not close it - digging toward it" line printed 8 times in 0.7 s from -272,31,112
      // while standing in lava, because every dig is aborted by the swim, every placement has no face to
      // click, and the router prices the cell as impassable. Count the wet iterations in the same cell and
      // hand the round back with the one move that can work named, instead of re-deciding to dig.
      const wetFoot = (() => { try { const b = bot.blockAt(p); return b && /lava|water/.test(b.name) ? b.name : null; } catch { return null; } })();
      // Counted PER CALL. The first version kept the tally on `bot`, so once it passed the cap every later
      // call returned the verdict on its very first iteration and the escape chain further down this same
      // body (bridgeOut -> dig -> pillar_up -> the assist lift) was never again attempted: 03:54-03:55 shows
      // the verdict firing immediately, twelve iterations or not. A verdict is what you say after the
      // recoveries have had their turn inside one call.
      if (wetFoot) {
        // Standing in lava is survivable for ~10 s and it has proved fatal twice today (03:2x and 04:1x -
        // each death costs a respawn in the Overworld, a walk to the portal and ~280 blocks of re-travel,
        // and it also REVOkes the sticky `nether` milestone because that one is revalidated). While the cell
        // is being thought about, do not let the thinking be what kills it. This is an ASSIST and it is
        // gated: MC_ASSIST=0 (the acceptance run) never gets it, so the acceptance semantics stay "lava
        // burns you and you must move".
        if (process.env.MC_ASSIST !== '0' && (!bot._lavaResistAt || Date.now() - bot._lavaResistAt > 90000)) {
          bot._lavaResistAt = Date.now();
          log.warn(`search_nether_fortress: ASSIST - feet read ${wetFoot}, asking /effect fire_resistance so the escape can be worked out without dying mid-decision`);
          try { bot.chat('/effect give @s minecraft:fire_resistance 120 0 true'); } catch {}
        }
        const key = `${p.x},${p.y},${p.z}`;
        bot._wetN = (bot._wetKey === key ? (bot._wetN || 0) : 0) + 1;
        bot._wetKey = key;
        if (bot._wetN > 10) {
          const ar = countItem(bot, 'arrow'), bw = countItem(bot, 'bow');
          const dry = bot._netherDry;
          return { ok: false, observation: `standing IN ${wetFoot} at ${p.x},${p.y},${p.z} for ${bot._wetN} iterations of this call, and the recoveries this cell allows have all been tried: a dig from fluid feet always aborts, there is no dry face to place against, and the router will not path through lava. ${ar === 0 && bw > 0 ? 'The bow has no arrows and arrows cannot be crafted in the Nether (feather=0, flint=0) - the run needs use_portal back to the Overworld, hunt chickens for feathers and mine gravel for flint, then re-enter via build_nether_portal; farm_blaze cannot be closed from this cell.' : `Get onto dry rock first: step back along the causeway toward ${dry ? `${dry.x},${dry.y},${dry.z}` : 'the last dry ground recorded'} and rebuild the deck from a dry footing.`}` };
        }

        // A wet cell WITH a dry neighbour is escapable right now, whatever the stock says. At 03:23:30 the
        // map read `feet=lava under=soul_soil +z soul_soil/soul_soil` at -288,25,114 - one step +z and it was
        // out - yet the only step-out branch was gated on "too little fill", so it stayed and spun.
        // Scored, not first-found: taking the first dry cell in a fixed order read the ledge BEHIND us as
        // "dry" and ping-ponged -263 <-> -264 every 1.6 s (04:08:37-56) while the fortress brick sat 6 blocks
        // the other way. So a candidate must (a) be a dry standing cell, (b) move toward the goal - the blaze
        // if one is visible, else the recorded brick - and (c) not be the cell we escaped from last time.
        const V3 = require('vec3');
        const solidB = (b) => !!b && b.boundingBox === 'block' && !/lava|water/.test(b.name);
        const dryStand = (q) => {
          try {
            const f = bot.blockAt(q), fl = bot.blockAt(new V3(q.x, q.y - 1, q.z));
            return solidB(f) || (solidB(fl) && !(f && /lava|water/.test(f.name)));
          } catch { return false; }
        };
        let gx = null, gz = null, gTag = '';
        try {
          const bl = bot.nearestEntity(en => en.name === 'blaze' && bot.entity.position.distanceTo(en.position) < 40);
          if (bl) { gx = Math.floor(bl.position.x); gz = Math.floor(bl.position.z); gTag = 'blaze'; }
        } catch {}
        if (gx === null) {
          try { const fs = require('../workshopRecord').at('fortress_seen'); if (fs) { gx = fs.x; gz = fs.z; gTag = 'fortress'; } } catch {}
        }
        const escCands = [];
        for (const [ux, uz] of [[-d[0], -d[1]], [d[1], -d[0]], [-d[1], d[0]], [d[0], d[1]], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
          for (const uy of [1, 0, -1]) {
            const q = { x: p.x + ux, y: p.y + uy, z: p.z + uz };
            if (!dryStand(q)) continue;
            let score = Math.hypot(ux, uz) + Math.abs(uy) * 0.4;
            if (gx !== null) {
              const align = ux * Math.sign(gx - p.x) + uz * Math.sign(gz - p.z);
              score -= align * 3;                       // toward the goal is worth three cells of distance
            }
            const from = bot._lastEscapeFrom;
            if (from && from.x === q.x && from.z === q.z) score += 4;
            escCands.push({ q, score });
          }
        }
        escCands.sort((a, b) => a.score - b.score);
        // Nothing adjacent is standable, but the box says rock exists within 16 cells: that is a SWIM, not a
        // dead end - which is what a player does in a lava lake (get to the nearest stone), and the fire
        // resistance above is what makes the 3-4 s of wading survivable. Attempted at most once a minute per
        // cell, so it cannot become a new way to burn the step budget.
        if (!escCands.length && process.env.MC_ASSIST !== '0' && (!bot._swimAt || Date.now() - bot._swimAt > 60000)) {
          const dry = P.nearestDryCell(bot, p, 16);
          if (dry) {
            bot._swimAt = Date.now();
            log.warn(`search_nether_fortress: no dry neighbour at all, but rock exists at ${dry.x},${dry.y},${dry.z} (${dry.dist} cells) - wading toward it a cell at a time`);
            const sw = await walkToDryHome(bot, 8, { x: dry.x, y: dry.y, z: dry.z }, { allowUnsafe: true });
            if (sw.walked) {
              stuck = 0; moved = 0; hops = 0; d = bot._netherDir || d;
              log.warn(`search_nether_fortress: waded ${sw.walked} cell(s) out of the lava (now ${sw.at.x},${sw.at.y},${sw.at.z})`);
              continue;
            }
          }
        }
        for (const c of escCands) {
          const st = await P.stepOnto(bot, c.q, {});
          if (st.moved >= 1) {
            bot._lastEscapeFrom = { x: p.x, z: p.z };
            log.warn(`search_nether_fortress: out of the lava - stepped ${st.moved} cell(s) onto a dry footing at ${c.q.x},${c.q.y},${c.q.z} (score ${c.score.toFixed(1)}${gTag ? `, toward ${gTag} ${gx},${gz}` : ''}; now ${st.to.x},${st.to.y},${st.to.z}; ${escCands.length} dry candidates here)`);
            stuck = 0; moved = 0; hops = 0; d = bot._netherDir || d;
            break;
          }
        }
      }
      // Remember the last cell that was safe to stand on.      // Remember the last cell that was safe to stand on. When the causeway runs out of fill
      // halfway across a lava sea, the only good move is back along it, and "back" has to mean toward the shore
      // I came from, not just the reverse of whatever heading I happen to be facing now.
      try {
        const fB = bot.blockAt(p), gB = bot.blockAt(p.offset(0, -1, 0));
        if ((!fB || (fB.boundingBox !== 'block' && !/lava|water/.test(fB.name))) && gB && gB.boundingBox === 'block' && !/lava|water/.test(gB.name)) bot._netherDry = { x: p.x, y: p.y, z: p.z };
      } catch {}
      const ahead = bot.blockAt(p.offset(d[0], 0, d[1]));
      const aheadHigh = bot.blockAt(p.offset(d[0], 1, d[1]));
      const under = bot.blockAt(p.offset(d[0], -1, d[1]));
      // A physical test, not a name list. The old allow-list (netherrack / blackstone / nether_brick /
      // basalt / end_stone) misses soul_sand, magma_block, gravel, nether_quartz_ore, ancient_debris and
      // the polished blackstones, all common at this depth - and when the cell ahead was one of those the
      // sweep neither dug it nor pathed around it: measured 05:42:54, `14 hops ... turned 14` with the
      // position frozen at -53,43,209 for two whole calls.
      const diggableSolid = b => !!b && b.boundingBox === 'block' && !isAir(b.name)
        && !/lava|water|bedrock/.test(b.name) && b.diggable !== false;
      // A dig cap has to come from the block, not from a constant. Hand-dig time is hardness x 5 s, and
      // this sweep has been running with no pickaxe in the pack: basalt and blackstone are hardness 1.25
      // (6.25 s) against a 6000 ms cap, so from 17:50 to 17:54 EVERY wall dig logged "timed out (6000ms)"
      // and then `dug++` counted it anyway - the sweep reported "dug 13" while the bot dug nothing.
      // Equip the best tool that exists, size the window from the hardness, and count a dig only once the
      // cell actually reads open.
      const digCapMs = (b) => Math.min(12000, 2500 + Math.max(0.2, Number(b && b.hardness) || 0.4) * 5000 * 1.2);
      const hasPick = () => { try { return bot.inventory.items().some(i => /pickaxe/.test(i.name)); } catch { return false; } };
      // Hand-dig time is hardness x 5 s, and obsidian (50) is not a hand problem at all - it needs a
      // diamond pick, so the attempt can only ever burn the whole window. Measured 18:11:25: my own
      // hardness-sized cap turned the old 6 s fast-fail into 30 s of nothing on an obsidian head block,
      // which is a worse stall than the bug it replaced. Refuse the attempt when no pick is in the pack.
      const handS = (b) => Math.max(0.2, Number(b && b.hardness) || 0.4) * 5;
      const digCell = async (b, label) => {
        if (!b) return false;
        // Measured 19:11:40 -> 19:12:15: four consecutive `dig nether wall timed out (11500ms)` on diorite
        // with `Digging aborted` behind each one, while the bot's feet cell read lava. A swimmer's view is
        // dragged by the fluid, and mineflayer cancels the swing the moment the bot stops looking at the
        // block - so EVERY dig from inside a fluid cell burns its whole window and aborts. Do not pay 12 s
        // for a move that cannot land: say what is wrong and let the caller take the lift.
        try {
          const fb = bot.blockAt(bot.entity.position.floored());
          if (fb && /lava|water/.test(fb.name)) {
            if (!bot._fluidDigNoted) {
              bot._fluidDigNoted = true;
              log.warn(`search_nether_fortress: my own feet cell reads ${fb.name} - digging from inside fluid always aborts (the swim drags the view), refusing ${label} and handing the round to the escape chain`);
            }
            return false;
          }
        } catch {}
        // Not worth a dig window, whoever asked. The supply ring takes ANY diggable neighbour, and at the
        // Nether-side portal that meant obsidian: three 12 s timeouts in 40 s (04:17:29-54, `obsidian
        // (hardness 50) still solid after 12s`) while standing on its own portal frame - and every one of
        // those digs was a step toward destroying the only way home. Anything this hard, or this valuable,
        // is left alone; a causeway is made of netherrack (0.4) and nether bricks (1.5), not of the frame.
        if (/obsidian|spawner|crafting_table|furnace|chest|beacon|enchanting|anvil/.test(b.name)) {
          if (!bot._hardSkipNoted) { bot._hardSkipNoted = true; log.warn(`${label}: skipping ${b.name} - too hard / too valuable to spend a dig window on (portal frames and workstations are not bridge stock)`); }
          return false;
        }
        if (b.hardness > 8) { log.warn(`${label}: ${b.name} (hardness ${b.hardness}) is above the 8 I will dig for footing`); return false; }
        if (!hasPick() && handS(b) > 12) {
          log.warn(`${label}: ${b.name} (hardness ${b.hardness}) is not a hand-dig problem (${Math.round(handS(b))}s bare) - skipping it, this sweep carries no pickaxe`);
          return false;
        }
        // Only reach for a tool when the pack actually holds one. equipBestToolFor with no pickaxe in
        // the pack walks the whole inventory and holds each item in turn (measured: gravel -> flint ->
        // crafting_table -> ..., ~6 s PER item, 13 items = 78 s of held-item churn per dig attempt, and
        // it still ended on "need a pickaxe"). A hand on netherrack is faster than that.
        // ...and only when the hand is not already holding a dig tool: equipBestToolFor insists on a tool
        // with 8 digs of durability left, so with a 47%-durability wooden pick in hand it walked the whole
        // pack and warned `netherrack allows only [...picks...] and no such pick in the pack has 8 digs
        // left` three times per second (measured 18:14:17) - while the worn pick digs netherrack fine.
        const heldDig = bot.heldItem && /pickaxe|axe|shovel/.test(bot.heldItem.name);
        if (hasPick() && !heldDig) { try { await P.equipBestToolFor(bot, b); } catch {} }
        await capped(bot.dig(b), digCapMs(b), label);
        const now = bot.blockAt(b.position);
        const open = !now || isAir(now.name);
        if (open) dug++;
        else log.warn(`${label}: ${b.name} (hardness ${b.hardness}) still solid after ${Math.round(digCapMs(b) / 1000)}s - not counted as dug`);
        return open;
      };
      if (diggableSolid(ahead)) await digCell(ahead, 'dig nether wall');
      else if (diggableSolid(aheadHigh)) await digCell(aheadHigh, 'dig head block');
      const stand = bot.blockAt(p.offset(d[0], -1, d[1]));
      // Where the support block actually is. On a soul-sand causeway the floored feet position is INSIDE
      // the block being stood on (15/16 hitbox), so "one down" is not the floor - see P.standCells.
      const sc = P.standCells(bot);
      if (!under || isAir(under.name) || under.name.includes('lava')) {
        // bridge the gap if we have fill; otherwise turn aside rather than swim
        // Dataset rule, not a name list: at 18:48 this line's allow-list (cobblestone|netherrack|dirt)
        // declared "no fill block in the pack" for a bot carrying 82 soul_sand + gravel + diorite + tuff,
        // 19 blocks short of bridging onto the fortress it had just found.
        let fill = P.cheapFill(bot, 1);
        // Two ways this cell kills the run, and both were measured inside ten minutes at -257..-259,25,102-104:
        // (1) the causeway spends fill - gravel at 19:33:49, diorite at 19:35:26-30 - and by 19:38 the pack
        // held none, while every neighbour was lava so there was nothing to mine; (2) with the feet cell in
        // fluid, digCell refuses to dig, so a stranded bot has no move at all and the sweep just turns
        // twelve headings in 1.4 s. So: top up while standing on dry rock, and when there is no fill AND
        // the feet are wet, walk back over the causeway already laid behind me - a direct step, because the
        // pathfinder prices every cell of a lava shore as impassable, including the ones I built myself.
        const feetWet = (() => { try { const b = bot.blockAt(p); return !!b && /lava|water/.test(b.name); } catch { return false; } })();
        const MINE_CANDS = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1], [0, -1, 0]];
        // Never saw the branch that mines the block under my own feet: on a one-cell causeway over a lava
        // sea that is a fall, and the fill it yields is one block. The other eight cells carry the same
        // errand without the risk, so the supply ring excludes the support.
        const SUPPLY_CANDS = MINE_CANDS.filter(([bx, by, bz]) => !(bx === 0 && by === -1 && bz === 0));
        // Resupply on an empty stomach AND on a nearly empty one, measured across the WHOLE pack. Gated on
        // `!fill` alone, the sweep spent 174 -> 62 blocks in eight minutes (01:46-01:54) while 131 blocks
        // short of the fortress, because the only moment it stopped to mine was the moment it had nothing
        // left - and by then the neighbours are lava, not rock. Reading the gate off the biggest single stack
        // then over-corrected the other way: at 02:01 it quit a 44-block gap holding `netherrack x31` while
        // the pack also carried 31 soul_soil. The real question is "can I pay for the remaining distance".
        const gapToFort = (() => {
          try {
            const r = require('../workshopRecord').at('fortress_seen');
            return r ? Math.round(Math.hypot(r.x - p.x, r.y - p.y, r.z - p.z)) : null;
          } catch { return null; }
        })();
        const RESUPPLY = 32;
        let fillTotal = P.cheapFillTotal(bot);
        // The floor is 12, not 32. The 32 was chosen when the gap was 131 blocks; at 03:40 it became the
        // thing that blocked the run: the fortress brick was 20 blocks away, the pack could pay for 21 cells,
        // and the gate still said "too low" -> retreat -> `stepped back 0 cell(s)` (no dry neighbour) -> 40+
        // identical lines. What the number has to track is the distance, plus a small margin to reach rock.
        // Once it is ON the structure, the wall itself is the fill: nether_bricks drops nether_bricks.
        const needCells = Math.min(96, Math.max(12, gapToFort === null ? 0 : gapToFort));
        if (!feetWet && fillTotal < needCells) {
          // Stock up in BULK, and widen as the ring runs out. The first version mined one 8-cell ring and
          // walked back onto the causeway it had just paid for - 8 blocks per errand that costs ~40 steps of
          // walking, which is how a crossing stalls at three quarters of the way. Grow the radius until two
          // consecutive rings come up empty, the pack can pay for the gap, or 60 s of the step is gone.
          // The own support cell (0,-1,0) is never a candidate: pulling it out is a fall into the lava sea.
          let stocked = 0, empty = 0;
          const stockT0 = Date.now();
          for (let r = 1; r <= 4 && fillTotal < needCells && empty < 2 && Date.now() - stockT0 < 60000 && Date.now() < (bot._stepDeadline || Infinity); r++) {
            let mined = 0;
            for (let dx = -r; dx <= r; dx++) {
              for (let dz = -r; dz <= r; dz++) {
                if (dx === 0 && dz === 0) continue;
                if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
                for (const dy of [0, -1]) {
                  const cand = bot.blockAt(p.offset(dx, dy, dz));
                  if (!diggableSolid(cand)) continue;
                  if (await digCell(cand, 'mine fill for the causeway')) { mined++; stocked++; fillTotal++; }
                }
              }
            }
            empty = mined ? 0 : empty + 1;
          }
          fill = P.cheapFill(bot, 1);
          if (stocked) log.warn(`search_nether_fortress: mined ${stocked} block(s) for the causeway - holding ${fill ? `${fill.name} x${fill.count}` : 'none'}, ${fillTotal} fillable cell(s) in the pack, gap ${gapToFort}`);
        }
        // Retreat test, widened at 19:50: the first version required the FEET to be in fluid, but the cell
        // this bot actually died in is its own causeway - dry feet, no fill, and every neighbour air or lava
        // so there is nothing to mine. That is exactly when staying is fatal, so the trigger is
        // "no fill AND nothing here can supply it", not "wet feet".
        const mineableHere = SUPPLY_CANDS.some(([bx, by, bz]) => { try { return diggableSolid(bot.blockAt(p.offset(bx, by, bz))); } catch { return false; } });
        // Wet feet alone must NOT trigger the retreat: a fortress deck flooded at feet level still has a dry
        // support under the bot, and the cell ahead is lava - which is bridgeable (this server accepts a
        // block placed into lava, the crossing was built that way for 200 blocks). Retreating on wet feet
        // alone pre-empted that bridge and the two rungs ping-ponged -289 <-> -288 every 1.6 s (02:19:24-45).
        // So the retreat is for the cell that cannot pay for the gap AND cannot supply itself here; wet feet
        // only make that true when the stock is already short.
        if (fillTotal < needCells && (feetWet || !mineableHere)) {
          const dryish = (q) => {
            try {
              const f = bot.blockAt(q), fl = bot.blockAt(q.offset(0, -1, 0));
              return (!f || (f.boundingBox !== 'block' && !/lava|water/.test(f.name))) && !!fl && fl.boundingBox === 'block' && !/lava|water/.test(fl.name);
            } catch { return false; }
          };
          const dry = bot._netherDry;
          const back = { x: p.x - d[0], y: p.y, z: p.z - d[1] };
          const cands = [];
          if (dry && (dry.x !== p.x || dry.z !== p.z)) {
            const ddx = dry.x - p.x, ddz = dry.z - p.z;
            cands.push(Math.abs(ddx) >= Math.abs(ddz)
              ? { x: p.x + (Math.sign(ddx) || -d[0]), y: p.y, z: p.z }
              : { x: p.x, y: p.y, z: p.z + (Math.sign(ddz) || -d[1]) });
          }
          cands.push(back,
            { x: p.x - d[0] + d[1], y: p.y, z: p.z - d[1] - d[0] },
            { x: p.x - d[0] - d[1], y: p.y, z: p.z - d[1] + d[0] });
          const pick = cands.find(dryish);
          const st = await P.stepOnto(bot, pick || back, { allowUnsafe: true });
          log.warn(`search_nether_fortress: causeway stock too low to cross this gap (${fill ? `${fill.name} x${fill.count}` : 'none of the pack usable'})${feetWet ? ' and feet in fluid' : ' and nothing to mine here'} - stepped back ${st.moved} cell(s) over my own causeway${pick ? ` toward dry ${pick.x},${pick.y},${pick.z}` : ''}${dry ? ` (last dry ground ${dry.x},${dry.y},${dry.z})` : ''} (now ${st.to.x},${st.to.y},${st.to.z})`);
          if (st.moved >= 1) { stuck = 0; moved = 0; hops = 0; d = bot._netherDir || d; continue; }
        }
        // The cell that needs filling is the floor one step ahead, p+(dx,-1,dz). A (reference, face) pair
        // is only usable when reference + face lands there: the old code took any physical cell it could
        // find and always clicked its TOP face, so with the reference being "the block I stand on" the
        // target became the cell the bot already occupies - which this server refuses ("the block is still
        // X"), and `bridged 0` was the only trace. Measured 06:09-06:11 at -53,43,209, where both the hop
        // sweep and two roam attempts had already failed to move it.
        const target = sc.floor.offset(d[0], 0, d[1]);
        const atNow = bot.blockAt(target);
        const targetOpen = !atNow || isAir(atNow.name) || atNow.name.includes('lava');
        // The three hardcoded candidates (own floor, two under the gap, two ahead) are ALL liquid on a
        // lava-sea shore, and that is how the sweep sat frozen at -271,26,98 for ten minutes with 82
        // soul_sand in the pack while the fortress it had just found waited 19 blocks away (18:43-18:53):
        // `0 usable reference face(s)` - the rule only looked for something to click in three cells it
        // already knew were lava. Add the six neighbours of the gap cell: any solid one of them is a face.
        const cand = [
          { at: sc.floor, face: new Vec3(d[0], 0, d[1]) },                   // click the side of my own floor
          { at: target.offset(0, -1, 0), face: new Vec3(0, 1, 0) },          // stack up from under the gap
          { at: target.offset(d[0], 0, d[1]), face: new Vec3(-d[0], 0, -d[1]) }, // pull in from ahead
        ].concat([[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
          .map(([ax, ay, az]) => ({ at: target.offset(ax, ay, az), face: new Vec3(-ax, -ay, -az) })));
        const pairs = cand.map(x => ({ ref: bot.blockAt(x.at), face: x.face }))  // placeBlock wants a BLOCK, not a position
          .filter(x => targetOpen && x.ref && x.ref.boundingBox === 'block' && !/lava|water/.test(x.ref.name));
        let bridged = false;
        if (fill && pairs.length) {
          try {
            await bot.equip(fill, 'hand');
            if (bot.heldItem && bot.heldItem.name === fill.name) {
              for (const x of pairs) {
                await capped(bot.placeBlock(x.ref, x.face), 4000, 'bridge');
                const now = bot.blockAt(target);
                if (now && !isAir(now.name) && !/lava|water/.test(now.name)) { bridged = true; placed++; break; }
              }
            }
          } catch {}
          if (bridged) {
          // Walk the causeway that was just laid. The hop's own goto will be refused by the same lava
          // pricing that defeated bridgeOut at 19:30:17, so take the step by hand and let the next
          // iteration start from dry rock instead of re-asking for a path that will never exist.
          const stp = await P.stepOnto(bot, { x: target.x, y: target.y + 1, z: target.z });
          log.warn(`search_nether_fortress: bridged ${target.x},${target.y},${target.z} and direct-stepped ${stp.moved} cell(s) (now ${stp.to.x},${stp.to.y},${stp.to.z})`);
        }
        if (!bridged) log.warn(`bridge: could not fill ${target.x},${target.y},${target.z} from ${pairs.length} face(s) with ${fill.name}`);
        // One dump per process: the ten-minute freeze at -271,26,98 could not be diagnosed from the
        // existing lines, because "0 usable reference face(s)" does not say what the cells actually are -
        // lava floor while standing on it and not burning, or a stale client column, are different faults
        // with different fixes, and guessing costs an hour each time.
        const dumpKey = `${p.x},${p.y},${p.z}>${d[0]},${d[1]}`;
        if (!bridged && bot._shoreDumped !== dumpKey) {
          bot._shoreDumped = dumpKey;
          const nm = (q) => { try { const b = bot.blockAt(q); return b ? `${b.name}${b.boundingBox === 'block' ? '' : '(non-solid)'}` : 'NULL'; } catch { return 'ERR'; } };
          const around = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]]
            .map(([ax, ay, az]) => `${ax},${ay},${az}=${nm(target.offset(ax, ay, az))}`).join(' ');
          log.warn(`search_nether_fortress: shore dump at ${p.x},${p.y},${p.z} feet=${nm(p)} head=${nm(p.offset(0, 1, 0))} own_floor=${nm(sc.floor)}${sc.sunk ? ' (SUNK: the feet cell IS the support, 15/16 hitbox)' : ''} target=${target.x},${target.y},${target.z}=${nm(target)} | target neighbours: ${around}`);
        }
        }
        if (!bridged) {
          // `continue` with no await here is a free spin: measured 05:18:20, the search reported
          // `turned 19210` while `hops` sat at 5 - it spent the whole 100 s budget choosing random
          // headings on a shore where the foot cell is lava, which no heading fixes. Bound the retries
          // and hand back the reason plus the move that would work.
          turnStreak++;
          // Turning with no displacement IS the stuck condition. This branch only bumped `turnStreak`, so
          // `stuck >= 8` - the gate for the escape chain that carries the assist lift, the dig-sideways
          // and the retreat - was never reached on a lava shore, and the bot returned "no floor to stand
          // on" every ~1.5 s while sitting 4 blocks from the fortress (20:14-20:20, seven restarts' worth
          // of the same message). Count it, so eight refusals escalate into the real escapes.
          stuck++;
          d = Math.random() < 0.5 ? [d[1], -d[0]] : [-d[1], d[0]];
          bot._netherDir = d; turned++;
          await sleep(120);
          if (turnStreak >= 12) {
            const t = target;
            const tb = bot.blockAt(t);
            return { ok: false, observation: `no floor to stand on around ${p.x},${p.y},${p.z} and the pack cannot bridge it (fill=${fill ? fill.name : 'none'}, ${pairs.length} usable reference face(s), the cell ahead-below reads ${tb ? tb.name : 'NULL'}) - this is a lava-lake shore, not a wall to dig through. Walk onto solid netherrack first (roam {block:'netherrack'}) and sweep from there; retrying this cell cannot work.` };
          }
          // Do not step over the escape chain: on a cell with no face to click every iteration ended on this
          // `continue`, so `stuck >= 8 && !moved` (bridgeOut -> dig -> pillar_up -> the assist lift) was
          // never reached and the sweep turned twelve times a second until the step budget ran out
          // (04:01:45-47: twelve `digging toward it` lines in 1.8 s, no recovery attempted).
          if (!(stuck >= 8 && !moved)) continue;
        }
      }
      turnStreak = 0;
      const before = bot.entity.position.floored();
      await capped(bot.pathfinder.goto(new (GN())(p.x + d[0], sc.standY, p.z + d[1], 0)), 6000, 'nether hop', () => { try { bot.pathfinder.stop(); } catch {} });
      const after = bot.entity.position.floored();
      // `hops` counted attempts, so a sweep that never moved could still report "20 hops". Measure the
      // displacement as its own number (the §19 rule: 标称步长 != 实际位移).
      if (after.x === before.x && after.z === before.z && after.y === before.y) {
        stuck++;
        // A 90-degree turn, never a random one: `Math.random() * 4` picks the reverse heading a quarter of
        // the time, which walks the sweep straight back over ground it just covered.
        d = Math.random() < 0.5 ? [d[1], -d[0]] : [-d[1], d[0]];
        bot._netherDir = d; turned++;
      } else { moved++; }
      hops++;
      if (stuck >= 8 && !moved) {
        // The verdict names the escape, so TAKE it. Waiting for the planner to route around a message it
        // never reads is how -53,43,209 held the bot for eighteen minutes on 2026-11-01: the stage lock
        // keys its routes on the MILESTONE's own answer (`blaze_rods=0 shots=0 ...`), so a phrase that
        // only this skill prints can never select a route. Three directions - side, down, up - then report honestly.
        const here = bot.entity.position.floored();
        if (escapes >= 3) {
          // The local block map, because every guess before it was wrong: at 06:48 the escape chain had
          // already tried sideways (all four neighbours are floor) and down, and nobody could say what was
          // actually holding the bot. Nine cells: feet, head, and the four sides at both levels.
          const nm = (q) => { const b = bot.blockAt(q); return b ? b.name : 'NULL'; };
          const map = `feet=${nm(here)} head=${nm(here.offset(0, 1, 0))} under=${nm(here.offset(0, -1, 0))}`
            + ` | +x ${nm(here.offset(1, 0, 0))}/${nm(here.offset(1, -1, 0))} -x ${nm(here.offset(-1, 0, 0))}/${nm(here.offset(-1, -1, 0))}`
            + ` +z ${nm(here.offset(0, 0, 1))}/${nm(here.offset(0, -1, 1))} -z ${nm(here.offset(0, 0, -1))}/${nm(here.offset(0, -1, -1))}`;
          return { ok: false, observation: `cannot move at all from ${here.x},${here.y},${here.z} - ${stuck} hops with zero displacement, and all three escapes failed (sideways: no side to bridge; down: refused by the depth floor; up: no height gained). ${map}. This is an enclosed pocket: it needs a teleport-level recovery, sweeping here cannot succeed.` };
        }
        escapes++;
        // Printed on the FIRST attempt, not only in the final verdict: the step's own 100 s budget was
        // expiring before `escapes >= 2` could be reached, so the nine cells that would explain the pin
        // never once appeared in the log (07:31, 07:35 and 07:37 all timed out first).
        const nm = (q) => { const b = bot.blockAt(q); return b ? b.name : 'NULL'; };
        log.warn(`search_nether_fortress: local map at ${here.x},${here.y},${here.z} -> `
          + `feet=${nm(here)} head=${nm(here.offset(0, 1, 0))} under=${nm(here.offset(0, -1, 0))}`
          + ` | +x ${nm(here.offset(1, 0, 0))}/${nm(here.offset(1, -1, 0))} -x ${nm(here.offset(-1, 0, 0))}/${nm(here.offset(-1, -1, 0))}`
          + ` +z ${nm(here.offset(0, 0, 1))}/${nm(here.offset(0, -1, 1))} -z ${nm(here.offset(0, 0, -1))}/${nm(here.offset(0, -1, -1))}`);
        // Scoop the fluid out with a bucket - the one move that needs neither a clickable face nor a swing
        // that survives the swim, and the pack carries three empty buckets. Measured 19:13-19:21 at
        // -269,25,97: feet/head/under all lava, no solid top with headroom anywhere within 16 blocks (the
        // pocket is buried in the mass), every dig returning `Digging aborted`, the assist lift reporting
        // "no way out" - 38 minutes frozen twenty blocks from the first fortress this run ever found.
        // Right-clicking the source with an empty bucket makes that cell dry, and a dry cell can be dug
        // from. Vanilla, not an assist: inst2 (MC_ASSIST=0) can use this too.
        const scoopFeet = (() => { try { const b = bot.blockAt(here); return !!b && /lava|water/.test(b.name); } catch { return false; } })();
        if (scoopFeet && !bot._lavaScoopTried) {
          bot._lavaScoopTried = true;
          const buck = bot.inventory.items().find(i => i.name === 'bucket');
          if (buck) {
            try { await bot.equip(buck, 'hand'); } catch {}
            // A bucket empties the cell the CROSSHAIR is in, not the cell the feet are in: the first
            // attempt here aimed at own cell and did nothing (`feet now reads lava, holding bucket,
            // lava_bucket in pack=0` at 19:23:00). So aim at the fluid NEIGHBOURHOOD, one cell at a time,
            // and stop as soon as a scoop leaves a standable pocket beside me.
            const cells = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, -1, 0], [0, 1, 0]];
            for (const [ax, ay, az] of cells) {
              const q = here.offset(ax, ay, az);
              let qb = null;
              try { qb = bot.blockAt(q); } catch {}
              if (!qb || !/lava|water/.test(qb.name)) continue;
              try { await bot.lookAt(q.offset(0.5, 0.5, 0.5), true); } catch {}
              try { await bot.activateItem(); } catch {}
              await sleep(900);
              let after = null;
              try { after = bot.blockAt(q); } catch {}
              const cleared = !after || !/lava|water/.test(after.name);
              log.warn(`search_nether_fortress: scooped ${qb.name} at ${q.x},${q.y},${q.z} -> ${after ? after.name : 'air'}, holding ${bot.heldItem ? bot.heldItem.name : 'none'}, lava_bucket=${countItem(bot, 'lava_bucket')}`);
              if (!cleared) continue;
              const floor = bot.blockAt(q.offset(0, -1, 0));
              if (!floor || floor.boundingBox !== 'block' || /lava|water/.test(floor.name)) continue;
              await capped(bot.pathfinder.goto(new (GN())(q.x + 0.5, q.y, q.z + 0.5, 0)), 8000, 'step into the scooped cell');
              const nw = bot.entity.position.floored();
              if (nw.x !== here.x || nw.y !== here.y || nw.z !== here.z) {
                log.warn(`search_nether_fortress: stepped into the drained cell - now at ${nw.x},${nw.y},${nw.z} (was ${here.x},${here.y},${here.z})`);
                stuck = 0; moved = 0; hops = 0; dug = 0; placed = 0;
                d = bot._netherDir || d;
                break;
              }
            }
            const feetNow = (() => { try { const b = bot.entity.position.floored(); const c = bot.blockAt(b); return c ? c.name : 'NULL'; } catch { return 'ERR'; } })();
            if (/lava|water/.test(feetNow)) log.warn(`search_nether_fortress: still sitting in ${feetNow} after the scoop round`);
            const nf = bot.entity.position.floored();
            if (nf.x !== here.x || nf.y !== here.y || nf.z !== here.z) {
              stuck = 0; moved = 0; hops = 0; dug = 0; placed = 0;
              d = bot._netherDir || d;
              continue;
            }
          } else log.warn('search_nether_fortress: feet in fluid and no empty bucket in the pack to scoop with');
        }
        // Feet in fluid = no physical move exists: dig aborts, placing needs a face and the cell under me
        // is lava, climbing needs the same face. So the local assist lift runs HERE, first, rather than at
        // the end of the escape chain - measured 19:13:14 -> 19:14:57, where bridgeOut, dig-down and
        // pillar_up each burned their own timeout and the step was cut off before the chain ever reached
        // the lift written below. Local (8 blocks), labelled, assisted instance only, once per process.
        const liftFeet = (() => { try { const b = bot.blockAt(here); return !!b && /lava|water/.test(b.name); } catch { return false; } })(); // read by the lift's log line: it says whether the feet cell was fluid
        // Unconditional here (assist-only, once per process): reaching this point in the code IS the
        // evidence that the cell offers nothing - it is inside `stuck >= 8 && !moved`, after the dig,
        // bridge and hop paths all failed. My earlier gates (`liftFeet`, `!fill`) excluded the case that
        // actually happened at 20:14-20:17: standing on dry rock 3 blocks from the fortress wall, with
        // netherrack in the pack, and no reference face to place against - so it never lifted and stayed
        // 4 blocks from the structure for the rest of the hunt.
        // Repeatable with a cooldown, not once per process. The cell the diagram cannot help with is the one
        // where there is NO red block at all (feet, floor and all four neighbours read lava at -266,31,115,
        // 05:29:11): with no face to click, nothing can be placed, so the only exits are the bridge behind
        // or a lift. One-per-process meant the second such pocket of a run was terminal - it cost 15+ minutes
        // of stalling twice today. MC_ASSIST=0 never gets this, so the acceptance run still has to walk out.
        // Only the cooldown and the cap. The first draft also OR-ed in `!bot._localLiftUsed`, which is set to
        // `true` inside the block - so after the first lift the test was always true and it burned 4/5 then
        // 5/5 seven seconds apart (05:32:04 / 05:32:11) instead of spacing the lifts three minutes apart.
        if (process.env.MC_ASSIST !== '0' && Date.now() - (bot._liftAt || 0) > 180000 && (bot._liftCount || 0) < 5) {
          bot._localLiftUsed = true;
          bot._liftAt = Date.now();
          bot._liftCount = (bot._liftCount || 0) + 1;
          let dest = null, bestScore = Infinity;
          // A full cubic scan, not eight spokes: the ring version sampled only 8 columns per radius, so
          // 16 radii read 128 cells of a 33x33x12 box and declared "no landing" while most of the box was
          // never looked at. The scoop round (19:25:41-43, lava_bucket=1 then the cell reading lava again)
          // proved this pocket is refilled by its neighbours, so a real landing is the only way out -
          // and the cell type the spokes kept missing is the fortress walkway itself. Scoring prefers
          // standing next to the remembered fortress, then closeness.
          let fx = null, fz = null;
          try { const fs3 = require('../workshopRecord').at('fortress_seen'); if (fs3) { fx = fs3.x; fz = fs3.z; } } catch {}
          const standable = (q) => {
            let feet = null, floor = null, head = null, up2 = null;
            try {
              feet = bot.blockAt(q); floor = bot.blockAt(q.offset(0, -1, 0));
              head = bot.blockAt(q.offset(0, 1, 0)); up2 = bot.blockAt(q.offset(0, 2, 0));
            } catch { return false; }
            const solid = (b) => !!b && b.boundingBox === 'block' && !isAir(b.name);
            const fluid = (b) => !!b && /lava|water/.test(b.name);
            return solid(floor) && !fluid(floor) && !solid(feet) && !fluid(feet) && !solid(head) && !solid(up2);
          };
          for (let ax = -16; ax <= 16; ax++) {
            for (let az = -16; az <= 16; az++) {
              for (let dy = 8; dy >= -3; dy--) {
                const q = here.offset(ax, dy, az);
                // Never "rescue" the bot onto the cell it is already in - that is a no-op teleport that
                // consumes the once-per-process lift and leaves the stall exactly where it was.
                if (Math.abs(ax) + Math.abs(az) + Math.abs(dy) < 2) continue;
                if (!standable(q)) continue;
                const score = (fx === null ? 0 : Math.hypot(q.x - fx, q.z - fz)) + Math.hypot(ax, az) * 0.15;
                if (score < bestScore) { bestScore = score; dest = { x: q.x, y: q.y, z: q.z }; }
              }
            }
          }
          if (dest) {
            log.warn(`search_nether_fortress: ASSIST local lift - feet read lava and nothing in this cell can be dug or placed; /tp onto the nearest solid top ${dest.x},${dest.y},${dest.z} (from ${here.x},${here.y},${here.z}; the landing may be up to 16 blocks out and up to 8 cells up, never across the map)`);
            try { bot.chat(`/tp @s ${dest.x + 0.5} ${dest.y} ${dest.z + 0.5}`); } catch {}
            for (let w = 0; w < 14; w++) {
              await sleep(600);
              const nf = bot.entity.position.floored();
              if (nf.x === dest.x && nf.z === dest.z && Math.abs(nf.y - dest.y) <= 2) break;
            }
            const lf = bot.entity.position.floored();
            const lfName = (() => { try { const b = bot.blockAt(lf); return b ? b.name : 'NULL'; } catch { return 'ERR'; } })();
            if (!/lava|water/.test(lfName)) bot._netherDry = { x: lf.x, y: lf.y, z: lf.z };   // the retreat target must know the ground we landed on
            log.warn(`search_nether_fortress: after the assist lift (${bot._liftCount}/5 this process) I am at ${lf.x},${lf.y},${lf.z}, feet reads ${lfName}`);
            if (lf.x !== here.x || lf.y !== here.y || lf.z !== here.z) {
              stuck = 0; moved = 0; hops = 0; dug = 0; placed = 0;
              d = bot._netherDir || d;
              continue;
            }
          } else log.warn('search_nether_fortress: feet in fluid and no solid top with headroom within 16 blocks - buried, so the bucket scoop and the heading escapes are all this cell offers');
        }
        // Use the capability directly. Going through `roam` meant its own guards (island/shore-spur,
        // headland, water) could bail out in 350 ms without ever trying the ledge step, and the escape
        // looked like it had run when nothing had been attempted.
        const bo = await P.bridgeOut(bot, d);   // d is the heading steered at the fortress - never bridge backwards
        log.warn(`search_nether_fortress: pinned at ${here.x},${here.y},${here.z} - bridgeOut (attempt ${escapes}/2) -> ${bo.ok ? bo.moved : `failed: ${bo.why}`}`);
        if (bo.ok) {
          stuck = 0; moved = 0; hops = 0; dug = 0; placed = 0;
          d = bot._netherDir || d;
          continue;
        }
        // Dig-sideways: the one move this cell actually needed. At 19:01 the bot stood INSIDE lava
        // (feet=lava, head=lava, under=lava) at -269,26,97 with solid netherrack at +x and -z. bridgeOut
        // needs a solid cell under the feet to click, dig-down needs a diggable floor, pillar_up needs a
        // face to place against - all three said no, and the run froze for 21 minutes next to the first
        // fortress it had found in thirteen hours. A player in that pocket breaks the wall beside them and
        // steps into the hole, so that is what happens here.
        let dugSide = false;
        for (const [ax, az] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const wall = bot.blockAt(here.offset(ax, 0, az));
          if (!wall || wall.boundingBox !== 'block' || isAir(wall.name) || /lava|water|bedrock/.test(wall.name)) continue;
          const opened = await digCell(wall, 'dig side wall (lava-pocket escape)');
          if (!opened) continue;
          // Re-read the cell that just opened. A lava SOURCE beside it flows into fresh air, and stepping
          // into the hole we just made for the same fluid is not an escape - it is the same pocket, one
          // cell over. Only continue when the cell is actually empty and its floor is solid.
          const hole = bot.blockAt(here.offset(ax, 0, az));
          if (hole && hole.boundingBox === 'block' && !isAir(hole.name)) { log.warn(`search_nether_fortress: the dug side cell already reads ${hole.name} again - not stepping in`); continue; }
          const floor = bot.blockAt(here.offset(ax, -1, az));
          if (!floor || floor.boundingBox !== 'block' || /lava|water/.test(floor.name)) { log.warn(`search_nether_fortress: dug ${wall.name} sideways but the cell below it is ${floor ? floor.name : 'NULL'} - not steppable`); continue; }
          await capped(bot.pathfinder.goto(new (GN())(here.x + ax + 0.5, here.y, here.z + az + 0.5, 0)), 8000, 'step into dug side');
          const nw = bot.entity.position.floored();
          if (nw.x !== here.x || nw.z !== here.z || nw.y !== here.y) {
            log.warn(`search_nether_fortress: dug the ${wall.name} at ${here.x + ax},${here.y},${here.z + az} and stepped into it (${nw.x},${nw.y},${nw.z}) - out of the fluid pocket`);
            dugSide = true;
            break;
          }
        }
        if (dugSide) { stuck = 0; moved = 0; hops = 0; placed = 0; d = bot._netherDir || d; continue; }
        // Sideways is not the trap (06:48:26: `every side face refused (each neighbour is already floor...)`)
        // - so the only direction a player has left is DOWN, which is also how you reach a fortress that
        // generates below you. Bounded to four blocks and reported either way.
        const allow = P.digDownAllowed(bot);
        const dig = allow.ok
          ? await reg.get('dig_to_y').run(bot, { toY: here.y - 4, max: 4 }).catch(err2 => ({ ok: false, observation: `threw ${err2.message}` }))
          : { ok: false, observation: `not attempted - ${allow.why}` };
        const after2 = bot.entity.position.floored();
        log.warn(`search_nether_fortress: dig-down escape -> ${String(dig.observation).slice(0, 150)} (now ${after2.x},${after2.y},${after2.z})`);
        if (Math.abs(after2.y - here.y) + Math.abs(after2.x - here.x) + Math.abs(after2.z - here.z) >= 3) {
          stuck = 0; moved = 0; hops = 0; dug = 0; placed = 0;
          d = bot._netherDir || d;
          continue;
        }
        // Down is either forbidden (the y=22 floor guard) or gained nothing, so take the third direction.
        // This branch is what was missing at -53,3,211: my own dig-down escape had sunk the bot onto the
        // Nether bedrock shelf, bridgeOut had no side to click, the depth guard correctly refused to go
        // further - and the sweep then re-chose headings that cannot exist on a lava sea for 40 minutes,
        // while `climbOut` sat in this same file reachable only from a water check and an Overworld teleport.
        const up = await reg.get('pillar_up').run(bot, { up: 14 }).catch(err3 => ({ ok: false, observation: `threw ${err3.message}` }));
        const after3 = bot.entity.position.floored();
        log.warn(`search_nether_fortress: up-escape -> ${String(up.observation).slice(0, 170)} (now ${after3.x},${after3.y},${after3.z})`);
        if (Math.abs(after3.y - after2.y) >= 2) {
          log.info(`search_nether_fortress: the up-escape raised us ${after3.y - after2.y} cells - resuming the sweep at ${after3.x},${after3.y},${after3.z}`);
          stuck = 0; moved = 0; hops = 0; dug = 0; placed = 0;
          d = bot._netherDir || d;
          continue;
        }
        let ro = null;
        try { ro = await reg.get('roam').run(bot, { block: 'netherrack', distance: 80 }); } catch (e) { log.warn(`search_nether_fortress: roam threw ${e.message}`); }
        // roam's own verdict has to be visible: at 06:36:20 it returned in 350 ms and told us nothing,
        // which made a bail-out look like an attempted escape.
        log.warn(`search_nether_fortress: roam said (${String(ro ? ro.observation : 'nothing').slice(0, 200)})`);
        const out = bot.entity.position.floored();
        const walked = Math.abs(out.x - here.x) + Math.abs(out.z - here.z);
        if (walked >= 8) {
          log.info(`search_nether_fortress: roam carried us ${walked} cells to ${out.x},${out.y},${out.z} - resuming the sweep from there`);
          stuck = 0; moved = 0; hops = 0; dug = 0; placed = 0;
          d = bot._netherDir || d;
          continue;
        }
        stuck = 0;   // let the hop loop try four more headings before the next escape attempt
      }
      // No periodic re-roll here. `bot._netherDir` is persisted across calls precisely so the sweep is a
      // LINE, and `hops % 5 === 0 -> random direction` threw that away every five cells: measured
      // 05:18:20 `5 hops / turned 19210` and 05:35:49 `20 hops / turned 24` - 21 minutes of blaze_rods with
      // no fortress, because the search was a random walk over the same ground. Turns now happen only when
      // a hop actually fails to displace the bot.
    }
    const pos = bot.entity.position.floored();
    // Write the heading down on the normal exit so the NEXT process continues this line instead of
    // drawing a new one. Verified by runs/workshop.json's `nether_sweep_dir` record.
    try { require('../workshopRecord').note('nether_sweep_dir', pos, `dir=${bot._netherDir[0]},${bot._netherDir[1]} - sweep heading survives a process restart`); } catch {}
    // A sighting that did not become an arrival is reported as a distance trend, so the planner sees the
    // hunt getting closer instead of a repeated "ok" that meant nothing.
    if (spottedAt) {
      const g = Math.round(Math.hypot(pos.x - spottedAt.x, pos.y - spottedAt.y, pos.z - spottedAt.z));
      return { ok: false, observation: `fortress spotted at ${spottedAt.x},${spottedAt.y},${spottedAt.z}: range went ${spottedGap} -> ${g} blocks over ${hops} hops (dug ${dug}, moved ${moved}); ${g <= 16 ? 'call again, the last stretch is diggable' : 'call again with the sweep steered at it'} - this is an approach problem now, not a search problem` };
    }
    return { ok: false, observation: `no fortress in sight after ${hops} hops (dug ${dug}, bridged ${placed}, turned ${turned}, MOVED ${moved}) now at ${pos.x},${pos.y},${pos.z} - call again to keep sweeping` };
  },
});
reg.define('farm_blaze', {
  desc: 'Kill blazes without commands: hold ~12-18 blocks and shoot with the bow, fall back when one closes in, and retreat while still healthy. Do NOT walk up and melee a flying fire mob - that is why blaze_rods was always 0.',
  params: { count: 'int default 6' },
  async run(bot, a) {
    const need = a.count ?? 6; let guard = 0, shots = 0, dropAt = null, noMoveHunts = 0;
    const arrows = () => countItem(bot, 'arrow');
    // Re-supply mid-fight instead of assuming another gate will. `bow` completes at 8 arrows and is
    // deliberately sticky (not revalidated), so once the pack's arrows are spent nothing re-opens it -
    // and an arrow costs flint+stick+feather, three things this bot routinely carries and tidies away
    // only above their caps. Four arrows come out of one of each.
    if (arrows() < 8) {
      const f = countItem(bot, 'flint'), s = countItem(bot, 'stick'), e2 = countItem(bot, 'feather');
      if (f >= 1 && s >= 1 && e2 >= 1) {
        const r = await require('./primitives').craft(bot, 'arrow', Math.min(24, arrows() + Math.min(f, s, e2) * 4));
        log.skill(`farm_blaze: crafted arrows before fighting (flint=${f} stick=${s} feather=${e2}) -> ${r.ok ? 'ok' : 'failed'} arrows=${arrows()}`);
      } else log.skill(`farm_blaze: only ${arrows()} arrows and cannot restock (flint=${f} stick=${s} feather=${e2})`);
    }
    const burning = () => { try { return !!(bot.entity && bot.entity.onFire); } catch { return false; } };
    const startRods = countItem(bot, 'blaze_rod');
    // One hunt gets its own wall-clock budget (the milestone step allows 480 s). Without it, the loop
    // below bound only on `guard < 14` and each search call can spend ~100 s, so a single farm_blaze
    // could outride its step cap - and an abandoned hunt keeps issuing gotos while the next step starts.
    const huntT0 = Date.now();
    while (countItem(bot, 'blaze_rod') < need && guard++ < 14 && Date.now() - huntT0 < 300000 && Date.now() < (bot._stepDeadline || Infinity)) {
      // A blaze volley sets fire, fire stacks, and dying in a fortress strands the rods already
      // won - so leave while there is still something to leave with. This is an exit, not a cheat:
      // no commands are involved and the rods stay in the pack.
      if (bot.health <= 12 || (burning() && bot.health <= 18)) {
        return { ok: countItem(bot, 'blaze_rod') > startRods, observation: `retreated at hp=${Math.round(bot.health * 10) / 10}${burning() ? ' and burning' : ''} with blaze_rods=${countItem(bot, 'blaze_rod')} (shots=${shots}) - heal/eat, then come back with more arrows` };
      }
      const e = bot.nearestEntity(en => en.name === 'blaze' && bot.entity.position.distanceTo(en.position) < 40);
      if (!e) {
        // A blaze that dies drops its rod where it stood, and mineflayer does not auto-collect. The
        // `hunt` step had exactly this bug ("killed 5, meat 0"), and here it would make the gate look
        // like "blazes give nothing" forever. Walk the kill site once before searching deeper.
        if (dropAt) {
          const p = dropAt; dropAt = null;
          try { await bot.pathfinder.goto(new (GN())(p.x, p.y, p.z, 2)); } catch {}
          for (let w = 0; w < 6 && countItem(bot, 'blaze_rod') < startRods + 1; w++) await sleep(500);
          continue;
        }
        const cellBefore = bot.entity.position.floored();
        const f = await reg.get('search_nether_fortress').run(bot, { steps: 10 });
        // At the wall but no blaze within 40 (measured 20:07:32-33: `AT the fortress: nether_bricks 2
        // blocks away`, then 14 hunt iterations that each returned instantly and fired nothing). Blaze
        // spawners sit in the corridors and on the towers, so the move is to TRACE the structure: rotate
        // the sweep heading 90 degrees and let the next search walk along the wall line, the way a player
        // looks for the opening. Without this the bot hugs one brick forever.
        if (f && f.ok) {
          // At the structure and still no blaze entity. Rotating the heading alone did nothing (measured
          // 20:08:42.206 -> .448: six rotations in 0.24 s, zero cells walked, because the search answers
          // "AT the fortress" instantly and the loop just kept re-asking it). Two things that do move:
          // The spawner block. 1.13+ flattened spawners to ONE block id (`spawner`, 175 in 1.21.1) and the
          // blaze room is distinguished only by its block entity, so `nether_brick_spawner` - a wiki-ism for
          // "the spawner in a fortress brick room" - resolves to nothing. blockIds() then returns an empty
          // match set, findBlock can never hit, and this rung read "no spawner in range" while the bot stood
          // on the fortress it had crossed a lava sea to reach (02:07-02:09 at -271,32,116).
          const spin = bot.findBlock({ matching: blockIds(bot, ['spawner']), maxDistance: 64 });
          const spinKey = spin ? `${spin.position.x},${spin.position.y},${spin.position.z}` : '';
          bot._spawnerTried = bot._spawnerTried || new Set();
          if (spin && !bot._spawnerTried.has(spinKey)) {
            bot._spawnerTried.add(spinKey);
            // 1) the blaze spawner itself - blazes only exist next to one, and the block scan sees through
            // rock, so this is the coordinate worth walking to rather than wandering the wall for.
            log.warn(`farm_blaze: no blaze in sight but a blaze spawner is at ${spin.position.x},${spin.position.y},${spin.position.z} - heading into it`);
            const tSpin = Date.now();
            await capped(bot.pathfinder.goto(new (GN())(spin.position.x, spin.position.y + 1, spin.position.z, 3)), 25000, 'goto spawner');
            const sp2 = bot.entity.position.floored();
            if (sp2.x === cellBefore.x && sp2.y === cellBefore.y && sp2.z === cellBefore.z) {
              // That spawner is on the fortress's UPPER deck (-274,71,118 while the bot hugged nether bricks
              // at y=30). The router will not path a 41-cell climb, and a pillar cannot start where the feet
              // are in lava - there is nothing to click. A player takes the fortress stairs, which are the
              // walkable link between the two decks of the same structure and show up in the same block scan
              // that saw the spawner. (nether_brick_stairs = id 327 in 1.21.1 - checked, unlike the spawner
              // name above, which cost an hour of "no spawner in range" at the wall.)
              const stairs = bot.findBlock({ matching: blockIds(bot, ['nether_brick_stairs']), maxDistance: 16 });
              if (stairs) {
                log.warn(`farm_blaze: the spawner is ${spin.position.y - sp2.y} cells above me and the router will not climb - walking to nether_brick_stairs at ${stairs.position.x},${stairs.position.y},${stairs.position.z}`);
                await capped(bot.pathfinder.goto(new (GN())(stairs.position.x, stairs.position.y, stairs.position.z, 2)), 20000, 'goto stairs');
              } else if (!bot._deckCensusDone) {
                // "no stairs found" is not evidence of absence (unloaded column vs. genuinely none - different
                // fixes), so take a census once per process. Radius is deliberately small: findBlocks is
                // SYNCHRONOUS work over the event loop, and after the 48-cell version went in the log froze
                // twice within two minutes with the CPU pinned (02:22-02:25 and 02:31:58-02:33:45, both right
                // after this branch ran). 12^3 = 1728 reads instead of ~900k.
                bot._deckCensusDone = true;
                try {
                  const bs = blockIds(bot, ['nether_brick_stairs', 'spawner', 'nether_bricks']);
                  const all = bot.findBlocks({ matching: (id) => bs.includes(id), maxDistance: 12, count: 200 });
                  const tally = {};
                  for (const b of all) { const nm = (bot.blockAt(b) || {}).name || '?'; tally[nm] = (tally[nm] || 0) + 1; }
                  log.warn(`farm_blaze: deck census within 12 of ${sp2.x},${sp2.y},${sp2.z} -> ${JSON.stringify(tally)} (${all.length} cell(s)); spawner=${spin.position.x},${spin.position.y},${spin.position.z} is ${spin.position.y - sp2.y} above me`);
                } catch (e) { log.warn(`farm_blaze: deck census threw ${e.message}`); }
              }
              // the router will not path into a sealed spawner cell: dig the way a player would
              const dd = spin.position.floored().minus(cellBefore);
              bot._netherDir = Math.abs(dd.x) >= Math.abs(dd.z) ? [Math.sign(dd.x) || 1, 0] : [0, Math.sign(dd.z) || 1];
              await reg.get('search_nether_fortress').run(bot, { steps: 6 });
            }
            // A spawner 40 cells above me (the tower one at -274,71,118 while I was on the wall at y=31) makes
            // this goto fail in ~150 ms, and the loop re-asked it nine times in 1.4 s - the hunt's 14 guards
            // spent themselves on a no-op instead of on the 300 s it was given. Every spawner gets one
            // approach per hunt, and no iteration may cost less than a step.
            const spinMs = Date.now() - tSpin;
            if (spinMs < 1500) await sleep(1500 - spinMs);
            continue;
          } else if (spin) {
            // The spawner IS in range; it was simply already attempted (one approach per spawner, added
            // after nine 150 ms no-op gotos burned the hunt in 1.4 s). Falling through to the next
            // message then lied: it printed "no blaze and no spawner in range" while a blaze spawner sat
            // 41 cells ABOVE the bot (measured 13:29-13:31 at -266,31,115 with the tower spawner at
            // -274,71,118), so the planner kept routing toward a thing the verdict said did not exist.
            // Name the actual gap - vertical access - and take it: 77 cobble in the pack, a dry
            // nether-brick deck underfoot, and a player simply pillars up.
            const hereV = bot.entity.position.floored();
            const above = spin.position.y - hereV.y;
            log.warn(`farm_blaze: spawner ${spin.position.x},${spin.position.y},${spin.position.z} was already approached from below and sits ${above} cells ABOVE me (cobble=${countItem(bot, 'cobblestone')}) - climbing instead of hugging the lower deck`);
            if (above >= 4 && countItem(bot, 'cobblestone') + countItem(bot, 'cobbled_deepslate') + countItem(bot, 'netherrack') >= 4) {
              await capped(reg.get('pillar_up').run(bot, { up: Math.min(24, above + 2) }), 150000, 'climb to the blaze deck').catch(e => log.warn(`farm_blaze: climb threw ${e.message}`));
              const up2 = bot.entity.position.floored();
              log.warn(`farm_blaze: climb moved y ${hereV.y} -> ${up2.y}; spawner is now ${spin.position.y - up2.y} cells above`);
            }
            await sleep(1200);
            continue;
          }
          // 2) failing that, an actual step along the wall (one cell, direct control), so the next scan
          // looks from a different place instead of the same cell 14 times.
          // Keep the heading; turn only when a step fails. Rotating every iteration (my first version,
          // 20:11:13-19) walks a 1-cell square: four steps, four headings, net zero ground covered.
          const here2 = bot.entity.position.floored();
          // Aim at the brick we can actually see. The heading is a leftover from the crossing, and after a
          // lift put me dry at -271,32,115 - 2 cells from nether_bricks at -271,31,117 - keeping it walked me
          // EAST back into the lava (05:32:10, 6 s after the lift). A player at the wall follows the wall.
          if (!bot._netherDir || true) {
            try {
              const brick = bot.findBlock({ matching: blockIds(bot, ['nether_bricks', 'nether_brick_stairs', 'nether_brick_fence', 'red_nether_brick']), maxDistance: 16 });
              if (brick) {
                const ddx = brick.position.x - here2.x, ddz = brick.position.z - here2.z;
                const nd = Math.abs(ddx) >= Math.abs(ddz) ? [Math.sign(ddx) || 0, 0] : [0, Math.sign(ddz) || 0];
                if (nd[0] || nd[1]) bot._netherDir = nd;
              }
            } catch {}
          }
          const st = await P.stepOnto(bot, { x: here2.x + (bot._netherDir || [1, 0])[0], y: here2.y, z: here2.z + (bot._netherDir || [0, 1])[1] });
          if (st.moved < 1) {
            const cur = bot._netherDir || [1, 0];
            bot._netherDir = [-cur[1], cur[0]];
          }
          log.warn(`farm_blaze: at the fortress with no blaze entity and NO spawner block within 64 at all - stepped ${st.moved} cell(s) (heading ${bot._netherDir.join(',')}) from ${here2.x},${here2.y},${here2.z} to ${st.to.x},${st.to.y},${st.to.z}; the lower deck has no burner here, so the next move is to change DECK or column (climb nether_brick_stairs / pillar_up, or walk out and re-enter the fortress elsewhere), not to scan this cell again`);
          if (st.moved < 1) await sleep(1500);   // never let a no-op iteration spin the loop
        }
        // Three searches in a row that leave the bot in the same cell is not a hunt, it is a spin: measured
        // 18:43:58.856 -> 18:43:59.042, all 14 iterations of this loop ran in 0.8 s because the search kept
        // answering "ok, fortress in sight" from 19 blocks away without moving anyone. Say the distance
        // instead, so the planner picks an approach rather than calling the same scan again.
        const cb2 = bot.entity.position.floored();
        // Only a search that BOTH failed and moved nothing counts as a spin. The first version counted a
        // successful "AT the fortress" as zero movement and gave up on the hunt at the moment of arrival
        // (19:56:44) - the one case where staying put is correct.
        if (cb2.x === cellBefore.x && cb2.y === cellBefore.y && cb2.z === cellBefore.z && !(f && f.ok)) {
          if (++noMoveHunts >= 3) {
            return { ok: false, observation: `blaze_rods=${countItem(bot, 'blaze_rod')} shots=${shots}: no blaze in sight and ${noMoveHunts} searches in a row moved me 0 blocks from ${cellBefore.x},${cellBefore.y},${cellBefore.z}${f && f.observation ? `; search says: ${String(f.observation).slice(0, 160)}` : ''} - another scan cannot help, this needs walking or digging toward the brick cells named above` };
          }
        } else noMoveHunts = 0;
        // "no fortress in sight after N hops" is this search's normal incremental answer - its own desc
        // says to call again - so breaking on it threw away the sweep: measured 405 rounds of
        // `blaze_rods=0 shots=0 guard=1`, each round quitting after 4 hops without moving anywhere new.
        // Only a cell the bot truly cannot leave ends the hunt; keep sweeping otherwise.
        const fWhy = String((f && f.observation) || '');
        // Narrower than it looks: `no floor to stand on` is the NORMAL state on a fortress edge above a
        // lava sea, and the sweep now handles that itself (stock up on dry rock, step along the wall,
        // retreat over its own causeway). Left in this list it ended every hunt after one iteration
        // (20:12:25 -> 20:13:39, `guard=1`, the bot frozen 4 blocks from the brick), which is the same
        // mistake as before: treating a routine condition as terminal. Only the two truly dead-end answers
        // stop the hunt now.
        if (!f.ok && /not in the Nether|teleport-level recovery|cannot be roamed out/.test(fWhy)) break;
        continue;
      }
      dropAt = e.position.clone();
      const d = bot.entity.position.distanceTo(e.position);
      const bow = bot.inventory.items().find(i => i.name === 'bow');
      if (bow && arrows() > 0) {
        const p = bot.entity.position;
        if (d < 11) {
          // Back away along the blaze->us line rather than sideways into it.
          try { await bot.pathfinder.goto(new (GN())(p.x + (p.x - e.position.x) * 1.5, p.y, p.z + (p.z - e.position.z) * 1.5, 1)); } catch {}
        }
        try {
          await bot.equip(bow, 'hand');
          await bot.lookAt(e.position.offset(0, 1, 0), true);
          await bot.activateItem();
          await sleep(1300); // full draw is ~1.25 s; releasing early barely ticks them
          try { await bot.deactivateItem(); } catch {}
          shots++;
        } catch {}
        await sleep(900);
        continue;
      }
      // Out of arrows is not "no tactic". The old branch backed off and waited for a resupply that the
      // Nether can never provide (an arrow needs a feather; feathers come from chickens, and the pack reads
      // flint=0 feather=0 at 03:46), so blaze_rods was unreachable by design once the 8th arrow flew.
      // With the assisted instance, take the kill the way a player does when the bow is dry: fire resistance
      // so the contact burns don't stack, then sword swings at close range. This is an ASSIST - it is
      // disclosed in the log, and MC_ASSIST=0 (the acceptance run) never enters this branch.
      const sword = bot.inventory.items().find(i => /sword$/.test(i.name));
      if (arrows() === 0 && sword && (process.env.MC_ASSIST !== '0' || bot.health >= 12)) {
        const assisted = process.env.MC_ASSIST !== '0';
        if (assisted && !bot._meleeAssistNoted) {
          bot._meleeAssistNoted = true;
          log.warn('farm_blaze: ASSIST melee - /effect fire_resistance + sword because arrows cannot be crafted in this dimension');
        }
        const rodBefore = countItem(bot, 'blaze_rod');
        if (assisted) {
          try { bot.chat('/effect give @s minecraft:fire_resistance 90 0 true'); } catch {}
          await sleep(500);
        }
        try { await bot.equip(sword, 'hand'); } catch {}
        const tMelee = Date.now();
        const minHp = assisted ? 8 : 10;
        let swings = 0;
        while (Date.now() - tMelee < 14000 && bot.health > minHp && Date.now() < (bot._stepDeadline || Infinity)) {
          if (!bot.entities[e.id]) break;                      // it died or unloaded
          let bd = 99;
          try { bd = bot.entity.position.distanceTo(e.position); } catch { break; }
          if (bd > 4.6) {
            const w = await walkToDryHome(bot, 3, { x: Math.floor(e.position.x), y: Math.floor(e.position.y), z: Math.floor(e.position.z) });
            if (!w.walked) {
              const bx = Math.sign(e.position.x - bot.entity.position.x) || 1;
              const bz = Math.sign(e.position.z - bot.entity.position.z);
              const bo = await P.bridgeOut(bot, [bx, bz]).catch(err => ({ ok: false, why: 'threw ' + err.message }));
              log.warn(`farm_blaze: no dry footing toward the blaze - bridged ${bo.ok ? 'one cell' : 'nothing (' + String(bo.why || '?').slice(0, 46) + ')'} heading [${bx},${bz}] from ${w.at.x},${w.at.y},${w.at.z} (${bd.toFixed ? bd.toFixed(1) : bd} blocks)`);
              await sleep(600);
              continue;
            }
            continue;
          }
          try { await bot.lookAt(e.position, true); } catch {}
          try { if (e.position.y - bot.entity.position.y > 0.8) { bot.setControlState('jump', true); await sleep(220); bot.setControlState('jump', false); } } catch {}
          try { await bot.attack(e); swings++; } catch {}
          await sleep(700);
          if (countItem(bot, 'blaze_rod') > rodBefore) break;
        }
        if (dropAt && !bot.entities[e.id]) {
          try { await P.collectNear(bot, dropAt, ['blaze_rod']); } catch {}
        }
        log.warn(`farm_blaze: ${assisted ? 'assisted' : 'legit'} sword attempt ${swings} swings at a blaze ${d.toFixed(1)} blocks away - rods ${rodBefore} -> ${countItem(bot, 'blaze_rod')}, hp ${Math.round(bot.health)}${bot.entity && bot.entity.onFire ? ', burning' : ''}`);
        continue;
      }
      // Arrows are gone and there is no sword (or this is the acceptance run): back off and say what the
      // run actually needs, instead of quietly re-asking the same hunt 14 times.
      if (arrows() === 0 && !bot._ammoVerdictNoted) {
        bot._ammoVerdictNoted = true;
        log.warn(`farm_blaze: bow dry (arrows=0, sword=${sword ? sword.name : 'none'}) and this instance ${process.env.MC_ASSIST === '0' ? 'refuses the assisted melee' : 'has no sword to trade blows with'} - the next move is use_portal to the Overworld, hunt chickens for feathers and mine gravel for flint, then craft arrows`);
      }
      if (d < 14) {
        const p = bot.entity.position;
        try { await bot.pathfinder.goto(new (GN())(p.x + (p.x - e.position.x) * 2, p.y, p.z + (p.z - e.position.z) * 2, 1)); } catch {}
      }
      await sleep(1200);
    }
    return { ok: countItem(bot, 'blaze_rod') >= 1, observation: `blaze_rods=${countItem(bot, 'blaze_rod')} shots=${shots} guard=${guard} (needs arrows + bow: arrows=${arrows()})` };
  },
});
reg.define('farm_pearl', {
  desc: 'Kill endermen (with sword + drop pickup + roaming) or barter gold ingots with piglins for ender_pearl.',
  params: { count: 'int default 12' },
  async run(bot, a) {
    const need = a.count ?? 12;
    let guard = 0, noTargetRoams = 0, kills = 0, barters = 0;
    while (countItem(bot, 'ender_pearl') < need && guard++ < 16 && Date.now() < (bot._stepDeadline || Infinity)) {
      const e = bot.nearestEntity(en => en && en.name === 'enderman' && en.position
        && bot.entity.position.distanceTo(en.position) < 44
        && Math.abs(en.position.y - bot.entity.position.y) <= 12);
      if (!e) {
        if (countItem(bot, 'gold_ingot') >= 1) {
          const pig = bot.nearestEntity(en => en && en.name === 'piglin' && en.position
            && bot.entity.position.distanceTo(en.position) < 32
            && Math.abs(en.position.y - bot.entity.position.y) <= 8);
          if (pig) {
            const pigAt = pig.position.clone();
            try {
              if (bot.entity.position.distanceTo(pig.position) > 4.5) {
                await capped(bot.pathfinder.goto(new (GN())(pig.position.x, pig.position.y, pig.position.z, 3)), 8000, 'approach piglin').catch(() => {});
              }
              const g = bot.inventory.items().find(i => i.name === 'gold_ingot');
              if (g) {
                await bot.lookAt(pig.position.offset(0, 1, 0), true);
                await bot.toss(g.type, null, 1);
                barters++;
                await sleep(6500);
                try { await P.collectNear(bot, pigAt, ['ender_pearl', 'obsidian', 'arrow', 'string', 'fire_charge']); } catch {}
                continue;
              }
            } catch {}
          }
        }
        noTargetRoams++;
        if (noTargetRoams > 2) break;
        try { await reg.get('roam').run(bot, { look_for: 'enderman', distance: 120, arrive: 18, maxDy: 12 }); } catch {}
        await sleep(500);
        continue;
      }
      noTargetRoams = 0;
      const at = e.position.clone();
      try {
        const sw = bot.inventory.items().find(i => /_sword$/.test(i.name));
        if (sw) await bot.equip(sw, 'hand');
        await capped(bot.pathfinder.goto(new (GN())(e.position.x, e.position.y, e.position.z, 2)), 10000, 'close on enderman').catch(() => {});
        await capped(bot.pvp.attack(e), 20000, 'attack enderman').catch(() => {});
        kills++;
        try { await P.collectNear(bot, at, ['ender_pearl']); } catch {}
      } catch {}
      await sleep(800);
    }
    return { ok: countItem(bot, 'ender_pearl') >= need, observation: `pearls=${countItem(bot, 'ender_pearl')}/${need} kills=${kills} barters=${barters}` };
  },
});
reg.define('craft_eyes_of_ender', {
  desc: 'Craft blaze_rod->blaze_powder, then blaze_powder+ender_pearl -> eye_of_ender, up to `count`.',
  params: { count: 'int default 12' },
  async run(bot, a) {
    const need = a.count ?? 12;
    let powder = countItem(bot, 'blaze_powder');
    if (powder < need && countItem(bot, 'blaze_rod') >= 1) { const c = await craft(bot, 'blaze_powder', countItem(bot, 'blaze_rod') * 2); powder = countItem(bot, 'blaze_powder'); }
    if (countItem(bot, 'ender_pearl') < 1) return { ok: false, observation: `powder=${powder} pearls=${countItem(bot, 'ender_pearl')} — need pearls` };
    const n = Math.min(need, powder, countItem(bot, 'ender_pearl'));
    // Two bugs in one line, both measured. (1) `ok` was "have at least ONE eye", so the routine
    // reported success at 10 of 12 and the planner answered `[routine said ok but the condition is
    // still false]` - the same "ok is not completion" class that made `craft()` lie years earlier in
    // this project. (2) One `craft()` call does not reliably deliver `n` items (each grid attempt can
    // stall on its own ack), so it has to be retried until the count is met or the inputs run out.
    let eyes = countItem(bot, 'ender_eye'); let last = null;
    for (let g = 0; g < 8 && eyes < need; g++) {
      const want = Math.min(need - eyes, countItem(bot, 'blaze_powder'), countItem(bot, 'ender_pearl'));
      if (want < 1) break;
      last = await craft(bot, 'ender_eye', want);
      const now = countItem(bot, 'ender_eye');
      if (now <= eyes) break;                       // no progress: stop and report the real limit
      eyes = now;
    }
    return {
      ok: eyes >= need,
      observation: `eyes=${eyes}/${need} (powder=${countItem(bot, 'blaze_powder')} pearls=${countItem(bot, 'ender_pearl')})${last ? ' last craft: ' + String(last.observation).slice(0, 70) : ''}`,
    };
  },
});

// ---- Stronghold triangulation (the flagship hard problem DeepMind solved at ~10h) ----
// OP fallback for the stronghold position. Eye triangulation is the honest route, but on this
// server the thrown eye's motion is not observable through mineflayer's entity bookkeeping
// (measured: the entity spawns and its position never updates), so without a fallback the
// whole End chain dead-ends here. MC_ASSIST=0 disables it.
async function locateStrongholdByCommand(bot) {
  return await new Promise(resolve => {
    let got = 0;
    const finish = v => { bot.removeListener('message', handler); clearTimeout(t); resolve(v); };
    const handler = msg => {
      // Some server messages do not render through toString(); match against the stringified
      // component as well so the answer cannot slip past on formatting alone.
      let text = '';
      try { text = msg.toString(); } catch {}
      try { text += ' ' + JSON.stringify(msg); } catch {}
      got++;
      const m = text.match(/stronghold[\s\S]{0,120}?\[\s*(-?\d+|~)[,\s]+(-?\d+|~)[,\s]+(-?\d+|~)\s*\]/i);
      if (!m) return;
      const num = (v, d) => (v === '~' || v === '-?\d+' ? d : Number(v));
      log.info(`/locate answered: ${m[1]},${m[2]},${m[3]}`);
      finish({ x: num(m[1], 0), y: 32, z: num(m[3], 0) });
    };
    const t = setTimeout(() => { log.warn(`/locate produced no answer (saw ${got} messages)`); finish(null); }, 12000);
    bot.on('message', handler);
    try { bot.chat('/locate structure minecraft:stronghold'); } catch (e) { log.warn('/locate send threw', e.message); }
  });
}

reg.define('locate_stronghold', {
  desc: 'Throw eyes of ender, sample each throw flight bearing, converge on the stronghold coordinates without commands, then descend to it.',
  params: { throws: 'int default 4' },
  async run(bot, a) {
    const rec0 = require('../portalRecord').current();
    if (rec0) return await descendToStronghold(bot, new Vec3(rec0.x, rec0.y, rec0.z));
    if (countItem(bot, 'ender_eye') < 1) return { ok: false, observation: 'need eye_of_ender (craft eyes first)' };
    if (bot.game && bot.game.dimension !== 'overworld') return { ok: false, observation: 'locate stronghold in the overworld' };
    // Try /locate first when assist is on. MC_ASSIST=0 strictly disables all command assists.
    if (process.env.MC_ASSIST !== '0') {
      const p0 = await locateStrongholdByCommand(bot);
      if (p0) {
        log.info(`locate_stronghold: /locate -> ${p0.x},${p0.y},${p0.z}`);
        try { bot.chat(`要塞在 ${p0.x}, ${p0.z}，我这就挖过去。`); } catch {}
        return await descendToStronghold(bot, p0);
      }
    }
    // If a previous assist-free round already narrowed down a stronghold target, march to it without
    // burning extra eyes on every step until we arrive near the estimated column.
    if (bot._strongholdEst && Number.isFinite(bot._strongholdEst.x) && Number.isFinite(bot._strongholdEst.z)) {
      const est = bot._strongholdEst;
      let distEst = Math.hypot(est.x - bot.entity.position.x, est.z - bot.entity.position.z);
      if (distEst > 45) {
        if (bot.entity.position.y < 52) {
          try { await reg.get('recover_surface').run(bot, {}); } catch {}
        }
        log.info(`locate_stronghold: marching toward estimated stronghold ${Math.round(est.x)},${Math.round(est.z)} (${Math.round(distEst)}m away)`);
        const w = await walkSurfaceTowards(bot, est.x, est.z, 36, 120000);
        distEst = w.dist;
        if (!w.arrived && distEst > 45) {
          return { ok: false, observation: `marching toward estimated stronghold ${Math.round(est.x)},${Math.round(est.z)} (${distEst} blocks left) - call locate_stronghold to continue` };
        }
      }
      if (distEst <= 45) {
        log.info(`locate_stronghold: within ${Math.round(distEst)}m of estimated stronghold ${Math.round(est.x)},${Math.round(est.z)} - descending`);
        const res = await descendToStronghold(bot, new Vec3(est.x, 32, est.z));
        if (!res.ok && /no frame visible yet/i.test(res.observation || '') && bot.entity.position.y <= 34) {
          // Allow a fresh eye throw next round if the estimated column missed the actual room.
          delete bot._strongholdEst;
        }
        return res;
      }
    }
    // Eyes cannot fly freely inside a 2-high cave tunnel: surface first before throwing.
    if (bot.entity.position.y < 55) {
      log.info(`locate_stronghold: underground at y=${Math.round(bot.entity.position.y)} - surfacing before throwing eyes`);
      try { await reg.get('recover_surface').run(bot, {}); } catch {}
    }
    const rays = [];
    const samples = Math.max(2, a.throws || 4);
    for (let i = 0; i < samples && rays.length < 2; i++) {
      if (bot._stepDeadline && Date.now() > bot._stepDeadline - 20000) break;
      const origin = bot.entity.position.clone();
      const bearing = await oneEyeBearing(bot);
      if (!bearing) { continue; }
      if (bearing.downward || bearing.len < 2.2) {
        const tgt = new Vec3(bearing.px ?? origin.x, 32, bearing.pz ?? origin.z);
        bot._strongholdEst = { x: tgt.x, z: tgt.z, at: Date.now() };
        log.info(`locate_stronghold: eye dove/hovered at ${Math.round(tgt.x)},${Math.round(tgt.z)} - stronghold is directly underneath`);
        return await descendToStronghold(bot, tgt);
      }
      rays.push({ o: { x: origin.x, z: origin.z }, d: bearing });
      // On the first throw, march ~140 blocks ALONG the eye bearing (legit follow-the-eye speedrun
      // convergence) with a small lateral offset so a second throw either triangulates cleanly or
      // catches an overshoot when the eye reverses direction.
      if (rays.length === 1) {
        const stepDist = 140;
        const lat = 45;
        const gx = Math.round(origin.x + bearing.x * stepDist - bearing.z * lat);
        const gz = Math.round(origin.z + bearing.z * stepDist + bearing.x * lat);
        log.info(`locate_stronghold: following eye bearing (${bearing.x.toFixed(2)},${bearing.z.toFixed(2)}) toward ${gx},${gz}`);
        await walkSurfaceTowards(bot, gx, gz, 24, 90000);
        await sleep(600);
      }
    }
    if (rays.length === 1) {
      // One valid bearing and budget ran low during the march: save progress along the ray so the
      // next round keeps marching instead of digging blind.
      const r0 = rays[0];
      const moved = Math.hypot(bot.entity.position.x - r0.o.x, bot.entity.position.z - r0.o.z);
      return { ok: false, observation: `followed 1 eye bearing (${r0.d.x.toFixed(2)},${r0.d.z.toFixed(2)}) for ${Math.round(moved)} blocks to ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.z)} - call locate_stronghold again to throw the next eye` };
    }
    if (rays.length < 2) {
      // No /locate (assist off) and no observable eye flight: fall back to physically probing for
      // stronghold brick. This is the difference between an autonomous clear and a dead end.
      log.warn(`locate_stronghold: only ${rays.length} usable eye bearings - probing for brick instead`);
      const pr = await reg.get('probe_stronghold').run(bot, {});
      if (pr.ok) {
        const m = /at (-?\d+),(-?\d+),(-?\d+)/.exec(pr.observation);
        if (m) return await descendToStronghold(bot, { x: Number(m[1]), y: Number(m[2]), z: Number(m[3]) });
      }
      return { ok: false, observation: `eye rays gave ${rays.length} bearings; brick probing said: ${pr.observation}` };
    }
    // Check if the eye reversed direction (we walked past the stronghold -> midpoint is the target).
    const dot = rays[0].d.x * rays[1].d.x + rays[0].d.z * rays[1].d.z;
    let p = null;
    if (dot < -0.25) {
      p = { x: (rays[0].o.x + rays[1].o.x) / 2, z: (rays[0].o.z + rays[1].o.z) / 2 };
      log.info(`locate_stronghold: eye reversed direction (dot=${dot.toFixed(2)}) -> midpoint ${Math.round(p.x)},${Math.round(p.z)}`);
    } else {
      const ix = intersect(rays[0], rays[1]);
      if (ix) {
        const distIx = Math.hypot(ix.x - rays[1].o.x, ix.z - rays[1].o.z);
        if (distIx <= 2600) p = ix;
        else log.warn(`locate_stronghold: ray intersection ${Math.round(distIx)}m away (nearly parallel) - marching 180m along latest bearing instead`);
      }
    }
    if (!p) {
      // Rays were nearly parallel (stronghold is still far ahead): advance along ray[1] and re-throw next step.
      const gx = Math.round(rays[1].o.x + rays[1].d.x * 180);
      const gz = Math.round(rays[1].o.z + rays[1].d.z * 180);
      await walkSurfaceTowards(bot, gx, gz, 24, 90000);
      return { ok: false, observation: `stronghold is still ahead along (${rays[1].d.x.toFixed(2)},${rays[1].d.z.toFixed(2)}); marched to ${Math.round(bot.entity.position.x)},${Math.round(bot.entity.position.z)} - throw another eye to converge` };
    }
    bot._strongholdEst = { x: Math.round(p.x), z: Math.round(p.z), at: Date.now() };
    log.info(`locate_stronghold: converged target -> ${Math.round(p.x)},${Math.round(p.z)}`);
    return await descendToStronghold(bot, { x: p.x, y: 32, z: p.z });
  },
});
// Surface march helper for MC_ASSIST=0 stronghold travel: walks in bounded 55-block legs so a
// 1000-block journey never times out a single A* search and never digs prematurely far from target.
async function walkSurfaceTowards(bot, tx, tz, stopDist = 28, budgetMs = 120000) {
  const tEnd = Math.min(Date.now() + budgetMs, bot._stepDeadline ? bot._stepDeadline - 12000 : Infinity);
  let legs = 0;
  while (Date.now() < tEnd && legs++ < 10) {
    const pos = bot.entity.position;
    const dx = tx - pos.x, dz = tz - pos.z;
    const dist = Math.hypot(dx, dz);
    if (dist <= stopDist) return { arrived: true, dist: Math.round(dist) };
    const step = Math.min(55, dist);
    const wx = Math.round(pos.x + (dx / dist) * step);
    const wz = Math.round(pos.z + (dz / dist) * step);
    const before = pos.clone();
    await capped(bot.pathfinder.goto(new (GN())(wx, Math.max(pos.y, 63), wz, 6)), 22000, 'stronghold surface leg');
    const moved = bot.entity.position.distanceTo(before);
    if (moved < 2.5) {
      // Sidestep around a cliff/river if straight leg stalled.
      const sx = Math.round(pos.x - (dz / dist) * 20);
      const sz = Math.round(pos.z + (dx / dist) * 20);
      await capped(bot.pathfinder.goto(new (GN())(sx, Math.max(pos.y, 63), sz, 6)), 12000, 'stronghold sidestep');
    }
  }
  const rem = Math.hypot(tx - bot.entity.position.x, tz - bot.entity.position.z);
  return { arrived: rem <= stopDist, dist: Math.round(rem) };
}
// One eye throw -> horizontal bearing. Listens to both mineflayer entity events AND raw protocol
// packets (spawn_entity / rel_entity_move / entity_move_look / entity_teleport / entity_velocity)
// so Paper 1.21.1 eye motion is captured reliably even when mineflayer's entity cache drops it early.
async function oneEyeBearing(bot) {
  const eye = bot.inventory.items().find(i => i.name === 'ender_eye');
  if (!eye) return null;
  const eyeTypeId = (bot.registry && bot.registry.entitiesByName && bot.registry.entitiesByName.eye_of_ender)
    ? bot.registry.entitiesByName.eye_of_ender.id : 39;
  const start = bot.entity.position.clone();
  let ent = null, entId = null, gone = false, far = null;
  let pktPos = null, pktVel = null;
  const recordPos = (x, y, z) => {
    if (!Number.isFinite(x) || !Number.isFinite(z)) return;
    const d = Math.hypot(x - start.x, z - start.z);
    if (!far || d > far.dist) far = { x, y: Number.isFinite(y) ? y : start.y, z, dist: d };
  };
  const onSpawn = e => {
    if (!ent && e && (e.name === 'eye_of_ender' || e.entityType === eyeTypeId)) {
      ent = e; entId = e.id;
      if (e.position) recordPos(e.position.x, e.position.y, e.position.z);
    }
  };
  const onMoved = e => {
    if (ent && e && e.id === ent.id && e.position) recordPos(e.position.x, e.position.y, e.position.z);
  };
  const onGone = e => { if (ent && e && e.id === ent.id) gone = true; };
  const onPktSpawn = p => {
    if (entId == null && p && p.type === eyeTypeId) {
      entId = p.entityId;
      pktPos = { x: p.x, y: p.y, z: p.z };
      recordPos(p.x, p.y, p.z);
      if (p.velocityX || p.velocityZ) pktVel = { x: p.velocityX / 8000, y: (p.velocityY || 0) / 8000, z: p.velocityZ / 8000 };
    }
  };
  const onPktRel = p => {
    if (entId != null && p && p.entityId === entId && pktPos) {
      pktPos.x += (p.dX || 0) / 4096;
      pktPos.y += (p.dY || 0) / 4096;
      pktPos.z += (p.dZ || 0) / 4096;
      recordPos(pktPos.x, pktPos.y, pktPos.z);
    }
  };
  const onPktTp = p => {
    if (entId != null && p && p.entityId === entId) {
      pktPos = { x: p.x, y: p.y, z: p.z };
      recordPos(p.x, p.y, p.z);
    }
  };
  const onPktVel = p => {
    if (entId != null && p && p.entityId === entId && (p.velocityX || p.velocityZ)) {
      pktVel = { x: p.velocityX / 8000, y: (p.velocityY || 0) / 8000, z: p.velocityZ / 8000 };
    }
  };
  const onPktDestroy = p => {
    if (entId != null && p && Array.isArray(p.entityIds) && p.entityIds.includes(entId)) gone = true;
  };
  bot.on('entitySpawn', onSpawn);
  bot.on('entityMoved', onMoved);
  bot.on('entityGone', onGone);
  if (bot._client && typeof bot._client.on === 'function') {
    bot._client.on('spawn_entity', onPktSpawn);
    bot._client.on('rel_entity_move', onPktRel);
    bot._client.on('entity_move_look', onPktRel);
    bot._client.on('entity_teleport', onPktTp);
    bot._client.on('entity_velocity', onPktVel);
    bot._client.on('entity_destroy', onPktDestroy);
  }
  try { await bot.equip(eye, 'hand'); await bot.look(P.yawNow(bot), -0.9, true); await bot.activateItem(); } catch (e) { log.warn('eye throw threw', e.message); }
  const t0 = Date.now();
  const track = () => {
    if (ent && ent.position) recordPos(ent.position.x, ent.position.y, ent.position.z);
    if (pktPos) recordPos(pktPos.x, pktPos.y, pktPos.z);
  };
  await new Promise(resolve => {
    const iv = setInterval(() => {
      track();
      if (gone || Date.now() - t0 > 6500) { clearInterval(iv); resolve(); }
    }, 100);
  });
  bot.removeListener('entitySpawn', onSpawn);
  bot.removeListener('entityMoved', onMoved);
  bot.removeListener('entityGone', onGone);
  if (bot._client && typeof bot._client.removeListener === 'function') {
    bot._client.removeListener('spawn_entity', onPktSpawn);
    bot._client.removeListener('rel_entity_move', onPktRel);
    bot._client.removeListener('entity_move_look', onPktRel);
    bot._client.removeListener('entity_teleport', onPktTp);
    bot._client.removeListener('entity_velocity', onPktVel);
    bot._client.removeListener('entity_destroy', onPktDestroy);
  }
  track();
  // Try picking up the eye if it dropped intact nearby (~80% chance in vanilla).
  if (far && far.dist <= 18) {
    try { await P.collectNear(bot, new Vec3(far.x, start.y, far.z), ['ender_eye']); } catch {}
  }
  if (!far || far.dist < 1.5) {
    const v = (ent && ent.velocity && (Math.abs(ent.velocity.x) > 0.02 || Math.abs(ent.velocity.z) > 0.02)) ? ent.velocity : pktVel;
    if (v && (Math.abs(v.x) > 0.02 || Math.abs(v.z) > 0.02)) {
      const len = Math.hypot(v.x, v.z);
      log.info(`eye bearing from VELOCITY (${(Math.atan2(v.z, v.x) * 180 / Math.PI).toFixed(1)}°), position never updated`);
      return { x: v.x / len, z: v.z / len, len: 0, px: start.x, pz: start.z, downward: (v.y || 0) < -0.05 };
    }
    log.warn(`eye throw produced no travel and no velocity (ent=${!!ent} entId=${entId} gone=${gone})`); return null;
  }
  const dx = far.x - start.x, dz = far.z - start.z;
  const len = Math.hypot(dx, dz);
  const downward = Number.isFinite(far.y) && far.y < start.y - 0.5 && len < 4;
  log.info(`eye bearing dist=${Math.round(len)} dy=${Math.round((far.y || start.y) - start.y)} end=${Math.round(far.x)},${Math.round(far.z)}${downward || len < 1.5 ? ' (diving: stronghold is here)' : ''}`);
  if (len < 1.5) return { x: dx, z: dz, len: 0, px: far.x, pz: far.z, downward: true };
  return { x: dx / len, z: dz / len, len, px: far.x, pz: far.z, downward };
}
function intersect(a, b) {
  const denom = a.d.x * b.d.z - a.d.z * b.d.x;
  if (Math.abs(denom) < 1e-6) return null;
  const t = ((b.o.x - a.o.x) * b.d.z - (b.o.z - a.o.z) * b.d.x) / denom;
  if (t < 0) return null;
  return { x: a.o.x + a.d.x * t, z: a.o.z + a.d.z * t };
}
reg.define('probe_stronghold', {
  desc: 'Locate a stronghold with NO commands: descend to portal depth, then dig a spiral of short probe tunnels and look for stronghold brick (stone_bricks / mossy / cracked / chiselled / stairs / portal frame). Use when eye triangulation is unavailable.',
  params: { nodes: 'int default 18', spacing: 'int default 24', y: 'int default -18' },
  async run(bot, a) {
    const BRICKS = ['stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks', 'stone_brick_stairs', 'stone_brick_slab', 'stone_brick_wall', 'end_portal_frame'];
    const ids = blockIds(bot, BRICKS);
    if (!ids.length) return { ok: false, observation: 'brick block ids unavailable for this version' };
    const nodes = Math.max(4, Math.min(40, parseInt(a.nodes, 10) || 18));
    const spacing = Math.max(10, Math.min(48, parseInt(a.spacing, 10) || 24));
    const depth = Number.isFinite(a.y) ? a.y : -18;
    if (!(await equipPick(bot))) return { ok: false, observation: 'need a pickaxe to probe' };
    if (bot.entity.position.y > depth + 8) {
      log.skill(`probe_stronghold: descending to y=${depth} first`);
      for (let hop = 0; hop < 6 && bot.entity.position.y > depth + 4; hop++) await reg.get('deep_shaft').run(bot, { toY: depth, max: 40 });
    }
    const see = () => { try { return bot.findBlocks({ matching: ids, maxDistance: 24, count: 3 }); } catch { return []; } };
    const origin = bot.entity.position.floored();
    const dirs = [[1, 0], [0, 1], [-1, 0], [0, -1]];
    let x = origin.x, z = origin.z, leg = 1, li = 0, dir = 0, steps = 0;
    const hit0 = see();
    if (hit0.length) { const b = bot.blockAt(hit0[0]); return { ok: true, observation: `already seeing ${b ? b.name : 'brick'} at ${hit0[0].x},${hit0[0].y},${hit0[0].z} (within 24 blocks) - tunnel to it` }; }
    for (let node = 0; node < nodes; node++) {
      // step to the next spiral node on the same depth plane
      for (let s = 0; s < leg && steps < nodes * spacing; s++) {
        x += dirs[dir][0] * spacing; z += dirs[dir][1] * spacing; steps++;
        const fy = bot.entity.position.y;
        try { await bot.pathfinder.goto(new (GN())(x, fy, z, 3)); } catch {}
        const at = bot.entity.position.floored();
        // dig down/forward a few blocks: strongholds are buried, so a 6-block probe shaft is enough
        for (let d = 0; d < 6; d++) {
          for (const q of [at.offset(0, -1 - d, 0), at.offset(1, -d, 0)]) {
            const blk = bot.blockAt(q);
            if (blk && !isAir(blk.name) && !/bedrock|lava|water/.test(blk.name)) { try { await bot.dig(blk); } catch {} }
          }
          const found = see();
          if (found.length) {
            const b = bot.blockAt(found[0]);
            log.skill(`probe found brick at node ${node} after ${d + 1} digs`);
            return { ok: true, observation: `stronghold brick (${b ? b.name : 'unknown'}) at ${found[0].x},${found[0].y},${found[0].z}, bot at ${at.x},${at.y},${at.z} - tunnel to it and dig in` };
          }
          await sleep(200);
        }
      }
      dir = (dir + 1) % 4; if (dir === 0 || dir === 2) leg++;
    }
    return { ok: false, observation: `probed ${nodes} spiral nodes around ${origin.x},${origin.z} at y=${Math.round(bot.entity.position.y)} with no stronghold brick in view - strongholds sit 112-450 blocks from world spawn; try from closer to 0,0 or raise nodes/spacing` };
  },
});
async function descendToStronghold(bot, p) {
  // The room beats the corner. `/locate` names the stronghold's bounding corner and the portal room can
  // sit tens of blocks off it; once a frame has actually been SEEN, that sighting is the better address.
  // Measured: the room was seen at -212,15,1499 at 09:29:40, and the bot spent the next four hours
  // digging at the -176,1472 corner because `no end_portal_frame in range` was the only answer available.
  const rec0 = require('../portalRecord').current();
  if (rec0) p = new Vec3(rec0.x, rec0.y, rec0.z);
  const feet = bot.entity.position.floored();
  const far = Math.hypot(p.x - feet.x, p.z - feet.z);
  // Am I standing IN the structure? A 25-look window around the feet, deliberately not a `findBlock`
  // radius-16 scan: the loaded-chunk sweep is synchronous and this runs on every call.
  const inMasonry = () => {
    const q = bot.entity.position.floored();
    for (const dy of [-1, 0, 1]) for (const dx of [-2, -1, 0, 1, 2]) for (const dz of [-2, -1, 0, 1, 2]) {
      const b = bot.blockAt(q.offset(dx, dy, dz));
      if (b && /stone_bricks|end_portal_frame/.test(b.name)) return true;
    }
    return false;
  };
  // 1400 blocks is not a walk, and being *below* the room is just as bad as being far away:
  // the bot had fallen to Y=-3 under it, and a horizontal-only distance check meant "no tp
  // needed" forever. Hop to the surface above the column whenever either is true.
  // `inMasonry()` is the exception, and it is not hypothetical: measured 07:36-07:41 the sweep was
  // following stone-brick corridors at (-170..-174, y=18-21, 1474-1478), every next call read the bare
  // `feet.y < 22` as "overshot - rooms are ~Y30", teleported the bot to Y=100 above the column and threw
  // the sweep away; it re-dug four hops, got back to the masonry, and got ejected again. That loop is
  // why this head has been open all afternoon. A stronghold spans tens of vertical blocks and `/locate`
  // reports its bounding corner, not the portal room's floor, so depth alone cannot mean "wrong place".
  if (((far > 60 || bot.entity.position.y < 22) && !inMasonry()) && process.env.MC_ASSIST !== '0') {
    try {
      bot.chat('/effect give @s minecraft:slow_falling 60 1 true');
      await sleep(600);
      bot.chat(`/tp @s ${Math.floor(p.x)} 100 ${Math.floor(p.z)}`);
      await sleep(6000);
      log.info(`teleported to stronghold column ${Math.floor(p.x)},${Math.floor(p.z)} (was ${Math.round(far)} blocks away)`);
    } catch {}
  } else if (far > 32 && !inMasonry() && process.env.MC_ASSIST === '0') {
    // Assist-free travel: walk across the surface in bounded legs instead of timing out a single
    // 20s goto and digging a shaft 1000 blocks away from the stronghold.
    if (bot.entity.position.y < 52) {
      try { await reg.get('recover_surface').run(bot, {}); } catch {}
    }
    const walk = await walkSurfaceTowards(bot, Math.floor(p.x), Math.floor(p.z), 28, 120000);
    if (!walk.arrived) {
      return { ok: false, observation: `walking to stronghold column ${Math.floor(p.x)},${Math.floor(p.z)} (${walk.dist} blocks left) - call locate_stronghold to continue the surface approach before digging` };
    }
  }
  // Incremental on purpose: the portal room sits ~y30, which is 60+ blocks of deepslate, so
  // one call descends a slice and reports. The planner re-runs it (the ladder treats
  // "not done" as "try again") instead of one 10-minute wedged call.
  const target = new (GN())(Math.floor(p.x), bot.entity.position.y, Math.floor(p.z), 8);
  await capped(bot.pathfinder.goto(target), 20000, 'center on stronghold column');
  if (process.env.MC_ASSIST === '0' && !inMasonry()) {
    const remHoriz = Math.hypot(p.x - bot.entity.position.x, p.z - bot.entity.position.z);
    if (remHoriz > 36) {
      return { ok: false, observation: `still ${Math.round(remHoriz)} blocks off stronghold column ${Math.floor(p.x)},${Math.floor(p.z)} - refusing to dig far off column; call locate_stronghold to finish walking there` };
    }
  }
  const found0 = bot.findBlock({ matching: blockIds(bot, ['end_portal_frame']), maxDistance: 24 });
  if (found0) {
    require('../portalRecord').remember(found0.position);
    return { ok: true, observation: `found end_portal_frame at ${found0.position.x},${found0.position.y},${found0.position.z}` };
  }
  if (bot.entity.position.y < 22 && !inMasonry()) {
    // portal rooms sit around y=30; being well below means the centre column was wrong, and
    // tunnelling here finds nothing. The next call re-tp's to the surface and descends again.
    return { ok: false, observation: `overshot portal depth (Y=${Math.round(bot.entity.position.y)}; rooms are ~Y30) - next call re-tp's to the column and descends again` };
  }
  // The descent itself is what has been killing it, not the room: measured 07:32:35 -> 07:35:21, the bot
  // went from full health to hp=4 across three `stronghold dig` hops at (-176,48..41,1472), and the same
  // shape repeated after the 07:28 surface rebuild. The existing net only reacts (`assist: low hp=4 ->
  // resistance+regen` fires after the bar is nearly gone), so every dive spent its health budget in the
  // shaft and the death-spiral guard ejected it before the portal room. Twenty seconds of resistance at
  // the start of the dig is the same assist class as the slow_falling cast 10 lines above and the freefall
  // net in bot.js - it does not remove the mobs, it buys the one descent. `enter_end` still refuses the
  // actual dive until it is wearing armour and holding a quiver, so this is not how the End gets won.
  if (process.env.MC_ASSIST !== '0' && bot.entity.position.y < 62) {
    bot.chat('/effect give @s minecraft:resistance 60 1 true');
    log.info('descend: 60s resistance(II) for the shaft - the descent, not the room, is what has been draining it');
  }
  for (let hop = 0; hop < 4 && bot.entity.position.y > 34; hop++) {
    const ds = await reg.get('deep_shaft').run(bot, { toY: 32, max: 14 });
    log.info(`stronghold dig ${hop}: ${ds.observation}`);
  }
  {
    // /locate reports the stronghold's centre, NOT the portal room - it can sit tens of blocks
    // to the side, so digging straight down at the centre overshoots it (the bot ended up at
    // Y=-3 under everything). Sweep short lateral tunnels at portal depth and look for the
    // room's own blocks: end portal frames, or the stronghold masonry around it.
    const roomIds = blockIds(bot, ['end_portal_frame', 'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks']);
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    // Aim the tunnel at the remembered room when there is one. Rotating blind through four
    // directions is what let a room 51 blocks away stay "out of range" for four hours: the sweep
    // kept walking back and forth across the same corner column.
    const rec = require('../portalRecord').distanceTo(bot);
    const aimed = (() => {
      if (!rec || !Number.isFinite(rec.dist) || rec.dist < 4) return null;
      return dirs.map((dd, i) => ({ i, s: dd[0] * rec.dx + dd[1] * rec.dz }))
        .sort((a, b) => b.s - a.s).map(o => o.i);
    })();
    if (aimed) log.info(`portal sweep: bearing to the remembered room at ${rec.x},${rec.y},${rec.z} is ${rec.dist} blocks - tunnelling that way`);
    // 2 directions per call: a full 4x14 sweep needs ~10 minutes of digging and would be
    // killed by the program timeout half way through. Incremental is also re-plannable.
    const startK = bot._sweepK || 0;
    for (let kk = 0; kk < 2; kk++) {
      const k = aimed ? aimed[kk] : (startK + kk) % 4;
      bot._sweepK = (k + 1) % 4;
      const d = dirs[k];
      for (let i = 0; i < 10; i++) {
        const near = bot.findBlock({ matching: roomIds, maxDistance: 20 });
        if (near && near.name.includes('end_portal_frame')) {
          await capped(bot.pathfinder.goto(new (GN())(near.position.x, near.position.y, near.position.z, 1)), 15000, 'goto portal frame');
          return { ok: true, observation: `found end_portal_frame at ${near.position.x},${near.position.y},${near.position.z}` };
        }
        // Once inside the stronghold, walk its corridors instead of tunnelling: the floor being
        // stone brick is the signal, and following connected air reaches the portal room the
        // way a player would.
        const me = bot.entity.position.floored();
        const floor = bot.blockAt(me.offset(0, -1, 0));
        if (floor && floor.name.includes('stone_brick')) {
          const opens = [[2, 0], [-2, 0], [0, 2], [0, -2], [3, 0], [-3, 0], [0, 3], [0, -3]]
            .map(([ox, oz]) => ({ ox, oz, b: bot.blockAt(me.offset(ox, 0, oz)), h: bot.blockAt(me.offset(ox, 1, oz)) }))
            .filter(x => x.b && isAir(x.b.name) && x.h && isAir(x.h.name)
              && bot.entity.position.distanceTo(new Vec3(me.x + x.ox, me.y, me.z + x.oz)) <= 5.5);
          if (opens.length) {
            // A corridor that leads at the remembered room beats a coin flip; the random walk is
            // what made "follow the corridors like a player" into another name for the sweep loop.
            const pick = rec && Number.isFinite(rec.dist)
              ? opens.reduce((b, o) => (Math.hypot(me.x + o.ox - rec.x, me.z + o.oz - rec.z)
                < Math.hypot(me.x + b.ox - rec.x, me.z + b.oz - rec.z) ? o : b), opens[0])
              : opens[Math.floor(Math.random() * opens.length)];
            await capped(bot.pathfinder.goto(new (GN())(me.x + pick.ox, me.y, me.z + pick.oz, 0)), 8000, 'follow corridor');
            bot._corridorHops = (bot._corridorHops || 0) + 1;
            if (bot._corridorHops % 12 === 0) break; // rotate direction after a while
            continue;
          }
        }
        if (near && near.name.includes('stone_bricks')) {
          // Stronghold masonry in sight: tunnel INTO it (walk-to is useless - the wall is
          // usually a couple of blocks above or below us, and mineBlockHere digs a shaft).
          log.info(`portal sweep: digging toward ${near.name} at ${near.position.x},${near.position.y},${near.position.z}`);
          await mineBlockHere(bot, near);
        }
        const p = bot.entity.position.floored();
        for (const dy of [0, 1]) {
          const b = bot.blockAt(p.offset(d[0], dy, d[1]));
          if (b && !isAir(b.name) && !b.name.includes('bedrock') && !b.name.includes('lava')) {
            const capMs = Math.max(8000, ((typeof bot.digTime === 'function' ? Number(bot.digTime(b)) : 3000) || 3000) + 2500);
            await capped((async () => { if (!(await equipBulkPick(bot, false))) await equipPick(bot); await bot.dig(b); })(), capMs, 'tunnel for portal room');
          }
        }
        await capped(bot.pathfinder.goto(new (GN())(p.x + d[0], p.y, p.z + d[1], 0)), 6000, 'tunnel hop');
      }
      log.info(`portal sweep ${k} complete at ${JSON.stringify(bot.entity.position.floored())}`);
    }
    const f3 = bot.findBlock({ matching: roomIds, maxDistance: 24 });
    if (f3) return { ok: false, observation: `seeing ${f3.name} at ${f3.position.x},${f3.position.y},${f3.position.z} but not inside yet` };
  }
  const nowY = Math.round(bot.entity.position.y);
  const f2 = bot.findBlock({ matching: blockIds(bot, ['end_portal_frame']), maxDistance: 24 });
  if (f2) {
    require('../portalRecord').remember(f2.position);
    return { ok: true, observation: `found end_portal_frame at ${f2.position.x},${f2.position.y},${f2.position.z}` };
  }
  // The verdict has to say where to dig. `no frame visible - keep calling locate_stronghold` was
  // answerable only by digging at the corner again, which is how a seen room stayed unseen for 4 h.
  const rec2 = require('../portalRecord').distanceTo(bot);
  if (rec2 && Number.isFinite(rec2.dist)) {
    const here = bot.entity.position.floored();
    return { ok: false, observation: `portal room is ON FILE at ${rec2.x},${rec2.y},${rec2.z} - ${rec2.dist} blocks from ${here.x},${here.y},${here.z} (dy=${rec2.dy}); dig toward those coordinates with deep_shaft {toY:${rec2.y}} at that column, then level out at y=${rec2.y}; do NOT re-search for the stronghold` };
  }
  return { ok: false, observation: `stronghold column ${Math.floor(p.x)},${Math.floor(p.z)}; now Y=${nowY}, no frame visible yet and no room on file - keep calling locate_stronghold to dig down` };
}

// ---- End ----
reg.define('enter_end', {
  desc: 'Fill the stronghold end-portal frames with eyes of ender to open the portal, then dive in.',
  params: {},
  async run(bot, a) {
    if (inEnd(bot)) return { ok: true, observation: 'already in the End' };
    // Get it HOME before anything can refuse the dive. The lift below the approach loop never ran: the
    // armour/quiver gates return first, and every refusal round let `roam` wander it further out -
    // 07:12 → 07:25 it went from -343,18 to -398,53 (190 blocks off an OPEN door) with `segmentMin` past 19
    // and no dive attempted at all. One disclosed /tp at the top of the step turns "walk 190 blocks over an
    // ocean in the wrong direction" into "stand at the portal". MC_ASSIST=0 never reaches this.
    if (process.env.MC_ASSIST !== '0') {
      try {
        const recH = require('../portalRecord').current();
        const pH = bot.entity && bot.entity.position;
        if (recH && recH.ringComplete && pH && Number.isFinite(pH.x)) {
          const distH = Math.hypot(pH.x - recH.x, pH.z - recH.z);
          if (distH > 150) {
            const cellH = recH.anchor && Number.isFinite(recH.anchor.x) ? recH.anchor : { x: recH.x, y: recH.y, z: recH.z };
            log.warn(`enter_end: OP LIFT home BEFORE any gate - ${Math.round(distH)} blocks off an open door (the refusal path is what walks it out), going to the room cell ${cellH.x},${cellH.y},${cellH.z}`);
            try { bot.chat(`/tp @s ${cellH.x + 0.5} ${cellH.y} ${cellH.z + 0.5}`); } catch {}
            await sleep(4000);
            const pA = bot.entity.position.floored();
            let fA = null, hA = null;
            try { fA = bot.blockAt(new Vec3(pA.x, pA.y, pA.z)); hA = bot.blockAt(new Vec3(pA.x, pA.y + 1, pA.z)); } catch {}
            if ((fA && fA.boundingBox !== 'none' && !/water|air/.test(fA.name)) || (hA && hA.boundingBox !== 'none' && !/water|air/.test(hA.name))) {
              log.warn(`enter_end: landed in ${fA ? fA.name : '?'}/${hA ? hA.name : '?'} at the room - stepping up one`);
              try { bot.chat(`/tp @s ${pA.x + 0.5} ${pA.y + 1} ${pA.z + 0.5}`); } catch {}
              await sleep(2000);
            }
          }
        }
      } catch (e) { log.warn(`enter_end: the home lift threw ${String(e.message).slice(0, 60)} - continuing on foot`); }
    }
    // Ammo is an ENTRY condition, not a fight condition. Arrows need a feather, chickens exist only in the
    // Overworld, and the End has no exit until the dragon dies - so arriving short means the trip ends in a
    // deliberate death. kill_dragon does try to restock in place, but that check can only fail here, which
    // is why the gate sits on the door instead. A bot already inside is never blocked: it fights or dies.
    let arrowHave = countItem(bot, 'arrow');
    // Make the arrows, don't promise them. The old test counted `makeable` and let the dive proceed on
    // arrows that were never crafted - measured 00:19 it cleared the gate as "18 arrows + 16 craftable"
    // and would have walked in holding 18. This is also the last place the recipe is even possible: the
    // End has no gravel for flint, no chicken for a feather and no tree for a stick.
    if (arrowHave < 32) {
      if (countItem(bot, 'flint') >= 1 && countItem(bot, 'feather') >= 1 && countItem(bot, 'stick') < 1) {
        const s = await capped(require('./primitives').craft(bot, 'stick', 4), 30000, 'craft sticks').catch(() => null);
        log.skill(`enter_end: making sticks for arrows -> stick=${countItem(bot, 'stick')} (${s && s.ok ? 'ok' : 'failed'})`);
      }
      const fl0 = countItem(bot, 'flint'), st0 = countItem(bot, 'stick'), fe0 = countItem(bot, 'feather');
      if (fl0 >= 1 && st0 >= 1 && fe0 >= 1) {
        // `craft(bot,item,n)` means "n IN TOTAL", not "n more" - it returns `already have <item> x<n>`
        // when the pack already holds n. Asking for the extra arrows is how this restock silently did
        // nothing at 18 arrows with 4 feathers in the pack.
        const extra = Math.min(64 - arrowHave, Math.min(fl0, st0, fe0) * 4);
        const r = await capped(require('./primitives').craft(bot, 'arrow', arrowHave + extra), 45000, 'craft arrows').catch(() => null);
        log.skill(`enter_end: arrow prep ${r && r.ok ? 'ok' : 'failed'} -> arrows=${countItem(bot, 'arrow')} (flint=${fl0} stick=${st0} feather=${fe0})`);
        arrowHave = countItem(bot, 'arrow');
      }
    }
    const flintHave = countItem(bot, 'flint'), stickHave = countItem(bot, 'stick'), featherHave = countItem(bot, 'feather');
    if (arrowHave < 32) {
      // Fail open on a counted stall, the same way the dive wrapper does for its own quiver gate: a bot
      // that has shot everything the pack can make is dressed, fed and standing at the door with 16 eyes,
      // and an endless refusal strands the whole run over ammo that no longer exists anywhere.
      bot._enterEndAmmoStall = arrowHave === (bot._enterEndAmmoLast || -1) ? (bot._enterEndAmmoStall || 0) + 1 : 0;
      bot._enterEndAmmoLast = arrowHave;
      // A waiver that still demands 12 arrows is not a waiver. The wrapper above releases on a counted
      // stall, and its own supplier (the `bow` errand) stops at 12 by design - one feather per chicken.
      // Measured 04:53: `arrows=8, feather=0` stood the run at the portal door for 201 attempts / 112
      // minutes of STAGE LOCK with nothing left in this part of the world to craft from, while the log
      // line one above it said "diving". So: three stalled rounds AND either the 12-arrow bar, or a pack
      // that provably cannot make another arrow - with a floor of 6, because an empty quiver is a
      // guaranteed walk back rather than a dive.
      const canCraftMore = flintHave >= 1 && stickHave >= 1 && featherHave >= 1;
      // The waiver floor must sit BELOW the bar it releases, or the escape hatch can never open: with both
      // at 6, a 3-arrow pack that cannot craft anything was refused forever (C2 caught it). One arrow is the
      // floor - an EMPTY quiver is still a guaranteed walk back rather than a dive.
      const starving = !canCraftMore && arrowHave >= 1;
      // The 12-arrow bar needs NO stall - 16 arrows is dressed. Requiring "12 AND three stalled rounds"
      // (this line until a minute ago) meant a pack that keeps manufacturing arrows resets its own counter
      // every round and can never dive: measured 05:04 -> 05:08 at arrows=16 then 19, `not diving into the
      // End with 16 arrows`, STAGE LOCK 210 attempts / 112 minutes. The counted waiver exists only for the
      // pack that cannot reach 12 at all (feather=0, no chicken in 117 blocks of roaming).
      if (!(arrowHave >= 6 || (starving && bot._enterEndAmmoStall >= 3))) {
        // The bar came down from 12 to 6 on 2026-11-05 because the way crystals actually die changed: the
        // sticky target + pillar sequence (3 arrows -> climb -> screened punch) dropped #39 at 03:30:46 and
        // #53 at 02:14 without a full quiver, and the perch is melee'd. At 12 this gate was the single
        // biggest source of lost ground - it sent the run hunting chickens and digging gravel, and at
        // 04:07-04:12 that is what put it 529 blocks from an OPEN door.
        return { ok: false, observation: `not diving with ${arrowHave} arrows (below 6; flint=${flintHave} stick=${stickHave} feather=${featherHave}): craft locally (1 flint + 1 stick + 1 feather = 4 arrows) or dig gravel within 32 - do NOT walk for a herd, and do NOT plan use_portal/farm_blaze/craft_eyes: the ring is complete and the ONLY move is enter_end at the remembered column` };
      }
      if (arrowHave < 12) log.warn(`enter_end: diving UNDER-QUIVERED with ${arrowHave} arrows after ${bot._enterEndAmmoStall} dead-end prep rounds (flint=${flintHave} stick=${stickHave} feather=${featherHave} canCraftMore=${canCraftMore}) - dig every caged crystal before you shoot, melee the perch, and treat this dive as a recon of which crystals are cageable`);
    } else bot._enterEndAmmoStall = 0;
    let frames = bot.findBlocks({ matching: blockIds(bot, ['end_portal_frame']), maxDistance: 24, count: 20 })
      .map(p => bot.blockAt(p)).filter(Boolean);
    if (!frames.length) {
      const rec3 = require('../portalRecord').distanceTo(bot);
      if (!rec3 || !Number.isFinite(rec3.dist)) {
        // `no room on file` was a LIE about the world model. At 21:43:37 the room WAS on file
        // (-216,15,1500, ringComplete:true) and this line still printed, because the bot's own x/z had gone
        // non-finite, so the distance is NaN and the record looked absent. The model then planned
        // `use_portal -> farm_blaze -> craft_eyes` - nine errands for a door that was standing open - and
        // Paper kicked for `invalid_player_movement` 100 s later. Name the real fault so the ladder stops
        // shopping for a new stronghold.
        const me = bot.entity && bot.entity.position;
        if (!me || !Number.isFinite(me.x) || !Number.isFinite(me.z)) {
          return { ok: false, observation: `MY OWN COORDINATES ARE UNREADABLE (pos=${me ? `${me.x},${me.y},${me.z}` : 'no entity'}) - the portal room IS on file at ${rec3 && rec3.x},${rec3 && rec3.y},${rec3 && rec3.z} and the ring state is unchanged: do NOT re-locate a stronghold, farm blaze rods or craft eyes. Nothing geo-based can run until the position is finite again; the bot reconnects itself for the server's coordinates` };
        }
        return { ok: false, observation: 'no end_portal_frame in range and no room on file (dig to the portal room)' };
      }
      // Walk the route instead of recommending it. At 18:51 the plan was `deep_shaft {toY:15}` twice while
      // standing at -285,61,1516 - 75 blocks from the room and in a flooded column - because "dig there"
      // reads to the planner as "dig where I am", and a shaft at the wrong column is a shaft that finds
      // nothing. A player walks to the door column first, then goes down.
      if (rec3.dist > 16) {
        // A long swim back to an open door is not a progression step. At 04:12 the bot stood 529 blocks away
        // - it had been pushed out there by the bow errand (gravel for flint, chickens for feathers) with
        // 7 arrows and no armour, and the walk/swim home was 21+ minutes into the enter_end stall the
        // operator asked me to break. Same disclosure as the pool hop and the obsidian platform: an OP lift,
        // never on MC_ASSIST=0, and it targets the cell the bot has ALREADY stood on in the room.
        if (rec3.dist > 150 && process.env.MC_ASSIST !== '0') {
          const cell = rec3.anchor && Number.isFinite(rec3.anchor.x) ? rec3.anchor : { x: rec3.x, y: rec3.y, z: rec3.z };
          try { bot.chat(`/tp @s ${cell.x + 0.5} ${cell.y} ${cell.z + 0.5}`); } catch {}
          await sleep(4000);
          const p = bot.entity.position.floored();
          const gained = rec3.dist - Math.round(Math.hypot(p.x - rec3.x, p.z - rec3.z));
          let feet = null;
          try { feet = bot.blockAt(new Vec3(p.x, p.y, p.z)); } catch {}
          log.warn(`enter_end: OP LIFT home to the open door (disclosed, not walked): ${rec3.dist} -> ${Math.round(Math.hypot(p.x - rec3.x, p.z - rec3.z))} blocks (cell ${p.x},${p.y},${p.z}, feet=${feet ? feet.name : 'NULL'}, gained ${gained})`);
          if (feet && feet.boundingBox === 'block' && !/air/.test(feet.name)) {
            log.warn(`enter_end: landed inside ${feet.name} - digging out before anything else`);
            try { await equipPick(bot); await bot.dig(feet); } catch {}
          }
        }
        log.warn(`enter_end: room is ${rec3.dist} blocks off at ${rec3.x},${rec3.y},${rec3.z} - walking to that column before any digging`);
        // `rec3.ringComplete` is the sentence that stops the hallucinated errand: with 3 eyes in the pack
        // and a long walk left, four rounds in a row planned `build_nether_portal -> farm_blaze ->
        // farm_pearl` on the theory that the portal still needed eyes. It does not - the twelfth eye went
        // in at 19:24:49 and the door has been standing open since.
        const ringFact = rec3.ringComplete
          ? 'THE RING IS ALREADY COMPLETE and the portal is open - the eyes in the pack are spare, so do NOT build a Nether portal, farm blaze rods or hunt pearls; WALK TO THE ROOM AND STEP INTO THE PORTAL'
          : 'fill the ring with eyes of ender once there';
        // Below y=58 the bot is inside the deepslate layer, where pathfinder has no route to give it -
        // that is a digging problem, not a routing problem (see tunnel_to). Above it the air is open and
        // walking is several times faster than cutting 200 blocks of rock, so the two stay separate.
        const underground = bot.entity.position.floored().y < 58;
        // Approach until it is AT the column, inside this one call. The reason is measured, not theoretical:
        // with the gate open since 22:19, the model planned `grid_craft leather_boots` - a recipe this project
        // does not even define (`no recipe for leather_boots in src/gridcraft.js`) - plus `hunt_spider`/
        // `harvest_kelp` for a third edible between every approach leg, and each errand walked it from 22 to
        // 45 to 61 blocks away from an OPEN portal. Twenty-nine minutes of that, with armour on and 26 arrows.
        // So the approach, the descent and the step-in belong to enter_end, not to the planner.
        let w = null;
        // The reserve is 20 s, not 90 s, and the FIRST leg always runs. The regression suite caught what the
        // 90 s reservation did on a short plan window (55 s phases are normal here): `deadline - 90000` lands
        // in the past, the loop broke at k=0, and this step reported "approach budget used" WITHOUT taking a
        // single step - the exact "walk cut short" behaviour the loop was written to remove.
        const leftMs = bot._stepDeadline ? bot._stepDeadline - Date.now() : 150000;
        const apprMs = Math.max(0, Math.min(150000, (Number.isFinite(leftMs) ? leftMs : 150000) - 20000));
        const apprEnd = Date.now() + apprMs;
        for (let k = 0; k < 8; k++) {
          const cur = require('../portalRecord').distanceTo(bot);
          if (!cur || !Number.isFinite(cur.dist) || cur.dist <= 16) break;
          if (k > 0 && Date.now() >= apprEnd) { w = { observation: `approach budget used, ${Math.round(cur.dist)} blocks off` }; break; }
          const under2 = bot.entity.position.floored().y < 58;
          w = await capped(under2
            ? reg.get('tunnel_to').run(bot, { x: rec3.x, z: rec3.z, tolerance: 6 })
            : reg.get('walk_to').run(bot, { x: rec3.x, y: rec3.y + 1, z: rec3.z, tolerance: 6 }), 65000,
            `${under2 ? 'tunnel' : 'walk'} approach leg ${k + 1} (${Math.round(cur.dist)} off)`).catch(() => null);
        }
        const near = require('../portalRecord').distanceTo(bot);
        // Do not hand the last 16 blocks back to the model. Live 22:36-22:43: the gate was OPEN (it printed
        // `diving on 2 edible item(s)` and worn=2/4 satisfies the two-piece rule), and every round the model
        // invented a new prerequisite - `Worn is 2/4 (need 3/4): 4 leather makes boots`, `kelp a 3rd edible` -
        // and the `grid_craft`/`harvest_kelp` errands walked it 22 -> 45 -> 61 -> 22 blocks from a portal it
        // could stand and enter. So: when the walk lands it on the column, descend in THIS call.
        if (near && Number.isFinite(near.dist) && near.dist <= 16) {
          log.warn(`enter_end: arrived at the room column (${near.dist} blocks off, y=${bot.entity.position.floored().y}) - descending in this step; the dive gate is already open (meter=${bot.food}, arrows=${countItem(bot, 'arrow')}) - no armour errand and no food gather from here`);
        } else {
          return { ok: false, observation: `${underground ? 'cut a corridor' : 'walked'} toward the remembered room (${String(w && w.observation || 'trip cut short').slice(0, 70)}) - now ${near && near.dist} blocks off at ${rec3.x},${rec3.y},${rec3.z}: ${ringFact}. THE DIVE GATE IS OPEN (hunger meter=${bot.food}/20, arrows=${countItem(bot, 'arrow')}): the ONLY remaining step is ${underground ? `tunnel_to {x:${rec3.x},z:${rec3.z},tolerance:6}` : `walk_to {x:${rec3.x},y:${rec3.y + 1},z:${rec3.z}`} from this cell, then call enter_end again - it descends to y=${rec3.y} and steps into the pool by itself. Crafting a third armour piece, gathering kelp or fishing is NOT a gate any more and each such round costs the dive its window` };
        }
      }
      let climbedUp = false;
      const belowY = bot.entity.position.floored().y;
      if (belowY < rec3.y - 1) {
        climbedUp = true;
        // Below the door floor, digging is the wrong verb. Live 17:41 it stood at y=12 with the pool at 15
        // and 18:57 at y=7 - `deep_shaft {toY:15}` opened the floor out from under it and dropped it
        // further under the room, then it hauled itself ~50 blocks back to the surface. Three of those
        // oscillations tonight, ~10 minutes each, with the ring already complete.
        log.warn(`enter_end: at the room column but ${rec3.y - belowY} blocks BELOW the pool floor (y=${belowY}, room y=${rec3.y}) - climbing up to the door instead of sinking`);
        const upTo = Math.min(120, rec3.y + 1);
        const cr = await capped(climbOut(bot, upTo), 120000, 'climb to the portal floor').catch(() => null);
        const nowY = bot.entity.position.floored().y;
        const near = require('../portalRecord').distanceTo(bot);
        const foundUp = bot.findBlocks({ matching: blockIds(bot, ['end_portal_frame']), maxDistance: 24, count: 20 })
          .map(p => bot.blockAt(p)).filter(Boolean);
        if (foundUp.length) {
          frames = foundUp;
          log.warn(`enter_end: after climbing to y=${nowY} the ring is in sight (${frames.length} frames) - filling and stepping in from here`);
        } else {
          return { ok: false, observation: `climbed from y=${belowY} toward the pool floor (now y=${nowY}, ${String((cr && cr.observation) || 'no climb result').slice(0, 70)}) - ${near && near.dist} blocks off the room at ${rec3.x},${rec3.y},${rec3.z}; call enter_end again, and do NOT dig down: the door is ABOVE this cell` };
        }
      } else {
        log.warn(`enter_end: at the room column (${rec3.dist} blocks off) - sinking to y=${rec3.y}`);
      }
      // Same budget buy as the platform drop below: the walk to the column arrives with the step spent,
      // and a zero-iteration `deep_shaft` is a round that changes nothing (four of those at 07:49-07:52).
      let ds = null;
      if (!climbedUp) {
        const dlS = bot._stepDeadline;
        if (Number.isFinite(dlS) && dlS - Date.now() < 30000) {
          bot._stepDeadline = Date.now() + 110000;
          log.warn(`enter_end: ${Math.round((dlS - Date.now()) / 1000)}s of step left - buying the descent 110s of its own`);
        }
        ds = await capped(reg.get('deep_shaft').run(bot, { toY: rec3.y, max: 20 }), 120000, 'shaft to the portal room').catch(() => null);
        bot._stepDeadline = dlS;
      }
      const again = bot.findBlocks({ matching: blockIds(bot, ['end_portal_frame']), maxDistance: 24, count: 20 })
        .map(p => bot.blockAt(p)).filter(Boolean);
      if (again.length) {
        // Do NOT return here. This branch used to answer `ok: true, found end_portal_frame` and stop,
        // which the ladder read as "step succeeded, milestone still false" and re-ran from the top -
        // 00:03:03 and 00:07:09 both logged exactly that, and the open portal stayed unsired for half
        // an hour. Hand the frames to the eye-filling and walk-in code below instead.
        frames = again;
        log.warn(`enter_end: ${frames.length} frames now in range after the descent - filling the ring and stepping in from here`);
      } else {
        return { ok: false, observation: `digging at the remembered room column ${rec3.x},${rec3.z} (was ${rec3.dist} blocks off): ${String(ds && ds.observation || 'shaft cut short').slice(0, 90)} - call enter_end again to keep descending toward y=${rec3.y}` };
      }
    }
    require('../portalRecord').remember(frames[0].position);
    // Pin the respawn INSIDE the portal room, one step from the open pool. The dive gate's own words are
    // "a death in the End costs the entire trip", and with the anchor on the surface bed that is arithmetic:
    // every one of tonight's 12 deaths put it at (-241,65,1520) - 45 blocks of deepslate ABOVE the door - and
    // it re-dug that shaft for ~20 minutes per attempt. Its own standing cell is the safest possible anchor
    // (solid room floor, ring in sight), and the same disclosure policy as the bed anchor applies:
    // MC_ASSIST=0 never sends the command.
    try {
      if (process.env.MC_ASSIST !== '0' && !bot._roomAnchorDone) {
        const st = bot.entity.position.floored();
        // "Inside the room" is a measurable thing, not a hope: the frames were found in range while the bot
        // was still 15 levels ABOVE them (the record on file says anchor y=30 against a room at y=15), and
        // the pin plus its own log line claimed a room anchor anyway. Every dive then started from a shaft
        // wall instead of the pool edge, so the claim has to be earned by the geometry before it is written.
        const rec0 = require('../portalRecord').current();
        const inRoom = !!(rec0 && Math.abs(st.y - rec0.y) <= 4
          && Math.hypot(st.x - rec0.x, st.z - rec0.z) <= 16);
        if (!inRoom) {
          log.warn(`enter_end: OP ANCHOR skipped - standing at ${st.x},${st.y},${st.z} but the room floor is recorded at ${rec0 ? `${rec0.x},${rec0.y},${rec0.z}` : 'unknown'}, so this cell is a shaft wall, not the portal edge`);
        } else {
          bot.chat(`/spawnpoint @s ${st.x} ${st.y} ${st.z}`);
          await sleep(1000);
          bot._roomAnchorDone = true;
          try { require('../portalRecord').rememberAnchor(st); } catch {}
          log.warn(`enter_end: OP ANCHOR (disclosed, not autonomous): /spawnpoint pinned INSIDE the portal room at ${st.x},${st.y},${st.z} - a death in the End now costs one step back to the pool instead of a 45-block re-dig`);
        }
      }
    } catch (e) { log.warn(`enter_end: room anchor threw ${String(e.message).slice(0, 60)}`); }
    // A bed at the door is the difference between "respawn at world spawn and re-pay the whole trip"
    // and "respawn three blocks from the portal". `onlyIfReady` is what makes this safe to attempt
    // standing in a cave: it refuses instantly when the wool and planks are not already carryable from
    // this pack, so a missing bed can never turn into a sheep hunt at y=34, and can never become a new
    // reason to refuse the dive either.
    try {
      const fb = await reg.get('forward_base').run(bot, { onlyIfReady: true, radius: 40 });
      log.skill(`enter_end: bed at the portal room ${fb.ok ? 'SET' : 'not set'} - ${String(fb.observation).slice(0, 120)}`);
    } catch (e) { log.warn(`enter_end: forward_base threw ${e.message}`); }
    let filled = 0;
    for (const fr of frames) {
      let hasEye = false;
      try { hasEye = !!(fr.getProperties && fr.getProperties().eye); } catch {}
      if (hasEye) { filled++; continue; }
      const eye = bot.inventory.items().find(i => i.name === 'ender_eye');
      if (!eye) break;
      await capped(bot.pathfinder.goto(new (GN())(fr.position.x, fr.position.y, fr.position.z, 1)), 12000, 'goto frame').catch(() => {});
      await capped(bot.equip(eye, 'hand'), 4000, 'equip eye');
      if (!bot.heldItem || bot.heldItem.name !== 'ender_eye') {
        log.warn(`enter_end: the hand holds ${bot.heldItem ? bot.heldItem.name : 'nothing'}, not an ender_eye - leaving this frame for the next round`);
        continue;
      }
      // An eye does not PLACE a block - it flips the frame's own `eye` state. `placeBlock` verifies its
      // work by waiting for a block to appear at the target cell, and for an eye that cell is air, so
      // the interaction that DID land was reported as a refusal: 17:53:48-17:54:02 logged ten
      // `Server refused to place ender_eye at (-216,16,1499): the block is still cave_air` while nine
      // frames already had their eyes. Ask the way a player does - look at the frame, use the held item -
      // and verify on the frame itself, with the old route only as the fallback.
      await capped(bot.lookAt(fr.position.offset(0.5, 0.85, 0.5), true), 3000, 'look at frame').catch(() => {});
      let used = 'timeout';
      try { used = (await capped(bot.activateItem(), 4000, 'use eye on frame')) === null ? 'threw/timeout' : 'ok'; } catch (e) { used = `threw ${e.message}`; }
      const frameState = () => {
        const b = bot.blockAt(fr.position);
        let on = false;
        try { on = !!(b && b.getProperties && b.getProperties().eye); } catch {}
        return on;
      };
      let eyeNow = frameState();
      if (!eyeNow) {
        const res = await capped(bot.placeBlock(fr, new Vec3(0, 1, 0)), 5000, 'place eye in frame').catch(() => null);
        eyeNow = frameState();
        if (!eyeNow) log.warn(`enter_end: eye NOT set at ${fr.position.x},${fr.position.y},${fr.position.z} (useItem=${used}, placeBlock=${res === undefined ? 'timeout' : 'returned'})`);
      }
      // Verify with the block's own `eye` property. The old test was `res !== null`, which is true even
      // when the server ignored the interaction, so enter_end could report 12/12 frames set while the
      // portal stayed shut - the same "ok is not completion" class as the craft() false successes.
      if (eyeNow) filled++;
    }
    log.info(`enter_end: ${filled}/${frames.length} frames eyes set`);
    if (filled >= 12) require('../portalRecord').markRingComplete();
    // "all the frames I can see are filled" is not "the portal is open". Standing at y=31 over a room
    // whose floor is y=15, the 24-block scan returns eight frames, eight eyes go in, and the ring is
    // still four short - which is exactly what happened at 20:00:01 (`eyes set 8/8; portal=not found`).
    // The recorded room floor is the only thing that says how much further down the rest of the ring is.
    if (frames.length < 12) {
      const rec4 = require('../portalRecord').distanceTo(bot);
      if (rec4 && Number.isFinite(rec4.dy) && Math.abs(rec4.dy) > 5) {
        log.warn(`enter_end: only ${frames.length} of 12 frames are in range and the recorded room floor is ${rec4.dy} blocks away in Y - sinking to it`);
        const ds2 = await capped(reg.get('deep_shaft').run(bot, { toY: rec4.y, max: 20 }), 120000, 'shaft to the rest of the ring').catch(() => null);
        return { ok: false, observation: `only ${frames.length}/12 frames reachable from y=${Math.round(bot.entity.position.y)}; sank toward the recorded floor y=${rec4.y} (${String(ds2 && ds2.observation || 'shaft cut short').slice(0, 80)}) - the rest of the ring, and the portal, are down there` };
      }
    }
    // The pool sits ON the room floor. At 04:08:42 the ring read 12/12 and the verdict was still
    // `portal=not found`, because the bot hung at y=33 - eighteen blocks above the water it was
    // searching for, outside any radius that would find it. A player drops onto the platform first.
    const ringY = frames[0] ? frames[0].position.y : null;
    if (ringY !== null && bot.entity.position.y > ringY + 2) {
      log.warn(`enter_end: the ring is at y=${ringY} and the bot is at y=${Math.round(bot.entity.position.y)} - dropping onto the platform before looking for the pool`);
      // The walk to the column consumes the whole step budget, and `deep_shaft` obeys `_stepDeadline`, so
      // the descent ran ZERO iterations four rounds in a row (07:49:26 / 07:49:41 / 07:51:51 / 07:52:32,
      // each `dug 0, stepped down 0, stuck 0, now Y=31`) while the bot stood on the lid of a lit portal.
      // This is the one moment worth buying its own clock for; the deadline is restored right after.
      const dl0 = bot._stepDeadline;
      if (Number.isFinite(dl0) && dl0 - Date.now() < 30000) {
        bot._stepDeadline = Date.now() + 110000;
        log.warn(`enter_end: the step had ${Math.round((dl0 - Date.now()) / 1000)}s left - buying the descent 110s of its own (last 16 blocks before the End)`);
      }
      const ds3 = await capped(reg.get('deep_shaft').run(bot, { toY: ringY, max: 20 }), 120000, 'shaft onto the portal platform').catch(() => null);
      bot._stepDeadline = dl0;
      if (bot.entity.position.y > ringY + 2) {
        return { ok: false, observation: `ring is complete (12/12) but the bot is still ${Math.round(bot.entity.position.y - ringY)} blocks above the platform: ${String(ds3 && ds3.observation || 'shaft cut short').slice(0, 90)} - call enter_end again to finish the drop and step into the pool` };
      }
    }
    const fromDim = bot.game && bot.game.dimension;
    // The portal opens in the middle of the ring once the 12th eye goes in. Walking into it
    // needs persistence: pathfinder treats the 3x3 hole as something to avoid.
    let portal = null;
    for (let i = 0; i < 6 && (bot.game && bot.game.dimension) === fromDim && Date.now() < (bot._stepDeadline || Infinity); i++) {
      portal = bot.findBlock({ matching: blockIds(bot, ['end_portal', 'end_gateway']), maxDistance: 24 });
      if (portal) {
        // Pathfinder treats the 3x3 portal as something to route AROUND, so `goto` can never deliver the
        // bot into it: measured 19:24:18 and 19:25:28, 12/12 eyes set, `portal=found`, and
        // `step into end portal timed out (8000ms)` between the two identical verdicts. A player does not
        // request a path here - they look at the pool and walk. `stepOnto` is this project's causeway
        // primitive for exactly that (physics, not routing: the pathfinder prices a reachable cell as
        // impassable when the block was laid by the bot), and the look-at + forward + jump is what
        // crosses the last cell and trips the dimension change.
        await capped(P.stepOnto(bot, portal.position), 6000, 'walk onto the portal cell').catch(() => {});
        try {
          await bot.lookAt(new Vec3(portal.position.x + 0.5, portal.position.y + 0.1, portal.position.z + 0.5), true);
          bot.setControlState('forward', true);
          bot.setControlState('jump', true);
          await sleep(1200);
          bot.setControlState('jump', false);
          await sleep(900);
          bot.setControlState('forward', false);
        } catch {}
      } else {
        await sleep(1500);
      }
      await sleep(3000);
    }
    if (portal && (bot.game && bot.game.dimension) === fromDim && process.env.MC_ASSIST !== '0') {
      // Six rounds of walking did not cross it. Same disclosure rule as the stronghold-column hop: this
      // is an assisted lift, not autonomous movement, and the acceptance instance (MC_ASSIST=0) never
      // reaches this line - it has to walk in or stay in the Overworld.
      // The FEET have to be inside the portal block. `/tp ... ${y + 1}` parked the bot standing on top of
      // the water surface, which is exactly why 03:03:43 read `portal=found; dim overworld -> overworld`
      // with 12/12 eyes set. Two targets, because a `findBlocks` hit can be an edge cell of the 5x5
      // surface: the found cell first, then the centroid of the ring (the pool's own middle).
      const lifts = [[portal.position.x + 0.5, portal.position.y + 0.05, portal.position.z + 0.5]];
      try {
        const ring = bot.findBlocks({ matching: blockIds(bot, ['end_portal_frame']), maxDistance: 24, count: 12 });
        if (ring && ring.length >= 3) {
          let sx = 0, sz = 0;
          for (const p of ring) { sx += p.x; sz += p.z; }
          lifts.push([sx / ring.length + 0.5, portal.position.y + 0.05, sz / ring.length + 0.5]);
        }
      } catch {}
      for (const c of lifts) {
        if ((bot.game && bot.game.dimension) !== fromDim) break;
        try { bot.chat(`/tp @s ${c[0].toFixed(2)} ${c[1].toFixed(2)} ${c[2].toFixed(2)}`); } catch {}
        await sleep(5000);
      }
      await sleep(5000);
      log.warn(`enter_end: OP LIFT into the end portal (not autonomous movement - disclose it): /tp feet-into the portal cell at ${portal.position.x},${portal.position.y},${portal.position.z} (ring centroid tried too) after six walked attempts left dim=${bot.game && bot.game.dimension}`);
    }
    const dim = bot.game && bot.game.dimension;
    return { ok: dim !== fromDim, observation: `eyes set ${filled}/${frames.length}; portal=${portal ? 'found' : 'not found'}; dim ${fromDim} -> ${dim}` };
  },
});
// The End kills bots with geography, not mobs: one step backwards while strafing and it is in
// the void (measured: DIED at y=-189, respawned in the Overworld and lost the fight). Keep a
// last-known-safe footing and never path into the void.
// The End pays for its own scaffolding. A pillar climb spends one paving block per level and the pack
// arrives empty because `tidy` trims the rock stacks to 8 minutes before the dive that needs them, while
// the island is end stone and there is nothing on it a bot would rather keep. Mine the wall BESIDE the
// bot: never the cell it stands in, never the cell under its feet, never the outermost shell of the rim
// (a cell only counts as quarry when the block further out from it is solid too), and head level comes
// first because digging there cannot pull the floor out from under it.
async function refuelFiller(bot, want) {
  const have = () => { try { return P.cheapFillTotal(bot); } catch { return 0; } };
  const slots = () => { try { return typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 1; } catch { return 0; } };
  if (have() >= want) return { ok: true, have: have(), mined: 0 };
  // End stone drops nothing to a bare hand, and the picks arrive in the End already worn out. Ask the pick
  // shop first: the pack normally carries the 3 cobble + 2 sticks a stone pick costs, and a table can be
  // crafted from the planks it carries too.
  if (P.usablePickCount(bot) === 0) {
    log.warn(`refuelFiller: no usable pick for the quarry - asking ensure_tools before digging end stone`);
    try { await reg.get('ensure_tools').run(bot, {}); } catch (e) { log.warn(`refuelFiller: ensure_tools threw ${String(e.message).slice(0, 70)}`); }
    if (P.usablePickCount(bot) === 0) return { ok: false, have: have(), mined: 0 };
  }
  const QUARRY = /^(end_stone|end_bricks|cobblestone|stone_bricks|smooth_stone|mossy_cobblestone|diorite|andesite|granite|tuff|blackstone|basalt)$/;
  const SHELL = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [-2, 0], [0, 2], [0, -2]];
  let mined = 0, dry = 0;
  while (have() < want && mined < want + 8 && dry < 4 && bot.entity.position && Date.now() < (bot._stepDeadline || Infinity)) {
    const f = bot.entity.position.floored();
    let target = null;
    for (const dy of [1, 0]) {
      for (const [dx, dz] of SHELL) {
        const c = new Vec3(f.x + dx, f.y + dy, f.z + dz);
        const b = bot.blockAt(c);
        if (!b || b.boundingBox !== 'block' || !QUARRY.test(b.name)) continue;
        const below = bot.blockAt(new Vec3(c.x, c.y - 1, c.z));
        if (!below || below.boundingBox !== 'block') continue;
        const outward = bot.blockAt(new Vec3(c.x + Math.sign(dx), c.y, c.z + Math.sign(dz)));
        if (!outward || outward.boundingBox !== 'block') continue;   // rim shell: leaving it keeps the footing
        target = b; break;
      }
      if (target) break;
    }
    if (!target) { dry++; await sleep(500); continue; }
    try {
      if (!(await equipBulkPick(bot, false))) await equipPick(bot);
      const dug = await capped(bot.dig(target), 15000, `mine ${target.name} for paving`).catch(() => null);
      if (dug === null) dry++;
      else mined++;
    } catch { dry++; }
    if (slots() <= 0) { log.warn(`refuelFiller: the pack has no free slot after ${mined} block(s) - stopping the quarry here`); break; }
    await sleep(80);
  }
  // The End has no cobblestone, no dirt and no gravel: the paving the screens and the pillar steps are
  // built from comes ONLY from the island shell, and at 10:23:09-10:23:28 the disclosed foothold put the
  // bot 2.0 blocks from crystal #49 with `filler=0` in the pack, so the 2-high blast screen could not be
  // placed and the dive gave up on a crystal it was already standing next to. The island quarry is tried
  // first (the loop above); this is the operator's rule for what the island cannot supply.
  if (have() < want && process.env.MC_ASSIST !== '0') {
    bot._opFiller = (bot._opFiller || 0);
    if (bot._opFiller < 3) {
      bot._opFiller++;
      await freeOneSlot(bot, 'the blast screens and the pillar steps are built from carried stone');
      try { bot.chat('/give @s cobblestone 64'); } catch {}
      await sleep(900);
      if (have() >= 64) log.warn(`OP PAVING (disclosed, ${bot._opFiller}/3 this dive): /give @s cobblestone 64 - the island cannot make the screens, and a foothold with no blocks in hand is a wasted lift`);
      else log.warn(`OP PAVING: the /give did not land (pack reads ${have()} placeable, free slots ${slots()}) - the screen stays unbuilt`);
    }
  }
  return { ok: have() >= want, have: have(), mined };
}

// The counter to an enderman that does not need aim, arrows, or winning a teleport race: water. An
// enderman standing in a source takes damage every tick and blinks away, and the island has no water of
// its own, so the one bucket in the pack IS the defense. Three of the last four End deaths read
// `slain by Enderman` with the retreat already logged (00:44:01 hp=6, 00:47:41 right after
// `still 3 blocks from an enderman after the retreat`), because hopping 6 cells loses to a mob that
// teleports and the sword swing is what provokes it in the first place.
// 末影人高 3 格。玩家/bot 只有 1.8 格，所以在自己头顶上方第 2 格(净空 2 格)铺一片"屋顶"，末影人就
// 站不进来也打不到我，而我自己照样能挥到它(它把头伸到 2 格口就够)。15:00-15:10 现场：在柱顶被末影人
// 连打到死(endDeaths=47)，水桶是唯一的非接触反制，但桶一空就只能"后退 13 格然后还在 2.7 格"。
// 屋顶要盖住自己和四条来路，只盖脚下一格的话它会从旁边站进来。
async function placeRoofCell(bot, x, y, z) {
  const solid = (b) => !!b && (b.boundingBox === 'block' || b.boundingBox === 'collision');
  const read = (px, py, pz) => { try { return bot.blockAt(new Vec3(px, py, pz)); } catch { return null; } };
  if (solid(read(x, y, z))) return true;                      // 已经是屋顶的一部分
  // 只准用建材：15:50:46 现场 `Server refused to place cooked_beef at (-17, 63, 26)` —— P.cheapFill 在背包
  // 快满时会把熟牛肉当"可放置物"交出来，而 1.21 的牛肉确实能放（这正是可放置物品选材陷阱那一类）。
  const BUILD = /^(cobblestone|cobbled_deepslate|stone|smooth_stone|stone_bricks|mossy_stone_bricks|end_stone|end_bricks|diorite|andesite|granite|tuff|blackstone|basalt|deepslate|dirt|sand|gravel|nether_bricks)$/;
  const it = bot.inventory.items().find(i => BUILD.test(i.name) && i.count >= 1);
  if (it) {
    for (const [dx, dy, dz] of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
      const ref = read(x + dx, y + dy, z + dz);
      if (!solid(ref)) continue;                              // 背包放置必须有邻接面
      try {
        await bot.equip(it, 'hand');
        await capped(bot.placeBlock(ref, new Vec3(-dx, -dy, -dz)), 4000, 'place the shelter roof').catch(() => null);
      } catch { break; }
      if (solid(read(x, y, z))) return true;
    }
  }
  if (process.env.MC_ASSIST !== '0') {
    // 黑曜石柱顶往往只有侧面一个面，放不下的格子用指令补：这是"缺物资就开指令拿"的同一条规则。
    try { bot.chat(`/setblock ${x} ${y} ${z} minecraft:cobblestone`); } catch { return false; }
    await sleep(700);
    if (solid(read(x, y, z))) { log.warn(`shelter: /setblock cobblestone at ${x},${y},${z} (disclosed) - the pack had no face to build from`); return true; }  }
  return false;
}

async function endermanShelter(bot, why) {
  const f = bot.entity.position.floored();
  // The cap is per SPOT, not per dive: 15:26:39-15:26:41 printed `6 attempts made no roof here` three
  // times in 2 seconds for three different endermen, but what had actually run out was the call counter,
  // not the terrain - the same function had roofed 5/5 cells a minute earlier. Move somewhere new and the
  // attempt budget moves with it.
  const spot = `${f.x},${f.y},${f.z}`;
  if (bot._shelterSpot !== spot) { bot._shelterSpot = spot; bot._shelterRounds = 0; }
  bot._shelterRounds = (bot._shelterRounds || 0) + 1;
  if (bot._shelterRounds > 3) { log.warn(`shelter: this cell (${spot}) has already refused the roof ${bot._shelterRounds - 1} times - not grinding it`); return false; }
  let laid = 0;
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    if (await placeRoofCell(bot, f.x + dx, f.y + 2, f.z + dz)) laid++;
  }
  const roofed = laid >= 3;
  log.warn(`kill_dragon: enderman shelter ${roofed ? `BUILT (${laid}/5 cells roofed at y=${f.y + 2})` : `incomplete (${laid}/5)`} - ${why}`);
  return roofed;
}

// 眼睛规则：末影人是"对视就敌对"的，而 mineflayer 的 lookAt(实体中心) 正好每次都扫到它的脸。
// 把准星改落到它踩的那格方块的顶面：泼水仍然落进它脚下那格，挥剑靠服务器自己的射程判定，
// 而玩家视角上我至始至终看的是地面。
async function lookAtItsFloor(bot, e) {
  const f = e.position.floored();
  try { await bot.lookAt(new Vec3(f.x + 0.5, f.y + 0.05, f.z + 0.5), true); } catch {}
}

async function wetTheEnderman(bot, mangler) {
  let items = [];
  try { items = bot.inventory.items(); } catch { return { wet: false }; }
  let full = items.find(i => i.name === 'water_bucket');
  if (!full) {
    // The island has no water, so a used-up bucket is not a resource problem the End can solve - it is the
    // enderman counter going offline. Live at 10:01: `could not wet enderman #168315 at 1.4 blocks (no full
    // bucket in the pack)` twice in seven seconds while the bot "backed off 13 cells" and stayed 2 blocks
    // away: with no water the dive spends every round on distance and never fires at a crystal.
    // The operator's rule for this run is "缺物资就自己开指令拿", and a bucket is the cheapest such item.
    if (process.env.MC_ASSIST !== '0') {
      bot._opBuckets = (bot._opBuckets || 0);
      // A grant is only worth its slot while the pack does not already hold the same thing. Every pour
      // turns `water_bucket` into `bucket` (non-stackable, one slot each) and the End cannot refill it, so
      // six grants per dive over four dives is what left 19 buckets in a 36-slot pack at 12:03-12:16 and
      // stopped the dive before it started. Two buckets - one full, one empty - is the whole working set.
      // The guard is about the WATER, not the metal: two EMPTY buckets are exactly the state that needs a
      // grant. Counting both names is what made the dive refuse its own counter at 13:07:46 and then spend
      // every round on "still 0.9 blocks from an enderman after the retreat".
      const heldFull = items.filter(i => i.name === 'water_bucket').length;
      const heldEmpty = items.filter(i => i.name === 'bucket');
      const heldAny = heldFull + heldEmpty.length;
      if (heldFull >= 1) {
        log.warn(`OP BUCKET skipped - a full water_bucket is already in the pack (${heldAny} bucket(s) total)`);
      } else if (heldEmpty.length > 1) {
        // The corpses of the last counter must not veto the next one. Live 14:06:07-14:06:08: four EMPTY
        // buckets in the pack, no water, and the dive fell back to `the sword/retreat` against endermen that
        // teleport into the bot's own cell - so the surplus empties are thrown away (kept one for scooping)
        // and the grant is retried on the freed slot.
        const keep = heldEmpty[0];
        let dropped = 0;
        for (const e of heldEmpty.slice(1)) {
          if (bot.heldItem && bot.heldItem.slot === e.slot) continue;
          try { await bot.tossStack(e); } catch { break; }
          dropped++;
        }
        log.warn(`OP BUCKET: ${dropped} empty bucket(s) tossed to make room for water (one kept for scooping) - an empty bucket is the previous counter, not a reason to fight endermen bare-handed`);
        if (bot._opBuckets < 6) {
          bot._opBuckets++;
          try { bot.chat('/give @s water_bucket 1'); } catch {}
          await sleep(1200);
          try { items = bot.inventory.items(); } catch { items = []; }
          const now = items.find(i => i.name === 'water_bucket');
          if (now) { full = now; log.warn(`OP BUCKET (disclosed, ${bot._opBuckets}/6 this dive): /give @s water_bucket 1 after clearing ${dropped} duplicate(s) - the End has no water to scoop`); }
          else log.warn('OP BUCKET: still nothing in the hand after clearing the pack - falling back to the sword/retreat');
        }
      } else if (bot._opBuckets < 6) {
        bot._opBuckets++;
        await freeOneSlot(bot, 'a water bucket is the only enderman counter and the pack is full');
        try { bot.chat('/give @s water_bucket 1'); } catch {}
        await sleep(900);
        try { items = bot.inventory.items(); } catch { items = []; }
        full = items.find(i => i.name === 'water_bucket');
        if (full) log.warn(`OP BUCKET (disclosed, ${bot._opBuckets}/6 this dive): /give @s water_bucket 1 - the End has no water to scoop, and an empty bucket is what ended the last four dives`);
        else {
          // The first give bounced. Buy the slot from the pack unconditionally (the client's own slot
          // count is what lied) and try once more - 11:57:38-11:58:23 spent 45 s of a dive re-logging this
          // failure without ever asking why.
          await freeOneSlot(bot, 'the water bucket give just bounced', true);
          try { bot.chat('/give @s water_bucket 1'); } catch {}
          await sleep(1000);
          try { items = bot.inventory.items(); } catch { items = []; }
          full = items.find(i => i.name === 'water_bucket');
          if (full) log.warn(`OP BUCKET (disclosed, retry with a bought slot): water_bucket is in the hand - ${bot._opBuckets}/6 this dive`);
          else log.warn('OP BUCKET: the /give still did not land after jettisoning - falling back to the sword/retreat');
        }
      } else {
        log.warn('OP BUCKET cap reached (6 this dive) - a refill every round is not a fight, it is a loop');
      }
    }
  }
  if (!full) return { wet: false, why: 'no full bucket in the pack' };
  const f = mangler.position.floored();
  const c = { x: f.x, y: f.y, z: f.z };
  // Live 02:11:02 and 02:11:11: `could not wet enderman #75814 at 0.4 blocks (the server kept air in
  // 12,58,32)` - 0.4 blocks means it is in the bot's OWN cell, and a source will not be placed around a
  // standing player. Trying the same placement every round is noise, not a plan: give ground instead.
  const bf = bot.entity.position.floored();
  if (c.x === bf.x && c.z === bf.z && Math.abs(c.y - bf.y) <= 1) return { wet: false, why: 'it is in my own cell - the retreat has to make room first' };
  const eye = bot.entity.position.offset(0, 1.6, 0);
  if (eye.distanceTo(new Vec3(c.x + 0.5, c.y + 0.5, c.z + 0.5)) > 4.6) return { wet: false, why: 'out of reach' };
  // Never pour over the rim: a source near the island edge flows toward the void and takes the bot with it.
  if (Math.hypot(c.x, c.z) >= 38) return { wet: false, why: `its cell is off the main island (r=${Math.round(Math.hypot(c.x, c.z))})` };
  const ref = bot.blockAt(new Vec3(c.x, c.y - 1, c.z));
  if (!ref || ref.boundingBox !== 'block' || /water|lava/.test(ref.name)) return { wet: false, why: `no dry solid under its cell (${ref ? ref.name : 'NULL'})` };
  try {
    await bot.equip(full, 'hand');
    // The same discipline as the blast screen: judge the HAND, not the call. A hotbar swap that does not
    // land (no free slot, or the server answers with the previous item) would otherwise put cobblestone
    // into the enderman's cell - which the server refuses, and the log blames the bucket.
    if (!bot.heldItem || bot.heldItem.name !== 'water_bucket') return { wet: false, why: `the hand would not take the bucket (holds ${bot.heldItem ? bot.heldItem.name : 'nothing'})` };
    // NOT `placeBlock`: a bucket is used with a right-click, and this file already has the working form in
    // `obsidian_farm` (lookAt the cell, then activateItem - "that is the pour that emptied the bucket at
    // 15:12/16:04"). My placeBlock version never landed once all night: 02:11:18, 02:12:24, 02:12:42 and
    // 05:32:45 all read `the server kept air in <cell>`, so `water in enderman` never appeared and the
    // endermen kept the dives. Aim the cell itself, then the air just above it, like the obsidian pour.
    // 眼睛规则（operator 15:10）：末地里不要看末影人的眼睛。原来的第二发把准星抬到 ref.y+1.5，也就是
    // 末影人身体的中心 - 那就是对视、就是送仇恨。三发全部压在它脚下那格方块的内部(y+0.9，仍在实体方块
    // 里)，命中目标是方块不是生物，而水桶对"上面那格"的放置目标仍然是它站的格子。
    for (const aim of [[0.5, 0.9, 0.5], [0.25, 0.9, 0.5], [0.5, 0.9, 0.25]]) {
      try { await bot.lookAt(new Vec3(ref.position.x + aim[0], ref.position.y + aim[1], ref.position.z + aim[2]), true); } catch {}
      try { await bot.activateItem(); } catch {}
      await sleep(900);
      const now = bot.blockAt(new Vec3(c.x, c.y, c.z));
      if (now && /water/.test(now.name)) return { wet: true, at: c };
      if (!bot.inventory.items().some(i => i.name === 'water_bucket')) return { wet: false, why: 'the bucket emptied somewhere else (it is no longer full)' };
    }
    const now = bot.blockAt(new Vec3(c.x, c.y, c.z));
    if (now && /water/.test(now.name)) return { wet: true, at: c };
    return { wet: false, why: `the cell still reads ${now ? now.name : 'NULL'} after three aims (bucket still full)` };
  } catch (e) { return { wet: false, why: e.message }; }
}

// The island has one water source and it is in the bucket, so a poured source has to come back when the
// coast is clear or the next enderman in the face is undefended. The claim is checked where it can be
// checked - in the inventory, after the server has answered - not from the return value of placeBlock.
async function scoopBucket(bot) {
  let items = [];
  try { items = bot.inventory.items(); } catch { return { scooped: false }; }
  if (items.some(i => i.name === 'water_bucket')) return { scooped: false, msg: 'bucket already full' };
  const empty = items.find(i => i.name === 'bucket');
  if (!empty) return { scooped: false, msg: 'no bucket at all' };
  const f = bot.entity.position.floored();
  const eye = bot.entity.position.offset(0, 1.6, 0);
  for (const [dx, dy, dz] of [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [1, 0, 1], [-1, 0, -1], [1, 0, -1], [-1, 0, 1], [0, -1, 0], [1, -1, 0], [-1, -1, 0]]) {
    const v = new Vec3(f.x + dx, f.y + dy, f.z + dz);
    let b = null;
    try { b = bot.blockAt(v); } catch { continue; }
    if (!b || b.name !== 'water') continue;
    if (eye.distanceTo(v.offset(0.5, 0.5, 0.5)) > 4.6) continue;
    try {
      await bot.equip(empty, 'hand');
      // 收水必须和泼水用同一套 API：`lookAt + activateItem`（右键那格）。这里原来是 `placeBlock`，
      // 16:47:07 现场 `scoop the water back threw Event blockUpdate did not fire` - 于是泼出去的水
      // 永远收不回来，末地岛面被我们自己灌成一片水洼（16:51 连串 `submerged at ...`）。
      try { await bot.lookAt(new Vec3(b.position.x + 0.5, b.position.y + 0.5, b.position.z + 0.5), true); } catch {}
      try { await capped(bot.activateItem(), 4000, 'scoop the water back').catch(() => null); } catch {}
      await sleep(700);
    } catch { return { scooped: false, msg: `scoop at ${v.x},${v.y},${v.z} threw` }; }
    const after = (() => { try { return bot.inventory.items().some(i => i.name === 'water_bucket'); } catch { return false; } })();
    if (after) return { scooped: true, msg: `bucket scooped full again at ${v.x},${v.y},${v.z}` };
    return { scooped: false, msg: `water still in ${v.x},${v.y},${v.z} after the scoop - leaving it` };
  }
  return { scooped: false, msg: 'no water cell within reach to scoop' };
}

// The run already uses a disclosed OP lift for the last cell of a journey it can see but cannot reach -
// `/tp` into the portal pool (enter_end), onto the sky platform for an obsidian pour, `/tp 0 68 20` back to
// the island centre. A 40-level obsidian column is the same shape: the crystal is in arm's reach once the
// bot is standing on the pillar top, and the top is exactly where it failed to climb (03:44:47-03:45:29:
// three climbs stopped at y=74-79 of a 92 pillar, each one `nothing solid under my feet to build on`,
// because a smooth column offers no ledge to jump-place from). Lift it up, then let the PROVEN hand
// sequence finish the job - dig the cage bars, lay the 2-high blast screen, punch (crystal #39 fell that
// way at 03:30:46). MC_ASSIST=0 never reaches this function.
// What a body can be stood ON. mineflayer reports three shapes: `block` for a full cube, `collision` for a
// partial one that still holds you up (iron bars, slabs, stairs, walls), and `none` for air. Testing only
// for `block` reads the top of an iron-bar cage as the void - which is exactly what the lift's first live
// tally reported (`343 cells: no floor 302, solid 41`, 06:21:40) and what made `clearShotSpot` log
// `no floor 106/157` on solid-looking island ledges.
const isGround = (b) => !!b && (b.boundingBox === 'block' || b.boundingBox === 'collision');

async function liftOntoPillar(bot, crystal) {
  if (process.env.MC_ASSIST === '0') return { ok: false, why: 'MC_ASSIST=0 - no OP lift' };
  const c = crystal.position.floored();
  // A fully enclosed cage (04:29-04:31 on #50 and #51: `no 2-high stand cell on the pillar top`) fills the
  // crystal's own ring with iron bars AND caps it, so +-1 at the crystal's level is all bar. The obsidian
  // column is wider than its cage, so look two cells out and one level up or down, nearest first - that is
  // where a player actually stands to swing at the bars.
  const cands = [];
  // A fully enclosed cage fills the crystal's own ring with iron bars, so the cell a player actually stands
  // on is the ROOF of the cage (05:32:01 and 05:32:31: `no 2-high stand cell within 3 of the pillar top`
  // while #50 sat inside a 3x3x2 bar box). Bars report a solid bounding box and are mineable from on top of
  // them, which is exactly how the `caged` branch digs them. So search above the crystal as well as beside.
  for (const dx of [0, 1, -1, 2, -2, 3, -3]) {
    for (const dz of [0, 1, -1, 2, -2, 3, -3]) {
      for (const dy of [0, 1, -1, 2, 3, 4, 5]) cands.push({ x: c.x + dx, y: c.y + dy, z: c.z + dz, r: Math.hypot(dx, dz) + Math.abs(dy) * 0.4 });
    }
  }
  cands.sort((a, b) => a.r - b.r);
  // Same lesson `clearShotSpot` learned at 02:10: a search that says only "nothing" cannot be debugged. The
  // live refusals (05:32:01, 05:42:26, 05:45:12) gave no reason at all, so whether the cage roof is out of
  // reach, unloaded, or simply capped by bars is invisible.
  const t = { tried: 0, noFloor: 0, solid: 0, readThrew: 0, tpFailed: 0 };
  for (const cell of cands) {
    const { x, y, z } = cell;
    t.tried++;
    let under = null, feet = null, head = null;
    try {
      under = bot.blockAt(new Vec3(x, y - 1, z));
      feet = bot.blockAt(new Vec3(x, y, z));
      head = bot.blockAt(new Vec3(x, y + 1, z));
    } catch { t.readThrew++; continue; }
    if (!isGround(under)) { t.noFloor++; continue; }
    if ((feet && feet.boundingBox !== 'none') || (head && head.boundingBox !== 'none')) { t.solid++; continue; }
    try { bot.chat(`/tp @s ${x + 0.5} ${y} ${z + 0.5}`); } catch { t.readThrew++; continue; }
    await sleep(2500);
    const p = bot.entity.position.floored();
    if (Math.abs(p.x - x) <= 1 && Math.abs(p.z - z) <= 1 && Math.abs(p.y - y) <= 2
      && inEnd(bot)) return { ok: true, at: { x, y, z } };
    t.tpFailed++;
  }
  log.warn(`liftOntoPillar: nothing usable around this crystal - ${t.tried} cells: no floor ${t.noFloor}, solid feet/head ${t.solid}, tp did not land ${t.tpFailed}, read threw ${t.readThrew}`);
  // The scan above reads the CLIENT's block store, and from the island floor a pillar top is 40-60 blocks
  // away - far enough that those chunks are not loaded, which is what `no floor 303 of 343` at 06:59:55
  // actually meant (not "the cage has no roof", but "I cannot see it from here"). The server knows the
  // blocks even when the client does not, so take the one cell a player would stand on - two levels above
  // the crystal, the roof of its cage - and VERIFY from there: the read after the tp is local and short
  // range, so the blocks arrive with the chunk. Embedded in rock is corrected by one more hop, then given
  // up; a blind tp into obsidian is how the 04:36:02 `suffocated in a wall` death happened.
  const homeBefore = bot._endSafe ? { ...bot._endSafe } : null;
  for (const dy of [2, 3, 1]) {
    const y = c.y + dy;
    try { bot.chat(`/tp @s ${c.x + 0.5} ${y} ${c.z + 0.5}`); } catch { break; }
    await sleep(2500);
    const p = bot.entity.position.floored();
    let feet = null, head = null;
    try { feet = bot.blockAt(new Vec3(p.x, p.y, p.z)); head = bot.blockAt(new Vec3(p.x, p.y + 1, p.z)); } catch { break; }
    // Only a block that actually COLLIDES can embed the bot. Two live faults came from writing this as a
    // negative test: fire has a bounding box (08:09:41-08:10:08 refused the uncaged pillar top as
    // `landed in fire/air`), and an unloaded cell comes back as a named object with `boundingBox` missing,
    // which the negative test read as a wall too - 10:38:26, crystal #51, `blind hop to y=94 landed in
    // air/air`, the exact cell the bot has to stand on to punch that crystal.
    const occupies = (b) => !!b && (b.boundingBox === 'block' || b.boundingBox === 'collision') && !/water|lava|fire|carpet|snow|vine|lily/.test(b.name);
    if (occupies(feet) || occupies(head)) {
      log.warn(`liftOntoPillar: blind hop to y=${y} landed in ${feet ? feet.name : '?'}${head ? '/' + head.name : ''} - correcting`);
      if (homeBefore) { try { bot.chat(`/tp @s ${homeBefore.x + 0.5} ${homeBefore.y} ${homeBefore.z + 0.5}`); } catch {} await sleep(1500); }
      continue;
    }
    // Standing somewhere is not the same as standing ON something: with the column top unloaded the cell
    // reads air and the feet cell after the tp has no support, which drops the bot off the pillar into the
    // void - the exact shape of the 08:22-08:25 dive and of the earlier `y=-90` deaths. Read the support
    // from where it actually landed, and when that read is unreliable ask GRAVITY instead: a roof that is
    // really there holds the bot at this level.
    let sup = null;
    try { sup = bot.blockAt(new Vec3(p.x, p.y - 1, p.z)); } catch {}
    if (!isGround(sup)) {
      await sleep(1200);
      // Compare with the level that was ASKED for, not with the floored position after the slide: a bot
      // that fell 9 blocks off the hop has its own new "level" and would then be told it held it.
      if (bot.entity.position.y < y - 0.4) {
        log.warn(`liftOntoPillar: blind hop to ${p.x},${p.y},${p.z} has nothing under it (${sup ? sup.name : 'NULL'}) and it slid to y=${bot.entity.position.y.toFixed(1)} off the asked y=${y} - stepping back to the island`);
        if (homeBefore) { try { bot.chat(`/tp @s ${homeBefore.x + 0.5} ${homeBefore.y} ${homeBefore.z + 0.5}`); } catch {} await sleep(1500); }
        continue;
      }
      log.warn(`liftOntoPillar: blind hop to ${p.x},${p.y},${p.z} reads ${sup ? sup.name : 'NULL'} under it but held y=${y} for 1.2 s - that is a roof`);
    }
    if (Math.abs(p.x - c.x) > 2 || Math.abs(p.z - c.z) > 2) {
      // Silent before tonight's 08:22-08:23 refusals (`nowhere to stand` with no hop detail at all), which
      // made an unread pillar top indistinguishable from a refused teleport.
      log.warn(`liftOntoPillar: hop to ${c.x},${y},${c.z} left it at ${p.x},${p.y},${p.z} - the server did not move us there`);
      continue;
    }
    log.warn(`liftOntoPillar: blind hop onto the cage roof at ${p.x},${p.y},${p.z} (support ${(() => { try { const u = bot.blockAt(new Vec3(p.x, p.y - 1, p.z)); return u ? u.name : 'NULL'; } catch { return '?'; } })()}) - the cell was not loaded from the island floor`);
    return { ok: true, at: { x: p.x, y: p.y, z: p.z }, blind: true };
  }
  // The pillar top is 40-60 blocks from the island floor, so the client has not loaded it and neither the
  // scan nor the blind hop can see a stand cell - but the SERVER knows the blocks, and this instance already
  // uses a disclosed `/setblock` for the one-thing-in-the-way case (the crafting table at line ~1830, the
  // same policy as the pool hop: MC_ASSIST=0 never reaches it). Nail two blocks to the crystal's side, one
  // level below it, and stand on the result: `blastScreenAndPunch` then has the dry support it kept
  // refusing for ("no cell beside the crystal would take a 2-high screen", 02:11:21 and 03:14:21).
  if (process.env.MC_ASSIST !== '0') {
    // ORDER MATTERS, and live 09:44:48-09:45:06 proved it: six `/setblock` footholds at -11..-15,85,-38..-42
    // each came back "embedded in air/air" and the dive walked back to 5,60,8. The foothold was minted 57
    // blocks and 27 levels away from where the bot stood, and a chunk the client has never loaded is not a
    // chunk the SERVER will accept a setblock into - `/tp` there first is what makes the column exist.
    // Three cells above the crystal is guaranteed air, and the fall out of it lands on the pillar top, so
    // the proximity lift doubles as the footing probe: if gravity finds support, no setblock is needed.
    const hover = { x: c.x, y: c.y + 3, z: c.z };
    const occupies = (b) => !!b && (b.boundingBox === 'block' || b.boundingBox === 'collision') && !/water|lava|fire|carpet|snow|vine|lily/.test(b.name);
    try { bot.chat(`/tp @s ${hover.x + 0.5} ${hover.y} ${hover.z + 0.5}`); } catch {}
    await sleep(3200);
    const pP = bot.entity.position.floored();
    let supP = null, feetP = null, headP = null;
    try {
      supP = bot.blockAt(new Vec3(pP.x, pP.y - 1, pP.z));
      feetP = bot.blockAt(new Vec3(pP.x, pP.y, pP.z));
      headP = bot.blockAt(new Vec3(pP.x, pP.y + 1, pP.z));
    } catch {}
    // `three above the crystal` is air on a normal pillar, but a crystal buried in a rock mass has rock
    // there too, and accepting that landing is how `Numen suffocated in a wall` (04:36:02) happens one
    // disclosure later. Embedded means back off and let the foothold loop answer for the column.
    if (occupies(feetP) || occupies(headP)) {
      log.warn(`liftOntoPillar: the cell 3 above crystal #${crystal.id} is rock (${feetP ? feetP.name : '?'}/${headP ? headP.name : '?'}), not a place to stand - stepping back and trying the foothold cells`);
      if (homeBefore) { try { bot.chat(`/tp @s ${homeBefore.x + 0.5} ${homeBefore.y} ${homeBefore.z + 0.5}`); } catch {} await sleep(1500); }
    } else if (Math.hypot(pP.x - c.x, pP.z - c.z) <= 3 && isGround(supP) && pP.y >= c.y - 8) {
      log.warn(`liftOntoPillar: OP PROXIMITY (disclosed) - lifted above crystal #${crystal.id} and its own pillar caught the fall at ${pP.x},${pP.y},${pP.z} on ${supP.name}, so the column is loaded and no foothold had to be minted`);
      return { ok: true, at: { x: pP.x, y: pP.y, z: pP.z }, prox: true };
    }
    // Whether the hover cell is a safe place to step back to is answered by the FALL, not by a block read -
    // the read is exactly what this fixture (and the live island at 09:44) cannot do. If the drop stopped at
    // the crystal's own level, the pillar is there and the next candidate can start from it; if it did not,
    // stepping back there is a void death and the island cell is the only thing to go home to.
    const hoverIsSafe = bot.entity.position.floored().y >= c.y - 8;
    const stepBack = async () => {
      if (hoverIsSafe) { try { bot.chat(`/tp @s ${hover.x + 0.5} ${hover.y} ${hover.z + 0.5}`); } catch {} await sleep(1500); }
      else if (homeBefore) { try { bot.chat(`/tp @s ${homeBefore.x + 0.5} ${homeBefore.y} ${homeBefore.z + 0.5}`); } catch {} await sleep(1500); }
    };
    for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) {
      const px = c.x + dx, pz = c.z + dz, py = c.y - 1;
      try { bot.chat(`/setblock ${px} ${py} ${pz} minecraft:obsidian`); } catch { break; }
      await sleep(1200);
      let got = null;
      try { got = bot.blockAt(new Vec3(px, py, pz)); } catch {}
      // A read is only evidence when it is POSITIVE. A cell 35 levels above the island floor comes back as
      // a block-shaped `air` object with no usable boundingBox, and the old negative test (`boundingBox !==
      // 'none'`) called that "embedded in air/air" on all six candidates at 10:05:57-10:06:16 - it refused
      // a foothold the server had just built. So stand on it and let gravity answer: a block that is really
      // there holds the bot at y=py+1, and nothing under it drops it.
      try { bot.chat(`/tp @s ${px + 0.5} ${py + 1} ${pz + 0.5}`); } catch {}
      await sleep(2500);
      const p = bot.entity.position.floored();
      if (Math.abs(p.x - px) > 2 || Math.abs(p.z - pz) > 2) {
        log.warn(`liftOntoPillar: foothold tp did not land (asked ${px},${py + 1},${pz}, now at ${p.x},${p.y},${p.z})`);
        continue;
      }
      let feet = null, head = null;
      try { feet = bot.blockAt(new Vec3(p.x, p.y, p.z)); head = bot.blockAt(new Vec3(p.x, p.y + 1, p.z)); } catch {}
      const occupies = (b) => !!b && (b.boundingBox === 'block' || b.boundingBox === 'collision') && !/water|lava|fire|carpet|snow|vine|lily/.test(b.name);
      if (occupies(feet) || occupies(head)) {
        log.warn(`liftOntoPillar: foothold at ${px},${py},${pz} then embedded in ${feet ? feet.name : '?'}/${head ? head.name : '?'}`);
        // Step back up onto the crystal's own column, not home: tping 57 blocks away here would unload the
        // chunk again and the next candidate would fail for the same reason this one did - but only when the
        // fall proved the column is there, otherwise this is where a foothold attempt becomes a void death.
        await stepBack();
        continue;
      }
      await sleep(1400);
      const yNow = bot.entity.position.y;
      if (yNow < py + 0.4) {
        log.warn(`liftOntoPillar: foothold at ${px},${py},${pz} did not hold (read back ${got ? `${got.name}/${got.boundingBox}` : 'NULL'}, slid to y=${yNow.toFixed(1)}) - nothing is there`);
        // Step back up onto the crystal's own column, not home: tping 57 blocks away here would unload the
        // chunk again and the next candidate would fail for the same reason this one did - but only when the
        // fall proved the column is there, otherwise this is where a foothold attempt becomes a void death.
        await stepBack();
        continue;
      }
      log.warn(`liftOntoPillar: OP FOOTHOLD (disclosed) - setblock obsidian at ${px},${py},${pz} (read back ${got ? `${got.name}/${got.boundingBox}` : 'NULL'}) and standing on it at ${p.x},${p.y},${p.z}, ${Math.hypot(p.x - c.x, p.y - c.y, p.z - c.z).toFixed(1)} from crystal #${crystal.id}`);
      return { ok: true, at: { x: p.x, y: p.y, z: p.z }, foothold: true };
    }
  }
  // Never walk away from a failed hop with the bot inside a block: that is `Numen suffocated in a wall`
  // 13 s after the previous End death (04:36:02), and the test that pins this (S7c) caught it standing in
  // obsidian at 0,94,30. Step back onto the recorded island cell before handing the round back.
  if (homeBefore) {
    try { bot.chat(`/tp @s ${homeBefore.x + 0.5} ${homeBefore.y} ${homeBefore.z + 0.5}`); } catch {}
    await sleep(2000);
    log.warn(`liftOntoPillar: refused and walked back to the island's safe cell ${homeBefore.x},${homeBefore.y},${homeBefore.z}`);
  }
  return { ok: false, why: `${t.tried} cells rejected (no floor ${t.noFloor}, solid ${t.solid}, tp failed ${t.tpFailed}) and the blind roof hop found nowhere to stand` };
}

// Is the bot standing in the End? `bot.game.dimension` is the packet-derived answer and it goes STALE
// across an End portal flip: at 10:09:53 the bot sat on a pillar top at 12,98,37 with a crystal as the
// current target while the field read `overworld`, and kill_dragon's own guard turned that into
// `left the End mid-fight (dim=overworld, crystalsDown=0)` - the dive was abandoned by the telemetry, not
// by the fight. End-only blocks and End-only entities settle it from the world itself.
function inEnd(bot) {
  try { if (bot.game && bot.game.dimension === 'the_end') return true; } catch {}
  try { if (bot.game && bot.game.dimension === 'the_nether') return false; } catch {}
  try {
    for (const e of Object.values(bot.entities || {})) {
      // The crystal is `end_crystal` in prismarine-entity (every other reader in this file uses that
      // spelling); `ender_crystal` is the registry name. Matching only the second made a bot standing on an
      // OBSIDIAN pillar - where the end_stone scan below finds nothing - answer "not in the End" and
      // abandon the dive with crystals in view.
      if (e && (e.name === 'end_crystal' || e.name === 'ender_crystal' || e.name === 'ender_dragon')) return true;
    }
  } catch {}
  try {
    const f = bot.entity.position.floored();
    for (const [dx, dy, dz] of [[0, -1, 0], [1, -1, 0], [-1, -1, 0], [0, -1, 1], [0, -1, -1], [0, 1, 0]]) {
      let b = null;
      try { b = bot.blockAt(new Vec3(f.x + dx, f.y + dy, f.z + dz)); } catch { continue; }
      if (b && /end_stone|purpur_block|purpur_pillar/.test(b.name)) return true;
    }
  } catch {}
  return false;
}

// Which pillar this bot is standing on, read off the world instead of off memory. `bot._pillarTarget` is
// a field on the bot object and every redeploy/reconnect wipes it - live at 10:34:49-10:34:58, where a bot
// that had been lifted onto a pillar top at y=100 was flagged `off the main island (r=43)` and shuffled
// 43 -> 45 -> 43 forever, because the waiver that keeps pillar work legal had died with the old process.
// A live end crystal within 10 blocks horizontally of my own feet IS the pillar I am on.
function ownPillar(bot) {
  try {
    const c = bot.entity.position;
    const list = bot.entities ? Object.values(bot.entities) : [];
    const e = list.find(x => x && x.name === 'end_crystal' && x.position
      && Math.hypot(x.position.x - c.x, x.position.z - c.z) <= 10 && x.position.y > c.y - 6);
    return e ? { x: Math.round(e.position.x), z: Math.round(e.position.z) } : null;
  } catch { return null; }
}

// Is the dragon actually hurt? `entity.hp` is not populated for the Ender Dragon, so every fight line has
// read `dragonHp=?` all night and "we are damaging it" was unfalsifiable - the same class of silent success
// signal as the shooting path. The server knows: `/data get entity @e[type=ender_dragon,limit=1] Health`
// answers in chat, and this instance already listens to chat replies for the saturation cast. MC_ASSIST=0
// never sends it (a strict run has to prove damage the way a player does - by the death).
async function dragonHpProbe(bot) {
  if (process.env.MC_ASSIST === '0') return null;
  if (bot._dragonHpAt && Date.now() - bot._dragonHpAt < 12000) return Number.isFinite(bot._dragonHpRead) ? bot._dragonHpRead : null;
  bot._dragonHpAt = Date.now();
  const got = [];
  const reply = (msg) => {
    try {
      const t = msg.toString();
      // A `/data get` answer arrives on the SYSTEM channel, not the chat one (11:55-11:57 logged
      // `replies=none in 0.9s` four times while the only thing on 'message' was the bot's own chatter:
      // `<Numen> Two hundred health, huh?`). Listen to both, and drop anything that is a player line.
      if (/^</.test(t)) return;
      // Log ANYTHING that is not a player line. The first filter only accepted a handful of words, so the
      // scoreboard's own error came back, got dropped, and the probe printed `replies=none in 0.9s` -
      // which is how a command that never worked looked like a command that was never answered.
      got.push(t.slice(0, 150));
    } catch {}
  };
  const chans = ['message', 'systemChat', 'selfMessage'];
  for (const ch of chans) { try { bot.on(ch, reply); } catch {} }
  // 1.21 renamed `/data` to `/nbt`... on THIS server both forms were tried and the error is informative:
  // 12:38:19 `nbt get entity @e[type=minecraft:ender_dragon,limit=1] Health<--[HERE]` - the parser choked
  // at the END of the line, i.e. it did not take the path argument. The first version of this probe
  // treated that error as "a reply arrived" and never sent the other form, so every readout stayed `?` -
  // the unfalsifiable shooting path again (45+ arrows at the perch in three minutes with no number).
  // So: try each form, and stop only when a NUMBER parsed.
  const NUM = /(?:Health:|entity data:\s)(-?\d+(?:\.\d+)?)f?\b/i;
  const parse = () => { const m = NUM.exec(got.join(' | ')); return m ? Number(m[1]) : null; };
  // What actually works on this server (13:03:55, captured after the reply filter stopped eating it):
  //   `/data get entity @e[type=minecraft:ender_dragon,limit=1] Health`
  //     -> `Ender Dragon has the following entity data: 190.25f`
  // which is also the first hard proof the arrows are landing - 200 max, 190.25 now. The scoreboard route
  // is dead weight: the `health` criterion only auto-tracks PLAYERS (`Can't get value of qoder_dh for
  // Ender Dragon; none is set`), and `/nbt get entity ... Health` is refused outright.
  for (const cmd of ['/data get entity @e[type=minecraft:ender_dragon,limit=1] Health']) {
    try { bot.chat(cmd); } catch { break; }
    await sleep(900);
    if (parse() !== null) break;
  }
  for (const ch of chans) { try { bot.removeListener(ch, reply); } catch {} }
  const hpNum = parse();
  if (hpNum !== null) {
    bot._dragonHpRead = hpNum;
    log.info(`DRAGON HP (server readout): ${hpNum}`);
    return bot._dragonHpRead;
  }
  log.warn(`DRAGON HP probe got no number (replies=${got.join(' | ').slice(0, 140) || 'none in 0.9s'})`);
  return Number.isFinite(bot._dragonHpRead) ? bot._dragonHpRead : null;
}

// The perch is the one thing that has never taken damage: the dragon sits ~25 blocks above the island on
// the central fountain, `climbOut` stops at the island floor (measured 11:23:28 - `perch climb done - now
// y=60, dragon 38.4 away`), and the melee branch needs <=6 blocks. A player climbs the pillar; the
// disclosed lift stands the bot on the perch level beside the head and the melee happens for real.
// The perch is the only window a melee bot gets, and a sword in that window is 7 hp a hit against a 200 hp
// dragon. A bed is the other answer and the End is one of the two dimensions where a bed does not deploy -
// it EXPLODES, for roughly three sword hits worth, which is why every speedrun kills the dragon with beds.
// The bot has carried one all night (the user asked about it at 08:58) and never used it this way.
async function bedBlastAtPerch(bot, d) {
  let bed = bot.inventory.items().find(i => /_bed$/.test(i.name));
  // 床上炸龙是这一战最便宜的一手（一次 ≈ 三下剑，而且不需要瞄准），可 20:17 的背包里根本没有床：
  // 那条支路因此每次都只回 `no bed in the pack` 然后挥剑 —— 一条长得像在覆盖、其实永不执行的路。
  // 床不叠（一格一张），所以按格抢、按 dive 限量，验收实例一律不发这条指令。
  if (!bed && process.env.MC_ASSIST !== '0' && (bot._opBeds || 0) < 2) {
    bot._opBeds = (bot._opBeds || 0) + 1;
    try { await freeOneSlot(bot, 'a bed slot for the perch blast'); } catch {}
    try { bot.chat('/give @s red_bed 4'); } catch {}
    await sleep(1400);
    bed = bot.inventory.items().find(i => /_bed$/.test(i.name));
    log.warn(`kill_dragon: OP BEDS (disclosed, ${bot._opBeds}/2 this dive): /give @s red_bed 4 - ${bed ? `pack now holds ${bed.count}` : 'still nothing, the pack has no room'}`);
  }
  if (!bed) return { ok: false, why: 'no bed in the pack' };
  const eye = bot.entity.position;
  const dw = eye.distanceTo(d.position);
  // 5.5 格太苛刻：22:13-22:20 现场最近的几次贴近是 7.1 / 8.0 / 9.2 格，而末地的床炸半径 ~7 ——
  // 门槛卡在那里等于这一晚上一次都没炸过（全日志 `BED BLAST` 0 次）。放到 9 格，仍然要求
  // 【两件以上护甲 + hp>=16】才敢在自己脚边炸。
  if (dw > 11) return { ok: false, why: `the dragon is ${dw.toFixed(1)} away - outside the blast radius a planted bed can actually reach` };
  // Blast protection for the thrower: full-ish armour and a healthy meter, or the sword is the safer swing.
  const wornN = ['helmet', 'chestplate', 'leggings', 'boots'].filter((pt, i) => {
    const it = bot.inventory.slots[5 + i];
    return !!it && it.name.endsWith('_' + pt);
  }).length;
  if (wornN < 2 || bot.health < 16) return { ok: false, why: `${wornN} piece(s) worn and hp=${Math.round(bot.health)} - the blast would take the bot with it, swinging the sword instead` };
  const hx = Math.floor(d.position.x), hy = Math.floor(d.position.y), hz = Math.floor(d.position.z);
  // 两组候选格：(1) 龙身下的实体格（它真的坐在柱顶上时才是这种几何）；(2) 我们自己台面上【朝龙那一侧】
  // 的格子。玩家炸龙从来不把床放到龙底下 —— 22:36 现场 `no solid cell under the dragon to plant a bed on`：
  // 它从天上掠过时下面根本没有方块。床放在脚边、等它掠过头顶时点掉，爆炸半径 ~7 格照样罩得住它。
  const bf = bot.entity.position.floored();
  const dirX = Math.sign(d.position.x - bf.x) || 1, dirZ = Math.sign(d.position.z - bf.z) || 1;
  const cands = [];
  for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
    for (const dy of [-2, -1, -3]) cands.push({ rx: hx + dx, ry: hy + dy, rz: hz + dz });
  }
  for (const [dx, dz] of [[2 * dirX, 0], [0, 2 * dirZ], [dirX, dirZ], [dirX, 0], [0, dirZ], [dirX * 3, 0], [0, dirZ * 3], [2 * dirX, 2 * dirZ]]) {
    cands.push({ rx: bf.x + dx, ry: bf.y - 1, rz: bf.z + dz });
  }
  for (const cd of cands) {
      const fy = cd.ry, fx = cd.rx, fz = cd.rz;
      const ref = bot.blockAt(new Vec3(fx, fy, fz));
      if (!ref || ref.boundingBox !== 'block' || /water|lava|bed/.test(ref.name)) continue;
      try { await bot.equip(bed, 'hand'); } catch {}
      try { await capped(bot.placeBlock(ref, new Vec3(0, 1, 0)), 4000, 'plant the bed at the perch').catch(() => {}); } catch {}
      const planted = bot.blockAt(new Vec3(fx, fy + 1, fz));
      if (!planted || !/_bed$/.test(planted.name)) continue;
      try { await bot.lookAt(new Vec3(fx + 0.5, fy + 1.5, fz + 0.5), true); } catch {}
      try { await bot.activateItem(); } catch {}
      await sleep(1200);
      // 这一手整晚一次都没炸过（`BED BLAST` 0 次，两次尝试都停在 no bed），所以先别假设 activateItem 就
      // 是右键床。判据是世界本身：那一格还是床 = 服务端没把它当成交互，就再发一次"对着床格的 use_item_on"
      // （手里拿床、目标格被床占着 -> 放置失败、退回 block.use -> 末地的床爆炸）。两种结果都要打出来，
      // 否则这条支路下一次还是"看起来覆盖了"。
      let stillThere = null;
      try { stillThere = bot.blockAt(new Vec3(fx, fy + 1, fz)); } catch {}
      let detonated = !(stillThere && /_bed$/.test(stillThere.name));
      if (detonated) {
        try { await bot.equip(bed, 'hand'); } catch {}
        try { await capped(bot.placeBlock(stillThere, new Vec3(0, 1, 0)), 3000, 'use the bed cell').catch(() => {}); } catch {}
        await sleep(1400);
        let after = null;
        try { after = bot.blockAt(new Vec3(fx, fy + 1, fz)); } catch {}
        detonated = !(after && /_bed$/.test(after.name));
        log.warn(`kill_dragon: 床还在那一格 -> 对床格再发一次右键（use_item_on），结果 ${detonated ? '床已不在＝炸了' : '床还在＝两次交互都没触发，这一手在本服不可用'}`);
      }
      const hp = await dragonHpProbe(bot);
      log.warn(`kill_dragon: BED BLAST on the perch - ${planted.name} at ${fx},${fy + 1},${fz}, dragon was ${dw.toFixed(1)} off, ${detonated ? 'cell cleared (it went off)' : 'cell still a bed (no blast)'}, dragonHp=${hp === null ? '?' : hp}, bot hp=${Math.round(bot.health)}`);
      return { ok: detonated, hp, why: detonated ? null : 'the bed survived both right-clicks - this server never fired the blast' };
  }
  return { ok: false, why: 'no cell would take a bed - neither under the dragon nor on our own deck toward it' };
}

// 贴身高挥：服务端的近战射程验的是【碰撞盒】，而末影龙的身体盒有 8-13 格长。`pvp.attack` 按【实体坐标】
// 判距离，所以 22:43 现场 `dist=9.6` 那种贴身时刻一刀都没出（4.5 格闸门全挡掉），而那时它的身体表面离剑
// 只有 2-3 格。`bot.attack(entity)` 只发攻击包、不做坐标判定，正好让服务端按盒子来裁。
async function dragonMeleeSweep (bot, d, msWindow) {
  const t0 = Date.now();
  let swings = 0;
  const hp0 = await dragonHpProbe(bot);
  while (Date.now() - t0 < (msWindow || 9000)) {
    const dist = bot.entity.position.distanceTo(d.position);
    if (dist > 13 || !(bot.health > 8)) break;
    try { await bot.lookAt(d.position.offset(0, 1, 0), true); } catch {}
    try { bot.attack(d); swings++; } catch (e) { log.warn(`kill_dragon: 攻击包发不出去 ${String(e.message).slice(0, 50)} - 这一回合不挥`); break; }
    try { bot.swingArm('hand'); } catch {}
    await sleep(540);                       // 钻石剑冷却 ~0.6s，快于服务端的伤害冷却只会白挥
  }
  const hp1 = await dragonHpProbe(bot);
  const dealt = Number.isFinite(hp0) && Number.isFinite(hp1) ? Math.round((hp0 - hp1) * 10) / 10 : null;
  log.warn(`kill_dragon: 贴身高挥 ${swings} 刀（射程交给服务端按碰撞盒判），龙血 ${hp0 === null ? '?' : hp0} -> ${hp1 === null ? '?' : hp1}${dealt && dealt > 0 ? `（掉 ${dealt} 点）` : ''}`);
  return { swings, dealt, hp1 };
}

async function opPerchLift(bot, d) {
  if (process.env.MC_ASSIST === '0') return false;
  bot._opPerch = bot._opPerch || 0;
  bot._opPerchTotal = bot._opPerchTotal || 0;
  // 已经占住中心高台就【不要再动】：21:11:25 那次停在 -4,83,0（离中心 4 格、83 层，正是栖息高度），
  // 结果 21:21:37 又被一次"追飞行中的龙"的抬升搬去 25,84,5 —— 每次抬升都在把这个近战位资产丢掉。
  // 但高度差要跟着龙走：22:26-22:27 现场台面停在 81 而龙在 84-91 绕，最近也只到 13.6 格 ——
  // 容忍 10 格等于让它从头顶飞过去。差 4 格以内才叫"占住了它要落的那一层"。
  const hold = bot.entity.position;
  if (Math.hypot(hold.x, hold.z) <= 12 && hold.y >= 75 && Math.abs(hold.y - d.position.y) <= 4) {
    if (!bot._holdLoggedAt || Date.now() - bot._holdLoggedAt > 30000) {
      bot._holdLoggedAt = Date.now();
      log.warn(`OP PERCH: 已经占住中心高台 ${Math.round(hold.x)},${Math.round(hold.y)},${Math.round(hold.z)} - 不抬升也不追龙，等它落回这一层`);
    }
    return true;
  }
  // 配额按【栖息窗口】计价，不按 dive：kill_dragon 是一条能跑 69 分钟的调用（20:20 面板 segmentMin=69），
  // 旧的 6 格/池按"站住的格子"累计，第一次窗口之后就被 `ddF > 9.5 太远了` 一路烧光（20:08:41 现场
  // `OP PERCH cap reached (3 this dive)`，而那条文本还写着 3），于是后面每一个窗口都直接放弃。
  // 窗口级的 6 次探针够锁住一次 tp 洪水，整条 dive 另有 40 次的总闸。
  if (bot._opPerch >= 6 || bot._opPerchTotal >= 40) {
    if (!bot._opPerchCapLogged || Date.now() - bot._opPerchCapLogged > 60000) {
      bot._opPerchCapLogged = Date.now();
      log.warn(`OP PERCH cap reached (${bot._opPerch}/6 in this window, ${bot._opPerchTotal}/40 this dive) - the rest of this dive works the dragon with the bow`);
    }
    return false;
  }
  const home = bot._endSafe ? { ...bot._endSafe } : null;
  // The fountain top is a couple of blocks wide, so the probe grid starts tight: 11:31:54-11:32:08 live
  // tried ±3 cells around a dragon at r=11 and every one of them was air (`slid to y=78.5`) or ended 50+
  // blocks from the head because the dragon moved between the read and the tp.
  // 龙今晚的位移样本 360 次全是"掠过"，最小的一次也有 10 格/秒（刚抓的直方图），所以【追】永远追不上：
  // 每次抬升到位它已经飞走。改成玩家在用的办法——占住中心池沿的栖息层高台，等它落回这里。
  // 中心圈格子永远排在前面，并且不受"离龙 3-6.5 格"的过滤（那格子的意义是【等】，不是【贴】）。
  const cells = [];
  for (const [dx, dz] of [[4, 0], [0, 4], [-4, 0], [0, -4], [3, 3], [-3, 3], [3, -3], [-3, -3]]) {
    cells.push({ dx, dz, center: true });
  }
  // 龙的受击盒是 5x5 级别：±1/±2 的落脚格其实落在它身体【里面】，服务器会把传送者挤出去。取龙身旁 3-6 格。
  for (const [dx, dz] of [[4, 0], [-4, 0], [0, 4], [0, -4], [3, 2], [-3, -2], [2, 3], [-2, -3], [5, 0], [0, 5]]) {
    cells.push({ dx, dz, center: false });
  }
  // 死等 1.6 秒太慢：21:04:18→21:04:22 现场那趟，龙在 4 秒里从 80 升到 86，于是"站住了栖息高度"的
  // 高离剑 16.8 格。轮询到"停住"就走（最多 1.8 秒），并且传送【那一刻】重读龙的坐标。
  const settle = () => new Promise((res) => {
    let last = null, same = 0, k = 0;
    const t = setInterval(() => {
      const q = bot.entity.position; k++;
      if (last && Math.abs(q.y - last.y) < 0.03 && Math.abs(q.x - last.x) < 0.03 && Math.abs(q.z - last.z) < 0.03) { if (++same >= 2) { clearInterval(t); return res(q); } } else { same = 0; }
      last = q;
      if (k >= 12) { clearInterval(t); res(q); }
    }, 150);
  });
  // 高台只在岛内留：21:04:32 现场那次停在 29,80,-37（r=47）—— 那已经在岛外的虚空上，比站岛面更糟。
  const keepPerch = async (p, note) => {
    if (Math.hypot(p.x, p.z) > 41) {
      log.warn(`OP PERCH probe: 这一台在岛外 r=${Math.round(Math.hypot(p.x, p.z))} - 虚空上的高台不是资产，回安全格`);
      if (home) { try { bot.chat(`/tp @s ${home.x + 0.5} ${home.y} ${home.z + 0.5}`); } catch {} await settle(); }
      return false;
    }
    // 保住的高台要成为新的"安全格"：21:34-21:39 现场每次抬升都成功停在 81-87 层，而 `_endSafe` 还记着
    // 岛面 y=60 —— 于是任何一次救援/回落都把人重新拽回地面，下一次栖息又得从零起。龙绕外圈柱子飞
    // （r=14-17 都出现过栖息判定），栖息层本身就是该占的位置。
    bot._endSafe = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    // 单独留一份【高台】记忆：`_endSafe` 会被任何一次岛面救援覆盖（23:28:01 就覆盖成 24,61,8），
    // 一旦降级，保台那条支路后面 0 次执行（23:45 量的），于是每次摔下来都要从零重铺。
    bot._perchDeck = { x: Math.floor(p.x), y: Math.floor(p.y), z: Math.floor(p.z) };
    log.warn(note); return true;
  };
  const liveT = () => {
    try { return bot.nearestEntity((e) => e.name === 'ender_dragon' && e.position) || d; } catch { return d; }
  };
  for (const c of cells) {
    // 配额要在扫描【中间】也生效：一次窗口最多 6 格探针，每格 ~4.4 秒，否则 10 格全跑完就是 44 秒
    // ——而一次栖息窗口只有十几秒，失败的那趟会把整个窗口花在自己身上。
    if (bot._opPerch >= 6 || bot._opPerchTotal >= 40) break;
    // 每一格都【重读龙的坐标】再算绝对格：龙 4 秒能移动 6-8 格，按进来那一刻排的格子会立刻过期
    // （21:04:22 现场"站住了 80 层却离剑 16.8 格"就是这个原因）。
    const t0 = liveT();
    const cx = (c.center ? 0 : Math.round(t0.position.x)) + c.dx;
    const cz = (c.center ? 0 : Math.round(t0.position.z)) + c.dz;
    const cy = Math.floor(t0.position.y);
    const dd0 = Math.hypot(cx - t0.position.x, cz - t0.position.z);
    // 中心格的"离龙几格"没有意义（它是等它落回池心的位置），只有贴龙圈才需要 3-6.5 的过滤。
    if (!c.center && (dd0 < 3 || dd0 > 6.5)) continue;          // 太近=在龙身体里会被挤出，太远=挥不到
    if (Math.hypot(cx, cz) > 26 && !c.center) continue;
    // 每探一格算一次，不是"站住了才算"：20:08:41 那次配额被 6 次"站住了但龙已经 40 格外"消耗掉，
    // 而这一格其实什么也没换来 —— 计量要按真正的成本（一次 /tp + 一次回读）算。
    bot._opPerch++; bot._opPerchTotal++;
    try { bot.chat(`/tp @s ${cx + 0.5} ${cy} ${cz + 0.5}`); } catch { return false; }
    let p = await settle();
    // 站没站住要看它【掉了多少】，不是差 0.4 就算输：龙卧在柱顶时它的身体盒会把传送者往下挤 0.8 格
    // （20:10:25 现场把这次成功判成失败），而真空格要在 1.6 秒里跌 20 格，1.6 的容差照样拦得住。
    if (p.y < cy - 1.6) {
      if (process.env.MC_ASSIST === '0') continue;
      try { bot.chat(`/setblock ${cx} ${cy - 1} ${cz} minecraft:obsidian`); } catch { return false; }
      // 一格悬空柱站不住：21:49:44 现场 `freefall v.y=-0.81 at (21, 90, -6)` —— 龙的身体盒一挤就把人推
      // 下去，接着就是虚空救援 + 高台全丢。把这一格扩成 3x3 平台（同一层多铺 8 格），人站在中间就被
      // 围着，掉不下去；这也是 09:50 那条"搭防爆墙"的同一类做法用在高台上。
      // 一格悬空柱站不住，3x3 也还是会被走掉（21:56 现场：抬升成功停在 -6,82,10，两秒后
      // `freefall at (0,69,10)` —— 末影人分支的"退开几格"把人带出台面）。台面做到 5x5：往任何方向
      // 退两格都还踩在自己铺的方块上，而不是踩空。这一层不碰人所在的那一格，不会埋人。
      for (const [ox, oz] of [[-2, -2], [-2, -1], [-2, 0], [-2, 1], [-2, 2], [-1, -2], [-1, 2], [0, -2], [0, 2], [1, -2], [1, -1], [1, 0], [1, 1], [1, 2], [2, -2], [2, -1], [2, 0], [2, 1], [2, 2], [-1, -1], [-1, 1], [0, -1], [0, 1], [1, -1]].filter(([a, b]) => Math.abs(a) + Math.abs(b) < 5)) {
        try { bot.chat(`/setblock ${cx + ox} ${cy - 1} ${cz + oz} minecraft:cobblestone`); } catch {}
        bot._opPillarCells = (bot._opPillarCells || 0) + 1;
        await sleep(50);
      }
      await settle();
      try { bot.chat(`/tp @s ${cx + 0.5} ${cy} ${cz + 0.5}`); } catch { return false; }
      p = await settle();
      if (p.y < cy - 1.6) {
        log.warn(`OP PERCH probe ${cx},${cy},${cz} still slid to y=${p.y.toFixed(1)} after a /setblock - next cell`);
        if (home) { try { bot.chat(`/tp @s ${home.x + 0.5} ${home.y} ${home.z + 0.5}`); } catch {} await settle(); }
        continue;
      }
    }
    // 返回 true 不等于"这一刀打得着"：调用方仍然用 dw<=9 决定近战/床爆，否则就在高台上开弓。
    const dd = p.distanceTo(t0.position);
    if (!await keepPerch(p, `OP PERCH LIFT (disclosed, ${bot._opPerch}/6 probes this window, ${bot._opPerchTotal}/40 this dive): 站在 ${cx},${p.y.toFixed(1)},${cz}（${cy} 层），龙现在 ${dd.toFixed(1)} 格外 - ${dd > 9.5 ? '留住岛内高台，下一回合从这里重新瞄' : '这一刀够得着'}`)) { continue; }
    return true;
  }
  return false;
}

// One free slot, paid for by the least useful thing in the pack. This exists because a full pack makes
// every other assist silently useless: 11:01:02 and 11:46:31 both read `the /give did not land (a full
// pack takes nothing)` / `skipped /give - the pack has no free slot`, and the thing that could not get in
// was the water bucket - the only counter to the enderman that has eaten 42 End deaths tonight. A `/give`
// to a full inventory is a NO-OP, so the grant is worth nothing until a slot exists. MC_ASSIST=0 never
// jettisons anything; it earns the slot the hard way (or dies holding 36 stacks).
const JETTISON_ORDER = ['wheat_seeds', 'rotten_flesh', 'bone', 'bone_meal', 'gold_nugget', 'iron_nugget',
  'andesite', 'diorite', 'granite', 'tuff', 'gravel', 'sand', 'dirt', 'grass_block', 'clay_ball', 'blackstone', 'basalt'];
async function freeOneSlot(bot, why, force) {
  if (process.env.MC_ASSIST === '0') return false;
  const slots = () => { try { return typeof bot.inventory.emptySlotCount === 'function' ? bot.inventory.emptySlotCount() : 1; } catch { return 0; } };
  // `force` exists because the client and the SERVER disagree: 11:57:38-11:58:23 logged four
  // `the /give did not land (a full pack takes nothing)` while `emptySlotCount()` still answered > 0, so
  // the early return below was a green light to a command that could not land. The caller that has just
  // watched its /give bounce passes force and the slot is bought back unconditionally.
  if (!force && slots() > 0) return true;
  let items = [];
  try { items = bot.inventory.items(); } catch { return false; }
  const rank = (n) => { const k = JETTISON_ORDER.indexOf(n); return k < 0 ? 999 : k; };
  let target = items.slice().sort((a, b) => rank(a.name) - rank(b.name)).find(i => rank(i.name) < 999);
  if (!target) {
    // Nothing on the junk list: the surplus paving is the only thing left that can pay for a bucket, and
    // OP PAVING puts it back on the next climb.
    target = items.filter(i => /^(cobblestone|cobbled_deepslate|stone|stone_bricks|end_stone)$/.test(i.name) && i.count >= 32)
      .sort((a, b) => b.count - a.count)[0];
  }
  if (!target) { log.warn(`NO SLOT (${why}): 36 stacks of ${items.slice(0, 5).map(i => i.name).join(',')} and none of it is on the jettison list`); return false; }
  const before = items.length;
  try { bot.chat(`/clear @s minecraft:${target.name}`); } catch { return false; }
  await sleep(1100);
  if (slots() > 0 || items.length < before) {
    log.warn(`OP JETTISON (disclosed): cleared ${target.count}x ${target.name} for a slot (${why}) - a /give that cannot land is not a supply`);
    return true;
  }
  log.warn(`OP JETTISON: /clear @s minecraft:${target.name} freed no slot (items ${before} -> ${(() => { try { return bot.inventory.items().length; } catch { return -1; } })()}) - ${why} cannot be answered here`);
  return false;
}

// How many crystals does the ISLAND have, as opposed to how many this client currently has loaded?
// The distinction decides the fight: a standing crystal heals the dragon faster than a bow can hurt it, and
// the entity-list count reads zero whenever the bot is standing away from the pillars - which is exactly the
// state at 13:10-13:13, where six consecutive readouts gave the same `190.25` and every arrow in between was
// spent against a dragon that could not drop. The server is the only witness here.
async function crystalCount(bot) {
  if (process.env.MC_ASSIST === '0') return null;
  if (Number.isFinite(bot._crystalCount) && bot._crystalCountAt && Date.now() - bot._crystalCountAt < 20000) return bot._crystalCount;
  bot._crystalCountAt = Date.now();
  const got = [];
  const reply = (msg) => { try { const t = msg.toString(); if (/^</.test(t) && !/QODER_CRYSTALS_PRESENT/.test(t)) return; got.push(t.slice(0, 160)); } catch {} };
  const chans = ['message', 'systemChat', 'selfMessage'];
  for (const ch of chans) { try { bot.on(ch, reply); } catch {} }
  try { bot.chat('/effect give @e[type=minecraft:end_crystal,limit=10] minecraft:glowing 2 0 true'); } catch {}
  await sleep(900);
  for (const ch of chans) { try { bot.removeListener(ch, reply); } catch {} }
  const text = got.join(' | ');
  // `/execute if entity ...` turned out to answer NOTHING at all on this server (13:20:06-13:22:12: six
  // probes, `replies=none in 0.9s`), which left the branch permanently conservative and the dragon
  // un-attackable. The effect form is the one this instance has already seen reply in chat (`Applied
  // effect Saturation to Numen`), and it counts: `Gave Glowing effect to N entities` / `No entities were
  // found`. A glow on a crystal for two seconds changes nothing about the fight.
  const cnt = /to (\d+) entit/i.exec(text);
  if (cnt) { bot._crystalCount = Number(cnt[1]); return bot._crystalCount; }
  if (/no entit|wasn't found|found 0|Unable to find/i.test(text)) { bot._crystalCount = 0; return 0; }
  log.warn(`CRYSTAL COUNT got no verdict (replies=${text.slice(0, 120) || 'none in 0.9s'}) - treating the island as if a crystal stands`);
  return null;
}

// 提前量：箭大约 3 格/刻(60 格/秒)飞行，而龙每两秒就能挪 10-23 格（17:28:50-17:29:07 现场实测）。
// 朝它"现在"的位置射，箭到的时候那里已经是空气 —— 这正是 `6 air shots ... bought nothing` 反复刷、
// 而血量读数 183.625 一小时纹丝不动的原因。按上一帧的位移算速度，再乘飞行时间外推。
function dragonLead(bot, d) {
  const now = Date.now();
  const prev = bot._dragonTrack;
  bot._dragonTrack = { x: d.position.x, y: d.position.y, z: d.position.z, at: now };
  const base = d.position.clone().offset(0, 1, 0);
  if (!prev) return base;
  const dt = Math.max(0.08, (now - prev.at) / 1000);
  const vx = (d.position.x - prev.x) / dt, vy = (d.position.y - prev.y) / dt, vz = (d.position.z - prev.z) / dt;
  const speed = Math.hypot(vx, vy, vz);
  if (speed > 45) return base;                  // 一次异常采样(传送/换维)不能把准星甩到地图外
  const flight = Math.min(2.0, bot.entity.position.distanceTo(d.position) / 60);
  return new Vec3(d.position.x + vx * flight, d.position.y + vy * flight + 1, d.position.z + vz * flight);
}

// 高位伏击：龙在飞的时候，站在岛面上任何武器都够不着它（近战要 4 格，弓箭在 40+ 格基本全脱靶）。
// 水晶打完之后【柱子还在原地】，而 `_crystalSpots` 记的就是柱顶坐标 —— 把它当爬升目标，
// 用已经验证过的 liftOntoPillar 站上去，就等于和龙的巡航高度持平。玩家在末地就是这么耗龙的。
async function highGroundPerch(bot) {
  let spots = Object.values(bot._crystalSpots || {}).filter(s => s && Number.isFinite(s.x) && s.y > 60);
  if (!spots.length) {
    // 重连把内存洗掉了，但柱子还在原处：读回上一次记录的柱顶坐标。
    try {
      const saved = JSON.parse(require('fs').readFileSync(require('../config').paths.runs + '/pillar_spots.json', 'utf8'));
      bot._crystalSpots = Object.assign({}, saved, bot._crystalSpots || {});
      spots = Object.values(bot._crystalSpots).filter(s => s && Number.isFinite(s.x) && s.y > 60);
      if (spots.length) log.warn(`highGround: 从 runs/pillar_spots.json 读回 ${spots.length} 个柱顶坐标（内存里被重连洗掉了）`);
    } catch {}
  }
  if (!spots.length) return { ok: false, why: 'no pillar top on file (never seen a crystal this dive)' };
  const p = bot.entity.position;
  const s = spots.sort((a, b) => Math.hypot(a.x - p.x, a.z - p.z) - Math.hypot(b.x - p.x, b.z - p.z))[0];
  bot._pillarTarget = { x: s.x, z: s.z };       // 让 endGround 知道这根柱子是任务，别把它从柱底拽走
  const fake = { id: -1, position: new Vec3(s.x + 0.5, s.y, s.z + 0.5) };
  const r = await liftOntoPillar(bot, fake);
  if (r.ok) { bot._holdRounds = 0; bot._airShots = 0; }
  return r;
}

// 指令立柱。climbOut 靠"跳起来把脚垫出去"，而末地岛面上这一脚经常抬不出自己那一格：20:21:59 现场连打
// 6 轮 `climbOut: jump did not clear 26,58,17 (y=58.58, physicsEnabled=true)`，接着
// `就地搭塔 58 -> 58（目标 y=87）还差 29 格` —— 高位伏击因此永远站不上去，只能用 40-60 格外的抛物线撒箭
// （实测 3-6 箭磨掉 0 点）。玩家遇到这种情况会换个地方搭，但真正不依赖跳跃时序的做法是：先把人抬到柱顶
// 上方，再【从最上面那格往下画】。画每一格的时候人都还在它上面，所以既不会把自己埋进方块（那一类债已经
// 付过两个世界），也不需要把跳跃和服务端时序对上。
async function opPillarUp(bot, targetY, label) {
  if (process.env.MC_ASSIST === '0') return { ok: false, why: 'MC_ASSIST=0 - 验收实例不立柱' };
  const legs = [];
  for (let leg = 0; leg < 4; leg++) {
    if (bot.entity.position.y >= targetY - 1) break;
    const f = bot.entity.position.floored();
    if ((bot._opPillarCells || 0) + 10 > 150) return { ok: false, why: `指令立柱的配额已用尽（${bot._opPillarCells}/150 格）` };
    let under = null;
    try { under = bot.blockAt(new Vec3(f.x, f.y - 1, f.z)); } catch {}
    if (!under || under.boundingBox !== 'block') return { ok: false, why: `立柱脚下读不到实体方块（${under ? under.name : 'NULL'}）` };
    const top = Math.min(targetY - 1, f.y + 9);
    try { bot.chat(`/tp @s ${f.x + 0.5} ${top + 2} ${f.z + 0.5}`); } catch { return { ok: false, why: '抬人的 /tp 自己抛了' }; }
    await sleep(220);
    for (let y = top; y >= f.y + 1; y--) {
      try { bot.chat(`/setblock ${f.x} ${y} ${f.z} minecraft:cobblestone`); } catch {}
      bot._opPillarCells = (bot._opPillarCells || 0) + 1;
      await sleep(70);
    }
    await sleep(1400);
    const q = bot.entity.position.floored();
    legs.push(q.y);
    log.warn(`OP PILLAR (disclosed): 这一列从 ${f.y} 画到 y=${top}，人现在 ${q.x},${q.y},${q.z} - ${label || '高位塔'}`);
    if (q.y <= f.y) return { ok: false, why: `画完仍然停在 ${q.y}，柱没接住` };
  }
  return { ok: bot.entity.position.y >= targetY - 1, at: bot.entity.position.floored(), legs };
}

// 自己搭塔上高位：`_crystalSpots` 这条依赖在末地后半段是死的 —— 水晶全掉光之后再也不会被看见，
// 17:47:41 / 17:48:14 现场两次 `高位伏击 去不了(no pillar top on file)` 就是这个。而龙绕飞的巡航高度
// 就在 y≈85-95，玩家的做法是就地垫圆石搭上去（铺料由 OP PAVING 供）。
async function highGroundTower(bot, d) {
  const rNow = Math.hypot(bot.entity.position.x, bot.entity.position.z);
  if (rNow > 40) return { ok: false, why: `在岛外 r=${Math.round(rNow)}，塔根没有支撑` };
  // 塔根必须是干格：18:55:11 / 18:56:15 现场 `就地搭塔 57 -> 58 ... 还差 28 格` —— 它站在自己给末影人
  // 泼的水里，climbOut 既不能往自己那格放水方块也跳不出水面，于是每一段只涨 1 格。
  // 先花一次到位（喷泉圈内找干格）再起塔。
  try {
    const wf = bot.entity.position.floored();
    const feetB = bot.blockAt(new Vec3(wf.x, wf.y, wf.z));
    const underB = bot.blockAt(new Vec3(wf.x, wf.y - 1, wf.z));
    if ((feetB && /water/.test(feetB.name)) || (underB && /water/.test(underB.name))) {
      const moved = await fountainApproach(bot);
      log.warn(`highGround: 塔根泡在水里 -> ${moved ? '先离开水格' : '圈内找不到干格'}`);
    }
  } catch {}
  const target = Math.min(105, Math.ceil(d.position.y) + 1);
  const need = target - Math.floor(bot.entity.position.y) + 6;
  if (P.cheapFillTotal(bot) < need) await refuelFiller(bot, need + 10);
  const before = Math.floor(bot.entity.position.y);
  let after = before;
  // 一次 climbOut 只肯爬 6 格（18:01:20 现场：59 -> 65，目标 83，我却按"+6 即到位"报了成功）。
  // 塔要真爬到离龙巡航高度 10 格以内才有意义，所以反复爬，直到接近目标、铺料用完，或某轮完全不涨。
  for (let k = 0; k < 5; k++) {
    if (after >= target - 10) break;
    await capped(climbOut(bot, target), 120000, `tower to the dragon altitude (leg ${k + 1})`).catch(() => null);
    let now = Math.floor(bot.entity.position.y);
    if (now <= after) {
      // 跳不出自己那格 -> 换指令立柱（同一件事的两种做法，一种靠跳跃时序，一种靠"抬起来再往下画"）
      const pil = await opPillarUp(bot, target, '就地搭塔');
      now = Math.floor(bot.entity.position.y);
      if (now <= after) { log.warn(`highGround: 第 ${k + 1} 段没长进（还在 y=${now}，目标 y=${target}）指令立柱也没接住（${pil.why || '无理由'}）- 停止搭塔`); break; }
    }
    after = now;
    if (P.cheapFillTotal(bot) < 8) { log.warn(`highGround: 铺料只剩 ${P.cheapFillTotal(bot)}，停在 y=${after}`); break; }
  }
  const ok = after >= target - 10;
  log.warn(`highGround: 就地搭塔 ${before} -> ${after}（目标 y=${target}，铺料 ${P.cheapFillTotal(bot)}）${ok ? '到位' : `还差 ${target - after} 格`}`);
  return { ok, at: { x: bot.entity.position.floored().x, y: after, z: bot.entity.position.floored().z } };
}

// 到喷泉边上等栖息：`hold the fountain` 一直在用 pathfinder 走 (0,y,0)，18:11 现场它离中心 30-52 格、
// goto 每轮都超时/被取消，于是龙每次栖息它都在射程外（`no perch-level footing ... out of reach (29.6)`）。
// 玩家在末地是走过去的，但这里的寻路在岛缘水洼里不可靠，所以用同一条已经验证过的办法：
// 试候选格 -> /tp -> 用重力验证真的站住了。落点必须在主岛内、脚下是实体方块、头上一格是干的空气。
async function fountainApproach(bot) {
  if (process.env.MC_ASSIST === '0') return false;             // 这是指令辅助，验收实例一律不走
  const p = bot.entity.position;
  const bearing = Math.atan2(p.z, p.x);
  const cands = [];
  for (const rr of [12, 10, 14, 8, 18]) {
    for (let k = 0; k < 4; k++) {
      const a = bearing + Math.PI + k * (Math.PI / 2);   // 从中心朝 bot 那一侧的四条半径出发
      cands.push({ x: Math.round(Math.cos(a) * rr), z: Math.round(Math.sin(a) * rr) });
    }
  }
  for (const c of cands) {
    let y = null;
    // y 下限必须是 58：18:29:51 那次它"到位"到了 5,53,4 —— 中心 65 那层被喷泉床岩占了，我的扫描一路往下
    // 找到了【岛底下的空洞】，龙在头顶 28 格而它在岛壳里面，比不站过去还糟。
    for (let yy = 74; yy >= 58; yy--) {
      let under = null, feet = null, head = null;
      try { under = bot.blockAt(new Vec3(c.x, yy - 1, c.z)); feet = bot.blockAt(new Vec3(c.x, yy, c.z)); head = bot.blockAt(new Vec3(c.x, yy + 1, c.z)); } catch { continue; }
      const solidUnder = !!under && (under.boundingBox === 'block' || under.boundingBox === 'collision');
      const clearAir = (!feet || feet.boundingBox === 'none' || /air|water/.test(feet.name)) && (!head || head.boundingBox === 'none' || /air|water/.test(head.name));
      if (solidUnder && clearAir && !/water/.test((feet || {}).name || '')) { y = yy; break; }
    }
    if (y === null) continue;
    try { bot.chat(`/tp @s ${c.x + 0.5} ${y} ${c.z + 0.5}`); } catch { return false; }
    await sleep(1600);
    const f = bot.entity.position.floored();
    if (Math.hypot(f.x, f.z) > 20) continue;                      // 没落在中心圈里
    if (bot.entity.position.y < y - 0.4) continue;               // 站不住 = 那是空气
    if (!inEnd(bot)) return false;
    log.warn(`fountainApproach (disclosed): 站到了喷泉圈内的 ${f.x},${f.y},${f.z}（离中心 ${Math.round(Math.hypot(f.x, f.z))} 格），栖息窗口现在够得着`);
    bot._endSafe = { x: f.x, y: f.y, z: f.z };
    return true;
  }
  log.warn('fountainApproach: 喷泉圈内 25 个候选格都没有站得住的干格');
  return false;
}

function endGround(bot) {
  const f = bot.entity.position.floored();
  const under = bot.blockAt(f.offset(0, -1, 0));
  const radius = Math.hypot(f.x, f.z);
  const solid = !!under && under.boundingBox === 'block';
  // The safe cell has to satisfy the SAME radius test as `danger`. With `< 60` here, a bot sitting at
  // r=51 (already danger by the line below) OVERWROTE its safe cell with its own position, so endRescue
  // walked it toward where it already stood, gained nothing, and that is why nine "attempts" fit inside
  // seven seconds at 04:17:09 -> 04:17:16 before the dive was abandoned.
  // ...but the obsidian pillars stand OUTSIDE the main island (r ~ 40-70), so "leave the island" and "walk
  // to the pillar this dive committed to" are the same walk. With the radius rule alone the crystal could
  // never be reached: 05:42-05:52 interleaved `end footing unsafe (off the main island (r=45))` with four
  // `climbing attempts left it at y=59 of an 86 pillar`, because the rescue yanked it off each column base
  // before the climb or the lift could finish. Standing on solid ground at the committed pillar IS safe.
  const pt = bot._pillarTarget || ownPillar(bot);
  const onPillar = !!(pt && Number.isFinite(pt.x) && Math.hypot(f.x - pt.x, f.z - pt.z) <= 8 && solid && f.y > 40);
  // The SAFE CELL stays on the main island even though the pillar is no longer an emergency: `endRescue`
  // walks toward it by looking at it and holding forward for 0.9 s, so a safe cell recorded on a column
  // 45 blocks out turns that walk into a path across the void (seen immediately after this shipped:
  // `end footing unsafe (nothing under feet); rescue gained nothing (r 65 -> 89)` nine attempts in a row,
  // each one further out). Only the danger flag is relaxed at the committed pillar.
  if (solid && f.y > 40 && radius < 43) bot._endSafe = { x: f.x, y: f.y, z: f.z };
  const danger = !solid || f.y < 42 || (radius > 43 && !onPillar);
  return { danger, reason: !solid ? 'nothing under feet' : (radius > 43 && !onPillar) ? `off the main island (r=${Math.round(radius)})` : `falling (y=${f.y})`, at: bot._endSafe || null };
}

async function endRescue(bot) {
  // With no recorded safe cell the old version only had an OP teleport to offer, and the moment the
  // fight started after a reconnect (`_endSafe` lives on the bot object, which is new every login) it
  // burned `/tp @s 0 68 20` or returned false. The island centre is home whether or not a safe cell was
  // ever recorded, so aim at that and walk.
  const f = bot.entity.position.floored();
  const s = bot._endSafe || { x: 0, y: f.y, z: 0 };
  if (!bot._endSafe && process.env.MC_ASSIST !== '0') { try { bot.chat('/tp @s 0 68 20'); await sleep(4000); return true; } catch {} }
  try {
    await bot.look(Math.atan2(s.z - bot.entity.position.z, s.x - bot.entity.position.x) - Math.PI / 2, 0.1, true);
    bot.setControlState('back', false);
    bot.setControlState('forward', true);
    await sleep(900);
    bot.setControlState('forward', false);
  } catch {}
  if (Math.hypot(bot.entity.position.x - s.x, bot.entity.position.z - s.z) > 3) {
    await capped(bot.pathfinder.goto(new (GN())(s.x, s.y, s.z, 1)), 12000, 'back to safe footing').catch(() => {});
  }
  return true;
}

// Standing cells on the main island, found from the client's own block view and ordered nearest the bot's
// own radial line, so a lift puts it back on the side it was already working rather than across the map.
// The scan is 6 radii x a bounded y window - deliberately NOT a findBlock over a sphere, which is the
// shape that pinned the event loop twice (see the 2026-11-02 note on synchronous wide scans).
function islandCellCandidates(bot) {
  const p = bot.entity.position;
  const r = Math.hypot(p.x, p.z) || 1;
  const ux = p.x / r, uz = p.z / r;
  const out = [];
  for (const rr of [30, 24, 36, 18, 12, 6]) {
    const cx = Math.round(ux * rr), cz = Math.round(uz * rr);
    for (let y = 78; y >= 50; y--) {
      let under = null, feet = null;
      try { under = bot.blockAt(new Vec3(cx, y - 1, cz)); feet = bot.blockAt(new Vec3(cx, y, cz)); } catch { under = null; }
      if (under && under.boundingBox === 'block' && (!feet || feet.boundingBox === 'none' || /air|water/.test(feet.name))) {
        out.push({ x: cx, y, z: cz });
        break;
      }
    }
  }
  return out;
}

// The "human to lead" that `cannot hold safe footing in the End` has been asking for since the ladder
// started: 31 of 59 deaths tonight were End deaths and the last read `DIED at {x:3,y:-91,z:-86}`, which
// is the void UNDER the island - a bot that slips off the rim has no walk home and no bridge to build
// into empty air. This puts it back on a cell it can verify, and only then claims success.
// MC_ASSIST=0 never sends the command.
async function opVoidLift(bot, why) {
  if (process.env.MC_ASSIST === '0') return false;
  const cands = islandCellCandidates(bot);
  if (!cands.length) {
    log.warn(`VOID LIFT: no island cell readable from r=${Math.round(Math.hypot(bot.entity.position.x, bot.entity.position.z))} (${cands.length} candidates) - ${why}, but nothing to stand on`);
    return false;
  }
  // 先回【自己铺的栖息台面】：22:51-22:57 现场伤害速率被抬到 2.1 点/分钟（8 分钟掉 17 血），紧接着
  // `VOID LIFT ... lifted 5,76,3 onto the island at 27,58,14 (safe cell re-learned)` 把 `_endSafe`
  // 重新学回岛面 —— 那条路一夜之间把高台丢了三次，速率也跟着归零。脚下还实就回台面，不许把"安全"
  // 降级成岛面。
  const deck = bot._perchDeck || bot._endSafe;
  if (deck && deck.y >= 75 && Math.hypot(deck.x, deck.z) < 43) {
    let dUnder = null;
    try { dUnder = bot.blockAt(new Vec3(deck.x, deck.y - 1, deck.z)); } catch {}
    if (dUnder && dUnder.boundingBox === 'block') {
      try { bot.chat(`/tp @s ${deck.x + 0.5} ${deck.y} ${deck.z + 0.5}`); } catch {}
      await sleep(1600);
      const f2 = bot.entity.position.floored();
      if (f2.y >= deck.y - 1) {
        log.warn(`VOID LIFT (disclosed): 回到自己的栖息台面 ${deck.x},${deck.y},${deck.z}（${why}）- 不降级成岛面`);
        return true;
      }
      bot._perchDeck = null;   // 台子已经接不住人了（被拆/被挤），别再记它
      log.warn(`VOID LIFT: 栖息台面 ${deck.x},${deck.y},${deck.z} 站不住（${why}）- 忘掉它，改用岛上别的干格`);
    }
  }
  for (const c of cands) {
    const from = { x: Math.round(bot.entity.position.x), y: Math.round(bot.entity.position.y), z: Math.round(bot.entity.position.z) };
    try { bot.chat(`/tp @s ${c.x + 0.5} ${c.y} ${c.z + 0.5}`); } catch { return false; }
    await sleep(1800);
    const f = bot.entity.position.floored();
    let under = null;
    try { under = bot.blockAt(new Vec3(f.x, f.y - 1, f.z)); } catch {}
    if (under && under.boundingBox === 'block' && Math.hypot(f.x, f.z) < 43 && f.y >= 45) {
      bot._endSafe = { x: f.x, y: f.y, z: f.z };
      log.warn(`VOID LIFT (disclosed): ${why} - lifted ${from.x},${from.y},${from.z} onto the island at ${f.x},${f.y},${f.z} on ${under.name} (safe cell re-learned)`);
      return true;
    }
    log.warn(`VOID LIFT probe ${c.x},${c.y},${c.z} ended on ${under ? under.name : 'NULL'} at ${f.x},${f.y},${f.z} - trying the next ring cell`);
  }
  return false;
}

// A crystal behind iron bars (or glass, or a chain) does not take an arrow: the bars are a full solid
// box, so every shot lands on the cage, the crystal heals the dragon untouched, and the quiver empties.
// Six dives, 35+ arrows spent, `crystal ... destroyed` never once printed in 1,580,000 log lines, and the
// player watching the island from the surface said the reason outright - some of them are caged. The fix
// is his instruction as a mechanic: find the cage, go up to it, dig an opening, THEN shoot.
const CAGE_BLOCKS = /(^iron_bars$|^glass$|^glass_pane$|_glass$|_glass_pane$|^chain$|^tinted_glass$|^beacon$|^iron_door$)/;
function isCageBlock(name) { return CAGE_BLOCKS.test(name) && !/obsidian|bedrock/.test(name); }
function crystalCage(bot, crystal) {
  const out = [];
  if (!crystal || !crystal.position) return out;
  const c = crystal.position.floored();
  for (let dx = -2; dx <= 2; dx++) {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dz = -2; dz <= 2; dz++) {
        let b = null;
        try { b = bot.blockAt(new Vec3(c.x + dx, c.y + dy, c.z + dz)); } catch { b = null; }
        // Obsidian is the pillar the crystal stands on, not a cage - never dig the floor out from under it.
        if (b && isCageBlock(b.name)) out.push(b);
      }
    }
  }
  return out;
}
// What the arrow would actually hit first, walking the straight line from the eye to the crystal.
function shotBlocker(bot, from, to) {
  const d = Math.max(1, Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z));
  const n = Math.ceil(d * 2);
  let last = '';
  for (let i = 1; i < n; i++) {
    const t = i / n;
    const p = new Vec3(from.x + (to.x - from.x) * t, from.y + (to.y - from.y) * t, from.z + (to.z - from.z) * t).floored();
    const k = `${p.x},${p.y},${p.z}`;
    if (k === last) continue;
    last = k;
    let b = null;
    try { b = bot.blockAt(p); } catch { b = null; }
    if (b && b.boundingBox === 'block' && P.isAir(b.name) === false) return b;
  }
  return null;
}

// A crystal on top of a 20-30 block obsidian pillar cannot be shot from where the bot parks. Measured
// 17:15-17:16: arrows away at crystal #51 from 37-46 blocks (lift 3.9-6.0) with the ray clipping obsidian
// at -39,88,-1 / -39,89,-1 / -39,88,0 each round, then three more at #39 through a column at 31,80,23 -
// six arrows, zero crystals, and the escalation was "walk under the crystal and climb its column", which
// on a bare pillar has never once found footing (`climbed to y=66 - stopped: nothing solid under my feet
// to build on`, three times). The island's pillars get in each other's way from the middle, so search the
// bearing ring around the crystal for a cell that stands on rock, sits outside the blast, and has a ray
// that hits nothing but air.
function clearShotSpot(bot, crystal) {
  const eye = bot.entity.position;
  const fy = eye.floored().y;
  const c = crystal.position;
  const baseAng = Math.atan2(eye.z - c.z, eye.x - c.x);
  // Live 02:10:05-02:10:18, the first dive with the sticky target: it rejected all 36 probes and printed
  // `ray blocked 0, no floor/unloaded 1, occupied 15, off the rim 20`. So NOT ONE cell was dropped for a
  // blocked line - the search lost on GEOMETRY, because it assumed every candidate cell sits at the bot's
  // own floor level. The island is a lump: at 16-34 blocks from a pillar base the surface is two to four
  // levels above or below wherever the bot happens to stand, so those cells are solid rock "occupied" or
  // float over nothing. Sweep the height as well as the bearing, and judge the ray from the eye the stand
  // cell actually gives.
  const t = { probes: 0, rim: 0, noFloor: 0, occupied: 0, blast: 0, ray: 0, threw: 0 };
  for (const dAng of [0, 0.45, -0.45, 0.9, -0.9, 1.4, -1.4, 2.1, -2.1]) {
    const ang = baseAng + dAng;
    for (const R of [16, 22, 28, 34]) {
      const x = Math.round(c.x + Math.cos(ang) * R), z = Math.round(c.z + Math.sin(ang) * R);
      if (Math.hypot(x, z) > 38) { t.rim++; t.probes++; continue; }              // must stay on the main island
      let found = null;
      // The island is a LUMP, not a floor at one height: 03:17:13-03:17:37 live gave 240 probes and
      // `ray blocked 0` every single time, with the failures split between void columns (`no floor 106`)
      // and cells buried in solid rock (`occupied 115`). Probing +-9 levels off the bot's own y still
      // missed, because the answer is not a window around where it happens to stand - it is the top of
      // that column. Scan each candidate from above and take the first cell a body fits in, exactly the
      // way a player walks out onto the highest ledge and shoots from there.
      t.probes++;
      let sawSurface = false;
      for (let y = fy + 13; y >= fy - 5; y--) {
        let under = null, feet = null, head = null;
        try {
          under = bot.blockAt(new Vec3(x, y - 1, z));
          if (!isGround(under)) continue;                                 // still above the surface
          feet = bot.blockAt(new Vec3(x, y, z));
          head = bot.blockAt(new Vec3(x, y + 1, z));
        } catch { t.threw++; sawSurface = true; break; }
        // The column's surface is here: whatever it turns out to be, a lower cell in the same column is
        // inside rock and is not what a player would shoot from.
        sawSurface = true;
        if ((feet && feet.boundingBox !== 'none') || (head && head.boundingBox !== 'none')) { t.occupied++; break; }
        const d = Math.hypot(x - c.x, y + 1.6 - c.y, z - c.z);
        if (d < 11) { t.blast++; break; }                                  // inside the crystal's own blast
        if (shotBlocker(bot, new Vec3(x + 0.5, y + 1.6, z + 0.5), c)) { t.ray++; break; }
        found = { y, dy: y - fy, d }; break;
      }
      if (!found && !sawSurface) t.noFloor++;                              // nothing to stand on in that column at all
      if (found) {
        log.warn(`clearShotSpot: ${x},${found.y},${z} reads CLEAR for crystal #${crystal.id} (${found.d.toFixed(0)} blocks, R=${R}, ${found.dy >= 0 ? '+' : ''}${found.dy} levels off my own y=${fy}) after ${t.probes} probes (ray ${t.ray}, noFloor ${t.noFloor}, occupied ${t.occupied})`);
        return { x, y: found.y, z, r: R, d: found.d };
      }
    }
  }
  log.warn(`clearShotSpot: no CLEAR cell for crystal #${crystal.id} in ${t.probes} probes - ray blocked ${t.ray}, no floor/unloaded ${t.noFloor}, occupied ${t.occupied}, off the rim ${t.rim}, inside blast ${t.blast}, threw ${t.threw}`);
  return null;
}

// The escalation the player described for a crystal that survives arrows: stand on the pillar top, put two
// blocks between me and the crystal so the blast has to eat those instead of me, then LEFT-CLICK it.
// The screen must not sit on the punch line or the hit never lands (the server refuses an attack through a
// solid cell), so the cells are taken one step to either side of the direct axis - which still covers the
// rays to the bot's legs and torso, and is verified with the same ray test the bow uses.
// Two cobblestone beside the bot's feet, placed by command and VERIFIED by reading both cells back. This
// exists because the blast screen is the last step of the sequence that actually drops a crystal, and
// tonight it failed for reasons the End cannot answer: no dry support on an obsidian top (10:22:49), no
// paving left after 343 cells of unread column (10:38:24), and a pack so full that even `/give` bounced
// off it (10:40:54). MC_ASSIST=0 never reaches it, and a screen that does not read back solid refuses the
// punch - an unbuilt screen means the blast takes the shooter, which is `blown up by 自己` in the records.
async function opScreenAt(bot, x, y, z, crystalId) {
  if (process.env.MC_ASSIST === '0') return false;
  // A cell that is already solid is already a screen: minting it again spent the dive's budget on ground
  // that existed. Live 11:19:39-11:19:40 crystal #50 burned all eight screens on candidate cells it had
  // built seconds before, then `OP SCREEN cap reached` starved every remaining crystal in the same dive.
  let already = 0;
  for (const dy of [0, 1]) {
    try { const b0 = bot.blockAt(new Vec3(x, y + dy, z)); if (b0 && (b0.boundingBox === 'block' || b0.boundingBox === 'collision')) already++; } catch {}
  }
  if (already >= 2) return true;
  bot._opScreensByCrystal = bot._opScreensByCrystal || {};
  const perCrystal = bot._opScreensByCrystal[crystalId] = bot._opScreensByCrystal[crystalId] || 0;
  // Nine candidate cells are tried in a single punch round, so a cap of 4 was exhausted by ONE round on
  // ONE crystal and every later crystal in the dive read "cap reached" (live 12:19-12:21, #43). The cap
  // that matters is per crystal: five screens on the same pillar is a habit, twelve is still a route.
  if (perCrystal >= 12) { log.warn(`OP SCREEN cap reached for crystal #${crystalId} (${perCrystal} on this pillar) - twelve candidate cells is the route, the thirteenth is a habit`); return false; }
  bot._opScreens = (bot._opScreens || 0);
  if (bot._opScreens >= 40) { log.warn('OP SCREEN dive cap (40) reached - there are only ten crystals'); return false; }
  const bf = bot.entity.position.floored();
  if (x === bf.x && z === bf.z) return false;                 // never wall in the bot's own column
  let laid = 0;
  for (const dy of [0, 1]) {
    try { bot.chat(`/setblock ${x} ${y + dy} ${z} minecraft:cobblestone`); } catch { return false; }
    await sleep(700);
    let b = null;
    try { b = bot.blockAt(new Vec3(x, y + dy, z)); } catch {}
    if (b && (b.boundingBox === 'block' || b.boundingBox === 'collision')) laid++;
  }
  if (laid < 2) {
    log.warn(`OP SCREEN: only ${laid}/2 cells at ${x},${y},${z} read solid - not punching into an unbuilt screen`);
    return false;
  }
  bot._opScreens++;
  bot._opScreensByCrystal[crystalId] = perCrystal + 1;
  log.warn(`OP SCREEN (disclosed, ${perCrystal + 1}/4 on crystal #${crystalId}, ${bot._opScreens}/30 this dive): /setblock cobblestone at ${x},${y},${z} +1 - no dry support and no packing hand to build the blast screen with`);
  return true;
}

async function blastScreenAndPunch(bot, crystal) {
  // The screen and the punch both need ARM'S REACH, and since the 09:50 tactic nothing else in this skill
  // walks the bot there - the bow used to be the long-range half. Without this, a crystal 20-30 blocks away
  // on the same level gets four `punched it and it is still there` rounds, because `use_entity` at that
  // distance is simply refused by the server (measured in the S2 fixture at 24.5 blocks).
  const d0 = bot.entity.position.distanceTo(crystal.position);
  if (d0 > 3.6) {
    await capped(bot.pathfinder.goto(new (GN())(crystal.position.x, bot.entity.position.y, crystal.position.z, 2)), 14000, 'walk to the crystal').catch(() => {});
    const d1 = bot.entity.position.distanceTo(crystal.position);
    log.warn(`kill_dragon: crystal #${crystal.id} was ${d0.toFixed(0)} blocks off - closed to ${d1.toFixed(1)} before screening and punching`);
    if (d1 > 4.6) return { ok: false, approaching: true, why: `walked to ${d1.toFixed(1)} blocks of crystal #${crystal.id} and could not close the last stretch (a punch needs 4), so no swing was spent` };
  }
  const f = bot.entity.position.floored();
  const ax = crystal.position.x - bot.entity.position.x, az = crystal.position.z - bot.entity.position.z;
  const sx = Math.abs(ax) >= Math.abs(az) ? Math.sign(ax) : 0;
  const sz = sx === 0 ? Math.sign(az) : 0;
  const offs = [];
  if (sx) offs.push([sx, 1], [sx, -1], [sx * 2, 1], [sx * 2, -1]);
  if (sz) offs.push([1, sz], [-1, sz], [1, sz * 2], [-1, sz * 2]);
  offs.push([sx, sz]);   // last resort: straight in front, if the punch line still clears it
  const it = P.cheapFill(bot, 2);
  if (!it) log.warn(`kill_dragon: no paving block in the pack to screen with (holds ${bot.inventory.items().slice(0, 4).map(i => `${i.count}x${i.name}`).join(',') || 'nothing'}) - trying the disclosed /setblock screen instead of abandoning the pillar`);
  const eye = bot.entity.position.offset(0, 1.6, 0);
  for (const [ox, oz] of offs) {
    if (!ox && !oz) continue;
    const cell = new Vec3(f.x + ox, f.y, f.z + oz);
    const support = it ? bot.blockAt(new Vec3(cell.x, cell.y - 1, cell.z)) : null;
    if (!support || support.boundingBox !== 'block' || /lava|water/.test(support.name)) {
      // No dry support under the screen cell is the normal case on an OBSIDIAN pillar top read from an
      // unloaded neighbour: at 10:22:49 and 10:38:24 it killed every attempt with `no cell beside the
      // crystal would take a 2-high screen`, after the disclosed lift had already put the bot 2 blocks
      // from the crystal. A `/setblock` needs no support and no inventory slot (the pack at 10:40:54
      // could not even take a bucket), so the two screen cells go in by command and the punch proceeds.
      const op = await opScreenAt(bot, cell.x, cell.y, cell.z, crystal.id);
      if (!op) continue;
      if (shotBlocker(bot, eye, crystal.position)) {
        log.warn(`kill_dragon: the OP screen at ${cell.x},${cell.y},${cell.z} covers the punch line - trying the next cell`);
        continue;
      }
      log.warn(`kill_dragon: OP screen at ${cell.x},${cell.y},${cell.z} - LEFT-CLICKING crystal #${crystal.id} (${bot.entity.position.distanceTo(crystal.position).toFixed(1)} blocks)`);
      try { bot.attack(crystal); } catch (e) { log.warn(`kill_dragon: punch threw ${e.message}`); }
      await sleep(600);
      const goneOp = inEnd(bot) && !Object.values(bot.entities).some(e => e.id === crystal.id);
      return { ok: goneOp, why: goneOp ? null : `punched crystal #${crystal.id} behind the OP screen and it is still there` };
    }
    let laid = 0;
    for (const dy of [0, 1]) {
      const ref = dy === 0 ? support : bot.blockAt(new Vec3(cell.x, cell.y, cell.z));
      if (!ref || (dy === 1 && (ref.boundingBox !== 'block' || ref.name !== it.name))) break;
      try {
        await bot.equip(it, 'hand');
        if (!bot.heldItem || bot.heldItem.name !== it.name) return { ok: false, why: `the hand would not take ${it.name} (holds ${bot.heldItem ? bot.heldItem.name : 'nothing'})` };
        await capped(bot.placeBlock(ref, new Vec3(0, 1, 0)), 4000, 'place the blast screen');
      } catch (e) { break; }
      if (bot.blockAt(new Vec3(cell.x, cell.y + dy, cell.z))) laid++;
      if (laid >= 2) break;
    }
    if (laid < 2) {
      // The other way the screen fails on a pillar top: the support reads fine and the SERVER never answers
      // the placement. Live 10:48:22-10:48:40, six consecutive `place the blast screen threw Server did not
      // answer the placement at (-13, 85, -40)` on the cage roof the disclosed lift had just put the bot on,
      // and the dive gave up a crystal it was standing next to. `/setblock` is not on that path.
      const op2 = await opScreenAt(bot, cell.x, cell.y, cell.z, crystal.id);
      if (!op2) continue;
      if (shotBlocker(bot, eye, crystal.position)) {
        log.warn(`kill_dragon: the OP screen at ${cell.x},${cell.y},${cell.z} covers the punch line - trying the next cell`);
        continue;
      }
      log.warn(`kill_dragon: OP screen at ${cell.x},${cell.y},${cell.z} after ${it ? it.name : 'nothing'} was refused - LEFT-CLICKING crystal #${crystal.id} (${bot.entity.position.distanceTo(crystal.position).toFixed(1)} blocks)`);
      try { bot.attack(crystal); } catch (e) { log.warn(`kill_dragon: punch threw ${e.message}`); }
      await sleep(600);
      const goneOp2 = inEnd(bot) && !Object.values(bot.entities).some(e => e.id === crystal.id);
      return { ok: goneOp2, why: goneOp2 ? null : `punched crystal #${crystal.id} behind the OP screen and it is still there` };
    }
    if (shotBlocker(bot, eye, crystal.position)) {
      log.warn(`kill_dragon: the ${it.name} screen at ${cell.x},${cell.y},${cell.z} covers the punch line - leaving it up (it still eats blast) and trying the next cell`);
      continue;
    }
    log.warn(`kill_dragon: screened with 2x ${it.name} at ${cell.x},${cell.y},${cell.z} - LEFT-CLICKING crystal #${crystal.id} (${bot.entity.position.distanceTo(crystal.position).toFixed(1)} blocks)`);
    try { bot.attack(crystal); } catch (e) { log.warn(`kill_dragon: punch threw ${e.message}`); }   // use_entity, synchronous
    await sleep(600);
    // A crystal missing from the list is only a KILL while the End is still loaded: a death unloads every
    // entity at once (05:34:59, `crystal 143 destroyed (down=1)` printed to a bot already face-down in the
    // Overworld), so the credit has to check the dimension it is claiming progress in.
    const gone = inEnd(bot) && !Object.values(bot.entities).some(e => e.id === crystal.id);
    return { ok: gone, why: gone ? null : `punched crystal #${crystal.id} behind the screen and it is still there` };
  }
  return { ok: false, why: 'no cell beside the crystal would take a 2-high screen (no dry support to build on)' };
}

reg.define('kill_dragon', {
  desc: 'Drop every end crystal by building up beside it, walling off the blast and punching it (no bow needed for that), then attack the perched Ender Dragon with the sword and the arrows that are left; uses the void-death reset if it stalls.',
  params: {},
  async run(bot, a) {
    if (!inEnd(bot)) return { ok: false, observation: 'not in the End' };
    // A bow is for the dragon, not for the crystals: since the 09:50 tactic every crystal falls to the
    // pillar sequence. Refusing the dive without one is what made an arrow-less End trip impossible, and
    // the perch is melee'd anyway (that is the branch that has never taken dragon damage).
    // Nine crystals need at least ~9 reliable shots and the dragon needs more; the measured fight wants
    // a couple of stacks. Arrows are the one ammo this bot can always re-make (flint+stick+feather), so
    // make them here rather than arriving with the 0 it woke up with tonight.
    if (countItem(bot, 'arrow') < 24) {
      const fl = countItem(bot, 'flint'), st = countItem(bot, 'stick'), fe = countItem(bot, 'feather');
      if (fl >= 1 && st >= 1 && fe >= 1) {
        // Same "n IN TOTAL" contract as above: `min(64-arrows, extra)` under-asked and craft answered
        // `already have`, so the dragon fight started on the arrows it woke up with.
        const r = await capped(require('./primitives').craft(bot, 'arrow', Math.min(64, countItem(bot, 'arrow') + Math.min(fl, st, fe) * 4)), 45000, 'craft arrows').catch(() => null);
        log.skill(`kill_dragon: arrow restock ${r && r.ok ? 'ok' : 'failed'} -> arrows=${countItem(bot, 'arrow')} (flint=${fl} stick=${st} feather=${fe})`);
      } else log.skill(`kill_dragon: cannot restock arrows (have ${countItem(bot, 'arrow')}; flint=${fl} stick=${st} feather=${fe}) - it will have to break crystals by other means`);
      // 合成是 45 秒一轮、常常整轮失败（21:14:17 / 21:21:18 / 21:40:49 三次 `restocking arrows failed:`），
      // 而同层抛射现在是这一战真正在掉血的那一手（173.44 -> 158.68 全靠它）。箭是龙的弹药、不是水晶的
      // （09:50 那条令没变），所以合成给不出来时按"缺物资就开指令拿"补一袋，每条 dive 一次，验收实例不发。
      if (process.env.MC_ASSIST !== '0' && countItem(bot, 'arrow') < 24 && (bot._opArrowBags || 0) < 3) {
        bot._opArrowBags = (bot._opArrowBags || 0) + 1;
        try { await freeOneSlot(bot, 'an arrow quiver'); } catch {}
        try { bot.chat('/give @s minecraft:arrow 32'); } catch {}
        await sleep(1100);
        log.warn(`kill_dragon: OP ARROWS (disclosed, ${bot._opArrowBags}/3 this dive): /give @s arrow 32 -> 包里现有 ${countItem(bot, 'arrow')} 支（水晶仍然只靠柱顶手打）`);
      }
    }
    // 近战武器才是这一战的输出：20:19:23 现场 `stone_sword@18%`（4 点伤害，还能砍十来下就断），断完
    // 栖息窗口就只剩拳头（1 点）。用户那条"缺物资就自己开指令拿，只验证打龙流程"覆盖这里：补一把钻石剑
    // （8 点），每条 dive 一次，`MC_ASSIST=0` 一律不发。
    if (process.env.MC_ASSIST !== '0' && (bot._opSword || 0) < 3) {
      const swords = bot.inventory.items().filter(i => /_sword$/.test(i.name));
      const best = swords.sort((a, b) => ((b.maxDurability || 0) - (b.durabilityUsed || 0)) - ((a.maxDurability || 0) - (a.durabilityUsed || 0)))[0];
      const left = best ? (best.maxDurability || 1) - (best.durabilityUsed || 0) : 0;
      if (!(best && left >= 40 && /diamond|netherite/.test(best.name))) {
        bot._opSword = (bot._opSword || 0) + 1;
        try { await freeOneSlot(bot, 'a diamond sword for the perch melee'); } catch {}
        try { bot.chat('/give @s minecraft:diamond_sword 1'); } catch {}
        await sleep(1200);
        const now = bot.inventory.items().find(i => i.name === 'diamond_sword');
        log.warn(`kill_dragon: OP SWORD (disclosed, ${bot._opSword}/3): was ${best ? `${best.name} 还剩 ${left}` : '没有剑'} -> ${now ? '钻石剑已进包' : '/give 没落地（背包满）'}`);
      }
    }
    let guard = 0, repositions = 0, stuckShots = 0, crystalsDown = 0, rescues = 0, shots = 0;
    // Every disclosed cap in this skill says "this dive", and until now none of them meant a dive: the
    // counters lived on the bot, so after the first three OP PERCH probes in a long process every later dive
    // opened already capped (`OP PERCH cap reached (3 this dive)` at 14:21 with no perch attempted yet).
    // The boundary is TIME, not the call: kill_dragon is re-called every round while a fight is running, and
    // wiping on each call would throw away the sticky target and the give-up list that the whole escalation
    // depends on (S1/S2 pin exactly that). 90 s of silence means the last dive died, left, or ended.
    if (!bot._lastDiveAt || Date.now() - bot._lastDiveAt > 90000) {
      bot._opPerch = 0; bot._opScreens = 0; bot._opScreensByCrystal = {}; bot._opBuckets = 0;
      bot._opArrows = 0; bot._opBows = 0; bot._opFiller = 0; bot._airShots = 0; bot._holdRounds = 0;
      bot._desperateSwings = 0; bot._stuckEnderman = 0; bot._crystalsSeenMax = 0;
      log.info('kill_dragon: new dive (the last one ended 90 s+ ago) - the disclosed supply/attempt caps start empty');
    }
    bot._lastDiveAt = Date.now();
    bot._opBuckets = 0;      // the water refill is per dive, not per session - see wetTheEnderman
    bot._opFiller = 0;       // and so is the paving refill - see refuelFiller
    bot._opScreens = 0;      // and the /setblock blast screens - see opScreenAt
    // 这些也必须按 dive 归零：19:14-19:19 现场 `waited through 13/15/16/17 rounds under the fountain`
    // 一路涨上去 —— 第一条 dive 把 `_holdRounds` 烧过 12 之后，之后每条 dive 一进门就立刻判定"等不到栖息"
    // 直接返回失败，龙再也打不着了。跨 dive 不清零的计数器就是一个自锁。
    bot._holdRounds = 0; bot._airShots = 0; bot._holdEscapes = 0; bot._opPerch = 0;
    bot._opPillarCells = 0;  // 塔根 /setblock 兜底也按 dive 计价 - see climbOut
    bot._opBeds = 0;         // 床爆的补床次数同样按 dive 计价 - see bedBlastAtPerch
    bot._opPerchTotal = 0;   // 抬升的窗口配额另有总闸 - see opPerchLift
    bot._opArrowBags = 0;    // 同层抛射的弹药袋也按 dive 计价 - see arrow restock
    bot._meleeSeen = null;   // 追击中的龙坐标快照按 dive 重新开始 - see the melee gap
    bot._shotsSinceDamage = 0; bot._dmgWindow = 0; bot._dragonHpLast = null;
    // Fourth instance of the class tools/lease_audit.js now looks for. 120 iterations is not a small
    // number when each one can contain a 32 s heal wait (line below) and an endRescue teleport: the worst
    // case is an hour, far past any step cap, and an evicted dragon fight keeps equipping the bow and
    // firing while the planner believes it moved on - the one stage where nobody is left to recover it.
    while (guard++ < 120 && Date.now() < (bot._stepDeadline || Infinity)) {
      const ground = endGround(bot);
      if (!inEnd(bot)) {
        // it died, respawned in the Overworld, and then spent 8 "rescues" trying to get back
        // onto an island it was no longer on. Leave; the ladder/planner re-enters via enter_end.
        return { ok: false, observation: `left the End mid-fight (dim=${bot.game.dimension}, crystalsDown=${crystalsDown}) - re-enter with enter_end` };
      }
      if (bot.health < 8) {
        // out of a corner and let saturation regen work instead of dying mid-fight
        log.warn(`dragon fight: hp=${Math.round(bot.health)}, retreating to safe footing`);
        await endRescue(bot);
        for (let i = 0; i < 8 && bot.health < 16; i++) await sleep(4000);
        continue;
      }
      if (ground.danger) {
        const rBefore = Math.hypot(bot.entity.position.x, bot.entity.position.z);
        await endRescue(bot);
        const rAfter = Math.hypot(bot.entity.position.x, bot.entity.position.z);
        // A rescue that closes on the island is PROGRESS, not a failed attempt. The old code counted one
        // strike per loop and nine loops fit inside seven seconds (measured 04:17:09 -> 04:17:16 at r=51),
        // so a bot that was genuinely walking back onto the island abandoned the fight 17 s after
        // entering it, died to the dragon next, and paid the whole dive for nothing.
        if (rAfter < rBefore - 0.5) {
          rescues = 0;
          log.warn(`end footing unsafe (${ground.reason}); rescue walked r ${rBefore.toFixed(0)} -> ${rAfter.toFixed(0)}, pressing on`);
        } else {
          rescues++;
          log.warn(`end footing unsafe (${ground.reason}); rescue gained nothing (r ${rBefore.toFixed(0)} -> ${rAfter.toFixed(0)}), attempt ${rescues}`);
          // Three dead walks off the rim is the void, not a route. Walking toward a safe cell the
          // pathfinder cannot reach is how 09:44-09:51 turned into `DIED at {x:3,y:-91,z:-86}`, so the
          // escalation now moves the bot instead of moving the counter.
          if (rescues >= 3) {
            const lifted = await opVoidLift(bot, `rescue gained nothing 3x at r=${rAfter.toFixed(0)} (${ground.reason})`);
            if (lifted) { rescues = 0; continue; }
            log.warn('kill_dragon: the void lift found no island cell - the walk is all that is left');
          }
        }
        if (rescues > 8) return { ok: false, observation: `cannot hold safe footing in the End (${ground.reason}); need bridging blocks or a human to lead` };
        continue;
      }
      // 顺手把自己泼的水收走：末地没有第二处水源，泼出去的每一格都永久留在那里。19:00-19:49 是
      // 13 泼 0 收，喷泉圈被自己灌成沼泽（19:40-19:49 一分钟 30 次 `submerged`），塔也起不来。
      // 背包里有空桶就每 ~15 秒收一格，不影响输出，纯粹是把战场排干。
      if (!bot._drainAt || Date.now() - bot._drainAt > 15000) {
        bot._drainAt = Date.now();
        try {
          if (bot.inventory.items().some(i => i.name === 'bucket')) {
            const sd = await scoopBucket(bot);
            if (sd.scooped) log.warn(`kill_dragon: 收回自己泼的水 - ${sd.msg}`);
          }
        } catch {}
      }
      // Endermen are the thing actually killing it on the island: 05:46:47 `slain by Enderman` at y=58 while
      // the bot was mid-draw on a crystal 30 blocks away (helmet already broken off). kill_dragon looked at
      // nothing but crystals and the dragon, so the melee hitting it between shots never got returned - and
      // the pearls are the one drop that makes the trip cheaper.
      // Engage ONLY when it is taking health off me right now. Swinging first is what provokes them, and
      // the measured dive at 13:09-13:10 burned rounds 21-23 on enderman #205420 in the "walk 3 cells off"
      // branch - 3 cells never exceeds the radius that re-arms this branch, so the fight looped on the
      // backing-off leg and left the End with crystalsDown=0.
      // Bare-handed against endermen in the dark is what the death count is made of: 14:06 live read
      // `worn 0` with hp 14 while the dive was mid-pillar. The armour grant belongs to `enter_end` and
      // takes 20 minutes to reach, and the operator's rule for this run is that a missing supply is taken
      // by command rather than paid for with a death. Bounded to one restock per dive, disclosed, and never
      // sent on the strict instance.
      if (process.env.MC_OP_RESUPPLY === '1' && process.env.MC_ASSIST !== '0' && (!bot._opArmourAt || Date.now() - bot._opArmourAt > 120000)) {
        const wornNow = ['helmet', 'chestplate', 'leggings', 'boots'].filter((pt, i) => {
          const it = bot.inventory.slots[5 + i];
          return !!it && it.name.endsWith('_' + pt);
        });
        if (wornNow.length <= 1) {
          bot._opArmourAt = Date.now();
          for (const piece of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) {
            if (wornNow.some(w => w === piece.slice(5))) continue;
            try { bot.chat(`/give @s ${piece} 1`); } catch {}
            await sleep(400);
          }
          try { await P.equipBestArmor(bot); } catch {}
          const after = ['helmet', 'chestplate', 'leggings', 'boots'].filter((pt, i) => {
            const it = bot.inventory.slots[5 + i];
            return !!it && it.name.endsWith('_' + pt);
          });
          log.warn(`OP ARMOUR (operator's call, disclosed, 1/dive): was ${wornNow.length || 'nothing'} worn mid-fight, now ${after.join('+') || 'still nothing - the gives did not land'}`);
        }
      }
      const hpRound = Math.round(bot.health || 20);
      const beingHit = bot._dragonHpRound !== undefined && hpRound < bot._dragonHpRound;
      bot._dragonHpRound = hpRound;
      bot._manglerTries = bot._manglerTries || {};
      bot._manglerIgnore = bot._manglerIgnore || {};
      const mangler = bot.nearestEntity(e => e.name === 'enderman' && e.position && bot.entity.position.distanceTo(e.position) <= (beingHit ? 12 : 5)
        && (beingHit || !bot._manglerIgnore[e.id]));
      if (mangler) {
        bot._manglerTries[mangler.id] = (bot._manglerTries[mangler.id] || 0) + 1;
        const mt = bot._manglerTries[mangler.id];
        const edist = bot.entity.position.distanceTo(mangler.position);
        const sw = bot.inventory.items().find(i => /_sword$/.test(i.name));
        if (edist <= 4.6) {
          if (beingHit || edist <= 3) {
            // 顺序按 operator 的机制来：先封顶（罩子里 3 格高的它进不来，直接杀掉），水只做兜底，
            // 而且【不在喷泉圈泼】—— 19:00-19:49 泼了 13 次、收回 0 次（末地没有第二处水可收），
            // 中心被自己灌成沼泽，19:40-19:49 光一分钟就 30 次 `submerged`，LLM 只好写"Drowned in the fountain again"。
            const roofed = await endermanShelter(bot, `enderman #${mangler.id} at ${edist.toFixed(1)} blocks (hp ${hpRound})`);
            if (roofed) {
              try {
                if (sw) await bot.equip(sw, 'hand');
                await lookAtItsFloor(bot, mangler);
                await capped(bot.pvp.attack(mangler), 20000, 'finish the enderman under the roof').catch(() => null);
              } catch (e) { log.warn(`kill_dragon: sheltered swing threw ${String(e.message).slice(0, 60)}`); }
              continue;
            }
            if (Math.hypot(bot.entity.position.x, bot.entity.position.z) <= 20) {
              log.warn(`kill_dragon: 在喷泉圈内不再泼水（已经 13 泼 0 收），罩子也没盖成 - 这轮只拉开距离`);
            } else {
              const w = await wetTheEnderman(bot, mangler);
              if (w.wet) {
                log.warn(`kill_dragon: water in enderman #${mangler.id}'s cell at ${w.at.x},${w.at.y},${w.at.z} - it burns there and blinks off; no swing to provoke it, no arrow spent, no retreat to lose (hp=${hpRound})`);
                await sleep(1500);
                continue;
              }
              log.warn(`kill_dragon: could not wet enderman #${mangler.id} at ${edist.toFixed(1)} blocks (${w.why || 'no bucket'}) - falling back to the sword/retreat`);
            }
          } else {
            const s = await scoopBucket(bot);
            if (s.scooped) log.warn(`kill_dragon: ${s.msg}`);
          }
        }
        if (beingHit && sw && mt <= 5) {
          // 两条规则同时生效（operator 15:10）：
          //  ① 被末影人追着打时，先在黑曜石塔角落把头顶第 2 格封顶 - 3 格高的它进不来，我在罩子里安全输出；
          //  ② "不要看末影人的眼睛"管的是【还没敌对】的那些：不主动 lookAt 它们、不朝它们走。已经打到我
          //     血量的这一只仇恨已经在了，必须能打到它，所以罩子盖好后我停在原地挥它，不再走过去贴脸。
          const roofed = await endermanShelter(bot, `enderman #${mangler.id} is hitting me from ${edist.toFixed(1)} blocks (hp ${hpRound})`);
          if (mt > (roofed ? 5 : 2)) {
            log.warn(`kill_dragon: enderman #${mangler.id} survived ${mt - 1} swings (shelter=${roofed}) - noted, this round stops paying attention to it`);
          } else {
            log.warn(`kill_dragon: enderman ${edist.toFixed(1)} off and hp=${hpRound} is dropping - meleeing it with the ${sw.name} (round ${mt}, shelter=${roofed ? 'roofed at feet+2' : 'no roof'})`);
            try {
              await bot.equip(sw, 'hand');
              if (!roofed) await capped(bot.pathfinder.goto(new (GN())(mangler.position.x, bot.entity.position.y, mangler.position.z, 1)), 6000, 'close on the enderman').catch(() => {});
              await lookAtItsFloor(bot, mangler);   // 起手前把准星压到它脚下那格，不抬到脸上
              await capped(bot.pvp.attack(mangler), 20000, 'melee the enderman').catch(() => null);
              const gone2 = !Object.values(bot.entities || {}).some(x => x && x.id === mangler.id);
              if (gone2) { bot._shelterRounds = 0; log.warn(`kill_dragon: enderman #${mangler.id} killed from under the roof - back to the dragon`); }
            } catch (e) { log.warn(`kill_dragon: enderman melee threw ${e.message}`); }
          }
        } else {
          // 没有剑、或者已经打过配额：不追、不看、不贴脸 - 退到够不着的距离，记下这只，本轮不再理它。
          const fx = bot.entity.position.x - mangler.position.x, fz = bot.entity.position.z - mangler.position.z;
          const Lm = Math.hypot(fx, fz) || 1;
          // One 12-cell goto with an 8-second cap is what got it killed. At 21:54:56 the retreat printed
          // `back 12 cells off the enderman timed out (8000ms)`, the bot stayed where it was, and three
          // endermen at 0.7/1.9/2.6 blocks took it down in nightclothes (endDeaths 11 -> 12). A player
          // backing off a pack of endermen does not make one big step he cannot see the end of - he hops,
          // checking between hops that he actually moved, and keeps going until nothing is within reach.
          bot._manglerIgnore[mangler.id] = true;
          let gone = 0;
          for (let h = 0; h < 3 && edist + gone < 10; h++) {
            const here = bot.entity.position.clone();
            const cell = { x: Math.round(here.x + fx / Lm * 6), y: here.floored().y, z: Math.round(here.z + fz / Lm * 6) };
            await capped(bot.pathfinder.goto(new (GN())(cell.x, cell.y, cell.z, 1)), 6000, 'hop off the enderman').catch(() => {});
            const moved = bot.entity.position.distanceTo(here);
            if (moved < 0.6) break;
            gone += moved;
            await sleep(250);
          }
          const stillNear = (() => { try { const e2 = bot.nearestEntity(x => x && x.name === 'enderman' && x.position && bot.entity.position.distanceTo(x.position) < 6); return e2 ? Math.round(bot.entity.position.distanceTo(e2.position) * 10) / 10 : null; } catch { return null; } })();
          log.warn(`kill_dragon: enderman #${mangler.id} ${edist.toFixed(1)} off, hp=${hpRound} ${beingHit ? `still hitting after ${mt - 1} answers` : 'is not hitting me'} - backed off ${Math.round(gone)} cells in short hops (nearest still ${stillNear === null ? 'unreadable' : stillNear} blocks), ignoring it for the rest of the dive`);
          if (stillNear !== null && stillNear < 3.5) {
            // Do not start a crystal shot from inside the pack: the aim turn looks straight through them and
            // every enderman in range takes it as a provocation. This round is spent walking, that is all.
            log.warn(`kill_dragon: still ${stillNear} blocks from an enderman after the retreat - spending the round on distance, not on a shot`);
            // ...unless the distance is not actually being bought. Live 14:26-14:29: `backed off 13 cells
            // (nearest still 1.8)` then `still 1.8 blocks ... spending the round on distance`, 36 rounds and
            // hp going down one point at a time, because an enderman teleports back into the cell you just
            // left. Two rounds of that means the retreat is not a plan, so the sword is - bounded, and it
            // re-arms only while the meter is genuinely falling.
            bot._stuckEnderman = (bot._stuckEnderman || 0) + 1;
            const sw2 = bot.inventory.items().find(i => /_sword$/.test(i.name));
            if (bot._stuckEnderman >= 2 && sw2 && beingHit && (bot._desperateSwings || 0) < 8) {
              bot._desperateSwings = (bot._desperateSwings || 0) + 1;
              log.warn(`kill_dragon: ${bot._stuckEnderman} retreats in a row left it at ${stillNear} blocks - swinging with the ${sw2.name} instead of walking for the 8 remaining answers of this dive (swing ${bot._desperateSwings}/8)`);
              try { await bot.equip(sw2, 'hand'); } catch {}
              await capped(bot.pvp.attack(mangler), 15000, 'desperate enderman swing').catch(() => null);
            }
          } else bot._stuckEnderman = 0;
        }
        if (dragonIsDead(bot)) return { ok: true, observation: 'ENDER DRAGON DEFEATED — game cleared!' };
        // Throttle: live 06:19:02-06:19:04 ran seven of these rounds inside two seconds, because the hop's
        // goto fails on the spot ("goal was changed") and pvp.attack resolves the same instant. Without a
        // beat here the fight spends its whole guard budget on an enderman it is swinging at.
        await sleep(900);
        continue;
      }
      // crystals first (an undestroyed one resurrects the dragon, so nothing else matters) - but NOT "the
      // nearest one". Live 21:52-21:55 the whole quiver went to crystal #39 because it happened to be the
      // closest: it sits 25 blocks overhead inside a cage, and the only ray to it from the island floor
      // passes through the cobblestone column this bot built while failing to climb to #39
      // (`blocked by cobblestone at 24,75,19`), so 3 arrows + a ring search + 3 more arrows bought nothing
      // while eight other crystals were never even looked at. Rank by what a shot can do from HERE:
      // an unobstructed line first, then the crystal this bot has NOT already spent arrows on, then the
      // lowest pillar (a hand kill needs feet near the crystal's own level), then distance.
      let crystal = null;
      {
        // Remember every pillar this dive has actually SEEN, by id. Without this the dive is blind the
        // moment it steps off a column: the hold-under-the-fountain mode parks the bot at r=0 where no
        // pillar is loaded, so `pickCrystalTarget` finds nothing, the dragon branch runs again, and 14:00-
        // 15:00 spent 20+ rounds in that circle with zero crystals attempted. The positions are the world's
        // fact, taken while they were in view, and they outlive the view.
        try {
          bot._crystalSpots = bot._crystalSpots || {};
          for (const e of Object.values(bot.entities || {})) {
            if (e && e.name === 'end_crystal' && e.position) bot._crystalSpots[e.id] = { x: Math.round(e.position.x), y: Math.round(e.position.y), z: Math.round(e.position.z) };
          }
          // 落盘：这条 dive 平均活不过几分钟（末地死亡 51 次，每次重连 bot 对象都是新的），
          // 而柱顶坐标是后面【高位伏击】唯一的目标来源。记在内存里等于没记。
          const nSpots = Object.keys(bot._crystalSpots).length;
          if (nSpots && nSpots !== bot._spotsSaved) {
            require('fs').writeFileSync(require('../config').paths.runs + '/pillar_spots.json', JSON.stringify(bot._crystalSpots));
            bot._spotsSaved = nSpots;
          }
        } catch {}
        const best = pickCrystalTarget(bot, 90, bot._crystalTarget);
        if (best && best.allGivenUp) {
          // Wipe the list on the way out: the next dive approaches from a different pillar and the
          // reasons this one gave up (no filler, blast-adjacent) may not hold there.
          const where = best.nearest && best.nearest.position ? `${Math.round(best.nearest.position.x)},${Math.round(best.nearest.position.y)},${Math.round(best.nearest.position.z)}` : '?';
          bot._crystalGivenUp = {};
          bot._crystalTarget = null;
          return { ok: false, observation: `gave up on all ${best.givenUp} crystal(s) loaded from this side of the island (caged above reach with no paving left, or standing inside its own blast on the pillar top). Every crystal still standing heals the dragon, so this dive cannot finish it: come back at the pillar of the nearest live crystal at ${where} with >=30 paving blocks in the pack, or let the climb refill itself from the island` };
        }
        if (best) {
          crystal = best.e;
          if (bot._crystalTarget !== crystal.id) {
            log.warn(`kill_dragon: target switched to crystal #${crystal.id} - ${best.blocked ? 'line BLOCKED from here' : 'line CLEAR from here'}, ${Math.round(best.d)} away, ${Math.round(best.dy)} up/down, ${best.tries} pillar tries already logged on it (ranked ${best.of} live crystals, ${best.openCount} not given up; nearest was #${best.nearest.id} at ${Math.round(bot.entity.position.distanceTo(best.nearest.position))}) - ${best.openCount > 1 ? 'committed until it falls or this dive gives up' : 'only candidate left'}`);
            bot._crystalTarget = crystal.id;
          }
        }
      }
      if (!crystal) crystal = bot.nearestEntity(e => e.name === 'end_crystal' && e.position && bot.entity.position.distanceTo(e.position) < 90);
      if (crystal) {
        const dist = bot.entity.position.distanceTo(crystal.position);
        // An arrow flies ~3 blocks/tick (60 b/s) and falls at ~20 b/s², so the drop over a shot of d blocks
        // is roughly d²/350. The old /900 under-aimed by more than half - measured 05:45-05:46 three arrows
        // at crystals 37 and 29 away with lift 1.5 and 1.0, every one of them falling short, and the first
        // real fight spent 60 shots to break one crystal.
        const lift = Math.min(8, (dist * dist) / 350);
        // A bow that breaks mid-fight used to leave this loop throwing once per second forever: the pack
        // read `bow=undefined`, `bot.equip(null)` threw, the catch logged and the next iteration did the
        // same thing - measured 19:31:49 through 19:32:01, thirteen identical
        // `crystal shot threw Invalid item object in equip (item is null...)` lines with the dragon still
        // healing. With no bow the crystals cannot be reached at all, so say that and hand the round back.
        const bowItem = bot.inventory.items().find(i => i.name === 'bow');
        if (!bowItem) {
          log.warn('enter_end/kill_dragon: the bow is gone mid-fight - crystals cannot be broken without it');
          return { ok: false, observation: `the bow is gone (broken or spent) with ${crystalsDown} crystal(s) down and arrows=${countItem(bot, 'arrow')}: an undestroyed crystal resurrects the dragon, so this fight cannot be won from here. In the End nothing makes a bow (spiders are an Overworld animal) - get out, craft one from 3 string + 3 sticks, and come back with it` };
        }
        // Every dive so far has ended with the bot inside the End and `arrow=0`. With no arrows the
        // crystals cannot fall and the dragon cannot be melee'd off a flying perch, so the honest move
        // is to stop paying the island edge with the bot's life and get out to re-arm.
        const arrows = countItem(bot, 'arrow');
        // An empty quiver used to end the dive wherever it stood. That was right while a crystal could only
        // fall to an arrow; since the pillar sequence works (#39 at 03:30:46, hand-killed behind a screen)
        // a bot with 0 arrows and a loaded crystal in front of it is one walk + one lift + one punch from a
        // kill. The first version of this exception keyed on "crystal within 14 blocks", which is never true
        // from the island floor (the pillars are 30-70 out), so the run looped bail -> leave -> re-arm ->
        // re-enter -> bail four times in a row at 06:53. Leave only when NOTHING is loaded to walk to.
        if (!arrows && !crystal) {
          return { ok: false, observation: `no arrows left inside the End (${crystalsDown} crystal(s) down): the dragon cannot be finished while any crystal stands and an arrow cannot be made here (flint=${countItem(bot, 'flint')} feather=${countItem(bot, 'feather')} stick=${countItem(bot, 'stick')}). Walk back to the portal column / re-arm to 24+ in the Overworld; do NOT melee a flying dragon to "make it work"` };
        }
        // Caged crystal: an arrow stops on the bars. Dig an opening first, from a level that reaches.
        const eyePos = bot.entity.position.offset(0, 1.6, 0);
        const blocker = shotBlocker(bot, eyePos, crystal.position);
        const cage = crystalCage(bot, crystal);
        // Only a cage block that is actually ON the line has to come out. Live at 05:29 the old test was
        // "any bar anywhere within two of the crystal" - a crystal inside a 54-bar shell only needs ONE
        // cell removed, and while the cage read 36 blocks the bot dug and dug and never fired an arrow.
        // Reach is measured from the EYES too: vanilla block reach is 4.5 from the eye, and the old
        // feet-cell test called a 4.9-block bar "unreachable" and sent the bot on a doomed 16-block climb.
        const caged = !!blocker && isCageBlock(blocker.name);
        if (caged) {
          const bar = blocker;
          const reach = eyePos.distanceTo(bar.position.offset(0.5, 0.5, 0.5));
          bot._cageTries = bot._cageTries || {};
          const tries = bot._cageTries[crystal.id] = (bot._cageTries[crystal.id] || 0) + 1;
          log.warn(`kill_dragon: crystal #${crystal.id} is caged - the ${bar.name} at ${bar.position.x},${bar.position.y},${bar.position.z} is ON the line, ${reach.toFixed(1)} from the eyes (try ${tries}, ${cage.length} cage blocks around it)`);
          if (tries > 8) {
            giveUpCrystal(bot, crystal.id, `cage (${bar.name} at ${bar.position.x},${bar.position.y},${bar.position.z} after ${tries} digs/climbs)`);
            log.warn(`kill_dragon: crystal #${crystal.id} is dropped for this dive - ${bar.name} at ${bar.position.x},${bar.position.y},${bar.position.z} stayed ${reach.toFixed(1)} from the eyes through ${tries} digs/climbs; every arrow fired into bars heals the dragon instead of the island`);
            continue;
          }
          if (reach <= 4.6) {
            const dug = await capped(mineBlockHere(bot, bar), 25000, 'dig a cage opening').catch(() => false);
            const after = bot.blockAt(bar.position);
            log.warn(`kill_dragon: dug the ${bar.name} at ${bar.position.x},${bar.position.y},${bar.position.z} (${dug ? 'ok' : 'refused'}), cell now reads ${after ? after.name : 'NULL'} - ${after && !P.isAir(after.name) ? 'dig again next round' : 'firing through the opening next round'}`);
            continue;
          }
          // The cage is above reach: walk to the pillar and climb to the crystal's own level, then the
          // next round digs from there. Bounded by the step deadline inside climbOut.
          await capped(bot.pathfinder.goto(new (GN())(crystal.position.x, bot.entity.position.y, crystal.position.z, 3)), 12000, 'walk under the cage').catch(() => {});
          const climbTo = Math.min(128, Math.ceil(crystal.position.y) + 1);
          const cr = await capped(climbOut(bot, climbTo), 150000, 'climb to the cage').catch(() => null);
          const yNow = bot.entity.position.floored().y;
          log.warn(`kill_dragon: climbed toward y=${climbTo} (now y=${yNow}, r=${Math.round(Math.hypot(bot.entity.position.x, bot.entity.position.z))}) - ${String((cr && cr.observation) || 'no climb result').slice(0, 90)}`);
          continue;
        }
        // Under MC_ASSIST=0 (strict survival, no OP pillar teleports), shoot uncaged crystals with the bow
        // from a clear line-of-sight spot on the main island first, and fall back to pillaring + screen-punch
        // only when caged, out of arrows, or 6 calibrated shots miss.
        if (process.env.MC_ASSIST === '0' && bowItem && arrows > 0) {
          bot._crystalBowTries = bot._crystalBowTries || {};
          const bt = bot._crystalBowTries[crystal.id] || 0;
          if (bt < 6) {
            let canShoot = !blocker && dist >= 10 && dist <= 56;
            if (!canShoot) {
              const spot = clearShotSpot(bot, crystal);
              if (spot) {
                await capped(bot.pathfinder.goto(new (GN())(spot.x, spot.y, spot.z, 1)), 12000, 'walk to clear crystal shot spot').catch(() => {});
                const eyeNow = bot.entity.position.offset(0, 1.6, 0);
                const dNow = bot.entity.position.distanceTo(crystal.position);
                canShoot = !shotBlocker(bot, eyeNow, crystal.position) && dNow >= 10 && dNow <= 56;
              }
            }
            if (canShoot) {
              bot._crystalBowTries[crystal.id] = bt + 1;
              const adj = [0, 0.35, -0.35, 0.75, -0.7, 1.15][bt] || 0;
              const dShot = bot.entity.position.distanceTo(crystal.position);
              const shotLift = Math.min(8, (dShot * dShot) / 350) + adj;
              try {
                await bot.equip(bowItem, 'hand');
                await bot.lookAt(crystal.position.offset(0, shotLift, 0), true);
                await bot.activateItem();
                await holdBow(1300);
                await bot.deactivateItem();
                shots++;
              } catch (e) { log.warn(`kill_dragon: crystal bow shot threw ${e.message}`); }
              await sleep(1100);
              const goneBow = inEnd(bot) && !Object.values(bot.entities).some(e => e.id === crystal.id);
              if (goneBow) {
                crystalsDown++;
                bot._crystalsDown = (bot._crystalsDown || 0) + 1;
                bot._crystalTarget = null;
                delete bot._crystalBowTries[crystal.id];
                log.info(`crystal ${crystal.id} destroyed by bow shot (dist=${dShot.toFixed(1)}, try=${bt + 1}/6, down=${crystalsDown})`);
              } else {
                log.warn(`kill_dragon: bow shot ${bt + 1}/6 at crystal #${crystal.id} (dist=${dShot.toFixed(1)}, lift=${shotLift.toFixed(2)}) missed - adjusting aim`);
              }
              continue;
            }
          }
        }
        // THE TACTIC (operator's call at 09:50, and tonight's numbers are the reason): every crystal dies
        // the same way - build up beside it, wall off the blast, punch it. The bow is out of the crystal
        // business entirely. 08:03-08:11 spent 36 lofted arrows at 38-70 blocks and the counter stayed at 1,
        // while both crystals that actually fell tonight (#39 at 03:30:46, #53 at 08:50:43) died to a
        // screened hand punch from their own pillar top. Arrows stay in the pack for the dragon perch, and
        // the no-bow / no-arrow bails above still decide whether a dive is worth starting at all.
        {
          const dy = crystal.position.y - bot.entity.position.y;
          if (Math.abs(dy) > 2.5) {
            bot._climbTries = bot._climbTries || {};
            const ct = bot._climbTries[crystal.id] = (bot._climbTries[crystal.id] || 0) + 1;
            if (ct > 3) {
              bot._pillarTarget = null;
              giveUpCrystal(bot, crystal.id, `three climbs of its column reached nothing (now y=${bot.entity.position.floored().y}, wanted ${Math.ceil(crystal.position.y)})`);
              log.warn(`kill_dragon: crystal #${crystal.id} is dropped for this dive - ${ct} climbing attempts left it at y=${bot.entity.position.floored().y} of a ${Math.ceil(crystal.position.y)} pillar`);
              continue;
            }
            // The island-radius footing rule has to know this pillar is the assignment, or the rescue
            // walks it off the column base between the climb attempts (see endGround's `onPillar`).
            bot._pillarTarget = { x: Math.round(crystal.position.x), z: Math.round(crystal.position.z) };
            // A climb pays one paving block per level, and the pack has reached the climb with nothing
            // because `tidy` trimmed the rock stacks to 8 minutes earlier (00:51:13 live:
            // `cobblestonex48 (trim->16->pit)` between two dives). Refuel from the island itself first.
            const climbTo = Math.min(128, Math.ceil(crystal.position.y) + 1);
            if (dy > 2.5) {
              const need = Math.max(24, climbTo - Math.floor(bot.entity.position.y) + 8);
              const rf = await refuelFiller(bot, need);
              if (!rf.ok) log.warn(`kill_dragon: only ${rf.have} paving blocks in the pack after mining ${rf.mined} block(s) of the island for crystal #${crystal.id} (a ${climbTo - Math.floor(bot.entity.position.y)}-level climb wants ${need}) - climbing anyway, the column may be shorter than the pillar`);
              await capped(bot.pathfinder.goto(new (GN())(crystal.position.x, bot.entity.position.y, crystal.position.z, 3)), 12000, 'stand under the crystal').catch(() => {});
              const cr = await capped(climbOut(bot, climbTo), 150000, 'climb onto the pillar').catch(() => null);
              log.warn(`kill_dragon: crystal #${crystal.id} sits ${Math.round(dy)} levels off my feet - building up beside it (try ${ct}, wanted y=${climbTo}, now y=${bot.entity.position.floored().y}, filler=${rf.have}) - ${String((cr && cr.observation) || 'no climb result').slice(0, 90)}`);
            } else {
              // A crystal BELOW my feet is not a climbing problem: `climbOut` to a lower y answers "reached
              // the target height" without moving, which is the wasted try #53 got at 10:34:24 (feet y=100,
              // crystal y=96, 51 blocks out). The lift is the branch that reaches it, so skip straight there.
              log.warn(`kill_dragon: crystal #${crystal.id} sits ${Math.round(-dy)} levels BELOW my feet at ${bot.entity.position.floored().x},${bot.entity.position.floored().y},${bot.entity.position.floored().z} - no climb reaches down, going straight to its column (try ${ct})`);
            }
            // The column gave no ledge to jump-place from: take the disclosed lift onto its top and go
            // straight at the crystal with the blast screen, which is the sequence that actually dropped
            // crystal #39 at 03:30:46 - and crystal #49 at 10:34:12 behind a two-block cobblestone screen.
            if (dy < -2.5 || bot.entity.position.floored().y < climbTo - 3) {
              const lf = await liftOntoPillar(bot, crystal);
              log.warn(`kill_dragon: OP LIFT onto crystal #${crystal.id}'s pillar ${lf.ok ? `standing at ${lf.at.x},${lf.at.y},${lf.at.z} (disclosed, not climbed)` : `refused (${lf.why})`}`);
              if (lf.ok) {
                await refuelFiller(bot, 8);
                const sc3 = await blastScreenAndPunch(bot, crystal);
                if (sc3.ok) {
                  crystalsDown++;
                  // The bot-level counter is what `stageLock` (metrics: crystals_gone) and the planner's
                  // End brief read. It was never assigned anywhere, so every kill tonight still logged
                  // `STAGE LOCK: kill_dragon has burned 81 attempts ... with the goal quantity unchanged`
                  // and told the LLM "Crystals this dive: 0" while crystals were on the floor.
                  bot._crystalsDown = (bot._crystalsDown || 0) + 1;
                  bot._crystalTarget = null;
                  bot._pillarTarget = null;
                  if (bot._climbTries) delete bot._climbTries[crystal.id];
                  log.info(`crystal ${crystal.id} destroyed by hand on the pillar top (down=${crystalsDown})`);
                  continue;
                }
                giveUpCrystal(bot, crystal.id, `lifted onto the pillar top and the screened punch still failed (${String(sc3.why).slice(0, 70)})`);
                bot._pillarTarget = null;
                continue;
              }
            }
            continue;
          }
          const rf2 = await refuelFiller(bot, 8);
          if (!rf2.ok) log.warn(`kill_dragon: only ${rf2.have} paving blocks after quarrying ${rf2.mined} from the island - the blast screen wants 2`);
          bot._punchTries = bot._punchTries || {};
          const pt = bot._punchTries[crystal.id] = (bot._punchTries[crystal.id] || 0) + 1;
          const sc = await blastScreenAndPunch(bot, crystal);
          if (sc.ok) {
            crystalsDown++;
            bot._crystalsDown = (bot._crystalsDown || 0) + 1;   // see the note at the lift-kill site
            bot._crystalTarget = null;
            bot._climbTries = bot._climbTries || {};
            delete bot._climbTries[crystal.id];
            delete bot._punchTries[crystal.id];
            log.info(`crystal ${crystal.id} destroyed by hand behind a blast screen (down=${crystalsDown})`);
          } else if (pt > 4) {
            // Bounded, because the route has no alternative to fall back to any more: an unbounded retry is
            // how the cage got its 8-dig loop, and a crystal nobody can punch must not eat the whole dive.
            giveUpCrystal(bot, crystal.id, `four screened punches failed (${String(sc.why).slice(0, 60)})`);
            log.warn(`kill_dragon: crystal #${crystal.id} is dropped for this dive - ${pt} screen-and-punch tries, the last one ${String(sc.why).slice(0, 60)}`);
          } else if (sc.approaching) {
            // Walking closer is PROGRESS, not a failed attempt. Charging it drops any crystal that is not
            // right next to the bot after four rounds of simply arriving (the AN fixture: 30 -> 26 -> 22 ->
            // 18 blocks, then "dropped for this dive" while it was closing the distance on foot).
            bot._punchTries[crystal.id] = pt - 1;
            bot._approachTries = bot._approachTries || {};
            const at2 = bot._approachTries[crystal.id] = (bot._approachTries[crystal.id] || 0) + 1;
            if (at2 > 8) {
              giveUpCrystal(bot, crystal.id, `eight approach rounds never reached arm's reach (${String(sc.why).slice(0, 60)})`);
              log.warn(`kill_dragon: crystal #${crystal.id} is dropped for this dive - ${at2} rounds of walking and it is still out of punch reach`);
            } else {
              log.warn(`kill_dragon: still closing on crystal #${crystal.id} (approach ${at2}/8) - ${sc.why}`);
            }
          } else {
            log.warn(`kill_dragon: screen-and-punch on crystal #${crystal.id} did not land (try ${pt}/4: ${sc.why}) - same route next round, this is a re-aim not a detour`);
          }
          continue;
        }
        // The arrow tail that used to live here (blast back-off, lofted shot, "shot anyway past the
        // obsidian", the random 6-cell shuffle) is gone on purpose: the operator's tactic at 09:50 made the
        // pillar sequence the only crystal route, and the counters it fed (`shots`, `stuckShots`) have no
        // other consumer. A crystal that dies to something else still stops being an entity, so the next
        // round simply stops picking it.
        continue;
      }
      const d = bot.nearestEntity(e => e.name === 'ender_dragon' && e.position);
      if (d) {
        bot._dragonSeen = true;
        const ddist = bot.entity.position.distanceTo(d.position);
        // The crystal chain learned arrow drop the hard way (d^2/350 blocks, §29af notes) and the dragon
        // branch never got it: this line aimed `+1` block above a dragon 20-40 blocks away, which is the
        // same as throwing the arrow into the floor in front of it. 26 arrows at ~7-10 damage is the whole
        // budget for a 200 hp dragon, so an unlofted shot is not a miss, it is the loss.
        const dlift = Math.min(8, (ddist * ddist) / 350);
        try {
          if (d.position.y < bot.entity.position.y + 4) {
            // 床爆原来只写在"龙在头顶 6 格以上"那条分支里，于是人一旦站上栖息层，龙落下来变成【同层】，
            // 这一晚上 `BED BLAST` 一次都没执行过（22:12 复核全日志 0 次，判据=会不会真的触发）。
            // 同层恰恰是玩家炸龙的标准站位：床就落在它身子底下的柱顶。
            const dBed = bot.entity.position.distanceTo(d.position);
            if (dBed <= 11.5) {
              const bb2 = await bedBlastAtPerch(bot, d);
              if (!bb2.ok) log.warn(`kill_dragon: 同层床爆没成（${bb2.why}），离龙 ${dBed.toFixed(1)} 格`);
              else if (bb2.hp !== null && bb2.hp <= 0) { bot._dragonKilled = true; log.info('*** ENDER DRAGON DEFEATED (bed blast at perch level, server readout: Health <= 0) ***'); }
              else log.warn(`kill_dragon: 同层床爆做完，龙血读数 ${bb2.hp === null ? '没读到' : bb2.hp}`);
            }
            const sword = bot.inventory.items().find(i => /_(sword)$/.test(i.name));
            if (sword) await bot.equip(sword, 'hand');
            // clamp the chase to the island: a dragon over the void must not pull us in
            const r = Math.hypot(d.position.x, d.position.z) || 1;
            const k = r > 34 ? 34 / r : 1;
            if (bot.entity.position.y < 75) await capped(bot.pathfinder.goto(new (GN())(d.position.x * k, Math.max(48, d.position.y), d.position.z * k, 3)), 12000, 'chase dragon');
            // 先补最后几格：19:00:52 塔爬到 y=82 与龙同高，但它站在 r=12 的塔顶，离龙 10 格 ——
            // `pvp.attack` 射程只有 3-4 格，所以两次 `melee window ... (attack returned)` 都是 1 秒内空手返回
            // （而 perch 抬升原本只在"龙在头顶"那个分支里调用，同高时永远进不去）。
            if (bot.entity.position.distanceTo(d.position) > 4.6) {
              // 只在龙【慢下来】的时候抬升：21:08 现场它绕岛飞（44-51 格外），抬升一路把人流到天上追着
              // 飞行的龙（5 次探针全花在"站住了但龙已经 44 格外"）—— 追飞行中的龙不是恢复手段，
              // 同层抛射才是。慢下来（≤3 格位移）才可能是真要栖息了。
              const pv = bot._meleeSeen;
              const mv = pv ? Math.hypot(d.position.x - pv.x, d.position.y - pv.y, d.position.z - pv.z) : null;
              bot._meleeSeen = { x: d.position.x, y: d.position.y, z: d.position.z };
              if (mv === null || mv <= 3) {
                const liftIn = await opPerchLift(bot, d);
                log.warn(`kill_dragon: 近战差最后几格 - perch 抬升${liftIn ? '已补位' : '没补上'}（当前离龙 ${bot.entity.position.distanceTo(d.position).toFixed(1)} 格，龙位移 ${(mv === null ? '?' : mv.toFixed(1))} 格）`);
              } else {
                log.warn(`kill_dragon: 龙在动（位移 ${mv.toFixed(1)} 格）- 不追飞行中的龙抬升，留在这个高度直接射`);
              }
            }
            // 抬升之后还是差几格就用手里的弓在这个高度射：19:23-19:26 现场三次 `melee window ... (attack
            // returned)` 都是站在 y=83 的平台上离龙 8.9-21 格 —— 近战射程只有 3-4 格，挥空等于这轮白过。
            // 而同一个高度上 8-20 格的箭几乎不会脱靶（对比地面 45 格甩狙 15 箭 0 伤害）。
            if (bot.entity.position.distanceTo(d.position) > 4.6) {
              const bowHi = bot.inventory.items().find(i => i.name === 'bow');
              const arrowsHi = countItem(bot, 'arrow');
              if (bowHi && arrowsHi > 0) {
                try { await bot.equip(bowHi, 'hand'); } catch {}
                const dHi = bot.entity.position.distanceTo(d.position);
                const aimHi = dragonLead(bot, d);
                await bot.lookAt(aimHi.offset(0, Math.min(4, (dHi * dHi) / 350), 0), true);
                await bot.activateItem();
                await holdBow(1300);
                await bot.deactivateItem();
                bot._dragonShots = (bot._dragonShots || 0) + 1;
                const hpHi = await dragonHpProbe(bot);
                if (Number.isFinite(hpHi) && hpHi <= 0) { bot._dragonKilled = true; log.info('*** ENDER DRAGON DEFEATED (server readout: Health <= 0) ***'); }
                log.info(`kill_dragon: arrow #${bot._dragonShots} away from the PERCH HEIGHT (dist=${dHi.toFixed(1)} dragonHp=${hpHi === null ? '?' : hpHi} arrowsLeft=${arrowsHi - 1})`);
                bot._shotsSinceDamage = (bot._shotsSinceDamage || 0) + 1;
              }
            }
            // Bounded: `pvp.attack` loops until the target dies or is unreachable, and a 200 hp dragon is
            // never unreachable - uncapped, this call eats the whole step budget and the fight never returns
            // to the crystals or to the bow. One 20 s window per round, then re-look.
            // 射程闸门：21:23:12-21:23:18 现场连打 3 次 `melee window ... (attack returned)`，每次 1-3 秒
            // 空手返回而龙血一动不动 —— 那时它在 5-9 格外，而近战只有 3-4 格。空挥不但没伤害，还把这一回合
            // 的 20 秒窗口和弓的蓄力都吃掉了。够不着就别挥。
            const dMelee = bot.entity.position.distanceTo(d.position);
            let hit = null, hpF;
            if (dMelee <= 4.5) {
              hit = await capped(bot.pvp.attack(d), 20000, 'melee the dragon').catch(() => null);
              hpF = await dragonHpProbe(bot);
            } else if (dMelee <= 13) {
              // 按碰撞盒出拳（见 dragonMeleeSweep）：4.5-13 格这一段以前每一回合都判"够不着"，
              // 而 22:43 现场 dist=9.6 明明是贴着它的身体飞过去。
              const sw = await dragonMeleeSweep(bot, d, 9000);
              hpF = sw.hp1;
              if (Number.isFinite(hpF) && hpF <= 0) { bot._dragonKilled = true; log.info('*** ENDER DRAGON DEFEATED (server readout: Health <= 0) ***'); }
            } else {
              log.warn(`kill_dragon: 离龙 ${dMelee.toFixed(1)} 格 > 13 - 这一回合不挥剑（身体盒也够不着），改用同层的箭`);
              hpF = await dragonHpProbe(bot);
            }
            if (Number.isFinite(hpF) && hpF <= 0) { bot._dragonKilled = true; log.info('*** ENDER DRAGON DEFEATED (server readout: Health <= 0) ***'); }
            log.info(`kill_dragon: 近战回合结束（${dMelee > 4.5 ? '射程外，这一回合没挥' : hit === null ? '20 秒窗口用完' : 'attack 返回'}）dragonHp=${hpF === null ? (typeof d.hp === 'number' ? Math.round(d.hp) : '?') : hpF} bot=${Math.round(bot.health)}`);
          } else if (d.position.y - bot.entity.position.y > 6 && Math.hypot(d.position.x, d.position.z) < 18) {
            // A perch has to be PROVEN by stillness, not by altitude. Live 14:31:06: `dragon 25 blocks ABOVE
            // me at r=13 (perched)` sent the dive to build a foothold at -3,81,16, and by the time it stood
            // on the thing the dragon had flown 43.7 blocks away - a flyby over the centre looks identical to
            // a sit in one sample, and the sit is the only position a sword can reach.
            const dPrev = bot._dragonLastSeen;
            const dMove = dPrev ? Math.hypot(d.position.x - dPrev.x, d.position.y - dPrev.y, d.position.z - dPrev.z) : null;
            bot._dragonLastSeen = { x: d.position.x, y: d.position.y, z: d.position.z, at: Date.now() };
            // 只按位移判定会把自己锁死：15:59-16:02 连 2.8 格的漂移都被判成"掠过"，于是永远不搭落脚点，
            // 44 分钟里龙血一动不动。真正栖息的龙特征是【高度不变】，掠过的龙每轮都换 y。
            const dYMove = dPrev ? Math.abs(d.position.y - dPrev.y) : null;
            bot._dragonHighStreak = (dYMove !== null && dYMove <= 3) ? (bot._dragonHighStreak || 0) + 1 : 0;
            if (dMove !== null && dMove > 2.5 && bot._dragonHighStreak < 4) {
              log.warn(`kill_dragon: dragon is ${Math.round(d.position.y - bot.entity.position.y)} above me but it MOVED ${dMove.toFixed(1)} blocks since the last look - that is a flyby, not the perch (alt-streak ${bot._dragonHighStreak}/4), so no footing is built for it`);
              // 窗口的"结束"就是这一句：起飞了才算换下一个窗口，配额在这里清回去（不是在栖息分支里清 ——
              // 那个分支每个回合都进，清了等于没有闸）。
              bot._opPerch = 0;
              // 掠过时不许在岛面上空等：00:57 现场它停在 y=60 连等 35 回合，而龙就在头顶 19 格 ——
              // 岛面上永远挥不到。铺过的栖息台面还在（脚下读得到实体）就回台面，那里才是出刀的位置。
              const dk = bot._perchDeck;
              if (dk && process.env.MC_ASSIST !== '0' && bot.entity.position.y < dk.y - 6) {
                let dUnder = null;
                try { dUnder = bot.blockAt(new Vec3(dk.x, dk.y - 1, dk.z)); } catch {}
                if (dUnder && dUnder.boundingBox === 'block') {
                  try { bot.chat(`/tp @s ${dk.x + 0.5} ${dk.y} ${dk.z + 0.5}`); } catch {}
                  await sleep(1500);
                  log.warn(`kill_dragon: 掠过时不站在岛面等 - 回到自己的栖息台面 ${dk.x},${dk.y},${dk.z}（龙在头顶）`);
                } else { bot._perchDeck = null; }
              }
              await sleep(900);
              continue;
            }
            // THE PERCH CASE — the one thing this skill has never handled, and the reason 12 dives produced
            // zero dragon damage. A perched dragon sits ~25 blocks ABOVE the island floor near the centre for
            // tens of seconds; the old split either waited for it to come below my feet (`d.position.y <
            // y+4`, which never happens while it is on the pillar) or loosed an arrow using the horizontal
            // arc lift, which is the wrong physics for a near-vertical angle. A player climbs the pillar and
            // hits the head. The pack carries 100+ paving blocks and climbOut has already reached y=97.
            const upNow = Math.round(d.position.y - bot.entity.position.y);
            bot._holdRounds = 0; log.warn(`kill_dragon: dragon ${upNow} blocks ABOVE me at r=${Math.round(Math.hypot(d.position.x, d.position.z))} (perched) - 先用指令抬到它身旁，抬不动才爬塔`);
            // 栖息窗口只有十几秒，而下面的走位+爬塔一层就要 30-100 秒。20:00:29 现场把这条顺序反了：
            // `perch climb done - now y=60, dragon 51.2 away` -> `no perch-level footing found by the lift
            // either`，窗口已被爬塔花光，抬升只能在龙飞到 51 格外之后执行，于是每个栖息窗口都空手而归。
            let dw = bot.entity.position.distanceTo(d.position);
            let lifted = false;
            if (dw > 6) {
              lifted = await opPerchLift(bot, d);
              dw = bot.entity.position.distanceTo(d.position);
              if (lifted) log.warn(`kill_dragon: 抬升直接站上栖息高度，离龙 ${dw.toFixed(1)} 格 - 剑现在够得着`);
            }
            if (!lifted) {
              await capped(bot.pathfinder.goto(new (GN())(d.position.x, bot.entity.position.y, d.position.z, 3)), 14000, 'walk under the perch').catch(() => {});
              dw = bot.entity.position.distanceTo(d.position);
              if (process.env.MC_ASSIST !== '0') {
                if (Math.hypot(bot.entity.position.x, bot.entity.position.z) > 16) await fountainApproach(bot);
                await capped(climbOut(bot, Math.ceil(d.position.y) + 1), 100000, 'climb to the perch').catch(() => null);
                dw = bot.entity.position.distanceTo(d.position);
                log.warn(`kill_dragon: perch climb done - now y=${bot.entity.position.floored().y}, dragon ${dw.toFixed(1)} away`);
                if (dw > 6) {
                  lifted = await opPerchLift(bot, d);
                  dw = bot.entity.position.distanceTo(d.position);
                  if (!lifted) log.warn(`kill_dragon: no perch-level footing found by the lift either - the swing stays out of reach (${dw.toFixed(1)})`);
                }
              } else {
                log.info(`kill_dragon: MC_ASSIST=0 walked to fountain rim under perched dragon (dw=${dw.toFixed(1)})`);
              }
            }
            if (dw <= 9) {
              // Bed before sword: one blast is roughly three sword hits and the perch window is the only time
              // either of them reaches. If the bed cannot be planted safely the sword takes the window.
              const bb = await bedBlastAtPerch(bot, d);
              if (!bb.ok) log.warn(`kill_dragon: bed blast skipped (${bb.why})`);
              else if (bb.hp !== null && bb.hp <= 0) { bot._dragonKilled = true; log.info('*** ENDER DRAGON DEFEATED (bed blast, server readout: Health <= 0) ***'); }
              const sword2 = bot.inventory.items().find(i => /_sword$/.test(i.name));
              if (sword2) { try { await bot.equip(sword2, 'hand'); } catch {} }
              const hpBefore = await dragonHpProbe(bot);
              const dSit = bot.entity.position.distanceTo(d.position);
              const hit2 = dSit <= 4.5
                ? await capped(bot.pvp.attack(d), 20000, 'melee the perched dragon').catch(() => null)
                : await dragonMeleeSweep(bot, d, 9000).then((sw) => sw.swings);   // 栖息时它也只在身体盒范围内，见上
              const hpAfter = await dragonHpProbe(bot);
              bot._dragonDamageSeen = (bot._dragonDamageSeen || 0) + (Number.isFinite(hpBefore) && Number.isFinite(hpAfter) && hpAfter < hpBefore ? Math.round(hpBefore - hpAfter) : 0);
              log.info(`kill_dragon: PERCH MELEE closed (${hit2 === null ? '20s cap used' : 'attack returned'}) dragonHp ${hpBefore === null ? '?' : hpBefore} -> ${hpAfter === null ? '?' : hpAfter} (damage seen this dive: ${bot._dragonDamageSeen || 0}) sword=${sword2 ? sword2.name : 'none'} botHp=${Math.round(bot.health)}`);
              if (Number.isFinite(hpAfter) && hpAfter <= 0) { bot._dragonKilled = true; log.info('*** ENDER DRAGON DEFEATED (server readout: Health <= 0) ***'); }
            } else {
              // No swing, so the bow still reaches a perched dragon - players kill it that way every day.
              // Without this fall-through the round did NOTHING but re-log the lift refusal (12:25:02-
              // 12:27:14: twelve cap lines, zero damage), and the dive's 600 s budget evaporated.
              const liveC = (() => { try { return Object.values(bot.entities || {}).filter(e => e && e.name === 'end_crystal' && e.position).length; } catch { return 0; } })();
              const srvC = await crystalCount(bot);
              const standing = srvC === null ? liveC : Math.max(srvC, liveC);
              const bow2 = bot.inventory.items().find(i => i.name === 'bow');
              if (standing > 0) {
                log.warn(`kill_dragon: the island still has ${srvC === null ? `${liveC} loaded` : 'at least one'} crystal - no arrow spent on the dragon (it heals faster than a bow can hurt it); back to the pillars`);
                bot._crystalGivenUp = {}; bot._crystalTarget = null;
              } else if (bow2 && countItem(bot, 'arrow') > 0) {
                await bot.equip(bow2, 'hand');
                const dd2 = bot.entity.position.distanceTo(d.position);
                const lift2 = Math.min(8, (dd2 * dd2) / 350);
                await bot.lookAt(d.position.offset(0, 1 + lift2, 0));
                await bot.activateItem();
                await holdBow(1300);
                await bot.deactivateItem();
                bot._dragonShots = (bot._dragonShots || 0) + 1;
                const hpS = await dragonHpProbe(bot);
                log.info(`kill_dragon: arrow #${bot._dragonShots} away at the PERCHED dragon (dist=${dd2.toFixed(1)} lift=${lift2.toFixed(1)} - no swing was in reach) dragonHp=${hpS === null ? '?' : hpS} arrowsLeft=${countItem(bot, 'arrow')}`);
              }
            }
          }
          else {
            const bow = bot.inventory.items().find(i => i.name === 'bow');
            // Two preconditions this branch used to ignore. (1) A crystal still standing makes the dragon
            // HEAL faster than any arrow can hurt it - 27 shots at 12:20-12:21 bought zero damage, and the
            // log said `dragonHp=?` the whole way. (2) `arrowsLeft=0`: an empty quiver does not stop the
            // draw, `activateItem` just fails silently, so the dive kept logging "arrow #26 away" with no
            // arrow in the pack at all - a counter that could only go up while nothing left the bow.
            const liveCrystals = (() => {
              try { return Object.values(bot.entities || {}).filter(e => e && e.name === 'end_crystal' && e.position).length; } catch { return 0; }
            })();
            // "Zero in the entity list" is NOT "all ten down": from the middle of the island the far pillars
            // are not loaded, and the count that made this branch reachable can be zero for reasons of
            // distance. The honest signal is the peak this dive has actually seen - the dragon is only
            // killable once crystals were visible and then went away.
            bot._crystalsSeenMax = Math.max(bot._crystalsSeenMax || 0, liveCrystals);
            const dry = countItem(bot, 'arrow') < 1;
            // Where the bot is decides what "zero crystals" means. Standing at the island CENTRE (r<=45) the
            // pillar tops are inside the loaded view, so an empty entity list is the evidence that they are
            // down - 14:08 live proved this: r=2, no crystal, and the dragon perched 17 blocks overhead.
            // Out at the rim the same zero only means the far pillars are not loaded, and shooting there is
            // how a dive spends 60 arrows on a dragon that is healing back to full every few seconds.
            const rCentre = Math.hypot(bot.entity.position.x, bot.entity.position.z);
            const crystalsUnreadable = liveCrystals === 0 && (bot._crystalsSeenMax || 0) === 0 && rCentre > 45;
            if (liveCrystals > 0) {
              bot._crystalGivenUp = {};
              bot._crystalTarget = null;
              log.warn(`kill_dragon: ${liveCrystals} crystal(s) still standing and they heal the dragon - no arrow spent on it; the give-up list is cleared and this round goes back to the pillars (down=${crystalsDown})`);
            } else if (crystalsUnreadable) {
              // A verdict here is a stall: 14:06-14:12 ran 28 rounds of exactly this return, because the
              // planner re-called kill_dragon and the cell still had nothing loaded. The island CENTRE sees
              // every pillar base (the disc is ~40 wide and the pillars ring it), so the fix is one capped
              // walk, not one more verdict.
              bot._crystalGivenUp = {};
              bot._crystalTarget = null;
              bot._unreadRounds = (bot._unreadRounds || 0) + 1;
              if (bot._unreadRounds <= 4) {
                log.warn(`kill_dragon: 0 crystals loaded and none seen yet this dive (r=${Math.round(Math.hypot(bot.entity.position.x, bot.entity.position.z))}) - walking to the island centre so the pillars load (unread round ${bot._unreadRounds}/4)`);
                await capped(bot.pathfinder.goto(new (GN())(0, bot.entity.position.y, 0, 6)), 14000, 'walk to the island centre').catch(() => {});
              } else {
                log.warn(`kill_dragon: ${bot._unreadRounds} rounds at the centre still load no crystal - this dive cannot see the pillars at all`);
                return { ok: false, observation: `no end crystal has loaded in ${bot._unreadRounds} rounds from r=${Math.round(Math.hypot(bot.entity.position.x, bot.entity.position.z))} on the island (peak seen this dive 0) - the dragon cannot be shot safely until a pillar is visible, because a standing crystal heals it. Either the render distance is not reaching the pillars or the island is on the far side: approach the pillar column at the last remembered site and re-look` };
              }
            } else if (!bow) {
              // The perch is melee-able and the air phase is not, and tonight three bows broke mid-dive. The
              // operator's rule again: a missing supply is taken by command rather than ending the dive -
              // bounded to two per dive and disclosed, never on the strict instance.
              bot._opBows = bot._opBows || 0;
              if (process.env.MC_OP_RESUPPLY === '1' && process.env.MC_ASSIST !== '0' && bot._opBows < 2) {
                bot._opBows++;
                try { bot.chat('/give @s bow 1'); } catch {}
                await sleep(1500);
                log.warn(`OP BOW (operator's call, disclosed, ${bot._opBows}/2 this dive): /give @s bow 1 - the bow broke mid-fight and the air phase cannot be shot without one (now ${countItem(bot, 'bow')})`);
              } else {
                log.warn('kill_dragon: the bow is gone mid-fight and no restock is available - the air phase cannot be shot at all');
                return { ok: false, observation: `cannot hurt the dragon from here: no bow, ${bot._crystalsSeenMax} crystal(s) were seen this dive and none are standing now. The perch is melee-able, the air phase is not - craft a bow (3 string + 3 sticks) and come back` };
              }
            } else if (dry) {
              // The operator's rule for this run: a missing supply is taken by command, not walked back for.
              // An empty quiver mid-End used to mean "leave and re-arm", which costs the dive its position.
              bot._opArrows = bot._opArrows || 0;
              if (process.env.MC_OP_RESUPPLY === '1' && process.env.MC_ASSIST !== '0' && bot._opArrows < 2) {
                bot._opArrows++;
                try { bot.chat('/give @s arrow 64'); } catch {}
                await sleep(1500);
                const now = countItem(bot, 'arrow');
                log.warn(`OP ARROWS (operator's call, disclosed, ${bot._opArrows}/2 this dive): /give @s arrow 64 - the quiver was empty mid-fight and the perch phase needs every arrow it can get (now ${now})`);
                if (now < 1) log.warn('OP ARROWS: the give did not land (a full pack?) - the dragon stays unhittable from the air');
              } else {
                log.warn(`kill_dragon: 0 arrows and no refill available (switch ${process.env.MC_OP_RESUPPLY === '1' ? 'on but capped' : 'off'}) - the air phase cannot be shot`);
                return { ok: false, observation: `cannot hurt the dragon from here: 0 arrows left with ${liveCrystals} crystal(s) confirmed down. The perch is melee-able, the air phase is not - re-arm to 24+ arrows and come back` };
              }
            } else if (ddist > 18 && (bot._airShots || 0) >= 6) {
              // 185 hp through 170 arrows is the whole argument: a dragon in the air at 30-60 blocks is not a
              // target, and every shot spent there is an arrow the perch cannot use. Past six of them the
              // dive stops firing and holds under the fountain, because the sit is the only position where
              // either the sword or a short shot reaches the head.
              bot._holdRounds = (bot._holdRounds || 0) + 1;
              log.warn(`kill_dragon: ${bot._airShots} air shots at a dragon ${ddist.toFixed(0)} blocks away bought nothing - holding under the fountain for the perch (round ${bot._holdRounds}, arrows left ${countItem(bot, 'arrow')})`);
              // And the hold has to be REACHED: 14:50-15:00 the bot sat at r=57 (off the main island, on an
              // outer shelf) and asked the pathfinder to walk to 0,0 through the void 22 times in a row.
              // The disclosed lift is the thing that puts it back on the disc the fountain stands on.
              const rHold = Math.hypot(bot.entity.position.x, bot.entity.position.z);
              if (rHold > 42) {
                const lifted = await opVoidLift(bot, `the perch hold is ${Math.round(rHold)} blocks out, across void the pathfinder will not walk`);
                if (lifted) { bot._holdRounds = 0; log.warn('kill_dragon: OP VOID LIFT put the dive back on the main island for the perch hold'); continue; }
              }
              const rCentreNow = Math.hypot(bot.entity.position.x, bot.entity.position.z);
              if (rCentreNow > 16 && process.env.MC_ASSIST !== '0') {
                // 走到喷泉边这件事本身已经失败了几十分钟（goto 超时/被外层取消），所以先到位再等：
                // 一次 /tp + 重力验证，比每轮 12 秒的寻路可靠。
                await fountainApproach(bot);
              } else {
                await capped(bot.pathfinder.goto(new (GN())(0, bot.entity.position.y, 0, 6)), 12000, 'hold the fountain').catch(() => {});
                await sleep(1200);
              }
              if (bot._holdRounds > 3) {
                // Three rounds is the budget; after that the hold is a blindness trap. Standing at r=0 no
                // pillar chunk is loaded, so the crystal branch cannot re-engage, the dragon branch fires
                // again, and 14:00-15:00 was 20+ rounds of exactly that circle with zero crystals attempted.
                // A remembered column is the way out, and it is the approach that has actually dropped them.
                const spots = Object.entries(bot._crystalSpots || {});
                const alive = spots.filter(([id]) => !(bot._crystalGivenUp || {})[id]);
                if (alive.length && (bot._holdEscapes = (bot._holdEscapes || 0) + 1) <= 4) {
                  const pick = alive.sort((a, b) => Math.hypot(a[1].x, a[1].z) - Math.hypot(b[1].x, b[1].z))[0];
                  const sid = Number(pick[0]), s = pick[1];
                  log.warn(`kill_dragon: blind hold ended after ${bot._holdRounds} rounds - walking to the remembered pillar of crystal #${sid} at ${s.x},${s.y},${s.z} (${alive.length} pillar position(s) on file, escape ${bot._holdEscapes}/4)`);
                  bot._airShots = 0; bot._crystalTarget = sid;
                  const rCol = Math.hypot(bot.entity.position.x, bot.entity.position.z);
                  if (rCol > 42) await opVoidLift(bot, `crystal #${sid}'s pillar is across the void from r=${Math.round(rCol)}`);
                  await capped(bot.pathfinder.goto(new (GN())(s.x, bot.entity.position.y, s.z, 4)), 20000, 'walk to the remembered pillar').catch(() => {});
                  continue;
                }
                if (!alive.length && (bot._holdEscapes = (bot._holdEscapes || 0) + 1) <= 6) {
                  // 走去柱圈只在一个前提下有意义：岛上还有水晶。15:56-15:58 现场连转了三个方位角都是
                  // "NO pillar on file"，而服务器的水晶计数回答 0（整个 dive 没有出现"岛上还有水晶"那行）
                  // - 那就是柱顶确实没了，再转下去只是烧 dive 的预算。所以先问服务器，再决定走不走。
                  const srv = await crystalCount(bot);
                  if (srv === 0) {
                    bot._holdEscapes = 6;
                    log.warn(`kill_dragon: the server says 0 crystals left on the island - no pillar to walk to; staying for the perch and taking the shots that land (hp readout is the judge)`);
                  } else {
                  const a = (bot._holdEscapes * 1.1) % (Math.PI * 2);
                  const tx = Math.round(Math.cos(a) * 34), tz = Math.round(Math.sin(a) * 34);
                  log.warn(`kill_dragon: holding with NO pillar on file after ${bot._holdRounds} rounds - walking the ring to ${tx},${tz} (bearing ${Math.round(a * 57.2958)}deg, escape ${bot._holdEscapes}/6) so the crystals come into view`);
                    bot._airShots = 0;
                    await capped(bot.pathfinder.goto(new (GN())(tx, bot.entity.position.y, tz, 6)), 20000, 'walk the pillar ring').catch(() => {});
                    continue;
                  }
                }
                if (bot._holdRounds > 40) return { ok: false, observation: `waited through ${bot._holdRounds} rounds under the fountain and the dragon never perched within reach - the perch is the only damage this dive can do, so it cannot be forced from the air; come back with a lead or take the shots at the sit` };
              }
            } else {
              if (ddist > 18) bot._airShots = (bot._airShots || 0) + 1;
              // 打到没打到，判据只有一个：服务器的血量读数。读数不动就是没打到，那就别再把补给的箭烧在空里
              // （17:28-17:29 连续 9 轮 `bought nothing`、读数 183.625 一动不动，箭反而被 /give 补到 49 根）。
              const hpChk = await dragonHpProbe(bot);
              const dropped = (Number.isFinite(hpChk) && Number.isFinite(bot._dragonHpLast)) ? Math.max(0, bot._dragonHpLast - hpChk) : 0;
              if (Number.isFinite(hpChk)) bot._dragonHpLast = hpChk;
              bot._shotsSinceDamage = (bot._shotsSinceDamage || 0) + 1;
              bot._dmgWindow = (bot._dmgWindow || 0) + dropped;
              // 判据是效率不是"有没有掉血"：17:35-17:39 每 4 分钟只磨掉 2.2 点（8 箭），因为龙一栖息就回血，
              // 偶尔一点伤害会把"连续没掉血"的计数清零 —— 我那 10 箭的闸门因此永远攒不满。
              // 现在：15 箭换不到 3 点血，或者已经在 45 格之外甩狙，就放弃岛面射法去爬柱子。
              const inefficient = bot._shotsSinceDamage >= 15 && bot._dmgWindow < 3;
              if ((inefficient || ddist > 45) && bot.entity.position.y < 70) {
                const hg = await highGroundPerch(bot);
                const final = hg.ok ? hg : await highGroundTower(bot, d);
                log.warn(`kill_dragon: ${bot._shotsSinceDamage} 箭只磨掉 ${Math.round(bot._dmgWindow * 10) / 10} 点 (hp=${hpChk === null ? '?' : hpChk}, ddist=${ddist.toFixed(0)}) - 高位伏击 ${final.ok ? `站上 ${final.at.x},${final.at.y},${final.at.z}${hg.ok ? '' : '（自己搭的塔）'}` : `去不了(${final.why || hg.why || '爬不上去'})`}`);
                bot._shotsSinceDamage = 0; bot._dmgWindow = 0;
                if (final.ok) continue;
              }
              await bot.equip(bow, 'hand');
              // 提前量：龙两秒能挪 10-23 格，瞄"现在"的位置等于把箭送到它身后的空气里。
              const aimP = dragonLead(bot, d);
              await bot.lookAt(aimP.offset(0, dlift, 0), true);
              await bot.activateItem();
              await holdBow(1300);
              await bot.deactivateItem();
              bot._dragonShots = (bot._dragonShots || 0) + 1;
              const leadBy = Math.hypot(aimP.x - d.position.x, aimP.z - d.position.z);
              log.info(`kill_dragon: arrow #${bot._dragonShots} away at the DRAGON (dist=${ddist.toFixed(1)} lift=${dlift.toFixed(1)} lead=${leadBy.toFixed(1)} dragonHp=${hpChk === null ? (typeof d.hp === 'number' ? Math.round(d.hp) : '?') : hpChk} arrowsLeft=${countItem(bot, 'arrow')})`);
            }
          }
        } catch (e) { log.warn('dragon attack threw', e.message); }
      } else if (repositions < 6) {
        // 看不见任何东西时"回岛中心"是死路：中心离最近柱顶也有 40+ 格，而且被柱子自己的背面挡着，
        // 所以水晶永远读不出来、perch 永远等不到 —— 13:30 以后 crystalsDied=0、hold 烧到 12 轮，就是这个圈。
        // 玩家的做法是沿岛缘转一圈让柱顶进入视野：目标改成 r=34 的柱圈，每换一个方位角；有记忆就先走去那根柱子。
        repositions++;
        const known = Object.values(bot._crystalSpots || {}).filter(s => s && Number.isFinite(s.x));
        let tx, tz, note;
        if (known.length) {
          const s = known.sort((a, b) => Math.hypot(a.x - bot.entity.position.x, a.z - bot.entity.position.z)
            - Math.hypot(b.x - bot.entity.position.x, b.z - bot.entity.position.z))[0];
          tx = s.x; tz = s.z; note = `walking to the remembered pillar column ${tx},${tz}`;
        } else {
          const a = (repositions * 1.1) % (Math.PI * 2);
          tx = Math.round(Math.cos(a) * 34); tz = Math.round(Math.sin(a) * 34);
          note = `walking the pillar ring at r=34, bearing ${Math.round(a * 57.2958)}deg`;
        }
        log.info(`dragon/crystals not visible; ${note} (try ${repositions})`);
        const rNow = Math.hypot(bot.entity.position.x, bot.entity.position.z);
        if (rNow > 45) await opVoidLift(bot, `${note} but the bot is at r=${Math.round(rNow)}, outside the main island`);
        await capped(bot.pathfinder.goto(new (GN())(tx, bot.entity.position.y, tz, 6)), 25000, 'walk the pillar ring').catch(() => {});
      }
      // victory check
      if (dragonIsDead(bot)) return { ok: true, observation: 'ENDER DRAGON DEFEATED — game cleared!' };
      await sleep(1500);
    }
    return { ok: dragonIsDead(bot), observation: `dragon still alive (seen=${!!bot._dragonSeen}, guard ${guard}, hp=${Math.round(bot.health)})` };
  },
});
async function holdBow(ms) { await sleep(ms); }
// "No dragon entity right now" is NOT "the dragon is dead": it flies out of loaded range
// constantly, and on first tick nothing is loaded yet. That false positive would let the bot
// claim the game was cleared (same class of bug as craft() once was). Require the achievement,
// or a previously-seen dragon that is now gone plus the reward it leaves behind.
function dragonIsDead(bot) {
  if (bot._dragonKilled) return true;
  if (!bot._dragonSeen) return false;
  // The evidence has to be collected IN THE END. The stronghold portal room at -212,15,1499 also contains
  // an `end_portal` block - the one you walk INTO - and at 12:04:53 a bot that had just been killed by an
  // enderman respawned there, found that block one second after its own death line, and printed
  // `*** ENDER DRAGON DEFEATED - game cleared ***`. That flag short-circuits `enter_end` (done), the
  // planner's End brief and the panel, so a false positive is not noise - it ends the run.
  if (!inEnd(bot)) return false;
  let stillThere = false;
  try { stillThere = Object.values(bot.entities).some(e => e && e.name === 'ender_dragon'); } catch { return false; }
  if (stillThere) return false;
  try {
    const reward = bot.findBlock({ matching: blockIds(bot, ['dragon_egg', 'end_portal']), maxDistance: 96 });
    if (!reward) return false;
    // The exit portal only ever exists at the island centre (0,y,0). Anything further out than the
    // fountain's own footprint is not the death reward.
    const rp = reward.position;
    if (Math.hypot(rp.x, rp.z) > 24) {
      log.warn(`dragonIsDead: ${reward.name} at ${rp.x},${rp.y},${rp.z} is not the centre structure (r=${Math.round(Math.hypot(rp.x, rp.z))}) - not accepted as evidence`);
      return false;
    }
    // SET and PERSIST the flag here. Two reasons this is the only working path: (1) the
    // `finishedAchievement` listener in src/bot.js was its previous setter and it NEVER fires on
    // 1.21.1 - 0 occurrences of `achievement` in the entire 1,387,220-line log across two days of
    // play, including many real advancements - so a genuine kill could not be recorded at all;
    // (2) mineflayer creates a NEW bot object on every reconnect, so a flag that lives only on the
    // bot is lost before the next milestone check reads it.
    bot._dragonKilled = true;
    try {
      const fsys = require('fs');
      fsys.writeFileSync(require('../config').paths.runs + '/dragon.json',
        JSON.stringify({ killedAt: new Date().toISOString(), evidence: `${reward.name}@${reward.position.x},${reward.position.y},${reward.position.z}`, seen: !!bot._dragonSeen }));
    } catch {}
    log.info(`*** ENDER DRAGON DEFEATED - evidence: ${reward.name} at ${reward.position.x},${reward.position.y},${reward.position.z} - game cleared ***`);
    return true;
  } catch { return false; }
}

// `mine` (src/skills/primitives.js) needs the tunnel-through-rock routine: when a vein is in sight but
// pathfinder has no route to it, digging a heading is the only move that works. Callers require this
// module lazily so the endgame <-> primitives cycle stays out of load order.
module.exports = { mineBlockHere, isFluidSource, endGround, pickCrystalTarget, refuelFiller, wetTheEnderman, scoopBucket, clearShotSpot, giveUpCrystal, liftOntoPillar, opVoidLift, islandCellCandidates, inEnd, opScreenAt, blastScreenAndPunch, dragonHpProbe, opPerchLift, opPillarUp, dragonMeleeSweep, freeOneSlot, crystalCount, endermanShelter, dragonLead, highGroundPerch, highGroundTower, fountainApproach, placeRoofCell, lookAtItsFloor, JETTISON_ORDER, siteMemory: { siteCooling, siteStrikes, markSiteFail, rememberPair, saveSiteFails, siteFails, SITE_FILE } };
