'use strict';
// Progression ladder toward the End, expressed as milestones. Each milestone either:
//   - is already satisfied (skip it), or
//   - runs a deterministic routine (no LLM), and on repeated failure hands a terse observation
//     to the LLM planner to reflect and choose a fix.
const mcdata = require('minecraft-data');
const Vec3 = require('vec3');
const log = require('../log');
const reg = require('./registry');
const ob = require('../observe');
const P = require('./primitives');
const { countItem, craft, itemId, blockIds, sleep, data } = P;
require('./endgame'); // registers deep-mining + Nether/End skills used by the LADDER below

// ---- advanced skills that need furnace / digging / building ----
// Operator's call 2026-11-05: with infinite saturation cast on every spawn (src/bot.js MC_PERMA_FED), the
// hunger bar cannot move, so every ration test below is a question with a fixed answer. The food milestone
// and the dive gate both stand down on this flag - and it is deliberately tied to MC_ASSIST != 0, because
// an acceptance run on inst2 must still earn its own meal. The dragon fight is what this session tests;
// the picks, arrows, bench and crystals are still paid for honestly.
function permaFed() { return process.env.MC_PERMA_FED === '1' && process.env.MC_ASSIST !== '0'; }

reg.define('smelt', {
  desc: 'Craft+place a furnace if needed, then smelt `count` of an item (needs fuel; auto-adds coal).',
  params: { item: 'e.g. raw_iron', count: 'int default 4', fuel: 'e.g. coal default coal' },
  async run(bot, a) {
    let item = a.item; let fuel = a.fuel || null;
    // The model asks for "raw_chicken" because that is what the item means in English, but 1.21
    // stores raw meat under the bare name (chicken/beef/porkchop/mutton). Without this the food
    // milestone died on `unknown item "raw_chicken" for smelting` and got hauled back to the
    // surface to hunt, abandoning a shaft it had spent ten minutes digging.
    const ALIAS = { raw_chicken: 'chicken', raw_beef: 'beef', raw_pork: 'porkchop', raw_porkchop: 'porkchop', raw_mutton: 'mutton', raw_rabbit: 'rabbit', raw_salmon: 'salmon', raw_cod: 'cod', pork: 'porkchop' };
    if (ALIAS[item]) { log.skill(`smelt: "${item}" is not an item id - smelting ${ALIAS[item]} instead`); item = ALIAS[item]; }
    // Look 48 blocks, not 16: a furnace placed by the previous round sits just outside 16, and the
    // skill then built and placed ANOTHER one, leaving the first full of uncounted raw iron behind.
    // Each abandoned furnace is a hole in the inventory - its contents are invisible to both
    // `raw_iron` and `iron_ingot`, which is how the armor step kept reporting ingots=0.
    let furnace = bot.findBlock({ matching: blockIds(bot, ['furnace']), maxDistance: 48 });
    if (!furnace) {
      let ti = bot.inventory.items().find(i => i.name === 'furnace');
      if (!ti) {
        // a furnace costs 8 stone-family blocks and "tidy" keeps only ~16 cobblestone, so the
        // bot regularly sits on 7 - one short of being able to craft one at all.
        // The list must match what the RECIPE accepts (cobblestone / cobbled_deepslate / blackstone).
        // It used to also count andesite, diorite, granite and tuff, so `stoneCount()` reported
        // "enough" while `craft(furnace)` answered `need {"c":["cobblestone"...` - and smelt returned
        // a failure with no idea of the real shortage. Counting a superset of the recipe is the same
        // "exists vs adequate" bug that made worn iron count as diamond armour.
        const STONE = ['cobblestone', 'cobbled_deepslate', 'blackstone'];
        const stoneCount = () => STONE.reduce((s, n) => s + countItem(bot, n), 0);
        if (stoneCount() < 8) {
          log.skill(`smelt: only ${stoneCount()} furnace-grade stone (cobble family), need 8 - mining first`);
          await reg.get('mine').run(bot, { names: ['cobblestone', 'stone', 'deepslate', 'cobbled_deepslate'], count: 10 });
        }
        const cf = await craft(bot, 'furnace', 1);
        if (!cf.ok) return { ok: false, observation: `cannot make furnace (${cf.observation}) - furnace-grade stone=${stoneCount()}, cobble=${countItem(bot, 'cobblestone')}, cobbled_deepslate=${countItem(bot, 'cobbled_deepslate')}, blackstone=${countItem(bot, 'blackstone')}` };
        ti = bot.inventory.items().find(i => i.name === 'furnace');
      }
      if (ti) {
        try { await bot.equip(ti, 'hand'); } catch {}
        for (let t = 0; t < 5; t++) {
          if (await P.placeAtFreeNeighbor(bot)) break;
          // hop to a slightly higher, offset spot to find flat open ground, then retry
          const p = bot.entity.position.floored();
          // Hop SIDEWAYS, not up: underground (y=-43) a +4 climb has no headroom, the goto throws,
          // and the retry loop spends all five attempts in the same cramped cell.
          try { await bot.pathfinder.goto(new (g())(p.x + (t % 2 ? 6 : -6), p.y, p.z + (t < 3 ? 6 : -6), 2)); } catch { await sleep(900); }
        }
      }
      furnace = bot.findBlock({ matching: blockIds(bot, ['furnace']), maxDistance: 8 });
    }
    if (!furnace) return { ok: false, observation: 'furnace not placeable' };
    // Retry the walk to the furnace: a concurrent pathfinder user (defend, the health watchdog, or a
    // timed-out step calling pathfinder.stop()) aborts an in-flight goto with "The goal was changed
    // before it could be completed!", which alone was enough to fail the whole smelt round - so 48
    // iron nuggets sat in the pack unwalked-to while the armor step claimed it had no material.
    for (let t = 0; t < 3; t++) {
      try { await bot.pathfinder.goto(new (g())(furnace.position.x, furnace.position.y, furnace.position.z, 2)); break; }
      catch (e) { log.skill(`walk to furnace try ${t + 1} failed: ${e.message}`); await sleep(700); }
    }
    const FUELS = [fuel, 'coal', 'charcoal', 'oak_planks', 'spruce_planks', 'birch_planks', 'jungle_planks', 'dark_oak_planks', 'acacia_planks', 'cherry_planks', 'oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'dark_oak_log', 'stick'].filter(Boolean);
    fuel = FUELS.find(n => countItem(bot, n) > 0) || null;
    if (!fuel) { await reg.get('mine').run(bot, { names: ['coal_ore', 'deepslate_coal_ore'], count: 4 }); fuel = FUELS.find(n => countItem(bot, n) > 0) || 'coal'; }
    if (P.freeSlots(bot) < 3) {
      await P.dropJunk(bot, true, 6); // takeOutput needs somewhere to land
      // Trimming rock does not make room at a dig site: the tossed stack lands at the bot's own feet and
      // is picked straight back up. Measured 18:00 at y=3 - `broke deepslate_iron_ore ... the pack gained
      // 0` twice with free=0, which is ore it cannot collect and therefore armour it cannot afford, which
      // is what holds the dive gate shut. A chest is the only room that survives its own drop.
      if (P.freeSlots(bot) < 3) {
        try {
          const s = await reg.get('stash').run(bot, { min_free: 6 });
          log.skill(`smelt: still ${P.freeSlots(bot)} free after tossing - ${String(s.observation).slice(0, 110)}`);
        } catch (e) { log.warn(`smelt: chest escalation threw ${String(e.message).slice(0, 80)}`); }
      }
    }
    try {
      const f = await bot.openFurnace(furnace);
      // Empty what an earlier round left inside before loading anything. A timed-out step abandons the
      // window with ore in the input and finished ingots in the output; both are invisible to
      // countItem(), so the bot re-mines while sitting on the metal it already smelted.
      try { const pre = f.outputItem(); if (pre) { await f.takeOutput(); log.skill(`smelt: rescued ${pre.count}x ${pre.name} left in the furnace by an earlier round`); } } catch (e) { log.warn(`smelt rescue output: ${e.message}`); }
      try { const pri = f.inputItem(); if (pri) { await f.takeInput(); log.skill(`smelt: pulled ${pri.count}x ${pri.name} back out of the furnace`); } } catch (e) { log.warn(`smelt rescue input: ${e.message}`); }
      const inputId = itemId(bot, item);
      const fuelId = itemId(bot, fuel);
      const have = countItem(bot, item);
      if (!inputId) { f.close(); return { ok: false, observation: `unknown item "${item}" for smelting` }; }
      if (have <= 0) { f.close(); return { ok: false, observation: `no ${item} in inventory to smelt (fuel=${fuel} ${countItem(bot, fuel)})` }; }
      // 6 items per batch = ~63s of furnace time, which keeps the whole milestone inside the
      // planner's 240s program timeout (the ladder re-invokes smelt until the ore is gone).
      const want = Math.min(a.count || 4, have, 6);
      // These are all async. Called without `await` they rejected inside mineflayer's furnace.js
      // (assert.ok(item) on an empty output slot, "destination full" on transfer) and smelt
      // reported "ok" while having deposited nothing.
      try { await f.putInput(inputId, null, want); } catch (e) { log.warn(`putInput ${item}: ${e.message}`); }
      if (fuelId && countItem(bot, fuel) > 0) {
        try { await f.putFuel(fuelId, null, Math.min(countItem(bot, fuel), 8)); } catch (e) { log.warn(`putFuel ${fuel}: ${e.message}`); }
      }
      log.skill(`smelt: input=${f.inputItem() && f.inputItem().count} fuel=${f.fuelItem() && f.fuelItem().count} burning=${!!f.fuel}`);
      let taken = 0;
      const deadline = Date.now() + Math.min(200000, want * 10500 + 30000);
      while (Date.now() < deadline) {
        const out = f.outputItem();
        if (out) {
          try { await f.takeOutput(); taken += out.count; } catch (e) { log.warn(`takeOutput ${out.name}: ${e.message}`); await sleep(1500); continue; }
        }
        if (taken >= want) break;
        if (!f.inputItem() && !f.outputItem()) break; // nothing left in the furnace
        await sleep(2000);
      }
      try { await f.takeInput(); } catch {} // pull any unburnt ore back out before closing
      try { await f.takeFuel(); } catch {}
      f.close();
      const out = outputName(item);
      const got = countItem(bot, out);
      return { ok: got > 0, observation: `smelt ${item}->${out}: took ${taken} out of ${want} loaded, inventory now ${out}=${got}, ${item} left=${countItem(bot, item)}` };
    } catch (e) { return { ok: false, observation: 'smelt threw: ' + e.message }; }
  },
});
reg.define('dig_to_y', {
  desc: 'Staircase-dig straight down until reaching Y = toY (for finding deep ores like diamond). Safe: leaves a step.',
  params: { toY: 'int default -53', max: 'int default 25 - digs per call, so the step finishes inside its own timeout' },
  async run(bot, a) {
    const toY = a.toY ?? -53; let dug = 0;
    // Honour `max`. The loop used to be hard-wired to 400 digs, so one call could spend 400 x
    // (dig + walk) - far beyond PROGRAM_TIMEOUT_MS - and every caller (the armor step at 180 s) hit
    // "timeout after 180s" without the descent ever completing. Bounded calls accumulate across
    // rounds instead: the bot simply stays where it dug to and the next call continues.
    const cap = Math.max(4, Math.min(400, parseInt(a.max, 10) || 25));
    // A descent with no pick in hand is a descent that pays nothing: stone, deepslate and ore all drop
    // ZERO to a bare hand, and this routine used to log `no pickaxe in the pack for stone - hand-digging
    // it` and keep digging anyway. Live 01:16-01:30 that sank y=48 -> y=46 in 14 minutes, then the step
    // went SILENT for 182 s with the End door open 110 blocks away, while 16 cobblestone and 9 sticks (a
    // stone pick is 3 + 2) sat uncrafted in the pack.
    if (P.usablePickCount(bot) === 0) {
      log.warn(`dig_to_y: no usable pickaxe in the pack - minting one before the descent (hand-dug stone drops nothing)`);
      const et = await reg.get('ensure_tools').run(bot, {}).catch(e => ({ ok: false, observation: `ensure_tools threw ${String(e.message).slice(0, 70)}` }));
      if (P.usablePickCount(bot) === 0) return { ok: false, observation: `no descent without a pick: ensure_tools left ${P.usablePickCount(bot)} usable picks (${String((et && et.observation) || 'no answer').slice(0, 150)}). A stone pick wants 3 cobblestone/cobbled_deepslate/blackstone + 2 sticks and a table within reach - pay for that first, then call dig_to_y again` };
      log.skill(`dig_to_y: pick re-minted (${P.usablePickCount(bot)} usable) - continuing the descent`);
    }
    // Do not sink a shaft into the respawn column - it turns the spawn point into a fatal pit the
    // bot falls into after every death (observed: 49 deaths at one x,z). Sidestep off dry land first.
    const dl = bot._dryLand;
    if (dl && Math.abs(bot.entity.position.x - dl.x) <= 3 && Math.abs(bot.entity.position.z - dl.z) <= 3) {
      try { await bot.pathfinder.goto(new (g())(dl.x + 16, bot.entity.position.y, dl.z + 12, 2)); } catch {}
      await sleep(500);
    }
    while (bot.entity.position.y > toY && dug < cap && Date.now() < (bot._stepDeadline || Infinity)) {
      const f = bot.entity.position.floored();
      const below = bot.blockAt(f.offset(0, -1, 0));
      const head = bot.blockAt(f.offset(0, 1, 0));
      // Water is as fatal as lava down a shaft: digging a waterlogged block floods the hole and the
      // bot drowns in it, respawns, and repeats the identical dig (3 deaths at -110,49,294).
      if (below && below.name.includes('water')) {
        return { ok: false, observation: `shaft is WATERLOGGED at y=${f.y} (${below.name} below, head=${head ? head.name : 'air'}) - do not dig straight down here; use branch_mine at this level or roam to a dry mining site` };
      }
      if (head && head.name.includes('water')) {
        await rotate(bot);
        const dry = await escapeWater(bot);
        if (!dry) return { ok: false, observation: `standing IN water at y=${f.y} and no dry neighbouring cell to step to - surface first` };
        continue;
      }
      if (!below) break;
      if (below.name.includes('lava')) { await rotate(bot); continue; }
      // A real staircase, never a free-fall. The loop used to dig only the block under the feet and
      // drop, once per iteration, down a 1-wide shaft - and that client-simulated fall is exactly
      // what Paper still rejects (3 invalid_player_movement kicks in 30 minutes here, all during a
      // descent at y=-11). Dig the diagonal-front floor plus the face, then let pathfinder WALK one
      // step down, so the bot is grounded on every block change and rotates its heading every few
      // steps to spiral instead of punching a straight column.
      const dir = [[1, 0], [0, 1], [-1, 0], [0, -1]][Math.floor(dug / 3) % 4];
      try { await equipBulkPick(bot); } catch {}
      for (const [ox, oy, oz] of [[dir[0], -1, dir[1]], [dir[0], 0, dir[1]], [0, -1, 0]]) {
        const b2 = bot.blockAt(f.offset(ox, oy, oz));
        if (!b2 || /air/.test(b2.name) || /lava|water|bedrock/.test(b2.name)) continue;
        try { await bot.dig(b2); if (oy === -1 && ox === 0 && oz === 0) dug++; } catch {}
      }
      await sleep(220);
      try { await bot.pathfinder.goto(new (g())(f.x + dir[0], f.y - 1, f.z + dir[1], 0.6)); } catch {}
      continue;
    }
    return { ok: bot.entity.position.y <= toY + 2, observation: `dug ${dug}, now y=${Math.round(bot.entity.position.y)}${dug > 0 && bot.entity.position.y > toY ? ' (partial descent, call again to continue from here)' : ''}` };
  },
});
reg.define('strip_mine', {
  desc: 'Branch-mine a 2-high tunnel to expose deepslate ores (diamond/iron/coal) while walking a direction.',
  params: { length: 'int default 40', direction: 'N|S|E|W default E' },
  async run(bot, a) {
    const len = a.length || 40; const dir = dirVec(a.direction || 'E'); let exposed = { diamond_ore: 0, iron_ore: 0, coal_ore: 0 };
    for (let i = 0; i < len; i++) {
      const f = bot.entity.position.floored().offset(dir.x, 0, dir.z);
      for (const off of [[0, 0], [0, 1], [-dir.z, 0], [dir.z, 0]]) {
        // Both cells must be read: `blockAt(a) || blockAt(b)` returns a for loaded air, so the second
        // row was never counted and an ore vein one block taller than the sight line read as "no ore".
        for (const dy of [1, 2]) {
          const b = bot.blockAt(f.offset(off[0], dy, off[1]));
          if (b && /_ore$/.test(b.name)) { exposed[b.name] = (exposed[b.name] || 0) + 1; break; }
        }
      }
      await digForward(bot, f, dir);
    }
    return { ok: true, observation: `striped ${len} blocks; ore seen=${JSON.stringify(exposed)} slots=${ob.invSummary(bot).slots}` };
  },
});
// Anything the bot can actually eat, and what raw meat becomes in a furnace. outputName() used to
// turn "beef" into "beef", so smelt(beef) claimed to have made beef and the food step never saw
// cooked_beef.
// Does the bot actually HAVE this piece - in the pack, in its hand, or ON its body? Worn armour is
// not part of inventory.items(), so a `countItem(...) >= 1` predicate on an armour piece silently
// becomes unsatisfiable the moment the bot equips what it crafted: `diamond_gear` would then keep
// crafting chestplates forever (same exists-vs-adequate family that already cost this run hours on
// the tool ladder and on the armor step).
function hasGear (b, name) {
  if (countItem(b, name) >= 1) return true;
  try { if (b.heldItem && b.heldItem.name === name) return true; } catch {}
  const slot = { diamond_helmet: 5, diamond_chestplate: 6, diamond_leggings: 7, diamond_boots: 8,
    iron_helmet: 5, iron_chestplate: 6, iron_leggings: 7, iron_boots: 8,
    netherite_helmet: 5, netherite_chestplate: 6, netherite_leggings: 7, netherite_boots: 8 }[name];
  if (slot) { const it = b.inventory.slots[slot]; return !!it && it.name === name; }
  return false;
}
const EDIBLE = ['cooked_beef', 'beef', 'apple', 'bread', 'porkchop', 'cooked_porkchop', 'chicken', 'cooked_chicken', 'mutton', 'cooked_mutton', 'carrot', 'potato', 'baked_potato', 'cod', 'cooked_cod', 'salmon', 'cooked_salmon', 'rabbit', 'cooked_rabbit', 'sweet_berries', 'glow_berries',
  // Emergency rations, counted as food security: every shaft fight drops it, and the `food`
  // milestone was failing on a hill with no animals while a stack of flesh went unused. auto-eat is
  // configured to eat this only when nothing else exists (fallbackFood), so it never displaces meat.
  'rotten_flesh', 'dried_kelp'];
const COOKED = { beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato', rabbit: 'cooked_rabbit', wet_sponge: 'sponge', kelp: 'dried_kelp' };
function outputName(raw) { if (COOKED[raw]) return COOKED[raw]; return raw.replace(/^raw_/, '').replace(/_ore$/, '') + (raw.includes('iron') ? '_ingot' : raw.includes('gold') ? '_ingot' : raw.includes('copper') ? '_ingot' : ''); }
function dirVec(d) { return { N: { x: 0, z: -1 }, S: { x: 0, z: 1 }, E: { x: 1, z: 0 }, W: { x: -1, z: 0 } }[d] || { x: 1, z: 0 }; }
function g() { const pf = require('mineflayer-pathfinder'); return (pf.goals && pf.goals.GoalNear) || pf.pathfinder.Goals.GoalNear; }
async function rotate(bot) { await bot.look(require('./primitives').yawNow(bot) + Math.PI / 2, 0, true).catch(() => {}); }
// Step onto a neighbouring dry cell instead of drowning in a flooded shaft. Digs the blocker away
// when the only way out is through stone, and never steps into water or lava.
async function escapeWater(bot) {
  const GN = g(), f = bot.entity.position.floored();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [0, 2]]) {
    const side = bot.blockAt(f.offset(dx, 0, dz));
    const above = bot.blockAt(f.offset(dx, 1, dz));
    if (!side || !above) continue;
    if (side.name.includes('water') || side.name.includes('lava')) continue;
    if (!P.isAir(above.name)) { try { await equipBulkPick(bot); await bot.dig(above); await sleep(250); } catch { continue; } }
    if (!P.isAir(side.name)) { try { await equipBulkPick(bot); await bot.dig(side); await sleep(300); } catch { continue; } }
    try { await bot.pathfinder.goto(new GN(f.x + dx, f.y, f.z + dz, 1)); return true; } catch {}
  }
  return false;
}
// Bulk rock digging must not burn the high-tier picks. The equipPick above walks
// netherite->diamond->iron->stone, so the shaft diggers - which only ever cut stone,
// deepslate and dirt - spent the ONE diamond pickaxe the obsidian chain requires
// (06:15 dpick@86% grinding dirt -> gone by 06:38, obsidian blocked). Cheapest pick that
// can still do the job wins: stone and wooden cut everything in a shaft.
async function equipBulkPick(bot) {
  const order = ['stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];
  const inv = bot.inventory.items();
  for (const n of order) {
    const cand = inv.filter(i => i.name === n).sort((a, b) => (ob.wear(bot, b) ?? 0) - (ob.wear(bot, a) ?? 0))[0];
    if (!cand) continue;
    if ((ob.wear(bot, cand) ?? 100) < 12) continue;
    try { await bot.equip(cand, 'hand'); return true; } catch { return false; }
  }
  return false;
}

async function equipPick(bot) {
  const pick = ['diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe'].map(n => bot.inventory.items().find(i => i.name === n)).find(Boolean);
  if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
}
async function digForward(bot, target, dir) {
  const b = bot.blockAt(target.offset(0, 1, 0));
  const b2 = bot.blockAt(target.offset(0, 2, 0));
  try { await equipPick(bot); if (b) await bot.dig(b); if (b2) await bot.dig(b2); await bot.setControlState('forward', true); await sleep(400); await bot.setControlState('forward', false); } catch {}
}

// ---- milestone ladder ----
function haveGear(bot) {
  const slots = {}; for (const i of bot.inventory.items()) slots[i.name] = (slots[i.name] || 0) + i.count;
  return slots;
}
const LADDER = [
  { id: 'wood', done: b => countItem(b, 'oak_log') + countItem(b, 'spruce_log') + countItem(b, 'birch_log') + countItem(b, 'jungle_log') + countItem(b, 'acacia_log') >= 8,
    run: b => reg.get('chop_trees').run(b, { count: 12 }) },
  { id: 'crafting_table', done: b => countItem(b, 'crafting_table') >= 1 || haveGear(b).crafting_table,
    run: b => craft(b, 'crafting_table', 1) },
  { id: 'wooden_pickaxe', done: b => countItem(b, 'wooden_pickaxe') >= 1,
    run: async b => { await P.craftPlanks(b); await craft(b, 'stick', 4); return craft(b, 'wooden_pickaxe', 1); } },
  { id: 'stone', done: b => countItem(b, 'cobblestone') >= 16,
    run: b => reg.get('mine').run(b, { names: ['stone', 'cobblestone'], count: 20 }) },
  { id: 'stone_tools', done: b => countItem(b, 'stone_pickaxe') >= 1 && countItem(b, 'stone_sword') >= 1,
    run: async b => { await craft(b, 'stick', 6); await craft(b, 'stone_pickaxe', 1); return craft(b, 'stone_sword', 1); } },
  // Count food in TOTAL, not "3 of one kind": with beef x2 + chicken x1 the old .some(>=3) test was
  // false, so `food` re-opened every single round (the ladder printed "routine said ok but the
  // condition is still false" and bounced eat->hunt->status forever) even though the bot was holding
  // three edible items and a full hunger meter was one bite away.
  // The dive gate owns hunger once the door is open - and this milestone kept taking the hand back:
  // grazing drained the meter from 20 to 17, `food` re-opened, and at 23:55 the ladder sent a bot that had
  // been 2 blocks from an OPEN portal out to swim for kelp 89 blocks away, where it "broke 1 kelp column(s)
  // and none landed in the pack". Two owners for one resource is the ping-pong, so while the ring is
  // complete and the door is close, a bot with a ration in the pack and a meter above 8 is fed ENOUGH to
  // dive; the dive gate's own latched waiver is what decides. An empty pack still re-opens this (no dive on
  // zero food), and any earlier stage keeps the original 3-items-or-full-bar rule untouched.
  { id: 'food', budgetMs: 420000, done: b => {
      if (permaFed()) return true;
      const ed = EDIBLE.reduce((s, n) => s + countItem(b, n), 0);
      if (ed >= 3 || b.food >= 19) return true;
      try {
        const rec = require('../portalRecord').current();
        if (!rec || !rec.ringComplete || !Number.isFinite(rec.x)) return false;
        const p = b.entity && b.entity.position;
        if (!p || !Number.isFinite(p.x) || Math.hypot(p.x - rec.x, p.z - rec.z) > 140) return false;
        return ed >= 1 && b.food >= 8;
      } catch { return false; }
    },
    run: async b => {
      // `done` above already stands down under MC_PERMA_FED; this is the same answer for whichever caller
      // reaches the body directly (the planner's eat/unblock routes do), so a food errand cannot be started
      // by a path that does not consult the milestone.
      if (permaFed()) return { ok: true, observation: 'MC_PERMA_FED: saturation is infinite, the hunger bar cannot move - no food errand, no hunt, no descent for a zombie. Go dig the paving blocks and the eyes instead.' };
      // Hunt alone livelocked this step: the bot stood on dry land with food=0 and hunt found no
      // animal, while eat() answered "auto-eat on" (ok) - so it reported success forever. Now it
      // hunts, cooks whatever raw meat it already carries, and reports the true edible count.
      const have = () => EDIBLE.reduce((s, n) => s + countItem(b, n), 0);
      // With the End door open and close, THE MEAL IS BELOW, NOT ON THE SURFACE. Tonight, measured: it killed
      // a zombie at y=23 in the stronghold corridor, while every surface graze in this ocean region answered
      // `no kelp column within 64 blocks` / `no REACHABLE cow/pig/sheep/chicken within 70`, and each of those
      // refusals walked it FURTHER from an open portal (2 blocks at 00:12 -> 299 blocks by 00:16, ending with
      // `edible=0`). The dark layer is the only larder that has actually produced food in this biome, so go
      // there first instead of circling the islet.
      const doorForLarder = (() => {
        try {
          const rec = require('../portalRecord').current();
          if (!rec || !rec.ringComplete || !Number.isFinite(rec.x)) return null;
          const p = b.entity && b.entity.position;
          if (!p || !Number.isFinite(p.x)) return null;
          const d = Math.hypot(p.x - rec.x, p.z - rec.z);
          return d <= 220 ? { d: Math.round(d), rec } : null;
        } catch { return null; }
      })();
      if (doorForLarder && have() === 0 && b.entity.position.floored().y >= 40 && b.food >= 8) {
        log.warn(`food: the door is open ${doorForLarder.d} blocks away, the pack has ZERO rations and this surface has none either - going DOWN to y=26 (the dark corridors where this run has already killed a zombie) instead of grazing the ocean`);
        let dr = null;
        try { dr = await reg.get('dig_to_y').run(b, { toY: 26, max: 26 }); } catch (e) { dr = { ok: false, observation: 'dig_to_y threw ' + String(e.message).slice(0, 60) }; }
        let hr = null;
        try { hr = await reg.get('hunt_spider').run(b, { kind: 'zombie', count: 2, maxDistance: 34 }); } catch (e) { hr = { ok: false, observation: 'hunt_spider threw ' + String(e.message).slice(0, 60) }; }
        return { ok: have() >= 1, observation: `dark larder now at y=${b.entity.position.floored().y}: descent=${String((dr && dr.observation) || 'none').slice(0, 80)} | hunt=${String((hr && hr.observation) || 'none').slice(0, 110)} | rations=${have()}` };
      }
      const inWater = () => { const bl = b.blockAt(b.entity.position.floored()); return !!bl && (bl.name === 'water' || bl.name === 'kelp_plant' || bl.name === 'seagrass'); };
      // An ocean tile has no cows, pigs, sheep or chickens at all, and hunting while swimming is
      // how the bot drowned to Drowned three times in a row. Get onto dry land first, then hunt.
      // Animals live on grass above sea level; at y<62 (riverbed/ocean floor) hunting can never work
      // because the pathfinder will not route through water. Surface, then hunt, then travel.
      const lowOrWet = () => {
        const f = b.entity.position.floored();
        const bl = b.blockAt(f), hd = b.blockAt(f.offset(0, 1, 0));
        return /water|kelp_plant|seagrass/.test((bl && bl.name) || '') || /water/.test((hd && hd.name) || '') || f.y < 62;
      };
      if (lowOrWet()) { await reg.get('recover_surface').run(b, {}); await sleep(2000); }
      // "A long time without food" is a clock, not a retry count: every call below fails in seconds, so
      // the attempt tallies never noticed the hour (measured 14:18-15:25, one ocean cell ran
      // hunt -> kelp -> roam -> hunt sixty-odd times with `edible=0` the whole way). Past three minutes of
      // an empty pack, stop asking this biome for a cow and go for a village's hay bales - grain is the
      // one food that exists where there is no livestock and no seaweed.
      if (have() >= 3 || b.food >= 19) b._hungrySince = 0;
      else if (!b._hungrySince) b._hungrySince = Date.now();
      const starvedFor = () => (b._hungrySince ? Date.now() - b._hungrySince : 0);
      const VILLAGE_AFTER_MS = Number(process.env.MC_VILLAGE_AFTER_MS || 180000);
      if (have() < 3) {
        // In taiga / snowy taiga biomes (zero cows/kelp), sweet berry bushes grow everywhere and
        // yield instant edible berries with zero combat and zero cooking.
        try {
          const berryIds = blockIds(b, ['sweet_berry_bush']);
          if (berryIds.length) {
            const bushes = b.findBlocks({ matching: berryIds, maxDistance: 48, count: 6 }) || [];
            if (bushes.length) {
              const GN = g();
              let picked = 0;
              for (const bp of bushes) {
                if (have() >= 6) break;
                const blk = b.blockAt(bp);
                if (!blk || blk.name !== 'sweet_berry_bush') continue;
                try {
                  await b.pathfinder.goto(new GN(bp.x, bp.y, bp.z, 2));
                  try { await b.activateBlock(blk); } catch {}
                  await P.collectNear(b, bp, ['sweet_berries']);
                  picked++;
                } catch {}
              }
              if (picked > 0) log.skill(`food: harvested ${picked} sweet_berry_bush(es) -> sweet_berries=${countItem(b, 'sweet_berries')}`);
            }
          }
        } catch {}
      }
      if (have() < 3) {
        const h = await reg.get('hunt').run(b, { count: 3 });
        if (!h.ok) {
          log.skill(`hunt said: ${h.observation}`);
          const kk = await reg.get('harvest_kelp').run(b, { count: 12 });
          if (kk.ok) log.skill(`harvest_kelp said: ${kk.observation}`);
          else if (starvedFor() > VILLAGE_AFTER_MS) {
            // If standing beside open water with a rod (or string+sticks to make one), fish right from shore!
            const canFish = countItem(b, 'fishing_rod') >= 1 || (countItem(b, 'string') >= 2 && countItem(b, 'stick') >= 3);
            let fishedOk = false;
            if (canFish) {
              try {
                const waterNear = b.findBlock({ matching: blockIds(b, ['water']), maxDistance: 12 });
                if (waterNear) {
                  await b.pathfinder.goto(new (g())(waterNear.position.x, b.entity.position.y, waterNear.position.z, 2)).catch(() => {});
                  const fr = await reg.get('fish').run(b, { count: 3, timeoutSec: 45 });
                  log.skill(`food: shore fishing said (${String(fr.observation).slice(0, 120)})`);
                  fishedOk = fr.ok || have() >= 3;
                }
              } catch {}
            }
            if (!fishedOk && have() < 3) {
              log.skill(`nothing edible for ${Math.round(starvedFor() / 60000)} min (kelp: ${String(kk.observation).slice(0, 80)}) - raiding a village for hay instead of roaming for a cow`);
              const rv = await reg.get('raid_village').run(b, { need: 3 });
              log.skill(`raid_village said: ${rv.observation}`);
              if (!rv.ok) {
                await reg.get('roam').run(b, { look_for: 'cow,pig,sheep,chicken', distance: 300 });
                await reg.get('hunt').run(b, { count: 3 });
              }
            }
          } else {
            await reg.get('roam').run(b, { look_for: 'cow,pig,sheep,chicken', distance: 300 });
            await reg.get('hunt').run(b, { count: 3 });
          }
        }
      }
      const raw = ['beef', 'porkchop', 'chicken', 'mutton', 'cod', 'salmon', 'kelp'].map(n => ({ n, c: countItem(b, n) })).filter(x => x.c > 0).sort((a, c) => c.c - a.c)[0];
      // Log the outcome. This call was fire-and-forget, so `eat: short food 9 -> 9 ate=nothing` on
      // 08:35 was the only trace that cooking had failed - i.e. the bot walked 100+ blocks hunting again
      // with a furnace and 31 coal in the pack and no way to see why the porkchop stayed raw.
      if (raw) {
        const sm = await reg.get('smelt').run(b, { item: raw.n, count: Math.min(6, raw.c) }).catch(e => ({ ok: false, observation: 'threw ' + e.message }));
        log.skill(`food: cooking ${raw.n} x${Math.min(6, raw.c)} -> ${sm.ok ? 'ok' : 'FAILED: ' + String(sm.observation).slice(0, 160)}`);
      }
      await reg.get('eat').run(b, {});
      const fed = b.food >= 14 && b.saturation >= 3;
      return { ok: have() >= 3 || fed, observation: `edible=${have()} meter=${Math.round(b.food)}/20 (raw meat=${raw ? raw.n + 'x' + raw.c : 'none'}, fuel coal=${countItem(b, 'coal') + countItem(b, 'charcoal')} logs=${countItem(b, 'birch_log') + countItem(b, 'oak_log')}, hp=${Math.round(b.health)} at y=${Math.round(b.entity.position.y)} dim=${b.game.dimension})` };
    } },
  { id: 'coal', done: b => countItem(b, 'coal') >= 3 || countItem(b, 'charcoal') >= 3 || b.inventory.items().filter(i => /_planks$|_log$/.test(i.name)).reduce((s, i) => s + i.count, 0) >= 6,
    run: b => reg.get('mine').run(b, { names: ['coal_ore', 'deepslate_coal_ore'], count: 5 }) },
  { id: 'iron_ore', done: b => countItem(b, 'iron_ingot') >= 8 || (countItem(b, 'raw_iron') >= 8),
    run: async b => {
      const have = () => countItem(b, 'raw_iron') + countItem(b, 'iron_ingot');
      const PICK = ['diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'];
      // "Owns any pickaxe" is the wrong test for iron: a wooden pickaxe breaks the ore and drops
      // NOTHING, so this milestone sat at raw_iron=5 for many rounds (y=41, pick=wooden_pickaxe)
      // while the pack held 76 cobblestone and 5 sticks - exactly the materials for a stone pick.
      const stonePlus = () => ['stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe'].some(n => countItem(b, n) > 0);
      if (!stonePlus()) { await craft(b, 'stick', 6); await craft(b, 'stone_pickaxe', 1); }
      if (!PICK.some(n => countItem(b, n) > 0)) {
        // deadlock rescue: pickaxe broke and we cannot craft one (no materials/table) -> OP gives a replacement
        if (process.env.MC_ASSIST !== '0') {
          try { b.chat('/give @s stone_pickaxe 2'); await sleep(1000); } catch {}
        }
      }
      // if stuck deep in deepslate without an iron pick, return to surface & mine iron in the fast stone layer
      if (b.entity.position.y < 0 && !['iron_pickaxe', 'diamond_pickaxe'].some(n => countItem(b, n) > 0)) {
        await reg.get('recover_surface').run(b, {});
      }
      if (b.entity.position.y > 16) await reg.get('deep_shaft').run(b, { toY: 16, max: 22 });
      await reg.get('branch_mine').run(b, { names: ['iron_ore', 'deepslate_iron_ore'], count: 8 });
      if (have() < 8) await reg.get('branch_mine').run(b, { names: ['iron_ore', 'deepslate_iron_ore'], count: 8 });
      return { ok: have() >= 8, observation: `raw_iron=${countItem(b, 'raw_iron')} ingots=${countItem(b, 'iron_ingot')} y=${Math.round(b.entity.position.y)} pick=${b.inventory.items().filter(i => i.name.endsWith('pickaxe')).map(i => i.name).join(',')}` };
    } },
  { id: 'iron_ingots', done: b => countItem(b, 'iron_ingot') >= 8,
    run: b => reg.get('smelt').run(b, { item: 'raw_iron', count: countItem(b, 'raw_iron') }) },
  { id: 'iron_gear', done: b => countItem(b, 'iron_pickaxe') >= 1 && countItem(b, 'iron_sword') >= 1 && countItem(b, 'bucket') >= 1,
    run: async b => {
      // This step used to be five craft() calls plus equip, which returned ok while the bot held
      // nothing - the ladder then spun on it every 30 s ("equipped hand") instead of going to get
      // the metal. Cost the missing pieces first, and mine/smelt for them if the ingots are short.
      const cost = (countItem(b, 'iron_pickaxe') ? 0 : 3) + (countItem(b, 'iron_sword') ? 0 : 2) + (countItem(b, 'bucket') ? 0 : 3);
      if (countItem(b, 'iron_ingot') < cost) {
        if (!b.inventory.items().some(i => i.name.endsWith('_pickaxe'))) await reg.get('ensure_tools').run(b, {});
        const want = Math.max(1, Math.min(8, cost - countItem(b, 'iron_ingot')));
        await reg.get('mine').run(b, { names: ['iron_ore', 'deepslate_iron_ore'], count: want, maxDistance: 48 });
        await reg.get('smelt').run(b, { item: 'raw_iron', count: 6 });
      }
      await craft(b, 'iron_pickaxe', 1); await craft(b, 'iron_sword', 1); await craft(b, 'bucket', 1); await craft(b, 'iron_boots', 1); await craft(b, 'iron_helmet', 1); return reg.get('equip').run(b, {});
    } },
  // budgetMs: this pipeline cannot fit the 180 s global cap, and that mismatch - not any single bug -
  // is why it stalled for hours. One pass needs: descend to the vein (~60 s) + mine 8 ore (~60-120 s) +
  // TWO smelt batches at ~10 s per item (the skill's own arithmetic: ~63 s per 6-item batch) + craft +
  // equip = ~350-450 s. Measured 03:04-03:25, three rounds cut in three different phases
  // (`armor:descend`, `armor:branch-mine`, `armor:sight-mine`), each abandoning its half-done work:
  // the furnace never got lit, the ore stayed unsmelted, and the next round re-crafted a table.
  // Every other long milestone already declares its own budget (obsidian 420, blaze_rods 480); armor
  // was the only one inheriting the cap. The step mutex (§11) keeps the watchdog from interrupting it.
  { id: 'armor', budgetMs: 420000, done: b => {
      // Lowered from "4 pieces worn at once" to a survival bar, on measured grounds: over one night the
      // run produced iron steadily (ingots swinging 2<->11, 143 cobble mined) yet failed this gate 145
      // times, because iron armour breaks as fast as it is re-made and the condition demanded all four
      // slots simultaneously - so it re-spent its 2 ingots on a replacement helmet instead of saving
      // for the chestplate, forever. The gate exists to make the dragon fight survivable, which is
      // torso coverage + one more piece + food to regen on. keepInventory is on, so the residual risk
      // costs time, not gear. This is my scaffolding being retuned, not a game rule being bent: the
      // pieces still have to be actually worn, and the End still has to be reached and won alone.
      const worn = ['helmet', 'chestplate', 'leggings', 'boots'].filter((pt, i) => {
        const it = b.inventory.slots[5 + i];
        return !!it && it.name.endsWith('_' + pt);
      });
      return worn.includes('chestplate') && worn.length >= 2;
    },
    run: async b => {
      // A companion that dies to every mob inside the stronghold cannot reach the dragon.
      // This step is only "done" when the pieces are actually WORN, not merely crafted.
      const have = n => countItem(b, n);
      // Stage labels for the step timer. `timeout after 180s` cannot say WHERE it hung, and this step
      // has already burned rounds in light, in dig_to_y, in smelt and in a stranded craft window -
      // each of which needs a different fix. The planner prints the last one set.
      const ph = s => { b._loopPhase = 'armor:' + s; };
      const SLOT = { helmet: 5, chestplate: 6, leggings: 7, boots: 8 };
      const PIECES = ['boots', 'helmet', 'leggings', 'chestplate'];
      const COST = { boots: 4, helmet: 5, leggings: 7, chestplate: 8 };
      const wornPiece = p => { const it = b.inventory.slots[SLOT[p]]; return !!it && it.name.endsWith('_' + p); };
      // The worn piece's MATERIAL matters: `wornPiece` only matched the suffix, so wearing an iron
      // helmet made owns('diamond','helmet') true, the step concluded it was diamond-tier equipped,
      // set ING='diamond', found 0 diamonds, never crafted the leggings its 13 iron ingots could
      // have bought, and burned 180 s per round mining instead - the exists-vs-adequate bug again.
      const wornTierOf = p => { const it = b.inventory.slots[SLOT[p]]; return it ? it.name.split('_')[0] : null; };
      const owns = (t, p) => have(`${t}_${p}`) > 0 || wornTierOf(p) === t;
      const tierPref = ['netherite', 'diamond', 'iron'].find(t => PIECES.some(p => owns(t, p))) || 'iron';
      const firstMissing = PIECES.find(p => !owns(tierPref, p));
      // Leather is the affordable fallback when iron cannot pay for the NEXT piece. Measured 16:20:
      // iron_ingot 0, cobblestone 0, no furnace - the iron route is ~19 ore mined, carried, and smelted
      // in batches, while `hunt` killed a pig and two chickens in under two minutes at this very spot.
      // This is NOT a weakened gate: `armor` asks for pieces actually WORN, of any material, and a
      // player armouring up cheap does exactly this on the way to the Nether. It also caps the iron
      // treadmill, because iron armour wears out and a full wipe re-opens the gate from zero.
      // (The material bid lives below, next to `slotCovered`: it cannot be decided until the gate
      // knows which slot it is still missing.)
      // Craft ONE affordable piece per call, cheapest first. Worn armor does not appear in
      // items(), so the old "do we own any piece?" test never saw the boots it was wearing and
      // re-ran the 24-ingot branch every time: 11 ingots in the pack, three consecutive 420 s
      // timeouts inside smelt rounds, and no helmet.
      // Repair before re-crafting: two damaged iron pieces of a kind combine into one (near-)new
      // piece in the 2x2 grid, which costs zero ingots. Without it the bot had to mine/smel/craft a
      // whole set again every time a piece broke, and the run spent 40 minutes bouncing between
      // 13 and 14 milestones on that treadmill.
      ph('repair');
      try {
        const rp = await require('../gridcraft').repairGear(b, 55, /_(pickaxe|axe|sword|shovel|hoe)$/);
        if (rp.repaired.length) log.skill(`armor: ${rp.observation}`);
      } catch {}
      // Light only where it is actually dark, and only a few per call. My earlier fix raised this to
      // 12 torches every round to stop the zombie deaths (it worked: 43 deaths -> 1), but each
      // placement is a pathfinder hop, so 12 of them ate the entire 180 s step budget and the armour
      // milestone timed out without ever crafting the missing piece.
      try {
        const f = b.entity.position.floored();
        const lit = typeof b.lightLevel === 'function' ? b.lightLevel(f) : 0;
        if (lit < 7) {
          ph('light');
          await reg.get('light').run(b, { count: 4 });
          log.skill(`armor step lit 4 torches (light level here was ${lit})`);
        }
      } catch {}
      let made = null;
      // EMPTY slots before upgrades. Measured failure at 08:26: it wore a leather helmet and boots,
      // `owns('iron','helmet')` was therefore false, and with 2 ingots in the pack both the LLM and
      // this loop bid on a 5-ingot iron helmet - a slot it already had covered - instead of saving for
      // the 8-ingot chestplate it genuinely lacked. That is how the night burned 145 rounds: spending
      // on covered slots keeps the ingot total below the one piece that would pass the gate.
      const slotCovered = p => wornPiece(p) || ['netherite', 'diamond', 'iron', 'gold', 'chainmail', 'leather'].some(t => have(`${t}_${p}`) > 0);
      const missing = PIECES.filter(p => !slotCovered(p));
      // The piece the GATE still wants. `done` is "a worn chestplate + one more piece", so the chestplate
      // is the bid only while that slot is bare; once it is worn, the gate is one cheap slot away and the
      // cheapest uncovered piece is what changes the result. Measured 00:20: worn=[chestplate],
      // iron_ingot=3, leather=4 - boots cost 4 of either, so four hides passed the gate while the 3-ingot
      // pack could only buy nothing, and the step spent the round branch-mining for iron it did not need.
      const gatePiece = slotCovered('chestplate') ? (missing[0] || 'chestplate') : 'chestplate';
      const gateCost = COST[gatePiece];
      // Leather is chosen ONLY when the hides can pay for the GATE piece right now. The test used to be
      // `firstMissing` (boots, 4 hides), and that quietly overrode fix 1 one layer up: at 04:49:50 the
      // step entered `tier='leather'`, computed `need 0 hides (have 4)`, and then went to HUNT COWS for
      // them in a biome §13 already proved has no cattle - burning the round and never reaching the iron
      // path that the fuel fix had just reopened. The gate piece is the only number the material choice
      // may bid against - and it is the gate piece, not always the chestplate, because the chestplate can
      // already be on the bot's back.
      const tier = (tierPref === 'iron' && have('iron_ingot') < gateCost
        && have('leather') >= gateCost) ? 'leather' : tierPref;
      const ING = { netherite: 'netherite_ingot', diamond: 'diamond', iron: 'iron_ingot', leather: 'leather' }[tier];
      // Buy the GATE piece first. This loop used to walk PIECES cheapest-first and break on the first
      // affordable one, so at 12 ingots it spent 7 on leggings and at 9 it spent 5 on a helmet - each
      // purchase leaving less than the 8 a chestplate costs, and the chestplate is the one piece `done`
      // cannot pass without. Measured 22:18-00:26: the pack crossed 8 ingots twice and still never
      // wore a chestplate, so the round ended and it went back to mining. While that slot is uncovered
      // nothing else is bought; once it is, the cheapest remaining slot fills for the gate's 2nd piece.
      const buyOrder = slotCovered('chestplate') ? ['boots', 'helmet', 'leggings'] : ['chestplate'];
      ph('buy-piece');
      for (const p of buyOrder) {
        if (owns(tier, p)) continue;
        // Only consider a covered slot once nothing is missing, so the material goes to the piece
        // that actually changes the gate result.
        if (slotCovered(p) && missing.length) continue;
        if (have(ING) >= COST[p]) { const r = await craft(b, `${tier}_${p}`, 1); if (r && r.ok) made = p; break; }
      }
      if (!made && !PIECES.every(p => owns(tier, p))) {
        // Not enough material for the next piece: one batch, then hand control back to the ladder
        // instead of camping in this step until the milestone timeout fires.
        // Only light a furnace for a real batch. With 1 raw_iron it smelted one item per ~70 s
        // milestone round and the armor step crawled (worn=[none] ingots=3 raw_iron=1 over and
        // over); mining a proper vein first costs less than the furnace cycles it saves.
        // Iron nuggets first: this bot carries 54 of them (zombie/fall drop + smithing leftovers),
        // one nugget smelts to one ingot, and that is a whole armour set with no mining at all -
        // but the step only ever looked at raw_iron, so it kept walking back into the mine instead.
        if (tier === 'leather') {
          // Cows are the whole route: 1-2 hides each, and `hunt` now walks the kill site to collect
          // drops (it used to report "killed 5, meat 0"). Cows only exist on grass above sea level, so
          // get there first instead of hunting a cave and logging a failure forever.
          // Against the GATE piece's cost, and don't hunt what the pack already has: the old form
          // produced `need 0 hides (have 4)` and then searched for three cows anyway.
          const needHide = gateCost - have('leather');
          if (needHide <= 0) {
            const r = await craft(b, `leather_${gatePiece}`, 1);
            log.skill(`armor: leather already covers the gate piece (${have('leather')} hides for ${gatePiece}) - crafting ${gatePiece}, not hunting: ${r.ok ? 'ok' : 'failed'}`);
            if (r && r.ok) made = gatePiece;
          } else {
          // Cows are an Overworld animal AND y<62 is an Overworld quantity, so out in the Nether both halves
          // of this branch are always true: it would call recover_surface, which delegates to
          // return_overworld - a portal ride HOME - from inside a blaze run, and the pack carries 3 obsidian
          // against the 10 needed to come back. Skip the hide hunt when there is nothing to hunt.
          const dimHide = (b.game && b.game.dimension) || 'overworld';
          if (dimHide !== 'overworld') {
            log.skill(`armor: no cows in ${dimHide} and altitude means nothing here - skipping the hide hunt rather than riding the portal home for it`);
            return { ok: false, observation: `leather armour cannot be crafted in ${dimHide}: cows do not exist outside the Overworld (hides=${have('leather')}, need ${needHide}) - take this tier on the Overworld side of a portal trip` };
          }
          if (b.entity.position.y < 62) { try { await reg.get('recover_surface').run(b, {}); } catch {} }
          // ...and HUNT alone is a 70-block search. The first version of this branch called only
          // `hunt`, which answered "no REACHABLE cow within 70 blocks - roam to open grass land first"
          // three rounds in a row in five seconds each: a fallback that can never succeed is worse
          // than no fallback, because the milestone reports "not done" without ever trying.
          let h = await reg.get('hunt').run(b, { count: Math.max(3, Math.ceil(needHide / 2)), kind: 'cow' });
          // No roam here on purpose: with the tier rule above this branch only runs when the hides are
          // already in the pack, and the roaming version spent 263 blocks per round finding none.
          log.skill(`armor: leather route - need ${needHide} hides (have ${have('leather')}) | ${String(h.observation).slice(0, 120)}`);
          }
        } else {
        // Vanilla fact check, correcting something I wrote into this step earlier today: iron NUGGETS
        // are NOT a furnace input. 9 nuggets CRAFT into 1 ingot (the "48 -> 3 nuggets, +6 ingots" I
        // measured was crafting, not smelting), and `smelt {item:'iron_nugget'}` was therefore a no-op
        // that ALSO required have(nugget)>=4 to even try. Raw iron IS smeltable.
        if (have('iron_nugget') >= 9) {
          const cg = await craft(b, 'iron_ingot', Math.floor(have('iron_nugget') / 9));
          log.skill(`armor: nuggets->ingots ${cg.ok ? 'ok' : 'failed'} nugget=${have('iron_nugget')} ingot=${have('iron_ingot')} | ${String(cg.observation).slice(0, 80)}`);
        }
        const smeltables = [['raw_iron', 8]];
        let smelted = false;
        // Fuel is a precondition of the smelt branch, and holding raw iron was enough to ENTER it - so
        // with `raw_iron=3 coal=0` the step spent every 420 s budget at y=65 trying to smelt, `smelt`
        // hunted coal_ore on a mountain top where none is exposed, and the branch that actually goes
        // down for iron+coal was skipped because `smelted` was already true. Measured identical for 17
        // straight minutes: `worn=[none] ingots=2 raw_iron=3 coal=0`. Needing coal to get coal is the
        // §10 self-lock class; the answer is to fall through to the dig, which targets iron AND coal.
        const FUELS = ['coal', 'charcoal', 'oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks',
          'acacia_planks', 'dark_oak_planks', 'oak_log', 'birch_log', 'spruce_log', 'jungle_log'];
        const fuel = FUELS.reduce((s, n) => s + have(n), 0);
        if (!fuel) log.skill('armor: no fuel in the pack - smelting is impossible here, going down to dig iron+coal instead');
        for (const [mat, cnt] of smeltables) {
          if (!fuel && mat === 'raw_iron') continue;
          if (have(mat) >= 2) { ph('smelt'); await reg.get('smelt').run(b, { item: mat, count: cnt }); smelted = true; break; }
        }
        if (!smelted) {
          // Go to the iron instead of hoping it is in range: this used to call mine(iron_ore) from
          // wherever it stood (y=73 on a mountain, maxDistance 48), found nothing, and reported
          // "need 4 pieces + fuel" forever. Iron veins sit well below y=24.
          // Get to the iron layer BEFORE hunting iron. One `dig_to_y {max:12}` per round left the bot
          // parked at y=53 running `mine` against veins it could SEE at y=24-38 but had no path to:
          // 16 target switches in 9 seconds (01:54:22-01:54:30, same at 02:02), `mined 0`, round spent.
          // dig_to_y already honours `bot._stepDeadline` and answers "partial descent, call again", so
          // the loop cannot overrun the step - it just stops wasting the round on an unreachable target.
          for (let k = 0; k < 4 && b.entity.position.y > 40; k++) {
            // A refusal is a LOCATION answer, not a "try again in place" answer. Measured 17:06:43:
            // `shaft is WATERLOGGED at y=60 (water below, head=water)` - the skill correctly refuses to
            // dig into an aquifer (that is the trap that used to drown it), but the step then reported
            // failure and the next round dug the same flooded column. Walk to dry ground, then descend.
            ph('descend');
            const yBefore = Math.round(b.entity.position.y);
            let dz = await reg.get('dig_to_y').run(b, { toY: 16, max: 12 }).catch(e => ({ ok: false, observation: 'threw ' + e.message }));
            if (/WATERLOGGED|IN water|standing IN/i.test(String(dz.observation))) {
              log.skill(`armor: refused by water (${String(dz.observation).slice(0, 70)}) - walking to a dry column before descending`);
              try { await reg.get('dry_escape').run(b, { max: 10 }); } catch {}
              dz = await reg.get('dig_to_y').run(b, { toY: 16, max: 12 }).catch(() => dz);
            }
            const yNow = Math.round(b.entity.position.y);
            log.skill(`armor: descend pass ${k + 1} -> y=${yNow} (was ${yBefore})${/partial/i.test(String(dz.observation)) ? ' [partial]' : ''}`);
            // Stop when a pass moves nothing. Measured 02:26:59: all four passes logged within 2 ms at
            // y=42 - the skill was refusing rather than digging, and an loop that spins on a refusal is
            // the same dead weight as the unbounded ones in §14. Only real descent justifies another pass.
            if (yNow >= yBefore) break;
          }
          // `mine` only takes ore it can SEE (it needs an exposed face within range), which is why the
          // armour step kept logging `mined 0 of ["iron_ore","deepslate_iron_ore"]` while standing in a
          // cave at y=53 with the veins one block behind the wall. `branch_mine` digs the tunnel that
          // exposes them and is what produced `mined 16 of [iron_ore...]` at 13:59. Try the cheap
          // sight-based pick first, then dig for it.
          const beforeIron = have('raw_iron');
          ph('sight-mine');
          // Iron and coal in one trip: fuel is the other half of this milestone (see the smelt branch
          // above), and the LLM kept proposing exactly this ("mine iron+coal in one pass") while the
          // deterministic path only asked for iron and then could not smelt what it brought back.
          const ORE = ['iron_ore', 'deepslate_iron_ore', 'coal_ore', 'deepslate_coal_ore'];
          const im = await reg.get('mine').run(b, { names: ORE, count: 8 });
          if (have('raw_iron') - beforeIron < 4) {
            log.skill(`armor: sight-mine gave ${have('raw_iron') - beforeIron} raw iron (${String(im.observation).slice(0, 60)}) - branch-mining to expose veins`);
            ph('branch-mine');
            await reg.get('branch_mine').run(b, { names: ORE, count: 8, length: 24 });
          }
          // Same correction as above: the furnace takes raw iron, not nuggets. Nugget piles are
          // converted by crafting (9->1) at the top of this step, so smelting here is raw_iron only.
          ph('smelt-batch');
          if (have('raw_iron') >= 2) await reg.get('smelt').run(b, { item: 'raw_iron', count: 8 });
        }
        }
      }
      ph('equip');
      await P.equipBestArmor(b);
      const worn = ['helmet', 'chestplate', 'leggings', 'boots'].filter(p => { const it = b.inventory.slots[5 + ['helmet', 'chestplate', 'leggings', 'boots'].indexOf(p)]; return !!it && it.name.endsWith('_' + p); });
      const spareChest = b.inventory.items().some(i => /_chestplate$/.test(i.name));
      return { ok: worn.includes('chestplate') && worn.length >= 2, observation: `worn=[${worn.join(',') || 'none'}${spareChest ? ' +chest spare in pack' : ''}] ingots=${countItem(b, 'iron_ingot') + countItem(b, 'diamond')} raw_iron=${countItem(b, 'raw_iron')} coal=${countItem(b, 'coal')}; gate wants a worn chestplate + one more piece (costs: chestplate 8, leggings 7, helmet 5, boots 4 ingots - EMPTY slot first)` };
    } },
  { id: 'diamond_pick', budgetMs: 360000, done: b => countItem(b, 'diamond_pickaxe') >= 1,
    run: async b => {
      if (countItem(b, 'diamond') < 3) { await reg.get('find_diamonds').run(b, { count: 3 }); }
      await reg.get('smelt').run(b, { item: 'raw_iron', count: countItem(b, 'raw_iron') });
      return craft(b, 'diamond_pickaxe', 1);
    } },
  { id: 'diamond_gear', optional: true, done: b => hasGear(b, 'diamond_sword') && hasGear(b, 'diamond_chestplate'),
    run: async b => {
      // The manual's §4 failure 主世界准备过度, applied to this step. It used to ask `find_diamonds`
      // for TEN diamonds and then craft a full five-piece set, and the run has been paying that bill
      // since: at 02:28:41 it was walking toward a table 16 blocks away to craft a diamond HELMET while
      // `diam=0`, `obs=6/10` and the Nether gate unopened. Nothing downstream reads a diamond set - the
      // pick (its own milestone) is what obsidian demands, the crystals are shot with the bow, and
      // `enter_end` builds a set itself if it arrives under-equipped. So: at most three diamonds, at
      // most a sword and a chestplate, and if the shaft cannot pay, the step CLOSES with the reason
      // instead of reopening every round.
      const have = countItem(b, 'diamond');
      if (have < 3) {
        const shaft = require('../shaftRecord');
        const canDig = shaft.live(shaft.current());
        if (!canDig && have === 0) {
          log.warn('diamond_gear SKIPPED: 0 diamonds in hand and no live shaft to continue - a set is not on the main chain (pick done, bow shoots the crystals, obsidian is next)');
          return { ok: true, skipped: 'diamond=0 and no shaft on file - a set is not on the main chain', observation: 'skipped: diamond gear is optional and unpayable here (diamond=0, no shaft on file) - go fill the portal frame' };
        }
        await reg.get('find_diamonds').run(b, { count: 3 });
      }
      if (countItem(b, 'diamond') < 3) return { ok: true, skipped: `only ${countItem(b, 'diamond')} diamonds after one bounded hunt`, observation: `skipped: only ${countItem(b, 'diamond')} diamonds after one bounded hunt - the pick is in hand and obsidian is the next link` };
      await craft(b, 'diamond_sword', 1);
      if (!hasGear(b, 'diamond_sword')) return { ok: false, observation: `have ${countItem(b, 'diamond')} diamonds but the sword craft failed (table reachable? planks=${countItem(b, 'oak_planks')})` };
      if (countItem(b, 'diamond') >= 8) { await craft(b, 'diamond_chestplate', 1); return reg.get('equip').run(b, {}); }
      // The predicate wants sword AND chestplate, and a chestplate costs 8. Without this the rung spends
      // three diamonds on a sword, can never satisfy its own flag, and re-hunts every round - the grind
      // this edit exists to stop, wearing a different hat. Close it the way the facility allows.
      return { ok: true, skipped: `sword crafted, ${countItem(b, 'diamond')} diamonds left (a chestplate wants 8)`, observation: `skipped the rest: a sword is in hand and the pick covers obsidian - a full set is not on the main chain` };
    } },
  { id: 'bow', done: b => countItem(b, 'bow') >= 1 && countItem(b, 'arrow') >= 8,
    run: async b => {
      // Never spend the bow step hand-digging stone/gravel when picks broke or were dropped.
      if (P.usablePickCount(b) === 0) {
        try {
          const et = await reg.get('ensure_tools').run(b, {});
          log.skill(`bow step ensure_tools: ${et.ok ? 'ok' : 'failed'} (${String(et.observation).slice(0, 90)})`);
        } catch (e) { log.warn('bow ensure_tools threw:', e.message); }
      }
      // A bow requires 3 string + 3 sticks. Previously this milestone tried craft('bow') once and then
      // spent its entire budget hunting chickens/gravel without EVER acquiring string.
      if (countItem(b, 'bow') < 1) {
        if (countItem(b, 'string') < 3) {
          // 1) Cobwebs (mineshafts/caves) drop 1 string guaranteed when broken with a sword.
          try {
            const webIds = blockIds(b, ['cobweb']);
            if (webIds.length) {
              const webs = b.findBlocks({ matching: webIds, maxDistance: 32, count: 4 }) || [];
              if (webs.length) {
                const sw = b.inventory.items().find(i => /_sword$/.test(i.name));
                if (sw) { try { await b.equip(sw, 'hand'); } catch {} }
                for (const wp of webs) {
                  if (countItem(b, 'string') >= 3) break;
                  const blk = b.blockAt(wp);
                  if (!blk || blk.name !== 'cobweb') continue;
                  try {
                    await b.pathfinder.goto(new (require('mineflayer-pathfinder').goals ? require('mineflayer-pathfinder').goals.GoalNear : require('mineflayer-pathfinder').pathfinder.Goals.GoalNear)(wp.x, wp.y, wp.z, 2));
                    await b.dig(blk);
                    await P.collectNear(b, wp, ['string']);
                  } catch {}
                }
              }
            }
          } catch {}
          // 2) Hunt spiders for remaining string. If underground with no nearby same-level spider, surface
          // first so night surface spiders (and daytime chickens/wood/gravel) are actually reachable instead
          // of drowning in dark caves chasing spiders behind granite walls.
          if (countItem(b, 'string') < 3) {
            const nearSpiderSameLevel = (() => {
              try {
                return !!b.nearestEntity(e => e && e.name && /spider/.test(e.name) && e.position
                  && b.entity.position.distanceTo(e.position) <= 32
                  && Math.abs(e.position.y - b.entity.position.y) <= 8);
              } catch { return false; }
            })();
            if (!nearSpiderSameLevel && b.entity && b.entity.position && b.entity.position.y < 55) {
              try { await reg.get('recover_surface').run(b, {}); } catch {}
            }
            const tod = b.time && typeof b.time.timeOfDay === 'number' ? (b.time.timeOfDay % 24000) : null;
            const isDaytime = tod !== null && (tod < 12300 || tod > 23400);
            if (!isDaytime || nearSpiderSameLevel || countItem(b, 'arrow') >= 8) {
              const hs = await reg.get('hunt_spider').run(b, { count: 3, maxDistance: 48 });
              log.skill(`bow step hunt_spider: ${hs.ok ? 'ok' : 'failed'} (${String(hs.observation).slice(0, 110)})`);
            } else {
              log.skill(`bow step: daytime (tod=${Math.round(tod)}) with no spider on this level - gathering arrows/feathers/flint first before hunting night spiders`);
            }
          }
        }
        if (countItem(b, 'string') >= 3 && countItem(b, 'stick') < 3) {
          await craft(b, 'stick', 4);
        }
        if (countItem(b, 'string') >= 3) {
          await craft(b, 'bow', 1);
        }
      }
      // 1 feather per arrow, and the generic hunt was killing cows instead: with flint+sticks in the
      // pack but no feathers the arrow craft always made 0 and the bow step looped.
      // One feather + flint + stick crafts FOUR arrows, so 2 feathers already satisfy the 8-arrow
      // requirement. This step used to insist on >=4 feathers, so it kept hunting (and failing)
      // while the arrows it could already make stayed uncrafted.
      // Flint, not feathers, is what gates the bow: arrow = flint + stick + feather, and the pack
      // held 3 flint_and_steel yet ZERO loose flint, so the arrow craft answered "no single item can
      // satisfy \"f\" (want 1 of flint)" four rounds in a row and this step ate its 180 s budget.
      // Vanilla flint only comes out of mined gravel (~10% per block), so dig a pile and keep what
      // drops instead of insisting the arrows are craftable.
      if (countItem(b, 'arrow') < 8 && countItem(b, 'flint') < 1) {
        const g = await reg.get('mine').run(b, { names: ['gravel'], count: 32, maxDistance: 64 });
        log.skill(`bow step digging gravel for flint: ${String(g.observation).slice(0, 110)} -> flint=${countItem(b, 'flint')}`);
      }
      // ...and sticks are the other half of an arrow. The pack had flint=2, feathers=2, planks=4 but
      // stick=0 (every stick had gone into tools and pressure plates), so the arrow craft failed on
      // "want 1 of stick" and the step timed out again. Two planks make four sticks: make them.
      if (countItem(b, 'stick') < 4) {
        const s = await craft(b, 'stick', 4);
        log.skill(`bow step making sticks for arrows: ${String(s.observation).slice(0, 90)}`);
      }
      const craftArrowsNow = async () => {
        // Bound the craft loop so a no-op craft never starves the event loop.
        for (let g = 0; g < 8 && countItem(b, 'feather') >= 1 && countItem(b, 'flint') >= 1 && countItem(b, 'arrow') < 12; g++) {
          const before = countItem(b, 'arrow');
          await craft(b, 'arrow', Math.min(12, before + countItem(b, 'feather') * 4));
          await sleep(250);
          if (countItem(b, 'arrow') === before) { log.skill(`bow: arrow craft made nothing (feather=${countItem(b, 'feather')} flint=${countItem(b, 'flint')} stick=${countItem(b, 'stick')}) - giving up this round`); break; }
        }
      };
      await craftArrowsNow();
      if (countItem(b, 'feather') < 1 && countItem(b, 'arrow') < 8) {
        // Chickens only live on grass at the surface; roaming for them inside a cave sends the bot
        // straight off a ravine ledge. Surface first when underground.
        if (b.entity && b.entity.position && b.entity.position.y < 55) {
          try { await reg.get('recover_surface').run(b, {}); } catch {}
        }
        const roam = await reg.get('roam').run(b, { look_for: 'chicken,cow,sheep,pig', distance: 320 });
        log.skill(`bow step roaming for chickens: ${roam.observation}`);
        await reg.get('hunt').run(b, { count: 4, kind: 'chicken' });
      }
      if (countItem(b, 'arrow') < 8) {
        // Dig gravel only when flint is genuinely short. This ran unconditionally and tunnelled after
        // gravel for the whole step budget while the pack already held 5 flint - enough for 20 arrows.
        if (countItem(b, 'flint') < 3) {
          await reg.get('mine').run(b, { names: ['gravel'], count: 6 });
          await craft(b, 'flint', 2);
        }
        if (countItem(b, 'stick') < 4) await craft(b, 'stick', 4);
        await craftArrowsNow();
      }
      return { ok: countItem(b, 'bow') >= 1 && countItem(b, 'arrow') >= 8, observation: `bow=${countItem(b, 'bow')} arrows=${countItem(b, 'arrow')} string=${countItem(b, 'string')} feathers=${countItem(b, 'feather')} flint=${countItem(b, 'flint')} stick=${countItem(b, 'stick')}` }; } },
  // 420 s was cut in the middle of the productive part: measured 12:42-12:49, one round spent 6 min on
  // "walk to high ground, then dig y=68 -> y=-4 with no water trap" and timed out before it could
  // search a vein. This milestone is an expedition (relocate, descend to the diamond layer, mine,
  // re-mint the pick, pour, mine obsidian), so it needs the longer budget. Kept under the watchdog's
  // 15-minute no-progress restart so a genuinely stuck round still gets killed.
  // 25 min, not 12: obsidian_farm may have to cross ~400 blocks to the one remembered water+lava pair
  // (458,-24,767 + 486,-24,762), and a step that dies mid-trek loses the trip. The walk is the cost of
  // the farm, and the farm is what has never once completed a pour-and-refill cycle in 3 hours.
  { id: 'obsidian', budgetMs: 1500000, done: b => countItem(b, 'obsidian') >= 10 || !!require('../workshopRecord').at('nether_portal_frame_ready'),
    run: async b => {
      // Obsidian only drops from a diamond/netherite pick, and that pick WEARS OUT in use (measured:
      // 3% at 14:15, gone by 14:26). `diamond_pick` is already marked done and stays sticky, so nothing
      // in the ladder re-opens it, and `make_obsidian` would keep answering "needs a diamond pickaxe"
      // while the bot dug at obsidian with a stone pick and collected nothing. The gate now declares
      // its own prerequisite instead of assuming an earlier milestone still holds.
      // ...and "has one" has to mean "has one that survives the job". At 09:13:50 the model itself
      // reported `1% diamond pick = every obsidian break fails`: a 10-12 block pile costs more uses than
      // a nearly-spent pick has left, and 1.21.1 items expose durabilityUsed/maxDurability (not
      // `durability`), so the wear floor is computed here rather than trusting presence.
      const dpickUses = (i) => (i && i.maxDurability ? i.maxDurability - (i.durabilityUsed || 0) : 999);
      // Twelve obsidian blocks cost twelve digs, so ask for 24 digs of headroom. A PERCENT floor made
      // 8% read as "no pickaxe" at 12:05-12:07 while that pick still had ~125 digs left, and the
      // milestone then refused for two straight minutes on a tool that was fine.
      const dpickOk = () => b.inventory.items().some(i => i.name === 'diamond_pickaxe' && dpickUses(i) >= 24);
      if (!dpickOk()) {
        if (countItem(b, 'diamond') < 3) {
          // This return value used to be dropped, so "find_diamonds came back in 1 ms" looked identical
          // to "find_diamonds dug for six minutes".
          const fd = await reg.get('find_diamonds').run(b, { count: 3 });
          log.skill(`obsidian: diamond hunt said (${String(fd && fd.observation).slice(0, 200)})`);
        }
        const c = await craft(b, 'diamond_pickaxe', 1);
        if (!dpickOk()) {
          return { ok: false, observation: `no diamond pickaxe yet (diamonds=${countItem(b, 'diamond')}; craft said: ${c.observation}) - obsidian cannot be collected without one` };
        }
      }
      // Farm first when a water+lava pair is already remembered: make_obsidian re-derives its whole
      // continent-wide search every round and never refills mid-pour, which is why obsidian sat at 2 for
      // three hours while a 28-block water+lava pair existed in the terrain memory (18:29-18:48:
      // `empty after 0 pour(s)` beside a lava pool 4 blocks away). With no pair remembered this call
      // returns in milliseconds and the search runs as before.
      const farm = await reg.get('obsidian_farm').run(b, { count: 12 });
      if (farm.ok) return farm;
      log.skill(`obsidian: farm said (${String(farm.observation).slice(0, 160)})`);
      const mo = await reg.get('make_obsidian').run(b, { count: 12 });
      if (mo.ok) return mo;
      // make_obsidian remembers every lava pool and water cell it walks past, so a search round that
      // found nothing can still leave a farmable pair behind for this second attempt.
      const f2 = await reg.get('obsidian_farm').run(b, { count: 12 });
      return f2.ok ? f2 : mo;
    } },
  { id: 'flint_steel', done: b => countItem(b, 'flint_and_steel') >= 1,
    run: b => craft(b, 'flint_and_steel', 1) },
  { id: 'nether', done: b => {
      if (b.game && b.game.dimension === 'the_nether') return true;
      // "I am standing in the Nether" is not what this milestone ever meant, and reading it that way made
      // every trip home rewind the ladder: measured 07:13-07:18 on the stronghold trek, `nether` re-opened
      // the moment the bot stepped out of its own portal and three rounds in a row went to
      // `build_nether_portal` (needs 10 obsidian, and the pack had 3 with no diamond pick to make more)
      // while 16 eyes sat unused 30 blocks from the portal room. A link that has been opened AND walked
      // through is recorded on arrival by `use_portal` itself, so that record is the durable fact; the
      // errands that still need to be physically down there (`blaze_rods`, and the rods-only retry) each
      // test the dimension and portal back in on their own, so nothing is lost by locking this one.
      try { if (require('../workshopRecord').at('portal_arrival_the_nether')) return true; } catch {}
      return false;
    },
    run: async b => {
      // a portal cannot be framed inside a 1-high tunnel, so get onto dry ground first
      if (b.entity.position.y < 45) await reg.get('recover_surface').run(b, {});
      return reg.get('build_nether_portal').run(b, {});
    } },
  { id: 'blaze_rods', budgetMs: 480000, done: b => countItem(b, 'blaze_rod') >= 6,
    run: async b => {
      // Blazes only exist in a Nether fortress. This milestone used to run farm_blaze standing in
      // the Overworld and report "0 rods" forever, so make sure we are actually in dimension -1.
      if (!b.game || b.game.dimension !== 'the_nether') {
        await reg.get('build_nether_portal').run(b, { count: 14 });
        if (b.game && b.game.dimension !== 'the_nether') await reg.get('use_portal').run(b, {});
        if (b.game && b.game.dimension !== 'the_nether') {
          return { ok: false, observation: `cannot reach the Nether for blaze rods (dim=${b.game && b.game.dimension}, obsidian=${countItem(b, 'obsidian')}, flint_and_steel=${countItem(b, 'flint_and_steel')}) - obsidian/flint_steel must be re-made first` };
        }
      }
      await reg.get('search_nether_fortress').run(b, { steps: 6 });
      return reg.get('farm_blaze').run(b, { count: 7 });
    } },
  { id: 'pearls', done: b => countItem(b, 'ender_pearl') >= 12,
    run: b => reg.get('farm_pearl').run(b, { count: 12 }) },
  { id: 'eyes', done: b => countItem(b, 'ender_eye') >= 12,
    run: b => reg.get('craft_eyes_of_ender').run(b, { count: 12 }) },
  { id: 'stronghold', budgetMs: 420000, done: b => { try { return !!b.findBlock({ matching: blockIds(b, ['end_portal_frame']), maxDistance: 24 }); } catch { return false; } },
    run: b => reg.get('locate_stronghold').run(b, {}) },
  { id: 'enter_end', budgetMs: 300000, done: b => { try { return require('./endgame').inEnd(b) || !!b._dragonKilled; } catch { return (b.game && b.game.dimension === 'the_end') || !!b._dragonKilled; } },
    run: async b => {
      // Operator's call 2026-11-05: "自己给自己give一些箭。现在缺物资就自己开指令拿，只给我验证打龙流程".
      // So the GATHERING half of this run is out of scope by instruction and the FIGHT is what is being
      // verified. Every grant below is an OP `/give` the bot issues on its own account (it is the op on this
      // instance), logged with what and why, and it is bounded by the pack's own counts so one round cannot
      // flood the inventory. `MC_OP_RESUPPLY=0`, or a strict acceptance instance (`MC_ASSIST=0`), turns the
      // whole block off - an unassisted clear must never inherit it by accident.
      if (process.env.MC_OP_RESUPPLY === '1' && process.env.MC_ASSIST !== '0') {
        const grants = [];
        const give = (item, n, why) => { grants.push({ item, n, why }); };
        if (countItem(b, 'arrow') < 32) give('arrow', 64, 'the one consumable the End cannot make: no chicken, no gravel');
        if (countItem(b, 'flint') < 8) give('flint', 16, 'arrow re-crafts (1 flint + 1 stick + 1 feather = 4 arrows)');
        if (countItem(b, 'feather') < 8) give('feather', 16, 'the arrow input this ocean region has never produced');
        if (countItem(b, 'stick') < 8) give('stick', 16, 'the other arrow input');
        if (P.usablePickCount(b) === 0) give('diamond_pickaxe', 1, 'the quarry and the cage bars need a pick that does not die on the third pillar');
        // Saturation holds the hunger bar but cannot raise it, and vanilla regen needs the meter at 18+.
        // That is why it keeps dying to the same enderman: 30 End deaths by 08:53, armour worn to nothing at
        // the moment of each, no healing between rushes. Food is a supply like arrows, so it is granted too.
        const edibleNow = ['cooked_beef', 'cooked_chicken', 'cooked_porkchop', 'cooked_mutton', 'bread', 'baked_potato', 'cooked_cod', 'cooked_salmon', 'golden_carrot', 'cake'].reduce((s, n) => s + countItem(b, n), 0);
        if (edibleNow < 8 || b.food < 18) give('cooked_beef', 32, 'regen needs the hunger bar above 18, and saturation from the /effect cannot raise it');
        // The grant list itself can be the blocker: at 10:55:09 the pack read `0 free slots` because every
        // round had been handed another 128 cobblestone, and a full pack strands the planks the bench needs
        // (and the /give of water bounces off it - 10:40:54 `the /give did not land (a full pack takes
        // nothing)`). So free the surplus rock FIRST, then grant against the slots that actually exist.
        const rockOf = (n) => countItem(b, n);
        const rock = rockOf('cobblestone') + rockOf('cobbled_deepslate') + rockOf('stone_bricks') + rockOf('end_stone') + rockOf('andesite') + rockOf('diorite');
        if (rock > 96 && P.freeSlots(b) < 4) {
          const cut = rock - 48;
          try { b.chat(`/clear @s minecraft:cobblestone ${cut}`); } catch {}
          try { b.chat(`/clear @s minecraft:cobbled_deepslate ${cut}`); } catch {}
          await sleep(1200);
          log.warn(`OP VOID (disclosed): cleared ${cut} surplus stone (was ${rock}) to buy back pack slots - a full pack is a gate I built myself, and it stops every other supply from landing`);
        }
        const slotBudget = () => Math.max(0, P.freeSlots(b) - 1);
        if (countItem(b, 'cobblestone') + countItem(b, 'cobbled_deepslate') < 40 && slotBudget() >= 1) give('cobblestone', 64, 'blast screens for a hand punch, and the pillar steps');
        const wornNow = ['helmet', 'chestplate', 'leggings', 'boots'].filter((pt, i) => {
          const it = b.inventory.slots[5 + i];
          return !!it && it.name.endsWith('_' + pt);
        });
        if (wornNow.length < 4) {
          for (const piece of ['iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots']) {
            if (!b.inventory.items().some(i => i.name === piece) && !wornNow.some(p => piece.endsWith(p))) give(piece, 1, 'the dive gate asks for a worn chestplate plus one more, and the endermen are what is killing it');
          }
        }
        if (grants.length) {
          for (const g of grants) {
            // Re-read the pack between grants: each one can consume the slot the next one needs, and a
            // /give that does not land is worse than no /give because the log then claims it was supplied.
            if (P.freeSlots(b) < 1) {
              try { await require('./endgame').freeOneSlot(b, `the supply list is handing out ${g.item}`); } catch {}
            }
            if (P.freeSlots(b) < 1) { log.warn(`OP SUPPLY: skipped /give @s ${g.item} - the pack has no free slot (it has to be tidied or worn down, not filled further)`); continue; }
            try { b.chat(`/give @s ${g.item} ${g.n}`); } catch {}
            log.warn(`OP SUPPLY (operator's call, disclosed): /give @s ${g.item} ${g.n} - ${g.why}`);
          }
          await sleep(1500);
          try { await P.equipBestArmor(b); } catch {}
          try { await P.craft(b, 'arrow', Math.min(64, 32)); } catch {}
          log.warn(`OP SUPPLY: ${grants.length} grant(s) issued; pack now ${JSON.stringify({ arrow: countItem(b, 'arrow'), flint: countItem(b, 'flint'), feather: countItem(b, 'feather'), picks: P.usablePickCount(b), cobble: countItem(b, 'cobblestone') })}`);
        }
      }
      // Walk it HOME before any gate can refuse the dive. The lift I first put inside the `enter_end` SKILL
      // never executed: the armour/quiver gates in this milestone return first, and every refusal round lets
      // `roam` take it further away - 07:12→07:41 it went from -329,1618 to -375,1427 with `segmentMin` at
      // 35 and no dive attempted at all, against a door that has been open since 00:08. One disclosed /tp at
      // the top of the step turns that into "standing at the portal". MC_ASSIST=0 never reaches this.
      if (process.env.MC_ASSIST !== '0') {
        try {
          const recH = require('../portalRecord').current();
          const pH = b.entity && b.entity.position;
          // Never move a bot that is already fighting in the End back to the Overworld door. `game.dimension`
          // is the string every other reader in this file uses; `world.dimension.name` is the newer enum, so
          // check both rather than silently defaulting to "not in the End".
          // Never move a bot that is already fighting in the End back to the Overworld door. The packet
          // field is not trustworthy across a portal flip (10:09:53: a bot on a pillar top at 12,98,37
          // read `overworld`), and a wrong answer here would /tp it out of the fight, so decide from the
          // world: End-only blocks and End-only entities.
          let dimEnd = false;
          try { dimEnd = require('./endgame').inEnd(b); } catch { dimEnd = (b.game && b.game.dimension) === 'the_end'; }
          if (recH && recH.ringComplete && !dimEnd && pH && Number.isFinite(pH.x)) {
            const distH = Math.hypot(pH.x - recH.x, pH.z - recH.z);
            // The anchor is only a room cell if the geometry says so. The one on file right now is
            // -208,30,1498 against a room floor at -212,15,1499 - a shaft wall written by a pin that
            // claimed "inside the portal room" from the frame being in FIND range, not the bot being
            // on the floor. Trusting it would /tp the dive to a hole 15 levels above the pool.
            const anchorIsRoom = !!(recH.anchor && Number.isFinite(recH.anchor.x)
              && Math.abs(recH.anchor.y - recH.y) <= 4
              && Math.hypot(recH.anchor.x - recH.x, recH.anchor.z - recH.z) <= 16);
            const cell0 = anchorIsRoom ? recH.anchor : { x: Math.floor(recH.x), y: recH.y, z: Math.floor(recH.z) };
            // Standing in the room means: at the recorded column AND at its floor level. The 150-block
            // version of this rule was written for a bot that had wandered 450 blocks out, and it left
            // the nearer, worse case uncovered: at 09:14-09:19 it sat 54 blocks off an OPEN door digging
            // a corridor through a water column and took three `STEP AIR ABORT` rounds (oxygen=20 = 6%
            // of 320, the meter is in ticks), i.e. the travel is where the dive dies now, not the gates.
            const inRoom = distH <= 10 && Math.abs(pH.y - cell0.y) <= 4;
            if (!inRoom) {
              const cellH = cell0;
              log.warn(`enter_end: OP LIFT home before the gates - ${Math.round(distH)} blocks off an OPEN door at y=${Math.round(pH.y)} against the room floor y=${cellH.y}, and the drown-corridor route is what eats the rounds now (every dive starts at the portal, never on foot); going to the room cell ${cellH.x},${cellH.y},${cellH.z}`);
              try { b.chat(`/tp @s ${cellH.x + 0.5} ${cellH.y} ${cellH.z + 0.5}`); } catch {}
              await sleep(4000);
              const pA = b.entity.position.floored();
              let fA = null, hA = null;
              try { fA = b.blockAt(new (require('vec3'))(pA.x, pA.y, pA.z)); hA = b.blockAt(new (require('vec3'))(pA.x, pA.y + 1, pA.z)); } catch {}
              const embedded = (x) => !!x && x.boundingBox !== 'none' && !/water|air/.test(x.name);
              if (embedded(fA) || embedded(hA)) {
                log.warn(`enter_end: the room cell is built over (${fA ? fA.name : '?'}/${hA ? hA.name : '?'}) - stepping up one`);
                try { b.chat(`/tp @s ${pA.x + 0.5} ${pA.y + 1} ${pA.z + 0.5}`); } catch {}
                await sleep(2000);
              }
            }
          }
        } catch (e) { log.warn(`enter_end: the home lift threw ${String(e.message).slice(0, 60)} - continuing on foot`); }
      }
      // Dying in the End is expensive in a way no other death is: the exit portal only exists AFTER the
      // dragon falls, so one death there puts the bot back on its Overworld spawnpoint and the whole
      // trip (portal -> fortress -> blaze rods -> eyes -> stronghold -> dive) has to be paid again.
      // Measured in the fixture run: `DIED at y=-189, respawned in the Overworld and lost the fight`.
      // So the dive gate refuses until it is wearing something and can feed itself mid-fight.
      // `const` here was a live crash: the recount below reassigns it, so any bot wearing fewer than
      // two pieces threw `Assignment to constant variable` on the first provisioning pass and enter_end
      // could never reach the portal (measured 12:58, 13:04 and 16:19 on 2026-11-02).
      let worn = ['helmet', 'chestplate', 'leggings', 'boots'].filter((pt, i) => {
        const it = b.inventory.slots[5 + i];
        return !!it && it.name.endsWith('_' + pt);
      }).length;
      // How short of armour this dive is. After two deaths INSIDE the End the bar stops being "any two
      // pieces": it has died twice wearing an iron helmet and iron boots with a bare chest, which is the
      // shape of "老死打不过龙" - and the answer to that is chest and legs, not a third run at the dragon
      // in the same kit.
      const chestWorn = () => !!b.inventory.slots[6] && /_chestplate$/.test(b.inventory.slots[6].name);
      const eatenInParts = (b._endDeaths || 0) >= 2;
      // The operator's call at 10:25, made when the chestplate rule had spent 57 minutes and 99 attempts
      // mining iron it did not have, while a set of iron armour grinds away in about 4 minutes of End
      // fighting. So the bar after two End deaths is now ONE worn piece, not chestplate+leggings - and it
      // is a COUNTED release, not a removal: it is anchored to the death count when it was granted, and
      // two more deaths inside the End on the relaxed rule put the chestplate requirement straight back.
      if (eatenInParts && !Number.isFinite(b._armourRelaxedAt)) b._armourRelaxedAt = b._endDeaths;
      const relaxedArmour = Number.isFinite(b._armourRelaxedAt) && (b._endDeaths || 0) < b._armourRelaxedAt + 2;
      const armourShort = () => (eatenInParts && !relaxedArmour ? !(chestWorn() && worn >= 2) : worn < 1);
      let edible = EDIBLE.reduce((s, n) => s + countItem(b, n), 0);
      // Provision, don't wait. Requiring food here while `food`'s own condition is
      // "3 edibles OR a full bar" means a bot at hunger 19 with an empty pack has the food milestone
      // marked done, my new revalidation rule (re-open only when hunger < 10 or nothing edible) keeps
      // it that way, and the dive would refuse forever - a deadlock of my own making, at the last
      // gate. So this step goes and gets the rations itself instead of relying on another gate.
      if (edible < 3) {
        try {
          await reg.get('roam').run(b, { look_for: 'cow,pig,sheep,chicken', distance: 200 });
          await reg.get('hunt').run(b, { count: 3 });
        } catch {}
        edible = EDIBLE.reduce((s, n) => s + countItem(b, n), 0);
      }
      if (armourShort() && (b._enterEndArmorStall || 0) >= 3 && !eatenInParts) {
        // Do not spend another round mining for the armour the pack has already failed to afford three
        // times: measured 18:19-18:23 each attempt burned 180 s and ended `sight-mine gave 0 raw iron`,
        // `STEP QUIET ABORT ... phase armor:sight-mine`, with `ingot=3` unchanged and the door 3 eyes away.
        log.warn(`enter_end: skipping the armour errand (stall ${b._enterEndArmorStall}, ingot=${countItem(b, 'iron_ingot')} leather=${countItem(b, 'leather')}) - walking to the door in what it wears`);
      } else if (armourShort()) {
        // Affordability has to be priced the way the gate is priced. `armor`'s own condition is "a worn
        // chestplate + one more piece", so while no chestplate exists the first purchase is the 8-cost
        // chestplate (`craft()` refuses to spend on anything else), and once one is worn the gate is
        // 4 hides from satisfied. Hard-coding 8 sent a bot wearing a chestplate with 4 hides in its pack
        // back to mining; hard-coding 4 sent tonight's bot (ingot=3, diamond=2, no chestplate) into
        // ~38 s rounds that could never complete.
        const payIron = countItem(b, 'iron_ingot') + countItem(b, 'diamond');
        const chestCovered = (!!b.inventory.slots[6] && /_chestplate$/.test(b.inventory.slots[6].name))
          || b.inventory.items().some(i => /_chestplate$/.test(i.name));
        const need = chestCovered ? 4 : 8;
        // Fuel, counted the way a player counts it. `coal + charcoal >= 1` was the whole test, so a bot
        // standing on 3 logs and a stack of planks - enough to burn through 8 raw iron - was told
        // "no armour errand" and sat on the doorstep until the stall counter hit the last resort
        // (live 20:43: ingot=2, leather=4, coal=0, logs=3, stall 8 of 12). Two planks is one fuel unit.
        const fuelUnits = countItem(b, 'coal') + countItem(b, 'charcoal')
          + ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log']
            .reduce((s, n) => s + countItem(b, n), 0)
          + Math.floor(['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'mangrove_planks', 'cherry_planks']
            .reduce((s, n) => s + countItem(b, n), 0) / 2);
        const smeltPath = (countItem(b, 'raw_iron') + payIron) >= need
          && (countItem(b, 'furnace') > 0 || countItem(b, 'cobblestone') >= 8)
          && fuelUnits >= 1;
        const canPay = payIron >= need || countItem(b, 'leather') >= need
          || countItem(b, 'iron_nugget') >= need * 9 || smeltPath;
        if (!canPay) {
          log.warn(`enter_end: no armour errand - the gate wants ${need} of a material${chestCovered ? ' (a chestplate is already worn)' : ' (no chestplate yet)'} and the pack has ingot+diamond=${payIron} leather=${countItem(b, 'leather')} raw_iron=${countItem(b, 'raw_iron')} nugget=${countItem(b, 'iron_nugget')} fuel=${fuelUnits} (coal/charcoal + logs + planks/2) - short by ${Math.max(0, need - payIron)} iron: mine {names:['iron_ore','deepslate_iron_ore']} or ${countItem(b, 'leather') >= 4 ? 'leather, which is already this close' : 'hides'}`);
        } else {
          // Provision, don't wait - and now REQUIRED, not optional: `armor` left the per-loop revalidation
          // sweep on 2026-10-29 because iron wears out roughly every 30 minutes of deep mining and each
          // rewind re-spent ~12 ingots (three re-opens in one hour: 05:43, 06:18, 07:25 - the single
          // biggest tax on the run, which never got past obsidian while it lasted). The protection did not
          // go away, it moved here: the boundary where being under-equipped actually costs the trip,
          // because the exit portal only exists after the dragon dies.
          const arm = LADDER.find(m => m.id === 'armor');
          for (let i = 0; i < 2 && armourShort(); i++) {
            log.skill(`enter_end: worn=${worn}/4 - building armour before the dive (pass ${i + 1})`);
            try { await arm.run(b, {}); } catch (e) { log.warn('armor provisioning threw ' + e.message); }
            try { await P.equipBestArmor(b); } catch {}
            worn = ['helmet', 'chestplate', 'leggings', 'boots'].filter((pt, j) => {
              const it = b.inventory.slots[5 + j];
              return !!it && it.name.endsWith('_' + pt);
            }).length;
          }
        }
      }
      // The bow. Tonight's proof that an entry condition has to be durability, not possession: it dove
      // with a bow at 15%, the bow broke inside the End at 19:31:49, and from then on the crystals - which
      // resurrect the dragon - were untouchable while the fight loop threw `item is null` once a second.
      // A bow cannot be made in the End (no spider for string, no tree for sticks), so it is settled here,
      // on this side of the portal. Waiver at 5 rounds, not 3: a bow IS obtainable with effort, and a
      // melee-only attempt is the last thing available rather than a guaranteed stalemate.
      try {
        const bowWear = () => { const x = b.inventory.items().find(i => i.name === 'bow'); return x ? ob.wear(b, x) : null; };
        const planksN = b.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
        if (planksN >= 2 && countItem(b, 'stick') < 3) await P.craft(b, 'stick', countItem(b, 'stick') + 4);
        const w0 = bowWear();
        if (w0 === null || w0 < 30) {
          if (countItem(b, 'string') < 3 && (!b.game || b.game.dimension === 'overworld')) {
            const hs = await reg.get('hunt_spider').run(b, { count: 4 });
            log.skill(`enter_end: string for the bow - ${String(hs.observation).slice(0, 120)}`);
          }
          if (countItem(b, 'string') >= 3 && countItem(b, 'stick') >= 3) {
            const haveBow = countItem(b, 'bow');
            const c = await P.craft(b, 'bow', haveBow + 1); // `want` is how many to HAVE
            // Judge the craft by the item that landed, not by the routine's own verdict: at 19:56:00
            // gridcraft said `made=0 have=1` (it reads the result slot before the arrival packet) while
            // the bow was genuinely in the pack, and a `FAILED` line over a finished bow is how a watcher
            // restarts a run that was about to win.
            const madeBow = countItem(b, 'bow') > haveBow;
            log.skill(`enter_end: bow provisioning ${madeBow ? 'ok' : 'FAILED'}${c.ok ? '' : ' (craft answered not-ok)'} - bow=${countItem(b, 'bow')} (was ${haveBow}) wear=${bowWear()} string=${countItem(b, 'string')}`);
          }
        }
        const w1 = bowWear();
        if (w1 === null || w1 < 25) {
          b._enterEndBowStall = (b._enterEndBowStall || 0) + 1;
          if (b._enterEndBowStall < 5) {
            return { ok: false, observation: `no usable bow for the crystals (${w1 === null ? 'none in the pack' : `bow at ${w1}% wear`}; string=${countItem(b, 'string')} stick=${countItem(b, 'stick')}): nine end crystals resurrect the dragon and a bow cannot be crafted inside the End - run hunt_spider {count:4} on this side, craft bow, then dive (bow stall ${b._enterEndBowStall}/5, after which a melee-only attempt is allowed)` };
          }
          log.warn(`enter_end: diving WITHOUT A WORKING BOW after ${b._enterEndBowStall} failed provisions (${w1 === null ? 'no bow' : `${w1}% wear`}) - crystals have to be reached by melee, which costs health`);
        } else b._enterEndBowStall = 0;
      } catch (e) { log.warn(`enter_end: bow provisioning threw ${String(e.message).slice(0, 90)}`); }
      // Arrows belong to the same class of gate as the rations, and are far cheaper to fix here than to
      // discover up there: `bow` passed with 8 arrows and left REVALIDATE in the same cleanup that moved
      // armour to this boundary, so nothing re-opens it while the pack shoots its last one at a chicken.
      // The End has no gravel, no chicken and no tree, and an arrow needs a 3-tall shaped recipe (flint /
      // stick / feather) that the 2x2 player grid cannot hold - so with no crafting table in the pack, an
      // arrow can never be made there.
      // The bar is 12, NOT the 24 that `kill_dragon` asks for, because the errand that produces arrows
      // (`bow`'s step) stops at 12 by design - feathers come one per chicken. A gate set above what its own
      // supplier can deliver is the obsidian/find_diamonds deadlock again, and this one sits in front of the
      // finish line. `kill_dragon` tops the quiver up from whatever flint/stick/feather is still in the pack.
      let arrows = countItem(b, 'arrow');
      // The errand has to be worth leaving the door for. Tonight it was the single biggest source of lost
      // distance: chasing gravel and chickens put the bot 529 blocks from an OPEN door (04:07-04:12) with 7
      // arrows and no armour, and the trip home ate 25 minutes of the enter_end stall. With the pillar-top
      // sequence in place (3 arrows -> climb/lift -> screened punch, which is how #39 fell at 03:30:46) the
      // crystals no longer need a full quiver, and the perch is melee'd. So: restock only when the door is
      // close enough that a round trip is cheaper than the arrows are worth.
      const doorNearForBow = (() => {
        try {
          const rec = require('../portalRecord').current();
          const p = b.entity && b.entity.position;
          if (!rec || !p || !Number.isFinite(p.x)) return true;      // unreadable geography: keep the old behaviour
          return Math.hypot(p.x - rec.x, p.z - rec.z) <= 120;
        } catch { return true; }
      })();
      // 04:55:00 proved a distance gate alone is not enough: standing 82 blocks from the door counted as
      // "near", so the errand fired and its supplier walked UP TO 200 BLOCKS for a log to build a bench for
      // arrows (04:59:57 -> 05:00:19, east to -223,1598). The crystals no longer need a full quiver - they
      // fall to the pillar sequence (3 arrows -> climb/lift -> screened punch, which is how #39 and #53
      // died tonight) - and the perch is melee'd. So: a 6-arrow quiver dives, and the errand only runs when
      // the pack is genuinely under that AND the door is close enough for a round trip to be cheap.
      const diveQuiver = 6;
      // And the errand may only run when its scarcest input actually exists in the pack. 07:47:00: the home
      // lift put it on the portal room floor in 5 seconds (-214,16,1498, standing IN the pool), and the very
      // next line sent it out again - `arrows=0 - running the bow errand (gravel for flint, chickens for
      // feathers)` with feather=0 in an ocean region that has produced no chicken in hours. Flint is diggable
      // out of gravel anywhere; a feather is only a chicken. With no feather in the pack the errand cannot
      // succeed, so it is not run at all - it is the single biggest source of distance this run has lost.
      if (arrows < diveQuiver && doorNearForBow && countItem(b, 'feather') >= 1) {
        const bowStep = LADDER.find(m => m.id === 'bow');
        log.skill(`enter_end: arrows=${arrows} - running the bow errand before the dive (gravel for flint, chickens for feathers, planks for sticks)`);
        try { await bowStep.run(b, {}); } catch (e) { log.warn('enter_end: arrow provisioning threw ' + e.message); }
        arrows = countItem(b, 'arrow');
      }
      const shortArrows = arrows < diveQuiver;
      if (arrows >= diveQuiver && arrows < 12) log.warn(`enter_end: arrows=${arrows} is below the old 12 but above the dive bar (${diveQuiver}) - diving instead of sending the bow errand after chickens, gravel or a 200-block tree`);
      if (shortArrows) {
        // Fail open on a counted stall, never silently: three rounds of the errand returning the same arrow
        // count means there is no chicken or gravel to be found from here, and an endless refusal would strand
        // a bot that is otherwise dressed, fed and standing at the door with 16 eyes in its pack.
        b._enterEndArrowStall = arrows === (b._enterEndArrowLast || -1) ? (b._enterEndArrowStall || 0) + 1 : 0;
        b._enterEndArrowLast = arrows;
      } else b._enterEndArrowStall = 0;
      // Paving stock, reported before the door where it is cheap. Every "cannot climb / cannot screen the
      // blast" verdict this run has logged ended on the number of blocks in the pack
      // (`climbed (no OP) to y=66, blocks left=4 - stopped: nothing solid under my feet to build on`), and
      // the island has no stone that can be mined without cutting a hole into the void - so the material
      // has to be carried in.
      // Reported, NOT gated and NOT fixed inline: a `mine` run inside this gate made the harness crawl
      // (>7 min) and would eat the step budget live, and a paving precondition the islet cannot satisfy
      // is the obsidian/find_diamonds deadlock with a new name. The verdict names the move instead, so
      // the planner buys the blocks as its own bounded step - which is how it already handles armour/food.
      const pave = P.cheapFillTotal(b);
      const shortPave = pave < 12;
      if (shortPave) log.warn(`enter_end: only ${pave} placeable blocks in the pack (cheapFillTotal counts every stack) - the crystal pillars and the blast screens are built from carried stone and the End has none: mine {names:['cobblestone','stone'], count:16} costs about a minute here, do not start the fight with an empty paving hand`);
      // Armour: a COUNTED fail-open. This gate has held the run for 265 minutes at `worn=0/4` while the
      // pack carries 3 ingots, no hides and 7 eyes, and the door is 3 eyes from open. The gate's own
      // reason for existing is what makes the exemption affordable now: inst1 runs keepInventory, so a
      // death at the portal is a walk back to the door rather than a re-run of fortress->rods->eyes -
      // measured 18:19:28 `armor gate left closed: ... iron_ingot=3 - with keepInventory a death is a
      // walk, not a re-mine`. It closes itself on the one fact that should close it: two deaths INSIDE
      // the End means the walk is not what is costing the run, the fight is - then chestplate and
      // leggings come first, exactly as this gate has always demanded.
      b._enterEndArmorStall = worn === (b._enterEndArmorLast === undefined ? -1 : b._enterEndArmorLast)
        ? (b._enterEndArmorStall || 0) + 1 : 0;
      b._enterEndArmorLast = worn;
      // The stall count survives redeploys. Every `bot-restart` wipes it, and this is a counter whose
      // whole job is to remember that the run has already spent half an hour trying - 20:43 showed
      // stall 8, my 20:53 deploy showed stall 0. The death tally already persists for the same reason.
      try {
        const f = require('../config').paths.runs + '/end_deaths.json';
        const fsx = require('fs');
        const j = fsx.existsSync(f) ? (JSON.parse(fsx.readFileSync(f, 'utf8')) || {}) : {};
        if (j.armorStall !== b._enterEndArmorStall || j.armorLast !== b._enterEndArmorLast) {
          j.armorStall = b._enterEndArmorStall;
          // The count only means anything next to the value it was counting against: without armorLast
          // the first round after a restart compares worn=1 to undefined and resets the stall to 0 anyway.
          j.armorLast = b._enterEndArmorLast;
          fsx.writeFileSync(f, JSON.stringify(j));
        }
      } catch {}
      // The food bar gets the same counted treatment as armour and arrows: `edible >= 3` is a sensible
      // wish and a bad absolute. Measured 00:11-01:54 the dive sat on `edible=2` for an hour and a half
      // while the `food` milestone re-opened, the pack could not find an animal through ocean water, and
      // the bot stood at food=0 with 1 raw chicken in its pocket - a two-item gap from a dive it was
      // otherwise ready for. Waiver floor is ONE edible, not zero: an empty bar with nothing to eat is a
      // guaranteed death, and the dragon fight is long.
      b._enterEndFoodStall = edible === (b._enterEndFoodLast === undefined ? -1 : b._enterEndFoodLast)
        ? (b._enterEndFoodStall || 0) + 1 : 0;
      b._enterEndFoodLast = edible;
      // The risk this number is supposed to price is "does it start a 10-minute fight hungry". Tonight the
      // meter says no and the stack count says yes: at 22:19 the counted waiver opened (3 food-stalled
      // rounds), ONE round later the counter was back to 0-2, and every cycle in between spent `roam -> hunt`
      // steps that walked it from 2 blocks off an OPEN portal out to 27 and then 75 (22:25-22:34). Twelve End
      // deaths so far were enderman / blast / fall - never starvation. Carried stacks are the wrong unit;
      // the hunger bar plus a reserve that cannot be consumed by auto-eat is the right one, so a full meter
      // with two rations now dives, while an empty-ish one still cannot.
      // Once the stall waiver has opened, it LATCHES for the approach. The counter above advances only while
      // `edible` is unchanged, and the errand rounds the refusal provokes (smelt, kelp, hunt) all CHANGE the
      // pack - so every reopen reset its own trigger: 3 errand rounds -> waiver -> 1 round that ate or moved
      // food -> counter 0 -> 3 more errands. Measured at 22:52, 23:39 and 23:50 with the shaft 10 blocks from
      // the pool, each cycle walking the bot away from an open door. An empty pack still clears the latch and
      // still refuses (Y0: ZERO food is a hard no).
      if (!edible || b.food < 8) b._enterEndFoodWaived = false;
      // Same owner as the `food` milestone change: while the ring is complete and the door is within 140
      // blocks, hunger is judged by the meter and ONE ration, not by a stack count that a kelp errand can
      // never raise. Measured 00:01-00:02: `edible=1 (food stall 0)` -> the waiver needed 3 rounds, but every
      // round it provokes changes the pack and resets its own counter to 0, so it can never reach 3. That is
      // a gate that consumes its own escape hatch, and it is why the bot swam at kelp 87 blocks from an open
      // door instead of diving. A zero-food pack is still a hard no.
      const doorCloseForFood = (() => {
        try {
          const rec = require('../portalRecord').current();
          if (!rec || !rec.ringComplete || !Number.isFinite(rec.x)) return false;
          const p = b.entity && b.entity.position;
          return !!p && Number.isFinite(p.x) && Math.hypot(p.x - rec.x, p.z - rec.z) <= 140;
        } catch { return false; }
      })();
      // MC_PERMA_FED makes the ration test unloseable, so it is not a test: the bar cannot drop and an
      // `edible=0` pack fights just as well. Y0 ("zero food on a normal run is a hard no") is untouched.
      const foodOk = permaFed() || edible >= 3 || (edible >= 2 && b.food >= 19) || (doorCloseForFood && edible >= 1 && b.food >= 8)
        || ((b._enterEndFoodStall >= 3 || b._enterEndFoodWaived) && edible >= 1);
      const armStalled = (b._enterEndArmorStall || 0) >= 3;
      // A feather is the one arrow input with no substitute and no source in this ocean region (flint=6,
      // stick=6, feather=0 at 07:40), so a quiver gate that demands arrows can hold the dive forever: 07:36
      // → 07:41 it refused at `arrows=0` six rounds running while the door stood open 160 blocks away. The
      // crystals fall to the pillar sequence and the perch is melee'd with a sword, so when the material
      // provably does not exist the dive goes ahead on the empty quiver rather than waiting for a chicken.
      const canCraftArrowsNow = countItem(b, 'flint') >= 1 && countItem(b, 'stick') >= 1 && countItem(b, 'feather') >= 1;
      // Last resort, so the chestplate rule cannot become the new deadlock: after ~8 failed rounds of
      // genuinely trying it dives in what it wears rather than sitting on the doorstep forever. 12 cost
      // tonight ~35 minutes of errands with the door open the whole time and the fight still unwon; the
      // count is persisted across redeploys now, so this is 8 REAL rounds, not 8 since my last restart. This is the same shape as every other gate here - a counted waiver, not
      // an unconditional one - and it is loud.
      const lastResort = (b._enterEndArmorStall || 0) >= 8;
      const armorOk = !armourShort() || (armStalled && (!eatenInParts || lastResort));
      const arrowsOk = !shortArrows || !canCraftArrowsNow || (armorOk && foodOk && b._enterEndArrowStall >= 3);
      if (shortArrows && !canCraftArrowsNow) log.warn(`enter_end: diving on ${countItem(b, 'arrow')} arrows because no arrow can be MADE from here (flint=${countItem(b, 'flint')} stick=${countItem(b, 'stick')} feather=${countItem(b, 'feather')}) - the crystals fall to the pillar sequence and the perch is melee'd with the sword; this is not a wait for a chicken`);
      // Carry the craft bench INTO the End. The island has no tree and the only door out is a death, so a
      // pick that dies on a pillar cannot be replaced there - and tonight it died exactly like that: the
      // pack reached the island with both picks under 8% wear, cobblestone 9 and sticks 8 in it (a stone
      // pick is 3 + 2) and no table anywhere, so the one craft that could have kept the fight supplied was
      // impossible to lay out in a 2x2 hand grid (01:23:03 -> 01:24:08, circling with a pick-shaped hole).
      // This PROVISIONS the table rather than refusing the dive on it: the gate below already buys a sword
      // the same way, and a second hard gate is how an open door becomes a 30-minute doorstep.
      try {
        if (countItem(b, 'crafting_table') === 0) {
          // The planks were not missing - they were STRANDED in the crafting table's grid because the pack
          // had no empty slot to withdraw them into (04:43:58: `GRID SWEEP: withdrew [oak_planksx1,
          // oak_planksx4] - STILL STRANDED, the pack has no room for them`, then
          // `cannot craft crafting_table: need {"p":"@planks"}` while planks=7 counted right above it).
          // So make room first, then mint.
          if (P.freeSlots(b) < 3) {
            log.warn(`enter_end: only ${P.freeSlots(b)} free slots before bench provisioning - tidging the pack first (a full pack strands the very planks the bench is made of)`);
            try { await reg.get('tidy').run(b, {}); } catch (e) { log.warn(`enter_end: tidy before provisioning threw ${String(e.message).slice(0, 60)}`); }
          }
          let planksForTable = b.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
          if (planksForTable < 4) await P.craftPlanks(b);
          planksForTable = b.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
          if (planksForTable >= 4) {
            const had = countItem(b, 'crafting_table');
            const tc = await P.craft(b, 'crafting_table', 1);
            log.skill(`enter_end: bench provisioning ${countItem(b, 'crafting_table') > had ? 'ok' : 'FAILED'} - crafting_table=${countItem(b, 'crafting_table')} (was ${had}, planks=${planksForTable}, craft answered ${tc.ok ? 'ok' : `"${String(tc.observation || '').slice(0, 70)}"`}) - without it no pick and no arrow can be re-made on the island`);
          } else log.warn(`enter_end: cannot provision a crafting table (planks=${planksForTable}, need 4) - ensure_tools now chops a tree for this, but if it stays empty the End trip has no bench and a worn pick is unrecoverable`);
        }
      } catch (e) { log.warn(`enter_end: bench provisioning threw ${String(e.message).slice(0, 80)}`); }
      // And the tool the island cannot make either: mint the pick HERE, on the surface where the bench and
      // the metal are affordable, instead of arriving on the pillar and finding every dig refused. Same
      // reasoning as the bench above and the sword below - a provision, not a refusal, because a second hard
      // gate on this doorstep is exactly how the 112-minute stage lock happened.
      const bench = countItem(b, 'crafting_table');
      // A bench the bot owns but left somewhere else still works: `craft()` walks to the remembered cell.
      // Keying only on the pack made this routine send for planks it does not need.
      let benchOnFile = null;
      try { benchOnFile = require('../workshopRecord').at('crafting_table'); } catch {}
      const benchReady = bench > 0 || !!benchOnFile;
      const toolMat = ['cobblestone', 'cobbled_deepslate', 'blackstone'].reduce((s, n) => s + countItem(b, n), 0);
      if (P.usablePickCount(b) === 0) {
        if (bench === 0 && benchOnFile) log.warn(`enter_end: no bench in the pack, but the one it placed at ${benchOnFile.x},${benchOnFile.y},${benchOnFile.z} is on file - the pick mint will walk there`);
        for (const tier of ['stone', 'iron', 'diamond']) {
          const mats = tier === 'stone' ? toolMat : countItem(b, tier === 'iron' ? 'iron_ingot' : 'diamond');
          if (benchReady && mats >= 3 && countItem(b, 'stick') >= 2) {
            const had = countItem(b, `${tier}_pickaxe`);
            // `craft(bot, item, n)` makes n, it does not target a total of n - asking for `had + 1` here
            // spent two picks' worth of cobble and sticks to add one pick.
            const pc = await P.craft(b, `${tier}_pickaxe`, 1);
            if (countItem(b, `${tier}_pickaxe`) > had) { log.skill(`enter_end: minted a ${tier}_pickaxe before the dive (was ${had}, craft answered ${pc.ok ? 'ok' : 'not-ok'}) - every dig on the island needs one`); break; }
            log.warn(`enter_end: ${tier}_pickaxe did not land (craft answered "${String(pc.observation || '').slice(0, 70)}") - trying the next tier`);
          }
        }
        if (P.usablePickCount(b) === 0) log.warn(`enter_end: DIVING WITH NO USABLE PICK (bench=${bench}, cobble=${toolMat}, iron_ingot=${countItem(b, 'iron_ingot')}, diamond=${countItem(b, 'diamond')}, stick=${countItem(b, 'stick')}) - the dive is not refused for it, but the first dig calls ensure_tools and the paving quarry cannot run without a pick`);
      }
      if (!(armorOk && foodOk && arrowsOk)) {
        return { ok: false, observation: `not ready to dive: worn=${worn}/4${chestWorn() ? ' (chestplate on)' : ' (no chestplate)'} (armour stall ${b._enterEndArmorStall}${eatenInParts && !relaxedArmour ? `, endDeaths=${b._endDeaths} - the relaxed release has been used up (${b._armourRelaxedAt} -> +2), chestplate + leggings come back first` : ''}), edible=${edible} (food stall ${b._enterEndFoodStall}), arrows=${arrows} (${armorOk ? `ARMOUR IS SATISFIED at ${worn}/4 with a chestplate - TWO pieces is the rule, do NOT craft a helmet/leggings to fill four slots` : `needs ${relaxedArmour ? 'one worn piece' : 'a chestplate once the End has eaten it twice, else 2 armour pieces (chestplate + boots counts)'}`})${foodOk ? ' | FOOD IS SATISFIED (meter + one ration near the open door) - a kelp or hunt errand cannot improve the gate and is NOT the next step' : '| food needs one more edible OR a meter at 19'} + 12 arrows (flint=${countItem(b, 'flint')} stick=${countItem(b, 'stick')} feather=${countItem(b, 'feather')}), paving=${pave} placeable blocks (the pillars and the crystal blast screens are built from carried stone and the End has none; mine {names:['cobblestone','stone']} is about a minute here) - a death in the End costs the entire trip because the exit portal only appears after the dragon dies, and nothing in the End crafts an arrow` };
      }
      if (relaxedArmour && eatenInParts && !chestWorn()) log.warn(`enter_end: RELAXED DIVE (operator's call at 10:25): worn=${worn}/4 with endDeaths=${b._endDeaths} against a chestplate requirement anchored at ${b._armourRelaxedAt} - the bar is one worn piece until the End eats two more from here, then the chestplate rule returns by itself`);
      if (armourShort()) log.warn(`enter_end: diving IN NIGHTCLOTHES (worn=${worn}/4, chestplate=${chestWorn() ? 'yes' : 'NO'}) after ${b._enterEndArmorStall} rounds the pack could not afford armour (ingot=${countItem(b, 'iron_ingot')} raw_iron=${countItem(b, 'raw_iron')} leather=${countItem(b, 'leather')}) - keepInventory makes this death a walk back to the door; two deaths in the End and this exemption closes itself`);
      if (edible < 3) { b._enterEndFoodWaived = true; log.warn(`enter_end: diving on ${edible} edible item(s) after ${b._enterEndFoodStall} food-stalled rounds - the waiver is now latched for this approach (an empty pack or a meter below 8 clears it), eat on the way to the perch and do not start the fight hungry`); }
      if (shortArrows) log.warn(`enter_end: diving UNDER-QUIVERED with ${arrows} arrows after ${b._enterEndArrowStall} stalled errands (flint=${countItem(b, 'flint')} stick=${countItem(b, 'stick')} feather=${countItem(b, 'feather')}) - melee the perch, do not waste shots`);
      // One usable weapon. The dragon fight is long melee at the perch, and the armour step's repair pass
      // can only merge TWO damaged pieces of the same kind - the pack has held exactly one diamond_sword
      // all night (23% at 16:12, 20% at 17:16), so that pass was a no-op for the sword. Two diamonds mint
      // a new one, and diamonds were never the armour this gate falls back to (iron chestplate 8 + leggings
      // 7), so the metal has no better claim on it.
      try {
        const sw = b.inventory.items().find(i => /_sword$/.test(i.name));
        const swWear = sw ? ob.wear(b, sw) : null;
        if ((swWear === null || swWear < 25) && countItem(b, 'diamond') >= 2 && countItem(b, 'stick') >= 1) {
          const have = countItem(b, 'diamond_sword');
          const c = await P.craft(b, 'diamond_sword', have + 1); // `want` is how many to HAVE, not how many to add
          const madeSword = countItem(b, 'diamond_sword') > have; // judged by the item that landed, same rule as the bow
          log.skill(`enter_end: sword provisioning ${madeSword ? 'ok' : 'FAILED'}${c.ok ? '' : ' (craft answered not-ok)'} - diamond_sword=${countItem(b, 'diamond_sword')} (was ${have}, wear=${swWear}) diamond=${countItem(b, 'diamond')}`);
        }
      } catch (e) { log.warn(`enter_end: sword provisioning threw ${String(e.message).slice(0, 80)}`); }
      // Carry a bed to the door. A death in the End used to cost the ENTIRE trip (portal -> fortress ->
      // rods -> eyes -> stronghold) because the respawn point is world spawn; a bed at the portal room
      // costs a walk to the shaft instead. This is the only place that can afford to go get the wool:
      // on the surface, in the Overworld, before the descent - 45 logged `forward_base` calls from
      // underground all ended the same way, `0 wool, need 3 - walking the herds`, so altitude and
      // dimension are preconditions of the call and not a detail. Fail open: a missing bed must never
      // become a new reason to refuse the dive, and the 30-minute backoff keeps a refused bed from
      // becoming the next treadmill.
      try {
        const baseRec = require('./base').loadBase();
        const onSurface = (!b.game || b.game.dimension === 'overworld') && b.entity.position.y >= 60;
        const hasBed = b.inventory.items().some(i => /_bed$/.test(i.name));
        if (onSurface && !baseRec.bed && !hasBed && Date.now() - (b._bedTriedAt || 0) > 20 * 60 * 1000) {
          b._bedTriedAt = Date.now();
          // `carry` - make the bed HERE, on the surface, and keep it in the pack. The door is not a shop:
          // measured 17:35 a `forward_base` call from inside the shaft walked 200 blocks after sheep and
          // `locate_stronghold` answered by /tp-ing the bot 86 blocks back, then `tidy` threw the bed it
          // had made. So the hunt is allowed only while this step still stands where sheep exist, and the
          // bed is placed later, at the portal room, by `enter_end` itself. Fail open: no bed must never
          // become a reason to refuse the dive.
          const fb = await reg.get('forward_base').run(b, { carry: true });
          log.skill(`enter_end: forward base ${fb.ok ? 'SET' : 'not set'} - ${String(fb.observation).slice(0, 110)}`);
        }
      } catch (e) { log.warn(`enter_end: forward_base threw ${String(e.message).slice(0, 90)}`); }
      // Sit down in the bed before the dive. Placing it is not enough - the respawn point only moves
      // when the bot sleeps - and nothing was going to sleep: the planner's night branch asks for
      // `nothing worn AND hp<18`, and tonight it dove at hp=20 with a fresh bed 30 blocks away. The bed
      // landed at -241,65,1520 at 19:07:33 and the step just continued past it. Sleeping also skips the
      // night, which is the hours this run keeps paying for. Non-blocking on purpose: a day that refuses
      // the sleep must never become another reason the portal cannot be opened.
      try {
        const baseRec2 = require('./base').loadBase();
        const t = b.time && typeof b.time.day === 'number' ? b.time.day : null;
        const isNight = t !== null && t >= 12541 && t <= 23458;
        const stale = !b._bedSleptAt || Date.now() - b._bedSleptAt > 10 * 60 * 1000;
        if (baseRec2.bed && isNight && stale) {
          const sl = await reg.get('forward_base').run(b, { sleepOnly: true });
          if (sl.ok) b._bedSleptAt = Date.now();
          log.skill(`enter_end: forward-base sleep ${sl.ok ? 'OK - respawn set at the stronghold' : 'no'} - ${String(sl.observation).slice(0, 120)}`);
        } else if (baseRec2.bed && !isNight) {
          // Is the clock frozen, or is it simply morning? `bot.time.age` counts ticks no matter what the
          // daylight rule says; `bot.time.day` only moves when the cycle is on. Two probes three seconds
          // apart with the age up and the day identical = doDaylightCycle=false.
          const age = b.time && typeof b.time.age === 'number' ? b.time.age : null;
          const prev = b._clockProbe;
          b._clockProbe = { age, day: t };
          const frozen = !!prev && typeof prev.age === 'number' && typeof age === 'number'
            && age - prev.age > 60 && prev.day === t;
          if (frozen) {
            // Measured: `server/world/level.dat` has doDaylightCycle="false" with DayTime stuck at 1000, and
            // `bot.time.day` has read 0 in every one of 1.58M log lines across two days. Night never comes
            // here, a bed only sets the spawn when slept in - the sleep branch above was dead code from the
            // day it was written. The instruction was the outcome (a death should be a short walk), so use
            // the one command that needs no night, and disclose it as an OP lift.
            // Re-asserted EVERY round, not once per session: `recover_surface` pins the spawnpoint to its own
            // dry-land cell when it lifts the bot out of a hole (measured 05:16:45 `recover_surface -> dry
            // land {-660,67,1536} (spawnpoint pinned)`), which would silently steal the anchor back 450
            // blocks from the door. The command is idempotent and costs one line.
            if (process.env.MC_ASSIST === '0') {
              if (!b._bedAnchorLogged) log.warn(`enter_end: the clock is frozen (day=${t} while age moved ${(age - prev.age)} ticks) so this bed can never be slept in - MC_ASSIST=0, no /spawnpoint: the anchor needs a human`);
              b._bedAnchorLogged = true;
            } else {
              // The room anchor wins over the bed. The bed is on the surface, and every dive that began by
              // re-pinning it turned the next End death into a fresh descent: 02:38:45 pinned the bed,
              // 02:43:52 pinned the room, 02:55:22 died in the End and put it back at the surface 79 blocks
              // and one shaft from an OPEN door. `anchor` is a cell it has actually stood on inside the
              // room, so a death there is one step from the pool.
              let roomPin = null;
              try {
                const rec = require('../portalRecord').current();
                if (rec && rec.ringComplete && rec.anchor) roomPin = rec.anchor;
              } catch {}
              const pin = roomPin || { x: baseRec2.bed.x, y: baseRec2.bed.y + 1, z: baseRec2.bed.z };
              b.chat(`/spawnpoint @s ${pin.x} ${pin.y} ${pin.z}`);
              await sleep(1200);
              if (!b._bedAnchorLogged) log.warn(`enter_end: OP ANCHOR (disclosed, not autonomous): /spawnpoint at the ${roomPin ? 'PORTAL ROOM cell it has stood on' : 'bed'} ${pin.x},${pin.y},${pin.z} because doDaylightCycle=false means night never arrives and an unslept-in bed sets no respawn point - re-asserted before every dive because recover_surface pins its own cell`);
              b._bedAnchorLogged = true;
            }
          } else if (!frozen && !b._bedWaitLogged) {
            b._bedWaitLogged = true;
            log.warn(`enter_end: bed on file at ${baseRec2.bed.x},${baseRec2.bed.y},${baseRec2.bed.z} but day=${t === null ? 'unknown' : Math.round(t)} - a bed only sets the spawn when slept in, so this waits for night`);
          }
        }
      } catch (e) { log.warn(`enter_end: bed sleep threw ${String(e.message).slice(0, 80)}`); }
      return reg.get('enter_end').run(b, {});
    } },
  { id: 'kill_dragon', budgetMs: 600000, done: b => !!b._dragonKilled,
    run: b => reg.get('kill_dragon').run(b, {}) },
];

module.exports = { LADDER, countItem };
