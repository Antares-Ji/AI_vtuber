'use strict';
// Primitive skills: each is a deterministic multi-step routine built on mineflayer plugins.
// They run autonomously to completion and return a SHORT text observation. The LLM only chooses
// which one to call with which arguments, so a whole sub-goal costs (at most) one LLM call.
const mcdata = require('minecraft-data');
const Vec3 = require('vec3');
const reg = require('./registry');
const ob = require('../observe');
const log = require('../log');
const cfg = require('../config');
const oreCache = require('../oreCache');
const pov = require('../pov');

function data(bot) { return mcdata(bot.version || '1.21.1'); }
function blockIds(bot, names) {
  const d = data(bot);
  const ids = [];
  for (const n of names) { const b = d.blocksByName[n]; if (b && !ids.includes(b.id)) ids.push(b.id); }
  return ids;
}
function itemId(bot, name) { const b = data(bot).itemsByName[name]; return b ? b.id : undefined; }
function countItem(bot, name) { return bot.inventory.items().filter(i => i.name === name).reduce((s, i) => s + i.count, 0); }

const WS = require('../workshopRecord');
const LOG_NAMES = ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log', 'oak_wood', 'spruce_wood'];

// --- simple observation skills ---
reg.define('status', {
  desc: 'Report health/food/position/dimension/inventory counts + nearby entities.',
  params: {},
  async run(bot) {
    const s = ob.status(bot); const inv = ob.invSummary(bot);
    return { ok: true, observation: `pos=${s.position} dim=${s.dimension} hp=${s.health} food=${s.food} xp=${s.xp} items=${inv.count} held=${inv.held} slots=${inv.slots} near=${JSON.stringify(s.nearbyEntities)}` };
  },
});
reg.define('look', {
  desc: 'Return an egocentric 17x17 ASCII map (.=floor ,=soil T=tree o=ore ~=water ^=lava #=solid B=bedrock P=portal @=me).',
  params: { r: 'radius int, default 8' },
  async run(bot, a) { return { ok: true, observation: ob.grid(bot, a.r || 8) }; },
});
reg.define('find_block', {
  desc: 'Find nearest loaded block matching a list of names; returns coordinates.',
  params: { names: 'array of block names', maxDistance: 'int default 32' },
  async run(bot, a) {
    const ids = blockIds(bot, a.names || []);
    if (!ids.length) return { ok: false, observation: 'unknown block names ' + JSON.stringify(a.names) };
    const b = bot.findBlock({ matching: ids, maxDistance: a.maxDistance || 32 });
    // A frame sighting IS the portal room's position; `/locate` only names the stronghold corner, so
    // without this the 09:29 sighting bought the run nothing and it dug at the corner for 4 more hours.
    if (b && (a.names || []).includes('end_portal_frame')) require('../portalRecord').remember(b.position);
    return b ? { ok: true, observation: `found ${b.name} at ${b.position.x},${b.position.y},${b.position.z}` }
            : { ok: false, observation: `no ${JSON.stringify(a.names)} within ${a.maxDistance || 32}` };
  },
});
reg.define('goto', {
  desc: 'Pathfind to absolute coordinates.',
  params: { x: 'int', y: 'int', z: 'int' },
  async run(bot, a) {
    const { GoalNear } = require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals;
    try {
      await bot.pathfinder.goto(new GoalNear(a.x, a.y, a.z, 1));
      return { ok: true, observation: `arrived near ${a.x},${a.y},${a.z}` };
    } catch (e) { return { ok: false, observation: 'goto failed: ' + e.message }; }
  },
});
reg.define('follow', {
  desc: 'Follow the given player name (companion mode).',
  params: { player: 'name' },
  async run(bot, a) {
    const name = a.player || 'nearest';
    const target = name === 'nearest' ? nearestPlayer(bot) : bot.players[name] && bot.players[name].entity;
    if (!target) return { ok: false, observation: 'player not found: ' + name };
    bot.pathfinder.setGoal(new (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).Follow(target, 3), true);
    return { ok: true, observation: 'following ' + (target.username || target.name) };
  },
});
reg.define('chat', {
  desc: 'Say a short message in game to the human player.',
  params: { message: 'string' },
  async run(bot, a) { bot.chat(a.message || '...'); return { ok: true, observation: 'said: ' + a.message }; },
});
reg.define('wait', {
  desc: 'Wait N seconds.',
  params: { sec: 'int' },
  async run(bot, a) { await sleep((a.sec || 3) * 1000); return { ok: true, observation: `waited ${a.sec || 3}s` }; },
});

// --- gathering ---
reg.define('chop_trees', {
  desc: 'Fell trees to collect logs (planks source). Repeats until it has `count` logs.',
  params: { count: 'int default 12' },
  async run(bot, a) {
    const need = a.count || 12;
    const logsNow = () => ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log'].reduce((s, n) => s + countItem(bot, n), 0);
    // Trees grow where there is SKY, not above some altitude. The old gate was `y < 30`, so at
    // 11:22:52 on 2026-10-30 a bot standing in a cave at y=52 with planks=0/stick=0 (the wall between
    // three diamonds and the diamond pickaxe) answered `no trees reachable; bot is underground` in
    // 0.9 s and never climbed - the remedy existed and a magic number hid it from the one case that
    // needed it. Roof-scan is the honest test: solid non-plant cover overhead means no sky, no trees.
    const roofed = () => {
      const f = bot.entity.position.floored();
      for (let dy = 2; dy <= 16; dy++) {
        let b = null;
        try { b = bot.blockAt(new Vec3(f.x, f.y + dy, f.z)); } catch { b = null; }
        if (!b || b.boundingBox !== 'block') continue;
        if (/leaves|_log|water|snow|vine|short_grass|tall_grass|fern|seagrass|air/.test(b.name)) continue;
        return true;
      }
      return false;
    };
    // No `*_log` block generates outside the Overworld, so every branch below this one - recover_surface,
    // the 200-block walk toward any log - is a dead end when the bot is standing in the Nether. Measured
    // 17:39-17:41 at 17,36,110 the_nether: chop_trees called recover_surface (which delegates to
    // return_overworld and starts a portal walk), then started its own wood walk, and the two cancelled
    // each other's pathfinder goal until the 90 s cap abandoned the whole thing. Answer in 0 s instead.
    // (Warped/crimson stems do plank in this version, but they are not in LOG_NAMES and need an axe to
    // harvest - that is a different recipe, not this skill.)
    const dimHere = bot.game && bot.game.dimension;
    if (dimHere && dimHere !== 'overworld') {
      return { ok: false, observation: `logs now=${logsNow()} in ${dimHere}: no log block generates in this dimension - wood, planks and sticks have to come from the Overworld, so take the portal back (return_overworld / use_portal) before any recipe that needs them` };
    }
    let guard = 0, surfaced = false, triedToSurface = false, sawTree = false, lastErr = '', walkedForWood = false, logsCut = 0;
    // Never try pathing straight through 40 blocks of ceiling rock to a surface tree while underground:
    // findBlock(maxDistance: 48) sees trees overhead at y=70 from y=29 and skips the !tree surface branch.
    if ((bot.entity.position.y < 52 || roofed()) && !triedToSurface) {
      triedToSurface = true;
      log.skill(`chop_trees: underground/roofed at y=${Math.round(bot.entity.position.y)} - surfacing before locating trees`);
      try {
        const rs = await reg.get('recover_surface').run(bot, {});
        if (rs && rs.ok) surfaced = true;
      } catch (e) { log.warn('chop_trees pre-surface threw:', e.message); }
    }
    while (logsNow() < need && guard++ < 12) {
      pov.progress('砍树', logsNow(), need);
      const ids = blockIds(bot, LOG_NAMES);
      const tree = bot.findBlock({ matching: ids, maxDistance: 48 });
      if (!tree) {
        // A reef is not a forest, and the old two tests both missed it: at 04:52 on 2026-10-31 the bot
        // stood at y=62-63 on an open-sky coral shelf (roofed()=false, y<62=false), so it never left the
        // water, `chop_trees` answered `0 logs, 0 planks`, and that single miss starved BOTH supply
        // chains - no planks means no crafting table, which blocks the fishing rod (food) and the
        // diamond pickaxe (obsidian) at the same time.
        const onReef = () => {
          const fr = bot.entity.position.floored();
          let land = 0;
          for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [4, 0], [-4, 0], [0, 4], [0, -4]]) {
            for (const dy of [0, -1]) {
              const b = bot.blockAt(fr.offset(dx, dy, dz));
              if (b && b.boundingBox === 'block' && !/water/.test(b.name)) { land++; break; }
            }
          }
          return bot.entity.position.y <= 65 && land === 0;
        };
        // A tree buys 2 sticks. The descent it would cancel is 26 blocks of deepslate already dug, with an
        // OPEN portal at the bottom of it - and wood is not a dive gate (the pack has 21 planks right now).
        const doorHere = nearOpenDoor(bot, 60);
        if (!surfaced && doorHere !== null) {
          const f1 = bot.entity.position.floored();
          return { ok: false, observation: `no tree at ${f1.x},${f1.y},${f1.z} and the open End portal is ${doorHere} blocks from this cell - NOT surfacing for wood (that exact errand hauled the bot from y=30 back to y=63 twice tonight). Wood is not a dive gate; skip it and keep descending` };
        }
        if (!surfaced && (roofed() || bot.entity.position.y < 62 || onReef()) && reg.get('recover_surface')) {
          surfaced = true; triedToSurface = true;
          const f0 = bot.entity.position.floored();
          log.skill(`chop_trees: no tree in reach at ${f0.x},${f0.y},${f0.z} (${roofed() ? 'roof overhead' : bot.entity.position.y < 62 ? 'below sea level' : 'standing on a treeless reef at sea level'}) -> recover_surface, then retry`);
          try { await reg.get('recover_surface').run(bot, {}); } catch (e) { log.skill(`chop_trees: recover_surface threw ${String(e.message).slice(0, 50)}`); }
          continue;
        }
        // Climbing out is not enough when the SURFACE itself is treeless. Measured 17:29-17:31 on
        // 2026-10-30: it surfaced (y=62/67 around 224,,350) and still had planks=0, because the bare
        // island the recovery lands it on has no wood within 48. A player walks until a forest shows
        // up, and `roam` already has a block-search mode for exactly that. One walk per call, then look
        // again - the alternative is the whole ladder idling on sticks (stone pick, diamond pick,
        // obsidian, portal: all gated behind 2 sticks).
        if (surfaced && !walkedForWood && reg.get('roam')) {
          walkedForWood = true;
          const fT = bot.entity.position.floored();
          log.skill(`chop_trees: open sky at ${fT.x},${fT.y},${fT.z} but no tree within 48 - walking up to 200 blocks toward any log block`);
          try {
            await reg.get('roam').run(bot, { block: 'oak_log,birch_log,spruce_log,jungle_log,acacia_log,dark_oak_log,mangrove_log,cherry_log', distance: 200 });
          } catch (e) { log.warn(`chop_trees: the wood walk threw ${String(e.message).slice(0, 50)}`); }
          continue;
        }
        await stepMove(bot); continue;
      }
      sawTree = true;
      try {
        await bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear(tree.position.x, tree.position.y, tree.position.z, 2));
        const dr = await digTree(bot, tree);
        if (dr && dr.broke > 0) logsCut += dr.broke;
        if (dr && dr.broke > 0 && logsNow() === 0) lastErr = `${dr.broke} log block(s) broken but no log in the pack - the drop never reached it${dr.err ? ` (${dr.err})` : ''}`;
      } catch (e) { lastErr = String(e.message || e).slice(0, 60); log.warn(`chop_trees: the ${sawTree ? 'dig' : 'walk'} to the trunk failed - ${lastErr}`); if (cfg.bot && cfg.bot.talk === 'game' && bot.chat) { try { bot.chat('chop err: ' + e.message); } catch {} } }
    }
    const have = logsNow();
    const fy = bot.entity.position.floored().y;
    return {
      ok: have > 0,
      observation: have >= need ? `logs now=${have}`
        : have > 0 ? `logs now=${have} of ${need} (a few trees, thin cover)`
        : sawTree
          ? `logs now=0 - a trunk WAS in reach and nothing landed in the pack${lastErr ? ` (last error: ${lastErr})` : ''} (y=${fy}): the walk or the dig is being refused, the biome is not the problem`
          : triedToSurface
            ? `logs now=0 - climbed out of the cover and still no tree within 48${walkedForWood ? ', then walked toward any log for up to 200 blocks without finding one' : ''} (y=${fy}, ${roofed() ? 'still roofed' : 'open sky, treeless biome'}): this biome has no wood, the ladder has to be paid for with what is here`
            : `logs now=0 (no trees reachable; bot is underground or in a treeless biome)`,
    };
  },
});
// An ore BLOCK and its DROP are different names on 1.21, and every "did I collect any" test that
// counts the block name is blind. Measured 06:06-06:10: `mine` reported `+0 collected` three times
// while raw_iron went 0 -> 2 -> 4 in the pack, so the loop never terminated, re-hunted a vein it had
// already emptied (`remembered iron_ore at 90,36,44 is now air`), and spent the whole obsidian step on
// an extraction that had actually succeeded.
const DROPS_OF = {
  iron_ore: ['raw_iron'], deepslate_iron_ore: ['raw_iron'],
  gold_ore: ['raw_gold'], deepslate_gold_ore: ['raw_gold'],
  copper_ore: ['raw_copper'], deepslate_copper_ore: ['raw_copper'],
  coal_ore: ['coal'], deepslate_coal_ore: ['coal'],
  diamond_ore: ['diamond'], deepslate_diamond_ore: ['diamond'],
  emerald_ore: ['emerald'], deepslate_emerald_ore: ['emerald'],
  lapis_ore: ['lapis_lazuli'], deepslate_lapis_ore: ['lapis_lazuli'],
  redstone_ore: ['redstone'], deepslate_redstone_ore: ['redstone'],
  quartz_ore: ['quartz'], nether_quartz_ore: ['quartz'], ancient_debris: ['ancient_debris'],
  // The stone forms. Measured 2026-11-01 01:41:34-38: 25 consecutive `broke stone ... the pack gained 0`
  // lines while cobblestone really was climbing, so the step returned `mined 0 of ["stone"]`, the ladder
  // re-ran it, and the iron pickaxe lost 8 durability per round cutting rock the verifier could not see.
  // The block keeps its OWN name in the list too: a silk-touch pick drops the block itself, and dropping
  // that name would make the same class of blindness happen in reverse.
  // NOT listed on purpose: granite/diorite/andesite/tuff/cobbled_deepslate drop themselves, so the
  // identity fallback already covers them and mapping them to cobblestone would credit the loop for a
  // rock it never collected. Proof for diorite is in the 01:42:31 pack dump (`diorite:1` arrived as an
  // item), and the rest follow from obtainability - no crafting or stonecutter recipe can produce them
  // from anything else, so a block that dropped something other than itself could never be collected.
  stone: ['cobblestone', 'stone'],
  deepslate: ['cobbled_deepslate', 'deepslate'], polished_deepslate: ['cobbled_deepslate', 'deepslate'],
  deepslate_bricks: ['cobbled_deepslate', 'deepslate'], deepslate_tiles: ['cobbled_deepslate', 'deepslate'],
  grass_block: ['dirt', 'grass_block'], podzol: ['dirt', 'grass_block'], mycelium: ['dirt', 'grass_block'],
};
const dropsOf = (blockName) => DROPS_OF[blockName] || [blockName];
const countDrops = (bot, blockName) => dropsOf(blockName).reduce((s, n) => s + countItem(bot, n), 0);

reg.define('mine', {
  desc: 'Mine and pick up `count` blocks by name (cobblestone, coal_ore, iron_ore, diamond_ore, obsidian...). Auto-equips best tool.',
  params: { names: 'array of block names', count: 'int default 8', maxDistance: 'int default 48' },
  async run(bot, a) {
    const names = a.names || ['cobblestone']; const need = a.count || 8; const range = a.maxDistance || 48;
    const ids = blockIds(bot, names);
    if (!ids.length) return { ok: false, observation: 'unknown ' + JSON.stringify(names) };
    // Tool TIER, not tool existence: a wooden pickaxe mines iron ore and yields literally nothing,
    // so the ladder kept reporting "raw_iron=5" forever while holding 76 cobblestone and a full
    // wooden pick that ensure_tools was happy with. Require the tier the target ore demands.
    const TIER = { wooden: 0, golden: 1, stone: 1, iron: 2, diamond: 3, netherite: 4 };
    const bestTier = () => bot.inventory.items().filter(i => i.name.endsWith('_pickaxe'))
      .reduce((m, i) => Math.max(m, TIER[i.name.split('_')[0]] ?? 0), -1);
    // Diamond and emerald ore need only an IRON pickaxe in vanilla (iron=2). Demanding a diamond
    // pick to mine the diamonds that make a diamond pick is the same bootstrap deadlock as asking
    // for a stone pick with no cobble - and it is what left the assist run at 15/23 with an iron
    // pick in hand and nothing it could do about it. Obsidian stays tier 3, where the demand is real.
    // Obsidian is tier 3 in vanilla: an iron or stone pick mines it to nothing. Without this the
    // generic `mine {names:['obsidian']}` call happily equipped a stone pick, spent 9 s per block and
    // reported 0 collected, which reads like "no obsidian here" instead of "wrong tool".
    // Lava and water cannot be mined: a pick drops nothing and the tool is a bucket. Measured
    // 07:01:30-07:02:08 - the model planned `mine {names:["lava"]}`, which can never succeed, so its
    // loop sat at "try 20..25" ACROSS two other steps, and every goto it issued cancelled the step that
    // was actually running ("The goal was changed before it could be completed!"), which is what held
    // `obsidian` at zero blocks. Refuse on the spot and name the skill that works.
    const LIQUID = names.filter(n => /^lava|^water$/.test(n));
    if (LIQUID.length) return { ok: false, observation: `${LIQUID.join(",")} cannot be mined (a pick drops nothing; the tool is a bucket). For lava: stand next to the pool and use make_obsidian; for water: face it with an empty bucket.` };
    const wantedTier = /obsidian/.test(names.join()) ? 3 : /diamond|emerald/.test(names.join()) ? 2 : /redstone|lapis|iron|gold|deepslate|nether_quartz/.test(names.join()) ? 1 : 0;
    if (bestTier() < wantedTier) {
      // Bootstrap when there is NO pickaxe in the pack: a stone pick needs 3 cobble, and cobble
      // needs a pick, so the tier guard alone is a deadlock. This froze the assist run at 02:30
      // with 8 iron ingots, a crafting table, 5 planks and 13 sticks in hand - it just stood there
      // asking for stone_pickaxe every 30 seconds.
      if (bestTier() < 0) {
        const w = await craft(bot, 'wooden_pickaxe', 1);
        log.skill(`mine: no pickaxe at all -> wooden bootstrap: ${w.ok ? 'ok' : 'failed'} (${w.observation})`);
        const wp = bot.inventory.items().find(i => i.name === 'wooden_pickaxe');
        if (wp) { try { await bot.equip(wp, 'hand'); } catch {} }
      }
      // Get the ingredient BEFORE asking for the craft again. This used to sit inside `bestTier() < 0`,
      // i.e. it only ran when the pack had NO pickaxe - and the live deadlock at 16:34 had a wooden pick
      // at 22 durability: tier 0, enough to mine stone, not enough for iron ore, so the gate skipped the
      // ingredient run and `craft stone_pickaxe` was re-attempted every round with 0 cobblestone
      // (`no single item can satisfy "c" ... want 3 of one of ["cobblestone","cobbled_deepslate"]`).
      // Any pick that can mine stone is enough to bootstrap; requiring "no pick at all" inverted the test.
      // The ingredient run may only name TIER-0 blocks. It used to include `deepslate`, which the tier
      // regex above maps to 1 - so "dig stone for the pick" itself demanded a stone pick and called straight
      // back into this bootstrap: Maximum call stack size exceeded, caught by tools/craft_bootstrap_selftest.js.
      // stone and cobblestone are tier 0 and a wooden pick mines both, which is the whole point.
      // `=== 1`, not `>= 1`: cobblestone is the ingredient of a STONE pick only. For an iron or diamond pick
      // the shortage is ingots or diamonds, and digging 8 stone there wastes a trip and puts "dug cobble"
      // in the log of a round whose real problem is iron - a misleading verdict is worse than a slow one.
      if (wantedTier === 1 && bestTier() >= 0 && countItem(bot, 'cobblestone') + countItem(bot, 'cobbled_deepslate') < 3) {
        const c = await reg.get('mine').run(bot, { names: ['cobblestone', 'stone'], count: 8, maxDistance: 32 });
        log.skill(`mine: tier ${bestTier()} pick but only ${countItem(bot, 'cobblestone') + countItem(bot, 'cobbled_deepslate')} cobble - dug for the stone pick first: ${String(c.observation).slice(0, 140)}`);
      }
      // Aim at the tier the target actually needs, not "stone unless diamond": with wantedTier=2 it
      // used to craft a stone pick, declare the tier still short, and give up.
      const make = wantedTier >= 3 ? 'diamond_pickaxe' : wantedTier >= 2 ? 'iron_pickaxe' : 'stone_pickaxe';
      const r = await craft(bot, make, 1);
      log.skill(`mine: needed tier ${wantedTier}, had ${bestTier()} -> crafted ${make}: ${r.ok ? 'ok' : 'failed'} (${r.observation})`);
      if (bestTier() < wantedTier) {
        return { ok: false, observation: `${JSON.stringify(names)} needs a ${wantedTier >= 3 ? 'iron/diamond' : 'stone'} pickaxe or better (a wooden one drops nothing); crafting ${make} failed: ${r.observation}` };
      }
    }
    let collected = 0, tries = 0;
    const tried = {}; let targetKey = null;
    const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
    while (collected < need && tries++ < 50 && Date.now() < (bot._stepDeadline || Infinity)) {
      if ((bot.food < 10 || bot.health <= 8) && !/food/i.test(String(bot._loopPhase || ''))) {
        log.warn(`mine: food=${bot.food} hp=${Math.round(bot.health * 10) / 10} - stopping the dig loop so the ladder can eat/heal before it dies mid-step`);
        return { ok: collected > 0, observation: `EMERGENCY (food ${bot.food}, hp ${Math.round(bot.health * 10) / 10}) after ${collected} collected - eat/heal first` };
      }
      const positions = bot.findBlocks({ matching: ids, maxDistance: range, count: 16 });
      let target = null;
      for (const p of positions) {
        const b = bot.blockAt(p);
        if (!b || !isExposed(bot, b)) continue;
        // Skip a block already tried twice. Measured right before two overnight disconnects:
        // `mine: heading to coal_ore at -223,57,549 dist=2.5 (try 10)` then try 11, 12, 13 - the same
        // point-blank block, each retry issuing a goto + look + dig whose packets the server is already
        // rejecting. Repeating a failed action at 2.5 blocks is both the waste and the kick risk, so
        // the target gets dropped and the next one picked instead.
        const key = `${p.x},${p.y},${p.z}`;
        tried[key] = (tried[key] || 0) + 1;
        if (tried[key] > 2) {
          // Third contact with the same block means pathfinder has no route through the rock to it.
          // Dropping it was wrong when it is the only vein in range: the step then oscillated between
          // `heading to deepslate_iron_ore (13.8 away)` and `nothing in sight, hopping to remembered`
          // without ever digging, and three back-to-back armor steps ended in
          // `timeout after 420s in phase "armor:sight-mine"` (07:32, 07:45, 07:58) for that reason
          // alone. A player tunnels at ore they can see, so tunnel - mineBlockHere digs the heading.
          if (bot.entity.position.distanceTo(b.position) <= 26) {
            log.info(`mine: ${b.name} at ${p.x},${p.y},${p.z} has no path (try ${tried[key]}) - tunneling toward it`);
            const d0 = bot.entity.position.distanceTo(b.position);
            const had = countDrops(bot, b.name);
            try {
              // `mineBlockHere` returns true whether or not it broke anything (its last statement is
              // an unconditional `return true`), so counting it as a collected ore was a phantom:
              // 18:33 ran eight tunnel passes in 2.5 s against obsidian 14 blocks away and each one
              // "succeeded". Count the inventory instead, and measure how far the pass actually moved.
              // The inventory read has to be the DROP name (raw_iron), not the block name (iron_ore).
              await require('./endgame').mineBlockHere(bot, b);
              const got = countDrops(bot, b.name) - had;
              if (got > 0) collected += got;
              const d1 = bot.entity.position.distanceTo(b.position);
              log.info(`mine: tunnel pass moved ${(d0 - d1).toFixed(1)} blocks (now ${d1.toFixed(1)} from ${b.name}), +${got} collected`);
            } catch (err) { log.warn(`mine: tunnel toward ${b.name} threw ${err.message}`); }
          }
          continue;
        }
        target = b; targetKey = key; break;
      }
      if (!target) {
        // Nothing exposed within reach: walk to a vein this run has ALREADY reported instead of
        // tunneling at random. Without this the armor step spent whole budgets digging sideways at
        // y=78 while its own log held iron at y=24-38 (`heading to iron_ore at -176,29,620`), one
        // round after the position was forgotten. Hops (14 blocks) rather than one long goto, for
        // the same reason as below: A* across an open cave system freezes the event loop.
        const known = oreCache.nearest(names, bot.entity.position);
        // Only worth a hop when the vein is actually elsewhere. Measured 04:00:03-04:00:26 with the
        // first threshold at 4: it re-hopped to the same remembered vein at 5-8 blocks eleven times
        // and mined nothing, because at that range the ore is BEHIND rock and the answer is to dig,
        // not to walk. Below 12 we fall through to the dig-to-expose branch below.
        if (known && known.dist > 12 && known.dist <= 140 && Date.now() < (bot._stepDeadline || Infinity)) {
          // Drop a stale memory as soon as the chunk says it is gone (mined out, or never there):
          // null means the chunk is not loaded yet, which is exactly when the walk is still worth it.
          const at = bot.blockAt(new Vec3(known.x, known.y, known.z));
          if (at && at.name !== known.name) {
            oreCache.forget(known.x, known.y, known.z);
            log.info(`mine: remembered ${known.name} at ${known.x},${known.y},${known.z} is now ${at.name} - dropped from cache`);
          } else {
          const kk = 14 / known.dist;
          const hx = Math.round(bot.entity.position.x + (known.x - bot.entity.position.x) * kk);
          const hy = Math.round(bot.entity.position.y + (known.y - bot.entity.position.y) * kk);
          const hz = Math.round(bot.entity.position.z + (known.z - bot.entity.position.z) * kk);
          const hopFrom = bot.entity.position.clone();
          log.info(`mine: nothing in sight, hopping to remembered ${known.name} at ${known.x},${known.y},${known.z} (${known.dist} away)`);
          try { await bot.pathfinder.goto(new GN(hx, hy, hz, 1)); } catch {}
          await sleep(200);
          // A hop that moves nothing must not be retried at 200 ms. Measured 22:46:00 -> 22:46:03, this
          // line printed fifteen times in 3 s: at y=-45 the 14/`dist` hop aim lands inside solid rock,
          // goto rejects immediately, and the loop spins with zero progress until the step deadline -
          // which no watchdog sees, because the log never goes silent (`logSilenceS=1`). Hand the trip
          // back to the caller, which is the only level that can actually walk 111 blocks.
          if (bot.entity.position.distanceTo(hopFrom) < 0.6) {
            const key = `${known.x},${known.y},${known.z}`;
            const prev = bot._mineHop;
            const n = (prev && prev.key === key ? prev.n : 0) + 1;
            bot._mineHop = { key, n };
            if (n >= 3) {
              bot._mineHop = null;
              return { ok: false, observation: `remembered ${known.name} at ${known.x},${known.y},${known.z} is ${Math.round(known.dist)} blocks away (${Math.abs(known.y - Math.round(bot.entity.position.y))} blocks vertically from y=${Math.round(bot.entity.position.y)}); three hops moved nothing - this needs a real trip there (walk_to, or resume_shaft to dig down to it), not another mine call` };
            }
          } else bot._mineHop = null;
          continue;
          }
        }
        // No exposed target nearby (e.g. surface stone is buried under grass): dig down/across a bit to expose it.
        const feet2 = bot.entity.position.floored();
        const dig = bot.blockAt(feet2.offset(0, -1, 0));
        // Never punch out the floor underneath falling blocks: gravel/sand collapses onto the
        // player and buries them, and a bot embedded in a block gets rejected on every later login
        // (that is the wedge that cost two worlds). Dig sideways instead and let the ladder move.
        const overheadFalls = [bot.blockAt(feet2.offset(0, 1, 0)), bot.blockAt(feet2.offset(0, 2, 0))]
          .some(b => !!b && /gravel|sand/.test(b.name));
        if (overheadFalls && dig && !isAir(dig.name)) log.skill('mine: not digging out the floor - gravel/sand above will bury us');
        if (dig && !isAir(dig.name) && !overheadFalls && !dig.name.includes('lava') && !dig.name.includes('water')) {
          try { await equipBestToolFor(bot, dig); await bot.dig(dig); await sleep(250); } catch { await stepMove(bot); }
        } else {
          await stepMove(bot);
        }
        continue;
      }
      try {
        const dist = bot.entity.position.distanceTo(target.position);
        log.info(`mine: heading to ${target.name} at ${target.position.x},${target.position.y},${target.position.z} dist=${dist.toFixed(1)} (try ${tries})`);
        // Remember what we can see: this is the line that already names the vein, so the cache costs
        // nothing to fill and the next round can walk to it instead of rediscovering it by tunneling.
        oreCache.remember(target.name, target.position.x, target.position.y, target.position.z);
        if (dist > 20) {
          // A* runs synchronously inside pathfinder.goto(), so a far goal across an open cave system
          // freezes the WHOLE event loop: the bow step sat at ~108% of one core for 4+ minutes with no
          // log line, no movement, and no step timeout able to fire (its own timer cannot run). Hop
          // toward the target instead, so every search covers a fraction of the volume.
          const k = 14 / dist;
          const hx = Math.round(bot.entity.position.x + (target.position.x - bot.entity.position.x) * k);
          const hz = Math.round(bot.entity.position.z + (target.position.z - bot.entity.position.z) * k);
          try { await bot.pathfinder.goto(new GN(hx, Math.round(target.position.y), hz, 1)); } catch {}
          await sleep(200);
          continue;
        }
        await bot.pathfinder.goto(new GN(target.position.x, target.position.y, target.position.z, 1));
        // The router above throws when it cannot reach, and the old code dug anyway: `broke stone_bricks at
        // -144,59,1477 dist=6.2 and the pack gained 0` (10:14:29). A block broken beyond pickup range is a
        // hole in the wall and a wasted pick swing, so walk a bit more by hand, then refuse honestly.
        let dNow = bot.entity.position.distanceTo(target.position);
        if (dNow > 4.2) {
          const step = { x: Math.round(bot.entity.position.x + (target.position.x - bot.entity.position.x) / Math.max(1, dNow) * 2),
                         y: Math.round(target.position.y), z: Math.round(bot.entity.position.z + (target.position.z - bot.entity.position.z) / Math.max(1, dNow) * 2) };
          try { await bot.pathfinder.goto(new GN(step.x, step.y, step.z, 1)); } catch {}
          dNow = bot.entity.position.distanceTo(target.position);
        }
        if (dNow > 4.2) {
          log.skill(`mine: refusing to dig ${target.name} at ${target.position.x},${target.position.y},${target.position.z} from ${dNow.toFixed(1)} blocks (pickup range is ~4.2) - walking closer first`);
          await sleep(150);
          continue;
        }
        await equipBestToolFor(bot, target);
        const hadHere = countDrops(bot, target.name);
        await bot.dig(target);
        // A drop is an ENTITY that appears a tick or two after the break packet; counting at dig-resolution
        // read +0 for walls that were in fact mined (10:25:27 `dist=1.6 ... the pack gained 0`, five times in
        // a row at 1.6 blocks), and the loop then walked away from a vein it had just opened. Wait for the
        // pickup - up to 1.5 s - before calling it a loss.
        let gotHere = 0;
        for (let w = 0; w < 5; w++) {
          gotHere = countDrops(bot, target.name) - hadHere;
          if (gotHere > 0) break;
          await sleep(300);
        }
        // Count what landed in the pack, not the block that broke. `collected++` used to credit every
        // break, so a stone pick on deepslate iron (drops nothing) reported success while the ore just
        // vanished - and the mirror bug at 06:07 was worse: it counted the BLOCK name, saw +0 while
        // raw_iron climbed 0->4, and never terminated the loop at all.
        collected += Math.max(gotHere, 0);
        pov.progress('采集 ' + String(names[0]).replace(/_/g, ' '), collected, need);
        if (gotHere <= 0) log.warn(`mine: broke ${target.name} at ${target.position.x},${target.position.y},${target.position.z} and the pack gained ${gotHere} (expected one of ${dropsOf(target.name).join('/')}) - tool tier or pickup?`);
        // It is gone now - do not send the next round walking back to an empty wall.
        oreCache.forget(target.position.x, target.position.y, target.position.z);
        try { await bot.pathfinder.goto(new GN(target.position.x, target.position.y, target.position.z, 0)); } catch {} // walk onto the drop
        await sleep(250);
      } catch (e) { await stepMove(bot); } // unreachable: move on rather than re-pick (collectBlock storms caused OOM)
    }
    return { ok: collected > 0, observation: `mined ${collected} of ${JSON.stringify(names)}; slots=${ob.invSummary(bot).slots}` };
  },
});

// --- crafting / equipment ---
reg.define('craft', {
  desc: 'Craft `count` of an item from inventory (auto-places a crafting table when needed).',
  params: { item: 'item name', count: 'int default 1' },
  async run(bot, a) { return craft(bot, a.item, a.count || 1); },
});
reg.define('equip', {
  desc: 'Equip the best held tool or the named item, and put on best armor.',
  params: { item: 'item name (optional; else best armor/tool)' },
  async run(bot, a) {
    try {
      if (a.item) { const it = bot.inventory.items().find(i => i.name === a.item); if (it) await bot.equip(it, 'hand'); }
      await equipBestArmor(bot);
      return { ok: true, observation: 'equipped ' + (bot.inventory.selectedItem ? bot.inventory.selectedItem.name : 'hand') };
    } catch (e) { return { ok: false, observation: 'equip failed: ' + e.message }; }
  },
});

// --- survival ---
// What the pack can actually eat, best first. `hunger` is the points the item restores (2 per drumstick),
// and raw meat is listed LAST on purpose: it feeds but risks poisoning, so a cooked piece or an apple
// always wins.
const EATABLE = [
  ['cooked_beef', 10], ['cooked_mutton', 10], ['cooked_porkchop', 10], ['cooked_salmon', 6],
  ['cooked_cod', 5], ['cooked_rabbit', 5], ['bread', 5], ['baked_potato', 5], ['cooked_chicken', 6], ['dried_kelp', 1],
  ['melon_slice', 2], ['carrot', 3], ['apple', 4], ['sweet_berries', 2], ['glow_berries', 2], ['beef', 3], ['porkchop', 3], ['mutton', 2],
  ['chicken', 1], ['cod', 2], ['salmon', 2], ['rabbit', 2], ['rotten_flesh', 4],
];
reg.define('eat', {
  desc: 'Eat the best food in the pack until the hunger meter reaches `target`, and only report success if the meter actually rose. (The auto-eat plugin stops at its own low threshold, so it never tops a wounded bot up - it is left enabled but is not the answer.)',
  params: { target: 'int default 19 when hurt / 12 otherwise - hunger points to reach (20 = full)' },
  async run(bot, a) {
    if (bot.autoEat) { try { bot.autoEat.enableAuto(true); } catch {} }
    const want = a.target ?? (bot.health < 20 ? 19 : 12);
    const before = bot.food;
    if (before >= want) return { ok: true, observation: `food=${before} already at or above the ${want} needed` };
    const eatable = () => {
      const have = bot.inventory.items().filter(i => EATABLE.some(([n]) => n === i.name))
        .sort((x, y) => (EATABLE.find(([n]) => n === y.name)[1]) - (EATABLE.find(([n]) => n === x.name)[1]));
      return have[0] || null;
    };
    let it = eatable();
    if (!it) return { ok: false, observation: `nothing edible in the pack (food=${before} of ${want}) - this needs hunting, farming or smelting, not eating` };
    const ate = [];
    let meterStuck = false;
    // Travel rations, because two gates were eating each other. The survive gate tops the meter with
    // `eat {target:20}` and the dive gate wants 3 edible items carried, with a waiver floor of 1 - so every
    // hunt ended full-fed-but-blocked (live 18:56:44 `edible=0 (food stall 3)` at the portal column, after
    // three cows killed at 18:24). While the End is the pending stage, stop while 3 rations remain; below
    // food=12 survival outranks the reserve, and this never hard-refuses a meal.
    // The phase alone was not enough: with the door open the run spends its time in `step:food` (the
    // milestone re-opens precisely because the pack is empty), and the reserve had to cover THAT - which is
    // where the stack actually gets eaten. `ringComplete` is the fact that says nothing is left but the dive.
    const divePending = /enter_end|kill_dragon/.test(String(bot._loopPhase || '')) || (() => {
      try { const rec = require('../portalRecord').current(); return !!(rec && rec.ringComplete); } catch { return false; }
    })();
    const RESERVE = 3;
    const edibleLeft = () => bot.inventory.items()
      .filter(i => EATABLE.some(([n]) => n === i.name))
      .reduce((s, i) => s + (i.count || 1), 0);
    for (let n = 0; n < 8 && bot.food < want && it; n++) {
      if (divePending && bot.food >= 8 && edibleLeft() - 1 < RESERVE) {
        log.warn(`eat: stopping at food=${bot.food} with ${edibleLeft()} edible left in the pack - those are the dive gate's travel rations for the End (the meter is above 8; below 8 the meal wins)`);
        break;
      }
      const was = bot.food;
      try {
        await capped(bot.equip(it, 'hand'), 6000, 'equip food');
        if (!bot.heldItem || bot.heldItem.name !== it.name) {
          return { ok: false, observation: `the hand would not take ${it.name} (holds ${bot.heldItem ? bot.heldItem.name : 'nothing'}) - food=${bot.food} of ${want}, so this is the equip path, not a missing meal` };
        }
        // `capped()` folds a rejection into null, which would turn "the server refused the meal" into
        // "there is nothing edible" and send the bot off hunting. Keep the reason.
        let fail = null;
        const p = Promise.resolve(bot.consume()).catch(e => { fail = e && e.message ? e.message : String(e); });
        const finished = await Promise.race([p.then(() => true), new Promise(res => setTimeout(() => res(false), 12000))]);
        if (fail) return { ok: false, observation: `could not eat ${it.name}: ${fail} (food=${bot.food} of ${want}, ${ate.join(' ') || 'nothing yet'}) - the food IS in the pack, the eating is what failed` };
        if (!finished) return { ok: false, observation: `eating ${it.name} did not finish within 12s (food=${bot.food} of ${want}) - the food IS in the pack, the consume stalled` };
      } catch (e) {
        // `Food is full` is a success wearing a failure's clothes; everything else is reported.
        if (/Food is full/i.test(e.message)) break;
        log.warn(`eat: consuming ${it.name} threw ${e.message}`);
        return { ok: bot.food > before, observation: `stopped eating ${it.name}: ${e.message} (food=${bot.food} of ${want}, ${ate.join(' ') || 'nothing yet'})` };
      }
      if (bot.food <= was) {
        // The food packet lands after the swallow animation, and one 700 ms re-check was not enough:
        // measured 00:18:32 `ate mutton and the meter did not move (19 -> 19)` while the very next
        // minute sample read food=20. Poll before declaring the meal a failure.
        for (let w = 0; w < 6 && bot.food <= was; w++) await sleep(500);
        if (bot.food <= was) { meterStuck = true; log.warn(`eat: ate ${it.name} and the meter did not move (${was} -> ${bot.food})`); break; }
      }
      ate.push(`${it.name} ${was}->${bot.food}`);
      it = eatable();
      if (Date.now() >= (bot._stepDeadline || Infinity)) break;
    }
    const ok = bot.food >= want;
    log.skill(`eat: ${ok ? 'ok' : 'short'} food ${before} -> ${bot.food} (target ${want}) ate=${ate.join(', ') || 'nothing'}`);
    // The old wording asserted "the pack is out of edible food" from a single failed bite. Measured
    // 00:18:32: that verdict went out while the pack held 25 raw chicken and 5 mutton, and the planner
    // obeyed it and went hunting. Name the failure that actually happened.
    const leftEdible = bot.inventory.items().filter(i => EATABLE.some(([n]) => n === i.name)).reduce((s, i) => s + i.count, 0);
    const why = meterStuck
      ? `the meter refused to move with ${leftEdible} edible still in the pack - this is the eating path, not an empty larder, so do NOT go hunting`
      : leftEdible
        ? `${leftEdible} edible left (${ate.join(' ') || 'none eaten yet'}) - the bites ran out or the step deadline hit, not the food`
        : 'the pack is out of edible food, go hunt or farm';
    return { ok, observation: ok ? `food=${bot.food} of ${want} after eating ${ate.join(', ')}` : `still food=${bot.food} of ${want} (ate ${ate.length} item(s)) - ${why}` };
  },
});
reg.define('hunt', {
  desc: 'Attack nearest mob for food, `count` kills. Passive livestock by default (cow/pig/sheep/chicken); kind=zombie or kind=husk hunts the undead instead - rotten flesh is on this run\'s edible list and, unlike livestock, they spawn in the dark corridors it is already standing in, with no grass, herd or water crossing needed. Walks to the target if it is far, and bails out honestly when none is loaded.',
  params: { count: 'int default 3', kind: 'cow|pig|sheep|chicken|zombie|husk (any livestock if omitted; chicken for arrow feathers, zombie/husk for food underground)' },
  async run(bot, a) {
    const ALL_PASSIVE = ['cow', 'pig', 'sheep', 'chicken', 'rabbit'];
    // Hunting the undead is a deliberate ask, not a fallback: it costs sword hits and can pull a creeper
    // into the corridor, so the passive path keeps its own rules (grass surface, no water routing) and
    // only this kind drops them.
    const UNDEAD = ['zombie', 'husk'];
    const huntUndead = UNDEAD.includes(a.kind);
    const PASSIVE = huntUndead ? [a.kind] : (ALL_PASSIVE.includes(a.kind) ? [a.kind] : ALL_PASSIVE);
    const reachable = (en) => {
      if (!PASSIVE.includes(en.name) || !en.position) return false;
      const d = bot.entity.position.distanceTo(en.position);
      // An animal 35 blocks away but 40 blocks down a ravine (or across open water) is not food:
      // the bot burned a whole milestone on one and starved at food=9 next to it.
      // Keep a height limit (an animal 60 blocks down a ravine is not food) but allow the long
      // horizontal reach, because roam now actually walks us toward the animal.
      // The leash must be TIGHTEST at the door, not only far from it. Live 22:09-22:10: the bot stood 2
      // blocks from the open portal column (-218,1500) in chestplate+leggings, and one `hunt` step for the
      // last edible item walked it 57 blocks EAST to -161,64 - the old rule only filtered when myDoor>250,
      // so at short range nothing protected the approach. A meal is worth a detour in proportion to how
      // little is left to lose: near the door, prey may not pull it further away at all.
      const slack = myDoor > 250 ? 50 : Math.max(8, Math.round(myDoor * 0.25));
      if (diveDoor && doorDist(en.position) > myDoor + slack) { leashFiltered++; return false; }
      return d <= 100 && Math.abs(en.position.y - bot.entity.position.y) <= 30;
    };
    const find = () => bot.nearestEntity(reachable);
    // The leash belongs to the CHASE too, not only to the wander. Live 20:32: the run was 420 blocks from
    // an already-open End portal and `hunt` kept walking it further out after cows, because the thing it
    // was missing (8 leather for a chestplate) can be found anywhere and the door cannot. Anything that
    // drags it away from the door is not worth the meal while the dive is the only stage left.
    const diveDoor = (() => {
      try {
        const rec = require('../portalRecord').current();
        if (!rec || !rec.ringComplete) return null;
        if (!/food|enter_end|kill_dragon/.test(String(bot._loopPhase || ''))) return null;
        return rec;
      } catch { return null; }
    })();
    const doorDist = (p) => Math.hypot(p.x - diveDoor.x, p.z - diveDoor.z);
    const myDoor = diveDoor ? doorDist(bot.entity.position) : 0;
    let leashFiltered = 0;
    const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
    let kills = 0;
    let stuckFromWater = false;
    const first = find();
    // It was standing at y=54 in a riverbed/ocean floor with animals on the shore. Pathfinder
    // refuses to route through water by default, so EVERY leg failed with "Path was stopped" and
    // the bot starved next to visible cows. Say so plainly instead of burning a milestone.
    const fw = bot.entity.position.floored();
    const wetFeet = ['water', 'kelp_plant', 'seagrass'].includes((bot.blockAt(fw) || {}).name);
    const wetHead = ['water', 'kelp_plant', 'seagrass'].includes((bot.blockAt(fw.offset(0, 1, 0)) || {}).name);
    if (!huntUndead && (wetFeet || wetHead || fw.y < 62)) {
      // Say WHY. The old text claimed water whenever `y < 62`, so a DRY cave at y=37 (`feet=air
      // head=air`) reported "standing in/at water - surface to dry grass", and the model obediently
      // called recover_surface and hauled the bot out of a perfectly good iron layer onto a bare,
      // animal-free plateau. The bail-out itself is right (passive mobs need a grass surface, and
      // pathfinder will not route through liquid) - but a false reason poisons the next decision.
      const why = wetFeet || wetHead
        ? `standing in/at water (feet=${(bot.blockAt(fw) || {}).name} head=${(bot.blockAt(fw.offset(0, 1, 0)) || {}).name} y=${fw.y}) - pathfinder cannot route through water`
        : `DRY cave at y=${fw.y} (feet=${(bot.blockAt(fw) || {}).name} head=${(bot.blockAt(fw.offset(0, 1, 0)) || {}).name}) - no grass surface, so passive mobs cannot spawn here; dig/step UP to open ground rather than assuming water`;
      // The bail is right about WALKING and wrong about shooting. At 09:04 on 2026-10-30 roam reported
      // "chicken #744361 is not path-reachable from here" while the bot sat at food=0 hp=10 in shallow
      // water with a bow in the pack - and hunt returned before ever looking at that bow, because this
      // branch used to be an unconditional failure. An arrow does not need a route.
      const shot0 = find();
      const quiver = bot.inventory.items().find(i => i.name === 'arrow');
      const hasBow = !!bot.inventory.items().find(i => i.name === 'bow');
      if (shot0 && hasBow && quiver && bot.entity.position.distanceTo(shot0.position) <= 34) {
        log.skill(`hunt: ${why} - but ${shot0.name} #${shot0.id} is ${Math.round(bot.entity.position.distanceTo(shot0.position))} blocks away and the pack has a bow + ${quiver.count} arrow(s): shooting from here instead of walking`);
        stuckFromWater = true; // the loop's shot gate, applied where `stuck` is declared
      } else {
        // "Get to dry grass before hunting" is not an action when the bot is standing IN the ocean and
        // the pathfinder refuses to route through water: at 01:54 that advice was the whole loop -
        // food=0, `submerged ... movement policy paused`, `roam leg threw Path was stopped`, and the same
        // verdict every round. The moves that work from inside the water are the ones this run already
        // has: backfill the cell it stands in with carried stone, then judge again.
        const esc = await reg.get('dry_escape').run(bot, { max: 10 }).catch(e => ({ ok: false, observation: 'threw ' + String((e && e.message) || e).slice(0, 60) }));
        const fw3 = bot.entity.position.floored();
        const nowWet = ['water', 'kelp_plant', 'seagrass'].includes((bot.blockAt(fw3) || {}).name)
          || ['water', 'kelp_plant', 'seagrass'].includes((bot.blockAt(fw3.offset(0, 1, 0)) || {}).name);
        log.skill(`hunt: ${why.slice(0, 80)} - tried dry_escape first (${String(esc && esc.observation || 'no answer').slice(0, 70)}) -> ${nowWet ? 'still wet' : 'dry, hunting from here'}`);
        if (!nowWet) stuckFromWater = false;
        else return { ok: false, observation: `${why}; dry_escape could not clear this cell (${String(esc && esc.observation || 'no answer').slice(0, 90)}) - it needs a causeway or a swim, not another hunt call from the same water` };
      }
    }
    if (!first) {
      const f = bot.entity.position.floored();
      const bl = bot.blockAt(f);
      if (huntUndead) {
        return { ok: false, observation: `no zombie/husk loaded within 100 blocks of ${f.x},${f.y},${f.z} (standing in ${bl ? bl.name : 'unknown'}, dim=${bot.game.dimension}) - the undead need an unlit corridor; walk_to a torchless passage or light-less depth, do not burn the quiver looking for them` };
      }
      const sword = bot.inventory.items().some(i => /_sword$/.test(i.name));
      // "Go up to grass" is right for livestock and wrong for a bot whose next door is 60 blocks BELOW it.
      // The village answers are 4,184 and 4,421 blocks out (live 20:14:09, /locate), there is no kelp bed,
      // and the food stage has now held 81 minutes with the run at food=0 hp=10 - while the stronghold and
      // the deepslate caves around it are dark, full of zombies, and exactly where it has to go anyway.
      let ringOpen = false;
      try { const rec = require('../portalRecord').current(); ringOpen = !!(rec && rec.ringComplete); } catch {}
      const down = ringOpen && sword ? `; and do NOT climb to grass for this meal - the End door is already open below you, so the dark corridors at y=15-40 are the larder: hunt_spider {kind:'zombie', count:3} works there and rotten flesh counts as edible` : '';
      const leashNote = leashFiltered ? `; ${leashFiltered} animal(s) were in range but they sit FURTHER from the open End portal than this cell, so they are not tonight's meal - walk back toward ${require('../portalRecord').current().x},${require('../portalRecord').current().z} and hunt on the way` : '';
      return { ok: false, observation: `no REACHABLE cow/pig/sheep/chicken within 70 blocks at a similar height (standing in ${bl ? bl.name : 'unknown'}, y=${f.y}, dim=${bot.game.dimension}) - roam to open grass land first; animals across a ravine or water do not count as food${f.y < 62 && sword ? `; there IS food down here though: hunt {kind:'zombie'} - rotten flesh counts as edible and this level spawns zombies without grass, water or a herd` : ''}${down}${leashNote}` };
    }
    // The old version only looked 40 blocks out and then wandered, so the planner saw cows at 44-59
    // blocks and every chain of hunts bailed instantly (livelock). Now it closes the distance in
    // legs of <=20s and attacks once within reach.
    // Two goto calls in a row (walk + hop) leave the first promise pending; the next leg then
    // cancels it and BOTH answer "The goal was changed before it could be completed!" - hunt looped
    // on that for minutes without moving. Always stop the old path first, and give up if the
    // distance is not shrinking.
    const leg = async (goal, ms, label) => {
      // Only cancel a path that is actually running. Calling stop() before every goto raced the new
      // request, so EACH leg failed instantly with "Path was stopped before it could be completed".
      try { if (bot.pathfinder.isMoving()) bot.pathfinder.stop(); } catch {}
      await sleep(150);
      await capped(bot.pathfinder.goto(goal), ms, label);
    };
    // Bow fallback: an animal you cannot walk to can still be shot. The bot starved for half an
    // hour next to a cow 14 blocks across water while the pathfinder refused to route it.
    const shootAt = async (target) => {
      const bow = bot.inventory.items().find(i => i.name === 'bow');
      const arrow = bot.inventory.items().find(i => i.name === 'arrow');
      if (!bow || !arrow) return false;
      // Arrows do not grow back. At 17:12 the bot spent 8 of them on a cow it could not see clearly
      // across water (3-shot volleys, "still standing there", repeat) and its quiver fell to 1 - the
      // bow is also its only answer to a creeper that walks in while it is mining. Keep a reserve,
      // and stop after two volleys at the same animal: if the shots are not landing, more shots will
      // not change that, and the melee approach is free.
      // The reserve is priced by the animal, not by a constant: a chicken is 4 hp and dies to ONE
      // arrow, so refusing to shoot at arrow=3 (which is exactly what starved the bot beside chicken
      // #744361 on 2026-10-30) trades a guaranteed meal for a quiver it was never going to spend.
      const small = /chicken|rabbit/.test(target.name || '') || (typeof target.health === 'number' && target.health > 0 && target.health <= 6);
      if (arrow.count <= 4 && !(small && arrow.count >= 2)) { log.skill(`hunt: only ${arrow.count} arrows left - holding them, going melee instead of shooting ${target.name}`); return false; }
      // The give-up tally was kept ON THE ENTITY OBJECT (`target._volleys`), and `find()` hands back a
      // freshly-read entity every iteration - so the counter was always undefined and the same pig got
      // "survived 2 volleys - giving up on shooting it" eight times in 30 seconds at 00:57, leaking
      // arrows the dragon fight needs while the bot stood at food=0. Keyed by entity id on the bot now,
      // so giving up on an animal actually sticks - and it means going and hitting it with the sword.
      const key = `${target.name}#${target.id}`;
      bot._huntVolleys = bot._huntVolleys || {};
      const volleys = bot._huntVolleys[key] || 0;
      if (volleys >= 2) { log.skill(`hunt: ${key} already survived ${volleys} volleys - no more arrows on it, closing in to hit it with the sword`); return false; }
      bot._huntVolleys[key] = volleys + 1;
      // One arrow does not kill a pig (10 hp, ~5 damage), and hunting one animal should not cost
      // two minute of walking - so keep shooting the SAME target while it is still loaded.
      for (let s = 0; s < (small ? 1 : 3); s++) {
        const live = bot.entities[target.id];
        if (!live) return true;
        const dist = bot.entity.position.distanceTo(live.position);
        if (dist > 36) return false;
        const lift = Math.min(6, (dist * dist) / 900);
        try {
          await bot.equip(bow, 'hand');
          await bot.lookAt(live.position.offset(0, 0.6 + lift * 0.3, 0));
          await bot.activateItem(); await sleep(1300); await bot.deactivateItem();
          await sleep(1100);
          log.skill(`arrow ${s + 1} at ${target.name} (${Math.round(dist)} blocks)`);
        } catch (err) { log.skill(`bow shot threw ${err.message}`); return false; }
      }
      const alive = !!bot.entities[target.id];
      log.skill(`shot at ${target.name} -> ${alive ? 'still standing there' : 'gone'}`);
      return !alive;
    };
    // Walk the drops. pvp.attack() resolves the instant the entity dies and mineflayer has no
    // automatic pickup beyond brushing the item, so five "hunt killed sheep" in one round left
    // the pack with raw meat=none: the bot starved for hours (food 0, hp 14) beside the carcasses
    // it had made, and every milestone behind it timed out because survive() could never raise
    // the hunger bar. Extracted from the melee branch because an arrow kill needs it just as much -
    // a shot animal drops its meat on the bank the pathfinder will not route to.
    const walkDrops = async (killAt) => {
      for (let t = 0; t < 12; t++) {
        const drops = Object.values(bot.entities)
          .filter(en => { try { return en.name === 'item' && en.position && en.position.distanceTo(killAt) < 12; } catch { return false; } })
          .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
        if (!drops.length) { await sleep(300); continue; }
        const d = drops[0];
        // `d.item` is often absent on 1.21.1 (the item metadata arrives with its own packet), so the name
        // read as '?' and `countItem(bot, '?')` is ALWAYS 0 - the bot picked the meat up and then reported
        // it had not, which is how 09:43 could show three `hunt killed sheep|cow` lines with
        // `edible=0 raw meat=none`. Prove the pickup by what left the world, not by a name we may not have.
        const dName = (d.item && d.item.name) || null;
        const packsBefore = bot.inventory.items().reduce((s, i) => s + i.count, 0);
        try { await bot.pathfinder.goto(new GN(d.position.x, d.position.y, d.position.z, 0.7)); }
        catch (e) {
          // A failed goto used to be invisible, which is how "hunt killed cow" and leather=0 sat
          // side by side (198 cow kills in this log) - the bot never reported that it could not
          // reach its own drop. Brush toward it by hand instead of giving up.
          try {
            await bot.lookAt(d.position.offset(0.5, 0.2, 0.5), true);
            bot.setControlState('forward', true);
            await sleep(600);
            bot.setControlState('forward', false);
          } catch {}
          log.skill(`hunt: goto to ${dName || 'unnamed'} drop failed (${e.message.slice(0, 40)}) - walked by hand`);
        }
        await sleep(220);
        const stillThere = Object.values(bot.entities).some(x => x.id === d.id);
        const before2 = dName ? countItem(bot, dName) : bot.inventory.items().reduce((s, i) => s + i.count, 0);
        if (!stillThere || (dName ? before2 > 0 : before2 > packsBefore)) {
          log.skill(`hunt: collected ${dName || 'the drop'}${dName ? ` (have ${before2})` : ` (pack ${packsBefore} -> ${before2})`}`);
          return true;
        }
      }
      return false;
    };
    let stuck = stuckFromWater ? 1 : 0;
    for (let tries = 0; kills < (a.count || 3) && tries < 14; tries++) {
      const e = find();
      if (!e) break;
      const d = bot.entity.position.distanceTo(e.position);
      // An animal this bot has already shot twice without killing is not a shooting target any more; it
      // is a sword target. `shotOut` is what keeps the loop from re-spending arrows on it (00:57: eight
      // "giving up on shooting it" lines on one pig, 30 seconds, food still 0).
      const shotOut = ((bot._huntVolleys || {})[`${e.name}#${e.id}`] || 0) >= 2;
      if (d > 4) {
        if (!shotOut && !huntUndead && stuck >= 1 && d <= 34) {
          const shotAt = (e.position || bot.entity.position).clone();
          if (await shootAt(e)) { kills++; log.skill(`hunt: ${e.name} down to arrows at ${Math.round(d)} blocks - walking its drop`); await walkDrops(shotAt); continue; }
        }
        // A single GoalNear 85 blocks away is unroutable (pathfinder answered in 0.3s, every leg),
        // so close the distance in <=14-block waypoints; and when even a waypoint has no path,
        // chase by hand - the pathfinder is a planner, not a locomotive, and a cow across a ravine
        // was unreachable forever, which starved the run at food=9.
        const before = d;
        const chase = async (seconds) => {
          try { bot.pathfinder.stop(); } catch {}
          bot.setControlState('forward', true);
          const t0 = Date.now();
          let last = bot.entity.position.distanceTo(e.position), stagnant = 0;
          while (Date.now() - t0 < seconds * 1000) {
            if (!e.position || bot.entity.position.distanceTo(e.position) < 4) break;
            try { await bot.lookAt(e.position.offset(0, 0.4, 0)); } catch {}
            await sleep(280);
            const now = bot.entity.position.distanceTo(e.position);
            if (now > last - 0.4) { if (++stagnant >= 8) break; } else { stagnant = 0; last = now; }
            const sx = Math.sign(e.position.x - bot.entity.position.x) || 1;
            const sz = Math.sign(e.position.z - bot.entity.position.z);
            const ahead = bot.blockAt(bot.entity.position.floored().offset(sx, 0, sz));
            if (ahead && isSupport(ahead)) {
              bot.setControlState('jump', true);
              setTimeout(() => { try { bot.setControlState('jump', false); } catch {} }, 260);
            }
          }
          bot.setControlState('forward', false);
        };
        const k = Math.min(14, Math.max(6, d - 3)) / d;
        const wx = bot.entity.position.x + (e.position.x - bot.entity.position.x) * k;
        const wz = bot.entity.position.z + (e.position.z - bot.entity.position.z) * k;
        await leg(new GN(wx, e.position.y, wz, 2), 16000, 'waypoint to animal');
        let after = bot.entity.position.distanceTo(e.position);
        if (after > before - 3) {
          log.skill(`no path to the ${Math.round(k * d)}-block waypoint (${e.name} still ${Math.round(after)} away) - chasing by hand${shotOut ? ' to reach it with the sword' : ''}`);
          // A shot-out animal is worth swimming/slow-walking an extra 7 s for, because the alternative is
          // starving beside a carcass the pathfinder calls unreachable.
          await chase(shotOut ? 14 : 7);
          after = bot.entity.position.distanceTo(e.position);
        }
        stuck = after < before - 2 ? 0 : stuck + 1;
        if (stuck >= (shotOut ? 6 : 4)) return { ok: false, observation: `cannot reach ${e.name} (${Math.round(after)} blocks away after ${stuck} waypoints + hand chase${shotOut ? ', and it has already survived 2 arrow volleys so the sword was the plan' : ''}, y=${Math.round(bot.entity.position.y)}) - roam to grass land where animals are reachable instead` };
      }
      const e2 = find();
      if (!e2) break;
      if (bot.entity.position.distanceTo(e2.position) <= 4) {
        try { await bot.pathfinder.goto(new GN(e2.position.x, e2.position.y, e2.position.z, 1)); } catch {}
        const killAt = (e2.position || bot.entity.position).clone();
        try { await bot.pvp.attack(e2); kills++; log.skill(`hunt killed ${e2.name}`); } catch (err) { log.skill(`attack ${e2.name} threw ${err.message}`); }
        await walkDrops(killAt);
      }
    }
    return { ok: kills > 0, observation: `hunted ${kills}; slots=${ob.invSummary(bot).slots}` };
  },
});

// String is the one material two endgame kits hinge on and nothing in this bot's vocabulary could go
// get it on purpose: 3 string = 1 wool = the bed, and 3 string + 3 sticks = the bow. Measured 19:31:49,
// the fight went on INSIDE the End after the bow wore out (it had been at 15%), and the End has no
// spider, no tree and no sheep - so a bow is an Overworld errand, not a fight-day invention. `hunt`
// cannot do this job: it only accepts passive mobs and it bails on a bare cave because grass animals
// cannot spawn there, while spiders spawn exactly there.
reg.define('hunt_spider', {
  desc: 'Kill hostile mobs and walk onto the drop: spiders/cave_spiders for STRING (a bow needs 3, a wool 4), kind=skeleton|stray for ARROWS (works in snowy/taiga biomes without chickens), or kind=zombie|husk for ROTTEN FLESH.',
  params: { count: 'int default 4 - drop items to end up with (string, arrow when kind=skeleton, or rotten flesh when kind=zombie)', maxDistance: 'int default 40 - how far the mob has to be to count as reachable', kind: 'spider (default) | skeleton | stray | zombie | husk' },
  async run(bot, a) {
    // One loop, three payoffs: the drop name decides when to stop.
    const undead = a.kind === 'zombie' || a.kind === 'husk' || a.kind === 'drowned';
    const archer = a.kind === 'skeleton' || a.kind === 'stray';
    const dropItem = undead ? 'rotten_flesh' : (archer ? 'arrow' : 'string');
    const findRe = undead ? /zombie|husk|drowned/ : (archer ? /skeleton|stray/ : /spider/);
    const roamKinds = undead ? 'zombie,husk,drowned' : (archer ? 'skeleton,stray' : 'spider,cave_spider');
    const want = Math.max(1, Math.min(24, parseInt(a.count, 10) || 4));
    const md = Math.max(8, Math.min(80, a.maxDistance || 40));
    const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
    const find = () => {
      try {
        return bot.nearestEntity(e => e && e.name && findRe.test(e.name) && e.position
          && !(e.name === 'drowned' && e.position.y < 60)
          && bot.entity.position.distanceTo(e.position) <= md
          && Math.abs(e.position.y - bot.entity.position.y) <= 16);
      } catch { return null; }
    };
    let got = countItem(bot, dropItem);
    let kills = 0, tries = 0, noPath = 0;
    const deadline = bot._stepDeadline && bot._stepDeadline > Date.now() + 3000 ? bot._stepDeadline : Date.now() + 90000;
    while (got < want && tries++ < 8 && Date.now() < deadline) {
      let e = find();
      if (!e) {
        // Caves have these; the loaded set is what lies about that, so walk a little before giving up.
        // Constrain vertical delta so a surface bot never dives 40 blocks into a flooded cave chasing an unreachable spider.
        try { await reg.get('roam').run(bot, { look_for: roamKinds, distance: 90, arrive: 14, maxDy: 10 }); } catch {}
        e = find();
        if (!e) { noPath++; if (noPath >= 2) break; continue; }
      }
      const d = bot.entity.position.distanceTo(e.position);
      if (d > 3.5) { try { await bot.pathfinder.goto(new GN(e.position.x, e.position.y, e.position.z, 2)); } catch {} }
      const live = bot.entities[e.id] || find();
      if (!live) continue;
      if (bot.entity.position.distanceTo(live.position) > 4.5) {
        // "No route" is a pathfinder answer, not a physics one. Live 19:42:35 a zombie sat 25 blocks off
        // and every goto failed - a cave mouth, a two-block step, a corner the A* gives up on - while the
        // mob was walkable and the run was at food=5 with nothing else in the biome. Chase it by hand for
        // as long as it is on this level and its own footing is not liquid; that is the whole difference
        // between a rotten flesh drop and another starved dive.
        const dy = Math.abs(live.position.y - bot.entity.position.y);
        let foot = null;
        try { foot = bot.blockAt(live.position.floored().offset(0, -1, 0)); } catch {}
        if (dy <= 5 && !(foot && /water|lava/.test(foot.name))) {
          const d0 = bot.entity.position.distanceTo(live.position);
          try {
            await bot.lookAt(live.position.offset(0.5, 1, 0.5), true);
            bot.setControlState('forward', true);
            await sleep(2600);
            bot.setControlState('forward', false);
          } catch {}
          const still = bot.entities[e.id] || find();
          const d1 = still ? bot.entity.position.distanceTo(still.position) : 0;
          log.skill(`hunt_spider: no goto route at ${Math.round(d0)} blocks - hand-chased to ${Math.round(d1)} (${still ? '#' + still.id + ' still there' : 'target gone'})`);
          if (!still) { noPath++; continue; }   // it left the loaded set - that is not a kill
          if (d1 > 4.5) { noPath++; if (noPath >= 3) break; continue; }
          e = still;
        } else {
          log.skill(`hunt_spider: still ${Math.round(bot.entity.position.distanceTo(live.position))} blocks away after the walk - no route to this one${dy > 5 ? ` and it is ${Math.round(dy)} levels off` : ''}`);
          noPath++;
          continue;
        }
        noPath = 0;
      } else noPath = 0;
      const sword = bot.inventory.items().filter(i => /_sword$/.test(i.name))
        .sort((x, y) => (ob.wear(bot, y) ?? 0) - (ob.wear(bot, x) ?? 0))[0];
      if (sword) { try { await bot.equip(sword, 'hand'); } catch {} }
      const at = live.position.clone();
      let atkTimer = null;
      try {
        await Promise.race([
          Promise.resolve(bot.pvp.attack(live)),
          new Promise(r => { atkTimer = setTimeout(r, 20000); }),
        ]);
        kills++;
      } catch (err) { log.skill(`hunt_spider attack threw ${String(err.message).slice(0, 70)}`); }
      finally { if (atkTimer) clearTimeout(atkTimer); }
      // The drop is on the floor where it died; the bot is not standing there and mineflayer has no
      // pickup sweep, so this is the difference between "killed 3, string 0" and string.
      try { await collectNear(bot, at, archer ? ['arrow', 'bow'] : [dropItem]); } catch {}
      got = countItem(bot, dropItem);
      if (Date.now() >= deadline) break;
    }
    return {
      ok: got >= want,
      observation: got >= want
        ? `${dropItem}=${got} from ${kills} ${undead ? 'undead' : 'spider'}(s) - ${undead ? 'rotten flesh counts as edible (4 hunger), eat only above the dive reserve' : 'a bow costs 3 string + 3 sticks, a wool 4 string'}`
        : `only ${got} of ${want} ${dropItem} after ${tries} attempts and ${kills} kill(s) - ${undead
          // A kill with no drop is NOT "no undead here". A zombie rolls 0-2 rotten flesh and comes up empty
          // about a third of the time, so at 22:07:49 one kill and zero flesh produced this line's old text
          // ("this cell has none loaded") - a lie about the cell the ladder was standing in, and the next
          // round would have walked away from the corridor that had just fed it. Say which of the two
          // happened, because only one of them is a reason to move.
          ? (kills >= 1
            ? `THIS CELL HAS UNDEAD (${kills} killed here) - a zombie rolls 0-2 flesh and sometimes drops none, so the fix is more kills, not a new corridor: ask hunt_spider {kind:'zombie',count:2} again from here (each undead step is ~40 s, so two or three steps normally fills the dive ration)`
            : 'the undead need an unlit corridor: dig toward a dark passage or a cave mouth, this cell has none loaded')
          : 'spiders are a night/cave animal: this needs open ground or a lit cave, and the bed/bow cannot be crafted without it'}`,
    };
  },
});

// --- build / nether helpers ---
// A solid block whose TOP already clears the waterline, with two dry cells above it. On this Paper
// server a block may NOT replace a submerged cell (`Server refused to place cobbled_deepslate at
// (117, 61, 22): the block is still water` at 09:17, and the same refusal for cobblestone at (62,61,34)
// at 08:24), so "build a causeway" is not an answer in open water - walking onto the next dry rock is.
// Coarse by design: every 2 blocks, 24-block radius, only the y band that can be a headland, and it
// runs from failure branches, not from a hot loop.
// `radius`/`stride` are arguments because the 24-block window is what pinned the bot in the open ocean:
// the shoreline sat 90 blocks out, so every roam heading failed the dry-route guard AND the bail message
// told the ladder to "walk onto that headland" - one it had never scanned. Coarse stride keeps the cost
// down when the caller only wants a distant bearing.
function nearestHeadland (bot, radius, stride) {
  const r = Math.max(8, Math.min(64, radius || 24));
  const step = Math.max(2, stride || (r > 32 ? 4 : 2));
  const f = bot.entity.position.floored();
  const dry = (p) => { const b = bot.blockAt(p); return !b || (b.boundingBox === 'empty' && !/water|lava/.test(b.name)); };
  const rock = (b) => !!b && b.boundingBox === 'block' && !/water|lava|kelp|seagrass/.test(b.name);
  let best = null;
  for (let dx = -r; dx <= r; dx += step) {
    for (let dz = -r; dz <= r; dz += step) {
      // y=68 as well as 62-66: a beach or a rock shelf at y=67 is a landing a swimming bot can use, and
      // the old 66 ceiling made the wide scan report "no headland" for shores it could have climbed.
      for (let y = 68; y >= 62; y--) {
        const p = new Vec3(f.x + dx, y, f.z + dz);
        let b = null;
        try { b = bot.blockAt(p); } catch { b = null; }
        if (!rock(b)) continue;
        if (!dry(p.offset(0, 1, 0)) || !dry(p.offset(0, 2, 0))) continue;
        const d = Math.round(Math.hypot(dx, dz));
        if (!best || d < best.d) best = { x: p.x, y: y + 1, z: p.z, d };
        break;
      }
    }
  }
  return best;
}

// Where is the nearest ground that can hold a herd, a kelp bed's shore, or a village? One biome read per
// column on a coarse lattice - not a volume scan - so a 280-block look-ahead costs a few thousand blockAt
// calls and only runs from roam's stuck branch and from the village hunt, never from a hot loop.
// Villages score as half their distance: a plains patch 200 out beats a beach 60 out, a beach 60 out
// still beats a plains patch 300 out.
const VILLAGE_BIOME = /^(snowy_|sunflower_)?(plains|meadow|taiga|savanna|desert|badlands|mesa)/;
function nearestLandPatch (bot, opts) {
  const o = opts || {};
  const reach = Math.max(32, Math.min(280, o.reach || 200));
  const stride = Math.max(6, o.stride || 10);
  const f = bot.entity.position.floored();
  const solid = (b) => !!b && b.boundingBox === 'block' && !/lava|water|kelp|seagrass/.test(b.name);
  const air = (b) => !b || (b.boundingBox === 'empty' && !/water|lava/.test(b.name));
  let best = null;
  for (let dx = -reach; dx <= reach; dx += stride) {
    for (let dz = -reach; dz <= reach; dz += stride) {
      const d = Math.round(Math.hypot(dx, dz));
      if (d > reach || d < stride) continue;
      const x = f.x + dx, z = f.z + dz;
      // Cheap reject for the common case, which is the open ocean column: air at the sea surface line and
      // water one below it is a swimming lane, not a landing, and it saves 17 block reads on almost every
      // lattice point when the bot is in the middle of a basin.
      let surf = null;
      try { surf = bot.blockAt(new Vec3(x, 64, z)); } catch { continue; }
      if (surf && (surf.name === 'air' || surf.name === 'cave_air')) {
        let w = null;
        try { w = bot.blockAt(new Vec3(x, 63, z)); } catch {}
        if (w && w.name === 'water') continue;
      }
      let patch = null;
      // Step 1, not 2: a coarse vertical stride misses every surface on the wrong parity, and a plains
      // shelf at y=65 with the scan on 84,82,...,64 reports "no land" for the land it is standing next to.
      for (let y = 78; y >= 62 && !patch; y--) {
        let q = null;
        try { q = bot.blockAt(new Vec3(x, y, z)); } catch { continue; }
        if (!q) continue;                                   // chunk not loaded: nothing to aim at yet
        if (!solid(q)) continue;
        if (!air(bot.blockAt(new Vec3(x, y + 1, z))) || !air(bot.blockAt(new Vec3(x, y + 2, z)))) continue;
        patch = { x, y: y + 1, z };
      }
      if (!patch) continue;
      // `block.biome.name` is NOT reliable here: prismarine-block builds the Biome through a registry
      // lookup that falls back to `{ ...emptyBiome, id }` (name ''), and the live run printed `(?)` for
      // every patch while my stub printed 'plains' - so the village preference was reading as "no biome
      // anywhere" and silently degraded to "nearest dirt". The numeric id survives the fallback, so map
      // it through minecraft-data when the name is missing.
      let biome = '';
      try {
        const bb = bot.blockAt(new Vec3(patch.x, patch.y - 1, patch.z));
        const bio = bb && bb.biome;
        biome = (bio && bio.name) || '';
        if (!biome && bio && typeof bio.id === 'number') { const bd = data(bot).biomes[bio.id]; biome = (bd && bd.name) || ''; }
      } catch {}
      const village = VILLAGE_BIOME.test(biome);
      if (o.villageOnly && !village) continue;
      const score = village ? d * 0.5 : d;
      if (!best || score < best.score) best = { x: patch.x, y: patch.y, z: patch.z, d, biome, village, score };
    }
  }
  return best;
}

// The End door, but only while it is the thing the run is working toward. `portalRecord` is the no-TTL
// record enter_end walks back to, and `ringComplete` is the only honest read of "the door is open"
// (the eye count in the pack says nothing). Returns null for every earlier stage, so the leash cannot
// hijack a run that is still mining.
function diveAnchor(bot) {
  try {
    const ph = String(bot._loopPhase || '');
    if (!/food|enter_end|kill_dragon/.test(ph)) return null;
    const rec = require('../portalRecord').current();
    if (!rec || !rec.ringComplete || !Number.isFinite(rec.x)) return null;
    return { x: rec.x, z: rec.z };
  } catch { return null; }
}

reg.define('roam', {
  desc: 'Travel a long distance in pathfinder legs, stopping as soon as something you want (animals, a biome block, the player) is loaded nearby. Use when the current spot simply does not contain the material - e.g. no chickens on a beach but feathers are needed for arrows.',
  params: { look_for: 'entity names, default cow,pig,sheep,chicken', block: 'optional block name to search for instead', distance: 'int default 240', arrive: 'int default 22 - how close to an entity counts as "reached" (roam walks toward it instead of stopping at first sight)', dir: 'N|S|E|W, default a new random heading each 5 legs' },
  async run(bot, a) {
    const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
    const arrive = Math.max(6, Math.min(60, parseInt(a.arrive, 10) || 22));
    // `block` means "I am looking for THAT": answering as soon as an unrelated cow wanders into
    // view made roam quit 26 blocks into a 240-block lava search. Entities only count when the
    // caller asked for them.
    const wantsEntities = !!a.look_for;
    const names = wantsEntities ? String(a.look_for).split(',').map(s => s.trim()).filter(Boolean) : [];
    const wantBlock = a.block ? blockIds(bot, String(a.block).split(',').map(s => s.trim())) : null;
    const DIRS = { N: [0, -1], S: [0, 1], E: [1, 0], W: [-1, 0] };
    const total = Math.max(48, Math.min(600, parseInt(a.distance, 10) || 240));
    const start = bot.entity.position.floored();
    let [dx, dz] = DIRS[String(a.dir).toUpperCase()] || DIRS[['N', 'S', 'E', 'W'][Math.floor(Math.random() * 4)]];
    let walked = 0, legs = 0, turned = 0, stuckLegs = 0, waterTurns = 0, bridgesTried = 0, digsTried = 0;
    // Animals seen to be unreachable are dropped for the rest of this call. Six `roam approach`
    // attempts in two minutes all targeted the SAME cow on the far side of a lake: the bot has 110
    // blocks of eyesight but pathfinder will not cross open water, so re-picking it burned the whole
    // food milestone while the real target was, in the bot's own words, "not food".
    const bad = new Set();
    let badTarget = null, badTries = 0;
    const maxDy = Math.max(4, Math.min(48, parseInt(a.maxDy, 10) || 14));
    const spot = () => {
      const e = bot.nearestEntity(en => names.includes(en.name) && en.position
        && !bad.has(en.id)
        && Math.abs(en.position.y - bot.entity.position.y) <= maxDy
        && bot.entity.position.distanceTo(en.position) < 110);
      if (e) return { kind: 'entity', id: e.id, name: e.name, at: e.position.floored() };
      if (wantBlock) {
        // A block search that matches the cell under the bot's own feet reports "arrived" without moving
        // an inch: measured 06:48:26, `roam said (block netherrack at -53,42,209 after walking ~0 blocks
        // from -53,43,209)` - the target was the block it was standing on. Require the match to be at
        // least `arrive` away, or there is nothing to travel to.
        // The cheap single match first, and the wide scan only when it is too close: `spot()` runs once
        // per leg, and `findBlocks` walks the loaded chunk map synchronously, so doing it 40 times a call
        // is how keep-alive timeouts get manufactured (see findFrameSite's radius note).
        try {
          const b = bot.findBlock({ matching: wantBlock, maxDistance: 48 });
          if (b && bot.entity.position.distanceTo(b.position) >= arrive) return { kind: 'block', name: b.name, at: b.position };
          if (b) {
            const far = bot.findBlocks({ matching: wantBlock, maxDistance: 48, count: 16 })
              .filter(q => bot.entity.position.distanceTo(q) >= arrive)
              .sort((p, q) => bot.entity.position.distanceTo(p) - bot.entity.position.distanceTo(q));
            if (far.length) return { kind: 'block', name: (bot.blockAt(far[0]) || {}).name || b.name, at: far[0] };
          }
        } catch {}
      }
      return null;
    };
    // Two bail points below ask the same question - "is there dry ground I can actually swim to?" - so the
    // answer lives here. It reports the displacement it really got, so `walked` keeps meaning travel.
    // Why this exists: the bot starved at food=0 for 30 min at -300,64,1666 while the dry-route guard
    // refused every heading with "open water between, turning aside" - a rule written for a bot standing
    // on the shore, which from inside the ocean is an instruction to stay exactly where it is.
    let swimStuck = 0;
    const wetFeetNow = () => {
      const q = bot.entity.position.floored();
      const a = (bot.blockAt(q) || {}).name || '';
      const h = (bot.blockAt(q.offset(0, 1, 0)) || {}).name || '';
      return /water|kelp_plant|seagrass/.test(a) || /water/.test(h);
    };
    const swimToShore = async (why) => {
      const land = nearestHeadland(bot, 48, 4) || nearestLandPatch(bot, { reach: 200 });
      if (!land) {
        const f2 = bot.entity.position.floored();
        return { moved: 0, dead: `no dry standing ground within 48 blocks and no land biome within 200 of ${f2.x},${f2.y},${f2.z} - this is open ocean: the meal has to come from a kelp bed (harvest_kelp), a village (raid_village) or a boat, not from another roam` };
      }
      const b0 = bot.entity.position.clone();
      log.skill(`roam: ${why} - swimming to dry ground at ${land.x},${land.y},${land.z} (${land.d} blocks${land.biome ? `, biome=${land.biome}` : ''})`);
      // Surface first, then swim: a leg started at 30% air is the leg the planner kills mid-crossing, and
      // the killed step throws away the whole shore approach.
      await breathe(bot, 'roam swim to shore');
      await capped(bot.pathfinder.goto(new GN(land.x, land.y, land.z, 3)), 26000, 'roam swim to shore', () => { try { bot.pathfinder.stop(); } catch {} });
      await sleep(400);
      const b1 = bot.entity.position.floored();
      const stillWet = (() => { const hb = bot.blockAt(b1.offset(0, 1, 0)); return !!hb && /water/.test(hb.name); })();
      if (stillWet) await breathe(bot, 'roam swim to shore (after leg)');
      const moved = Math.round(Math.hypot(bot.entity.position.x - b0.x, bot.entity.position.z - b0.z));
      if (moved < 3) {
        swimStuck++;
        if (swimStuck >= 3) return { moved, dead: `${swimStuck} swim attempts toward ${land.x},${land.y},${land.z} moved ${moved} blocks from ${b0.x.toFixed(0)},${b0.y.toFixed(0)},${b0.z.toFixed(0)} - pathfinder will not give a water route here; the cell needs dry_escape or a new region` };
      } else swimStuck = 0;
      return { moved };
    };
    // The lease clock, not just a leg count: 40 legs x a 26 s timeout is 17 minutes, far past any step
    // cap, so when the planner evicted this roam the abandoned worker kept issuing gotos and every one
    // of them came back `orphan step: goto refused - the hand belongs to the live step` (measured
    // 18:24:40, while the bot swung between -40,60,131 and 71,60,121 without settling on a heading).
    // Third instance of the same class tonight - see tools/lease_audit.js.
    while (walked < total && legs++ < 40 && Date.now() < (bot._stepDeadline || Infinity)) {
      const found = spot();
      if (found) {
        if (found.kind === 'block') return { ok: true, observation: `${found.kind} ${found.name} at ${found.at.x},${found.at.y},${found.at.z} after walking ~${walked} blocks from ${start.x},${start.y},${start.z}` };
        const fd = bot.entity.position.distanceTo(found.at);
        // "Found it" is not "got to it": roam used to return the moment a cow appeared 90 blocks
        // away, then hunt rejected that same cow as unreachable and the pair ping-ponged forever.
        if (fd <= arrive) return { ok: true, observation: `reached ${found.name} at ${found.at.x},${found.at.y},${found.at.z} (${Math.round(fd)} blocks) after walking ~${walked} blocks` };
        const kk = 18 / fd;
        const ax = bot.entity.position.x + (found.at.x - bot.entity.position.x) * kk;
        const az = bot.entity.position.z + (found.at.z - bot.entity.position.z) * kk;
        const b0 = bot.entity.position.clone();
        await capped(bot.pathfinder.goto(new GN(ax, found.at.y, az, 3)), 20000, 'roam approach', () => { try { bot.pathfinder.stop(); } catch {} });
        await sleep(400);
        // same accounting as the leg branch: an animal on the far side of a lake is visible but not
        // path-reachable, and crediting the nominal 18 blocks each try let roam "approach" forever.
        const mdA = Math.hypot(bot.entity.position.x - b0.x, bot.entity.position.z - b0.z);
        walked += Math.max(0, Math.min(18, Math.round(mdA)));
        if (mdA < 3) {
          stuckLegs++;
          badTries = badTarget === found.id ? badTries + 1 : 1;
          badTarget = found.id;
          if (badTries >= 2) {
            bad.add(found.id); badTries = 0;
            log.skill(`roam: ${found.name} #${found.id} is not path-reachable from here - ignoring it, continuing the search`);
          }
          if (stuckLegs >= 4) {
            const f = bot.entity.position.floored();
            return { ok: false, observation: `spotted ${found.name} ${Math.round(bot.entity.position.distanceTo(found.at))} blocks away but ${stuckLegs} approach tries moved <3 blocks from ${f.x},${f.y},${f.z} - the ground between is not path-reachable (water/cliff); roam a different direction or surface first` };
          }
        } else stuckLegs = 0;
        continue;
      }
      const before = bot.entity.position.clone();
      // Homeward leash. Once the End door is open, the run must not drift hundreds of blocks from it
      // chasing a meal: live 18:20:40 had roam 436 blocks east of the portal column on the `food` stage,
      // and every such drift re-pays the 40-block descent plus the dive gate. Inside the leash roam
      // wanders freely; outside it the heading points at the door and the leg maths re-anchors here so
      // the goal is measured from where the bot actually stands, not from the far side of the map.
      const door = diveAnchor(bot);
      const out = door ? Math.hypot(bot.entity.position.x - door.x, bot.entity.position.z - door.z) : 0;
      // 160 was too loose to protect the approach: live 22:09-22:12 a dressed bot (chestplate+leggings,
      // 2 of the 3 edible items the dive gate wants) stood 2 blocks from the open portal, went out for the
      // last one, and came back up at (-333,68,1499) - 117 blocks west of the door, inside the old leash,
      // where roam wanders freely. Sixty blocks is a real meal search and still under an hour of walking.
      const leashed = !!door && out > 60;
      if (!a.dir && (legs % 5 === 0 || leashed)) {
        if (leashed) {
          const ax = door.x - bot.entity.position.x, az = door.z - bot.entity.position.z;
          [dx, dz] = Math.abs(ax) >= Math.abs(az) ? (ax >= 0 ? DIRS.E : DIRS.W) : (az >= 0 ? DIRS.S : DIRS.N);
          const f2 = bot.entity.position.floored();
          start.x = f2.x; start.z = f2.z; walked = 0;
          log.skill(`roam: ${Math.round(out)} blocks from the open End portal at ${door.x},${door.z} - leash points the heading home`);
        } else { [dx, dz] = DIRS[['N', 'S', 'E', 'W'][Math.floor(Math.random() * 4)]]; }
        turned++;
      }
      const L = 26;
      const gx = start.x + dx * (walked + L), gz = start.z + dz * (walked + L);
      // Aim at the GROUND of the goal column, searched over a wide vertical window. The old ±4 scan
      // was the whole reason roam stopped moving: on a mountain the ground 26 blocks away is 10-20
      // blocks lower, so the goal landed inside the hillside (or in mid-air over a cliff) and
      // pathfinder answered "Took to long to decide path to goal!" for every leg, 3-4 in a row, while
      // the bot stood on the plateau at y=78 starving next to no loaded animals.
      let gy = null;
      for (let dy = 8; dy >= -24 && gy === null; dy--) {
        const bl = bot.blockAt(new Vec3(gx, start.y + dy, gz));
        if (!bl || !isSupport(bl)) continue;
        // Accept only a DRY, EMPTY standing cell. `isSupport` is true for a sea-floor block two layers
        // under water, and the first version of this scan walked the bot 176 blocks into an ocean bed at
        // y=62 (repeated "submerged ... movement policy paused") while it was looking for cows. Checking
        // only for LIQUID above the support left the second half of that hole open: with the sand floor at
        // 58 the scan happily "stood" the bot at 58, which is the sand itself - so every ocean column
        // reported a dry goal, the leg failed in the water, and the swim branch below never ran.
        const above = bot.blockAt(new Vec3(gx, start.y + dy + 1, gz));
        if (above && (!isAir(above.name) || /water|kelp_plant|seagrass|lava/.test(above.name))) continue;
        gy = start.y + dy + 1;
      }
      if (gy === null) {
        // Nothing dry in that column: on land it is a cliff face or open sky, so pick a new heading
        // rather than burning another 26 s on an unreachable goal. In the water it is the sea floor ahead,
        // which is the normal shape of "swim to shore" - so swim instead of turning.
        if (wetFeetNow()) {
          const s = await swimToShore('no dry goal column and the feet are already wet');
          walked += s.moved;
          if (s.dead) return { ok: false, observation: s.dead };
          continue;
        }
        [dx, dz] = DIRS[['N', 'S', 'E', 'W'][Math.floor(Math.random() * 4)]];
        turned++;
        continue;
      }
      // A dry GOAL column is not a dry ROUTE. At 09:25 the bot burned leg after leg whose endpoint was
      // on dry rock while the path walked straight through the bay: `submerged at 71,62,126 - movement
      // policy paused` ... `resumed (standing dry) after 1s` ... again, each time costing the full 26 s
      // timeout, which is how the food milestone kept timing out at a shoreline with land in sight.
      // Sample the column at 40% and 75% of the leg and refuse the heading if neither band has a dry
      // standing cell - quarter-turn instead of wading in.
      if (Math.abs(start.y - 62) <= 4) {
        let crossed = null;
        for (const frac of [0.4, 0.75]) {
          const mx = Math.round(bot.entity.position.x + (gx - bot.entity.position.x) * frac);
          const mz = Math.round(bot.entity.position.z + (gz - bot.entity.position.z) * frac);
          let dryMid = false;
          for (let dy = 6; dy >= -6 && !dryMid; dy--) {
            const bl = bot.blockAt(new Vec3(mx, start.y + dy, mz));
            if (!bl || !isSupport(bl)) continue;
            const ab = bot.blockAt(new Vec3(mx, start.y + dy + 1, mz));
            if (ab && /water|kelp_plant|seagrass|lava/.test(ab.name)) continue;
            dryMid = true;
          }
          if (!dryMid) { crossed = `${mx},${mz}`; break; }
        }
        if (crossed) {
          // From the shore, refusing a water route is right. From inside the ocean it is a freeze: the
          // guard fires on every heading, the bot turns four times, and the verdict tells it to walk onto
          // a headland its own 24-block scan never covered. So if the feet are already wet, swim.
          if (wetFeetNow()) {
            const s = await swimToShore(`heading to ${gx},${gz} crosses open water at ${crossed}`);
            walked += s.moved;
            if (s.dead) return { ok: false, observation: s.dead };
            continue;
          }
          if (++waterTurns >= 4) {
            const f2 = bot.entity.position.floored();
            const land = nearestHeadland(bot, 48, 4);
            return { ok: false, observation: land
              ? `all ${waterTurns} headings from ${f2.x},${f2.y},${f2.z} cross open water, but dry standing rock is at ${land.x},${land.y},${land.z} (${land.d} blocks) - walk onto that (walk_to / goto), do not roam and do not try to build a causeway: this server will not let a block replace a submerged cell`
              : `all ${waterTurns} headings from ${f2.x},${f2.y},${f2.z} cross open water and no rock with its top above y=62 within 24 blocks - this tile cannot be roamed out of; it needs a swim or recover_surface toward the mainland` };
          }
          [dx, dz] = [dz, -dx];
          turned++;
          log.skill(`roam: heading to ${gx},${gz} has no dry ground at ${crossed} - open water between, turning aside instead of wading in`);
          continue;
        }
        waterTurns = 0;
      }
      await capped(bot.pathfinder.goto(new GN(gx, gy, gz, 4)), 26000, 'roam leg', () => { try { bot.pathfinder.stop(); } catch {} });
      await sleep(400);
      // Credit REAL displacement. `walked += L` used to run unconditionally, so a bot pinned in a
      // riverbed at y=58 (pathfinder cannot route through water) reported 26 blocks per leg while not
      // moving, aimed each next leg further away, and burned ~17 minutes "roaming" for food without
      // travelling an inch - which is exactly the stall that held the ladder at 16/23 here.
      const md = Math.hypot(bot.entity.position.x - before.x, bot.entity.position.z - before.z);
      walked += Math.max(0, Math.min(L, Math.round(md)));
      if (md < 3) {
        stuckLegs++;
        if (stuckLegs >= 3) {
          const f = bot.entity.position.floored();
          const wet = ['water', 'kelp_plant', 'seagrass'].includes((bot.blockAt(f) || {}).name)
            || ['water', 'kelp_plant', 'seagrass'].includes((bot.blockAt(f.offset(0, 1, 0)) || {}).name);
          // The verdict said "dig out sideways"; here is the doing. A dry ledge is exactly the case the
          // pathfinder refuses (it will not route an unsafe drop) and the one a player solves by laying a
          // block - which the pack almost always has. Bounded to two attempts per roam so a bridge that
          // lands but is not walkable cannot loop here.
          if (!wet && bridgesTried < 2) {
            bridgesTried++;
            const bo = await bridgeOut(bot);
            if (bo.ok) { log.warn(`roam: ${f.x},${f.y},${f.z} was a ledge - ${bo.moved}; continuing the roam`); stuckLegs = 0; continue; }
            // Sideways is exhausted, so take the other direction. Gated to the Nether on purpose: digging
            // down is how you reach a fortress and how you leave a narrow netherrack corridor, and it is
            // also how you fall into an ocean ravine at y=60 in the Overworld.
            let downObs = 'not attempted (only the Nether digs down as an escape)';
            if ((bot.game && bot.game.dimension === 'the_nether') && digsTried < 2 && digDownAllowed(bot).ok) {
              digsTried++;
              const before2 = bot.entity.position.floored();
              const dg = await reg.get('dig_to_y').run(bot, { toY: before2.y - 6, max: 6 }).catch(e => ({ ok: false, observation: `threw ${e.message}` }));
              const after3 = bot.entity.position.floored();
              const dropped = Math.abs(after3.y - before2.y) + Math.abs(after3.x - before2.x) + Math.abs(after3.z - before2.z);
              downObs = String(dg.observation);
              log.warn(`roam: dig-down escape -> ${downObs.slice(0, 130)} (moved ${dropped} cells, now ${after3.x},${after3.y},${after3.z})`);
              if (dropped >= 3) { stuckLegs = 0; continue; }
            } else if (bot.game && bot.game.dimension === 'the_nether') {
              downObs = `refused: ${(digDownAllowed(bot).why || 'budget spent in this chunk')}`;
            }
            // The third direction, and the one this cell usually still has. `dig DOWN a shaft or
            // recover_surface` was advice the bot could not always take: at -53,3,211 the depth guard
            // (rightly) refused to sink below the Nether floor and the sides were lava, so roam returned a
            // recommendation with no executable move behind it - and the caller retried it for 40 minutes.
            const u1 = bot.entity.position.floored();
            let upObs = 'not attempted';
            try { upObs = String((await reg.get('pillar_up').run(bot, { up: 10 })).observation); } catch (e) { upObs = `threw ${e.message}`; }
            const u2 = bot.entity.position.floored();
            if (Math.abs(u2.y - u1.y) >= 2) {
              log.warn(`roam: ${f.x},${f.y},${f.z} had no lateral route - pillar_up gained ${u2.y - u1.y} cells, continuing the roam from ${u2.x},${u2.y},${u2.z}`);
              stuckLegs = 0; bridgesTried = 0; digsTried = 0; continue;
            }
            return { ok: false, observation: `pinned at ${f.x},${f.y},${f.z} - ${stuckLegs} legs in a row moved <3 blocks. All three directions failed: sideways (${bo.why}), down (${downObs.slice(0, 110)}), up (${upObs.slice(0, 140)}). This cell has no route out that a bot can build; it needs a teleport-level recovery (recover_surface), not another roam` };
          }
          return { ok: false, observation: `pinned at ${f.x},${f.y},${f.z} - ${stuckLegs} legs in a row moved <3 blocks${wet ? ' and the bot is STANDING IN WATER (pathfinder will not route through it)' : ''}. Do not roam from here: climb to dry ground above y=62 (dry_escape / recover_surface) or dig out sideways first` };
        }
      } else stuckLegs = 0;
    }
    const now = spot();
    return { ok: !!now, observation: now ? `${now.kind} ${now.name} in range after ~${walked} blocks` : `walked ~${walked} blocks from ${start.x},${start.z} (turned ${turned}x) and still found no ${names.join('/')}${wantBlock ? ' or ' + a.block : ''}` };
  },
});
reg.define('place', {
  desc: 'Place `count` of an item against nearby ground (for pillars/walls).',
  params: { item: 'block item name', count: 'int default 1' },
  async run(bot, a) {
    const it = bot.inventory.items().find(i => i.name === a.item);
    if (!it) return { ok: false, observation: 'missing ' + a.item };
    await bot.equip(it, 'hand');
    // The old three hardcoded y-1 cells, each clicked on its TOP face, have nothing to say to a bot
    // standing on its own one-cell causeway: its support is at `floor`, and the cell it needs is BESIDE
    // that support at the same level - clicking a top face there would fill the cell the bot occupies,
    // which the server refuses. Enumerate (reference, face) pairs whose destination is empty and outside
    // the bot, and prefer a destination that is a walkable floor at stand height.
    const { p, floor, standY } = standCells(bot);
    const emptyAt = (q) => {
      try { const b = bot.blockAt(q); return !!b && (b.boundingBox !== 'block' || /lava|water/.test(b.name)); } catch { return false; }
    };
    const inside = (q) => (q.x === p.x && q.z === p.z && (q.y === p.y || q.y === p.y + 1));
    const pairs = [];
    for (const rq of [floor, floor.offset(1, 0, 0), floor.offset(-1, 0, 0), floor.offset(0, 0, 1), floor.offset(0, 0, -1),
      floor.offset(0, -1, 0), floor.offset(1, -1, 0), floor.offset(-1, -1, 0), floor.offset(0, -1, 1), floor.offset(0, -1, -1)]) {
      const rb = firstPhysical(bot, [rq]);
      if (!rb) continue;
      for (const [fx, fy, fz] of [[0, 1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
        const dq = rb.position.offset(fx, fy, fz);
        if (inside(dq) || !emptyAt(dq)) continue;
        // Water is not replaceable here (measured repeatedly: `the block is still water` for granite,
        // andesite and diorite at -227,62,1444, 10:19:23-24). Only lava takes a block. Refusing here saves a
        // placed-and-refused round trip on every dry_escape in an ocean.
        try { const wb = bot.blockAt(dq); if (wb && /water/.test(wb.name)) { if (!bot._waterPlaceNoted) { bot._waterPlaceNoted = true; log.skill('place: skipping water cells - this server only lets a block replace lava'); } continue; } } catch {}
        if (bot.entity.position.distanceTo(new Vec3(dq.x + 0.5, dq.y + 0.5, dq.z + 0.5)) > 4.5) continue;
        pairs.push({ ref: rb, face: new Vec3(fx, fy, fz), rank: (fy === 1 && dq.y === standY) ? 0 : 1 });
      }
    }
    pairs.sort((x, y) => x.rank - y.rank);
    if (!pairs.length) return { ok: false, observation: `no empty cell to place ${a.item} against around ${p.x},${p.y},${p.z} (support ${floor.x},${floor.y},${floor.z}, stand height ${standY})` };
    let placed = 0;
    for (let i = 0; i < (a.count || 1); i++) {
      let done = false;
      for (const pr of pairs) { try { await bot.placeBlock(pr.ref, pr.face); done = true; break; } catch {} }
      if (!done) break;
      placed++;
    }
    return { ok: placed > 0, observation: `placed ${placed} ${a.item}` };
  },
});

// ============ helpers ============
function nearestPlayer(bot) {
  let best = null, bd = 1e9;
  for (const p of Object.values(bot.players)) {
    if (!p.entity || p.username === bot.username) continue;
    const d = bot.entity.position.distanceTo(p.entity.position);
    if (d < bd) { bd = d; best = p.entity; }
  }
  return best;
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function digTree(bot, logBlock) {
  // break the trunk from bottom up
  const d = data(bot);
  const logIds = blockIds(bot, LOG_NAMES);
  let b = logBlock, broke = 0, err = '';
  for (let i = 0; i < 8 && b && logIds.includes(b.type); i++) {
    try {
      await equipBestToolFor(bot, b);
      await bot.dig(b);
      broke++;
      b = bot.blockAt(b.position.offset(0, 1, 0));
    } catch (e) {
      // This `catch {}` was silent for a whole evening. 19:28:48: `a trunk WAS in reach and nothing
      // landed in the pack` - and nothing in the log said whether the walk, the equip or the dig failed,
      // so the wood chain (sticks -> stone pick -> the diamond pick's survival -> obsidian) could not be
      // diagnosed. Name the block, the cell, the count and the error.
      err = String((e && e.message) || e).slice(0, 70);
      const at = b && b.position ? `${b.position.x},${b.position.y},${b.position.z}` : '?';
      log.warn(`digTree: stopped after ${broke} log block(s) at ${at}${b ? ` (${b.name})` : ''} - ${err}`);
      break;
    }
  }
  // collect dropped items around
  await collectDrops(bot, 6);
  return { broke, err };
}

async function collectDrops(bot, r) {
  const items = bot.entities.filter ? null : null;
  try {
    const drops = Object.values(bot.entities).filter(e => e.name === 'item' && bot.entity.position.distanceTo(e.position) <= (r || 5));
    if (drops.length) {
      const { GoalNear } = require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals;
      for (const d of drops) { try { await bot.pathfinder.goto(new GoalNear(d.position.x, d.position.y, d.position.z, 1)); } catch {} }
    }
  } catch {}
}

// Once per (tool class, block) per process: the pack either holds the class or it does not, and repeating
// the same "there is no shovel" line 40 times an hour is noise that buries the lines that move.
const noToolWarned = new Set();
async function equipBestToolFor(bot, block) {
  // Bounded, and the hand is verified afterwards. A 1.21 `set_slot` ack that never arrives used to hang
  // the whole step right here: at 05:40:30 the obsidian round logged `mine: heading to iron_ore at
  // 70,37,33 (try 5)` and then produced NOTHING for 8.5 minutes with the position frozen at y=50 - this
  // await was the only thing outstanding, and the step's own 25-minute budget had to expire before the
  // loop could move again. "the await returned" and "the tool is in the hand" are two facts (§26v).
  const bounded = async (what, p, ms) => {
    let acked = false;
    await Promise.race([
      Promise.resolve(p).then(() => { acked = true; }, e => { acked = true; log.warn(`equipBestToolFor: ${what} threw ${String(e && e.message || e).slice(0, 80)}`); }),
      sleep(ms || 6000).then(() => { if (!acked) log.warn(`equipBestToolFor: ${what} never acked past ${Math.round((ms || 6000) / 1000)}s - continuing with whatever the hand holds`); }),
    ]);
  };
  const wantTool = blockHarvestTool(bot, block);
  const handIsRight = () => !!(bot.heldItem && bot.heldItem.name.endsWith('_' + wantTool));
  // Bail when the pack holds no tool of the class this block wants. Every path below that case can only
  // churn: mineflayer-tool's equipForBlock walks the inventory and holds each stack up in turn, so at
  // 18:29:07-18:29:17 digging soul_sand produced four `equipForBlock left the hand on netherrack /
  // crafting_table, need a shovel - falling back to the pack` in ten seconds, with no shovel in the pack
  // and no way to make one there (1 plank, 5 sticks, and planks need a tree, which the Nether has none of).
  // Hand-digging is still allowed - it is just slow - so this returns quietly after saying it once.
  if (wantTool && wantTool !== 'hand') {
    let hasClass = true;
    try { hasClass = bot.inventory.items().some(i => i.name.endsWith('_' + wantTool)); } catch { hasClass = true; }
    if (!hasClass) {
      const key = wantTool + ':' + block.name;
      if (!noToolWarned.has(key)) {
        noToolWarned.add(key);
        log.warn(`equipBestToolFor: no ${wantTool} in the pack for ${block.name} - hand-digging it, and not repeating this line`);
      }
      return;
    }
  }
  // The user's rule, stated 05:05 on 2026-10-31: 钻石镐优先挖掘黑曜石，不是黑曜石就先用铁镐.
  // It has to be enforced HERE because mineflayer-tool's `equipForBlock` optimises for SPEED, not for
  // conservation: it equips the diamond pick to grind ordinary stone and deepslate, and that is how the
  // last three picks died (measured 32% -> 24% -> 21% -> gone, all of it inside phases that never needed
  // the tier), leaving the obsidian chain without the only tool that drops it.
  // The allowed set comes from the block's own `harvestTools` item ids - guessing a `toolTier` field name
  // returned 'hand' for obsidian and would have handed it the iron pick (caught by
  // tools/pick_tier_selftest.js case 2). Order = iron first, then the cheaper rock picks, with
  // diamond/netherite LAST so they appear only when nothing else in the pack can harvest the block.
  const PICK_ORDER = ['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];
  if (wantTool === 'pickaxe') {
    let allowed = null;
    try {
      const b = data(bot).blocks[block.type];
      if (b && b.harvestTools) allowed = new Set(Object.keys(b.harvestTools).map(Number));
    } catch { /* unknown block: let the general picker decide */ }
    if (allowed) {
      const digs = (i) => (i.maxDurability ? i.maxDurability - (i.durabilityUsed || 0) : 999);
      const can = (i) => { const id = itemId(bot, i.name); return id !== undefined && allowed.has(id); };
      const needsDiamond = /^(obsidian|crying_obsidian|respawn_anchor|ancient_debris)$/.test(block.name || '');
      const diamondFallbackOk = needsDiamond || /^(diamond_ore|deepslate_diamond_ore|gold_ore|deepslate_gold_ore|redstone_ore|deepslate_redstone_ore|emerald_ore|deepslate_emerald_ore)$/.test(block.name || '');
      const cands = bot.inventory.items()
        .filter(i => /_pickaxe$/.test(i.name) && can(i) && digs(i) >= 8
          && (diamondFallbackOk || !/^(diamond|netherite)_pickaxe$/.test(i.name)))
        .sort((a, b) => (PICK_ORDER.indexOf(a.name) - PICK_ORDER.indexOf(b.name)) || (digs(b) - digs(a)));
      for (const t of cands) {
        await bounded(`equip ${t.name}`, bot.equip(t, 'hand'), 6000);
        for (let q = 0; q < 6 && !handIsRight(); q++) await sleep(250);
        if (!handIsRight()) continue;
        if (/diamond|netherite/.test(t.name) && cands.some(i => !/diamond|netherite/.test(i.name))) {
          log.warn(`equipBestToolFor: cut ${block.name} with ${t.name}@${digs(t)} digs left - no cheaper pick in the pack could harvest it`);
        } else if (/_pickaxe$/.test(t.name) && bot.inventory.items().some(i => /diamond_pickaxe|netherite_pickaxe/.test(i.name))) {
          log.skill(`equipBestToolFor: ${block.name} -> ${t.name}@${digs(t)} digs left, diamond pick stays reserved for obsidian`);
        }
        return;
      }
      // If no non-diamond pick has >=8 digs for ordinary rock, try quick-minting a stone/iron pick
      // right here (throttled) instead of either burning the obsidian diamond_pickaxe or hand-digging stone!
      if (!needsDiamond && cands.length === 0 && (block.hardness || 0) >= 1.2) {
        const nowMs = Date.now();
        if (!bot._quickPickAt || nowMs - bot._quickPickAt > 15000) {
          const cob = countItem(bot, 'cobblestone') + countItem(bot, 'cobbled_deepslate') + countItem(bot, 'blackstone');
          const hasTable = countItem(bot, 'crafting_table') > 0 || !!bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 5 });
          if (hasTable && countItem(bot, 'stick') >= 2 && (countItem(bot, 'iron_ingot') >= 3 || cob >= 3)) {
            bot._quickPickAt = nowMs;
            const targetPick = countItem(bot, 'iron_ingot') >= 3 ? 'iron_pickaxe' : 'stone_pickaxe';
            try {
              const cr = await craft(bot, targetPick, 1);
              log.skill(`equipBestToolFor: auto-crafted ${targetPick} before digging ${block.name} -> ${cr.ok ? 'ok' : 'failed'}`);
              const fresh = bot.inventory.items().find(i => i.name === targetPick && digs(i) >= 8);
              if (fresh) {
                await bounded(`equip ${fresh.name}`, bot.equip(fresh, 'hand'), 6000);
                if (handIsRight()) return;
              }
            } catch {}
          }
        }
      }
      const hardOnly = cands.length === 0 && bot.inventory.items().some(i => /_pickaxe$/.test(i.name));
      if (hardOnly) log.warn(`equipBestToolFor: ${block.name} allows only [${[...allowed].map(id => (data(bot).items[id] || {}).name).filter(Boolean).join(',')}] and no non-reserved pick in the pack has 8 digs left (held=${bot.heldItem ? bot.heldItem.name : 'nothing'})`);
      // Never fall through to mineflayer-tool/diamond_pickaxe for ordinary stone when conserving diamond_pickaxe!
      if (!diamondFallbackOk && cands.length === 0) return;
    }
  }
  // Prefer mineflayer-tool (auto picks + equips the correct tier/tool for the block).
  if (bot.tool && wantTool !== 'pickaxe') {
    await bounded('bot.tool.equipForBlock', bot.tool.equipForBlock(block, { itemDamageRatio: 1 }), 8000);
    for (let t = 0; t < 6 && !handIsRight(); t++) await sleep(250);
    if (handIsRight()) return;
    log.warn(`equipBestToolFor: equipForBlock left the hand on ${bot.heldItem ? bot.heldItem.name : 'nothing'}, need a ${wantTool} - falling back to the pack`);
  }
  // Fallback: pick matching tool we carry, keeping diamond_pickaxe reserved for obsidian/high-tier ores.
  const want = wantTool === 'pickaxe'
    ? (/^(obsidian|crying_obsidian|respawn_anchor|ancient_debris|diamond_ore|deepslate_diamond_ore)$/.test(block.name || '')
      ? ['iron', 'diamond', 'netherite', 'stone', 'wooden', 'golden']
      : ['iron', 'stone', 'wooden', 'golden'])
    : ['iron', 'stone', 'diamond', 'wooden', 'golden', 'netherite'];
  const items = bot.inventory.items();
  for (const tier of want) {
    const t = items.find(i => i.name === `${tier}_${wantTool}`);
    if (!t) continue;
    await bounded(`equip ${t.name}`, bot.equip(t, 'hand'), 6000);
    for (let s = 0; s < 6 && !handIsRight(); s++) await sleep(250);
    if (handIsRight()) return;
    log.warn(`equipBestToolFor: still holding ${bot.heldItem ? bot.heldItem.name : 'nothing'} after equipping ${t.name} - trying the next tier`);
  }
}
function blockHarvestTool(bot, block) {
  // THIS WAS THE WOOD CHAIN'S ROOT CAUSE, and it hid for the whole project. minecraft-data for 1.21
  // has no `blocksById` (it is `blocks`, keyed by id, plus `blocksArray`), so this lookup threw
  // `Cannot read properties of undefined (reading '48')` for EVERY block - 48 is birch_log. Because
  // `equipBestToolFor` runs before every `bot.dig` in `digTree`, NO tree has ever been chopped through
  // this path: 19:42:46 `digTree: stopped after 0 log block(s) at 42,64,353 (birch_log) - Cannot read
  // properties of undefined (reading '48')`. No logs -> no planks -> no sticks -> no stone pick -> the
  // diamond pickaxe ate itself on ordinary rock -> obsidian frozen at 7/12.
  let b = null;
  try {
    const d = data(bot);
    const byId = d.blocks || d.blocksById || {};
    b = byId[block.type] || (block.name && d.blocksByName ? d.blocksByName[block.name] : null);
  } catch { b = null; }
  // `harvestWith` does not exist either; the dataset spells the field `toolType`, and it is undefined
  // for a number of blocks, so the name heuristic is the fallback rather than a default pickaxe.
  const t = (b && (b.harvestWith && b.harvestWith.length ? b.harvestWith[0] : b.toolType)) || '';
  if (t === 'axe' || /log|plank|wood|bark|mushroom_stem/.test(block.name || '')) return 'axe';
  if (t === 'shovel' || /dirt|grass$|sand|gravel|clay|snow|soul_|mud|farmland/.test(block.name || '')) return 'shovel';
  return 'pickaxe';
}

async function stepMove(bot) {
  // wander a little to expose new chunks (used when a target isn't loaded)
  try {
    const { GoalNear } = require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals;
    const a = Math.floor(Math.random() * 4);
    const dx = [8, -8, 0, 0][a], dz = [0, 0, 8, -8][a];
    const p = bot.entity.position;
    await bot.pathfinder.goto(new GoalNear(p.x + dx, p.y, p.z + dz, 2));
  } catch {}
}

// Robust craft: craft ONE at a time (multi-count bot.craft stalls on updateSlot timeouts); 2x2
// grid first, else use a crafting table that is GUARANTEED reachable (place one right beside the
// bot if needed — the earlier "distant surface table" lookup deadlocked underground).
// One gather per item per call chain. The tier-0-only ingredient list above is what actually prevents
// recursion; this is the belt to that braces, because a future name-list edit must not be able to turn a
// helper into an infinite loop (the `clickWindow` rename did exactly that once).
const _gathering = new Set();
async function craft(bot, item, count) {
  const id = itemId(bot, item);
  if (!id) return { ok: false, observation: 'unknown item ' + item };
  // Chestplate-first, enforced at the shared craft entry. The `armor` gate is "a WORN chestplate + one
  // more piece", so until any chestplate exists - in the pack or on the body - every other piece is
  // 4-7 ingots taken out of the single purchase that can close it. Measured 02:35 -> 02:48: the ladder's
  // own ordering was fixed at 01:14, but the LLM planned `iron_boots` through this entry, four ingots
  // left the pack, the boots broke on the same mine trip, and the gate reopened at ingots=0. Fixing only
  // the deterministic path left a second door open, which is what this guard closes.
  const otherPiece = /^(netherite|diamond|iron|gold|chainmail|leather)_(helmet|leggings|boots)$/.exec(item);
  if (otherPiece) {
    const wornChest = !!bot.inventory.slots[6] && /_chestplate$/.test(bot.inventory.slots[6].name);
    const spareChest = bot.inventory.items().some(i => /_chestplate$/.test(i.name));
    if (!wornChest && !spareChest) {
      log.skill(`craft ${item} refused: no chestplate yet, and the gate needs one - saving the material`);
      return { ok: false, observation: `skip ${item}: the armor gate wants a WORN CHESTPLATE plus one more piece, so spend the ingots on <tier>_chestplate first (cost 8 iron / 8 diamond); this piece would only move the chestplate further away` };
    }
  }
  const want = Math.max(1, count || 1);
  // A full inventory makes every craft fail: the 2x2/table grid cannot put the result away, and
  // mineflayer throws "destination full" out of bot.transfer. Free up room before trying.
  if (freeSlots(bot) < 2) { await dropJunk(bot, true, 6); log.skill(`craft ${item}: inventory was full, tidied -> free=${freeSlots(bot)}`); }
  const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
  const craftLoop = async (table) => {
    let made = 0;
    for (let i = 0; i < want; i++) {
      const before = countItem(bot, item);
      if (table) { try { await bot.pathfinder.goto(new GN(table.position.x, table.position.y, table.position.z, 2)); } catch {} }
      let okCraft = false;
      for (let attempt = 0; attempt < 3 && !okCraft; attempt++) {
        const rs = bot.recipesFor(id, null, 1, table);
        if (!rs.length) break;
        try { await bot.craft(rs[0], 1, table); } catch (e) { log.skill(`craft ${item} threw ${e.message}`); }
        for (let w = 0; w < 12 && countItem(bot, item) <= before; w++) await sleep(120); // wait for result to land
        if (countItem(bot, item) <= before && await rescueCursor(bot, item)) {
          for (let w = 0; w < 8 && countItem(bot, item) <= before; w++) await sleep(120);
        }
        if (countItem(bot, item) > before) okCraft = true;
      }
      if (!okCraft) break;
      made++;
    }
    return made;
  };
  // 0) Any recipe with a shape table: click the grid deterministically FIRST. bot.craft() on 1.21
  //    can block 20 s on `updateSlot:0` and still deliver nothing (mineflayer#3906); the fresh-world
  //    run paid that timeout six times on `stick` alone before a cursor rescue cleaned up the stack.
  const gc0 = require('../gridcraft');
  if (gc0.knows(item)) {
    // For tools, "have" means have one that still works: a 2% pickaxe satisfies no mine task, and
    // counting it as enough made craft() return "already have" forever.
    const isTool = /_(pickaxe|axe|shovel|hoe|sword)$/.test(item);
    const usable = () => {
      if (!isTool) return countItem(bot, item);
      return bot.inventory.items().filter(i => i.name === item)
        .reduce((s, i) => { const w = ob.wear(bot, i); return s + ((w === null || w >= 15) ? i.count : 0); }, 0);
    };
    const have0 = usable();
    if (have0 >= want) return { ok: true, observation: `already have ${item} x${have0}` };
    let win0 = null;
    bot._gridFails = bot._gridFails || {};
    const skipGrid = (bot._gridFails[item] || 0) >= 2;
    if (!gc0.fits2x2(item) && !skipGrid) {
      const tbl0 = bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 6 });
      if (tbl0) win0 = await gc0.openTable(bot, tbl0);
    }
    if ((gc0.fits2x2(item) || win0) && !skipGrid) {
      const r0 = await gc0.craftGrid(bot, item, want - have0, win0);
      const have1 = usable();
      log.skill(`grid-first ${item} x${want - have0}: made=${r0 && r0.made} have=${have1} (${r0 && r0.observation})`);
      if (have1 >= want) return { ok: true, observation: `crafted ${item} x${have1 - have0} (grid) have=${have1}` };
      bot._gridFails[item] = (bot._gridFails[item] || 0) + 1;
    } else if (skipGrid) {
      // No table window is opened on this path: an open window is what makes `bot.craft` fail later
      // (§19's "带着合成台窗口点击 2x2" family), so the detour must leave the world as it found it.
      log.skill(`grid-first ${item}: skipped after ${bot._gridFails[item]} attempts where the cells were never filled - going straight to bot.craft`);
    }
  }
  // 1) craftable in the 2x2 player grid?
  if (bot.recipesFor(id, null, 1, null).length) {
    const made = await craftLoop(null);
    const have = countItem(bot, item);
    if (have >= want || made >= want || (have > 0 && !bot.recipesFor(id, null, 1, null).length)) {
      return { ok: true, observation: `crafted ${item} x${made} (hand) have=${have}` };
    }
  }
  // 2) get a NEARBY placed crafting table (within reach), placing one beside us if needed
  const findNear = () => bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 6 });
  let table = findNear();
  if (!table) {
    let haveTable = countItem(bot, 'crafting_table');
    if (!haveTable) {
      const tbId = itemId(bot, 'crafting_table');
      let r = bot.recipesFor(tbId, null, 1, null);
      if (!r.length) { await craftPlanks(bot); r = bot.recipesFor(tbId, null, 1, null); }
      if (r.length) { try { await bot.craft(r[0], 1, null); } catch (e) { log.skill(`table craft threw: ${e.message}`); } }
      else {
        // (bestPlank/PLANKS live in the block below; compute locally to avoid a TDZ reference here)
        const pl = bot.inventory.items().filter(i => i.name.endsWith('_planks'));
        const bySp = {};
        for (const i of pl) bySp[i.name] = (bySp[i.name] || 0) + i.count;
        const topSp = Math.max(0, ...Object.values(bySp));
        log.skill(`no recipe for crafting_table; best single-species planks=${topSp} of ${JSON.stringify(bySp)} (need 4 OF ONE WOOD TYPE) logs=${bot.inventory.items().filter(i => i.name.endsWith('_log')).map(i => i.name + ':' + i.count).join(',') || 'none'} free=${freeSlots(bot)}`);
      }
      // Even the 2x2 table craft goes through bot.craft(), which on 1.21 can report success and
      // deliver nothing. Click the 2x2 grid ourselves as a second attempt.
      if (!countItem(bot, 'crafting_table')) {
        try {
          const gr = await require('../gridcraft').craftGrid(bot, 'crafting_table', 1, null);
          log.skill(`gridcraft crafting_table in 2x2: ${gr.observation}`);
        } catch (e) { log.skill(`gridcraft table threw ${e.message}`); }
      }
      haveTable = countItem(bot, 'crafting_table');
      log.skill(`craft table item, have=${haveTable}`);
    }
    if (!haveTable) {
      // A table costs 4 planks OF THE SAME SPECIES (11 separate recipes, one per wood type), so
      // summing species was wrong and doubly harmful: it also skipped the "go chop a tree" branch,
      // leaving the bot stuck with 3 birch + 2 oak planks and no crafting table forever.
      const PLANKS = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks'];
      const perSpecies = PLANKS.map(n => countItem(bot, n));
      const bestPlank = Math.max(0, ...perSpecies);
      const woodish = LOG_NAMES.some(n => countItem(bot, n) > 0) || bestPlank >= 4;
      const anyLog = woodish || bot.inventory.items().some(i => i.name.endsWith('_log') || i.name.endsWith('_planks'));
      if (!woodish) {
        // The reflect loop sometimes re-plans the same failing craft, so fix the cause here:
        // chop_trees surfaces by itself, then retry the table once. Costs ~1 minute of game
        // time instead of another 4-minute milestone timeout.
        log.skill('no logs for a crafting_table - chopping trees first');
        const wood = await reg.get('chop_trees').run(bot, { count: 6 });
        if (!wood.ok) {
          // Nothing to fell in this biome (the bot was standing on a dripstone beach). Roam until a
          // trunk is loaded, then fell it - same trick that found chickens for arrow feathers.
          const trip = await reg.get('roam').run(bot, { block: LOG_NAMES.join(','), distance: 400 });
          log.skill(`roaming to trees: ${trip.observation}`);
          if (trip.ok) await reg.get('chop_trees').run(bot, { count: 6 });
        }
        if (countItem(bot, 'oak_log') + countItem(bot, 'birch_log') + countItem(bot, 'spruce_log') + countItem(bot, 'jungle_log') > 0) {
          await craftPlanks(bot);
          const tbId2 = itemId(bot, 'crafting_table');
          const r2 = bot.recipesFor(tbId2, null, 1, null);
          if (r2.length) { try { await bot.craft(r2[0], 1, null); } catch (e) { log.skill(`retry table craft threw: ${e.message}`); } }
          haveTable = countItem(bot, 'crafting_table');
        }
      }
      if (!haveTable) {
        // A bench we already set down counts. At 19:52 the pack held 4 DIAMONDS - the first vein this
        // bot ever mined - and no table, and this function returned "no crafting table and wood attempt
        // failed (0 logs, 0 planks)" while the table it had placed itself 80 blocks up the same shaft
        // was still in the loaded column. The walk-to-a-placed-table code below cannot be reached from
        // inside this branch, so the diamond pickaxe stayed uncrafted over a bench 80 blocks away.
        const placed = bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 128 });
        if (placed) {
          log.skill(`craft ${item}: nothing in the pack but a table is PLACED at ${placed.position.x},${placed.position.y},${placed.position.z} (${Math.round(bot.entity.position.distanceTo(placed.position))} blocks away) - walking to it instead of hunting wood`);
          try { await reg.get('walk_to').run(bot, { x: placed.position.x, y: placed.position.y + 1, z: placed.position.z, tolerance: 4 }); } catch (e) { log.warn(`craft ${item}: walk to the placed table threw ${e.message}`); }
          haveTable = bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 8 }) ? 1 : 0;
          if (!haveTable) log.warn(`craft ${item}: walked toward the placed table and still has no bench within 8 - falling back to the wood attempt`);
        }
      }
      if (!haveTable) return { ok: false, observation: `no crafting table and wood attempt failed (${countItem(bot, 'oak_log') + countItem(bot, 'acacia_log') + countItem(bot, 'birch_log')} logs, ${countItem(bot, 'oak_planks')} planks) before crafting ${item}` };
    }
    if (!haveTable && process.env.MC_ASSIST !== '0') {
      // The 3x3 recipes (iron chestplate/leggings, bow) are unreachable without a table, and this
      // bootstrap has already tried planks -> logs -> chop_trees. Ask the server for one so the
      // run keeps moving; the log line marks it as an assist, not as an autonomous craft.
      log.skill('ASSIST: /give @s crafting_table (2x2 plank bootstrap could not deliver a table)');
      bot.chat('/give @s crafting_table 1');
      for (let w = 0; w < 15 && !countItem(bot, 'crafting_table'); w++) await sleep(200);
      haveTable = countItem(bot, 'crafting_table');
    }
    if (!table) {
      // Place what we are CARRYING before walking to a bench we set down an hour ago. Measured
      // 02:39:59: it set off on a 37-block walk to an old table while `crafting_table:1` sat in the
      // pack, and came back with `craft furnace threw Error: Event windowOpen did not fire within
      // timeout of 20000ms` three times in a row - 60 s of dead waits plus the walk, for a recipe it
      // could have done standing still. The long walk below stays as the fallback for the case it was
      // written for: a bot embedded in its own 1x1 shaft, where nothing can be placed at all.
      const carried = bot.inventory.items().find(i => i.name === 'crafting_table');
      if (carried) {
        try { await bot.equip(carried, 'hand'); } catch {}
        if (await placeAtFreeNeighbor(bot)) table = findNear();
        if (!table) { await digWorkshop(bot); table = findNear(); }
        if (table) log.skill(`craft ${item}: placed the carried table instead of walking to an old one`);
      }
    }
    if (!table) {
      // Walk back to a table we already placed instead of fighting to place a new one from inside a
      // 1x1 shaft at y=-50. That stubbornness produced "no reachable table" twenty times with 209
      // cobblestone in the pack: findNear() only looks 8 blocks, while the bot has set up benches all
      // over this world. A player simply carries the ingots back to the bench.
      let far = bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 128 });
      if (!far) {
        // Blind in the loaded chunks is not "it does not exist". The table left at 611,36,731 is the
        // pack's only 3x3 bench and the bot owns the coordinates - use them instead of concluding that a
        // second one has to be built out of logs this reef does not have.
        const rem = WS.at('crafting_table');
        if (rem) { far = { position: new (require('vec3'))(rem.x, rem.y, rem.z), fromRecord: true }; log.skill(`craft ${item}: no table loaded within 128 - using the remembered cell ${rem.x},${rem.y},${rem.z} (${rem.extra || ''})`); }
      }
      if (far) {
        // Write down what we can see NOW: next round the same table may be outside the loaded
        // chunks (y=36 seen from a reef at y=63) and `findBlock` goes blind on something the bot owns.
        try { WS.note('crafting_table', far.position, 'seen by the craft walk'); } catch { }
        const d = Math.round(bot.entity.position.distanceTo(far.position));
        log.skill(`craft ${item}: no table close, walking back to the placed one (${d} blocks)`);
        const GN2 = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
        try { await capped(bot.pathfinder.goto(new GN2(far.position.x, far.position.y, far.position.z, 2)), 45000, 'walk to table', () => { try { bot.pathfinder.stop(); } catch {} }); } catch {}
        table = findNear();
        if (!table) {
          try { await bot.equip(bot.inventory.items().find(i => i.name === 'crafting_table'), 'hand'); } catch {}
          if (await placeAtFreeNeighbor(bot)) table = findNear();
        }
        // Still nothing to work at -> fetch the table it ALREADY owns. `stow_workshop` (break a placed
        // crafting_table/furnace and carry it, base.js:145) has existed since §26bb and NOTHING called it,
        // so at 05:15:55 the bot stood on a reef with `a table is PLACED at 611,36,731 (37 blocks away)`,
        // walked toward it, failed to get within 8 (a cliff it cannot path down), and then went hunting
        // logs to build a second table - the one failure mode where carrying beats reaching.
        if (!table) {
          const sw = await reg.get('stow_workshop').run(bot, { radius: Math.max(24, d + 12), take: 'crafting_table' });
          log.skill(`craft ${item}: stow_workshop -> (${String(sw.observation).slice(0, 160)})`);
          if (sw.ok) {
            const ti2 = bot.inventory.items().find(i => i.name === 'crafting_table');
            try { await bot.equip(ti2, 'hand'); } catch {}
            if (await placeAtFreeNeighbor(bot)) table = findNear();
            else { await digWorkshop(bot); table = findNear(); }
          }
        }
      }
    }
    if (haveTable) {
      const ti = bot.inventory.items().find(i => i.name === 'crafting_table');
      try { await bot.equip(ti, 'hand'); } catch {}
      // dig a free nook + place the table right next to us, retry a few spots
      for (let t = 0; t < 3 && !table; t++) { if (await placeAtFreeNeighbor(bot)) table = findNear(); else table = findNear(); }
      if (!table) { await digWorkshop(bot); table = findNear(); }
      if (table) { try { WS.note('crafting_table', table.position, 'placed by the craft path'); } catch { } }
      // Overworld only, and this is the fifth instance of the same trap tonight: `recover_surface`
      // delegates to `return_overworld` outside the Overworld, so calling it here from inside the Nether
      // is a portal ride HOME - and that is what pulled the run out of the Nether at 19:45:22-25
      // (`after surfacing, table placed -> false` and then `use_portal: ... walking to it`). The /setblock
      // ASSIST branch below fixes the same cramped-placement problem without changing dimension, and the
      // Nether has no "surface" to reach anyway - its ceiling is bedrock.
      if (!table && process.env.MC_ASSIST !== '0' && (!bot.game || !bot.game.dimension || bot.game.dimension === 'overworld')) {
        // The bot is often embedded in its own 1x1 shaft at y=-50: pathfinder has no route to flat
        // ground ("No path to the goal" x6) and digWorkshop cannot carve a site from inside it.
        // Surface (OP teleport, remembered dry land) and place there instead of timing out again.
        log.skill('table held but unplaceable underground -> surfacing to set up');
        try { await reg.get('recover_surface').run(bot, {}); } catch (e) { log.skill(`recover_surface threw ${e.message}`); }
        await sleep(1200); // let the respawn/tp settle so blockAt is not mid-air
        if (await placeAtFreeNeighbor(bot)) table = findNear();
        if (!table) { await digWorkshop(bot); table = findNear(); }
        log.skill(`after surfacing, table placed -> ${!!table}`);
        if (!table && process.env.MC_ASSIST !== '0') {
          // The table exists but the bot cannot legally place it (no reachable supported cell).
          // Paint it into the world with a command so the 3x3 recipes (arrow, chestplate, bucket,
          // eyes of ender) are not blocked forever. Logged as an ASSIST: an MC_ASSIST=0 clear still
          // needs a real fix for cramped-space placement.
          const f = bot.entity.position.floored();
          for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
            const cell = bot.blockAt(f.offset(dx, 0, dz));
            const floor = bot.blockAt(f.offset(dx, -1, dz));
            if (!cell || !isAir(cell.name) || !floor || !isSupport(floor)) continue;
            bot.chat(`/setblock ${f.x + dx} ${f.y} ${f.z + dz} minecraft:crafting_table`);
            await sleep(900);
            const after = bot.blockAt(f.offset(dx, 0, dz));
            if (after && after.name === 'crafting_table') { log.skill(`ASSIST: /setblock crafting_table at ${f.x + dx},${f.y},${f.z + dz}`); table = after; break; }
          }
        }
      }
      log.skill(`placed table nearby -> ${!!table}`);
    }
  }
  if (!table) {
    // A stale lease refuses placeBlock/goto/equip, and every guard above swallows that refusal, so the
    // honest verdict is "this craft belonged to a step the planner had already abandoned" - not "there
    // is no bench". Measured 20:59:04: the pack HELD a crafting_table and the milestone announced
    // `no reachable table`, which the planner read as a bench problem and answered with grid_craft and
    // ensure_tools - while the real blocker was 1 diamond of the 3 needed, one shaft short of y=-25.
    if (require('../stepLease').stale()) {
      return { ok: false, observation: `this craft step was already abandoned by the planner (its lease is stale), so every place/goto/window call below it was refused - the pack holds ${countItem(bot, 'crafting_table')} crafting table(s) and nothing about the bench is wrong. Do not read this as a table shortage.` };
    }
    return { ok: false, observation: `no reachable table; slots=${ob.invSummary(bot).slots}` };
  }
  const haveRecipe = bot.recipesFor(id, null, 1, table).length;
  let made = haveRecipe ? await craftLoop(table) : 0;
  let have = countItem(bot, item);
  if (!haveRecipe || made < 1 || have < want) {
    // Upstream breakage, not our logic: on 1.21 bot.craft() waits for a set_slot packet for the
    // craft-result slot that the server never sends, so 3x3 recipes "succeed" and deliver nothing
    // (mineflayer#3906). Click the grid ourselves from the recipe table in src/gridcraft.js and
    // trust only the inventory delta.
    const gc = require('../gridcraft');
    const win = await gc.openTable(bot, table);
    const r = gc.knows(item) ? await gc.craftGrid(bot, item, want - made, win) : await gc.craftShapeless(bot, item, win);
    if (win) { try { bot.closeWindow(win); } catch {} }
    if (r && r.made > made) made = r.made;
    have = countItem(bot, item);
    log.skill(`gridcraft ${item} x${want}: made=${made} have=${have} (${r && r.observation})`);
  }
  if (have < 1) {
    // Detecting a shortage is only half the job: the caller has to be able to act on it. A craft missing a
    // STONE-FAMILY ingredient is one the bot can fix by itself - any pick (even wooden) mines stone - so dig
    // it and retry once instead of returning "need cobblestone" and letting the next round ask again.
    // 16:34:13 is the shape this closes: `mine` -> `craft stone_pickaxe` -> `no single item can satisfy "c"`
    // -> `mine` again, every round, while a wooden pickaxe sat in the pack with 22 uses left.
    // Deliberately narrow: only stone/cobble/deepslate, only once per call, only with a pick in hand.
    // Iron ingots, diamonds and planks are NOT gathered here - smelting and wood chains have their own
    // skills, and auto-chaining them inside craft() is how a helper becomes a second planner.
    const key = (require('../gridcraft').RECIPES[item] || {}).key || {};
    const wanted = [].concat(...Object.values(key).map(v => Array.isArray(v) ? v : [v]));
    const STONE = ['cobblestone', 'cobbled_deepslate', 'stone', 'deepslate'];
    const shortStone = wanted.some(w => STONE.includes(w)) && countItem(bot, 'cobblestone') + countItem(bot, 'cobbled_deepslate') < 3;
    const anyPick = bot.inventory.items().some(i => /_pickaxe$/.test(i.name));
    if (shortStone && anyPick && !_gathering.has(item) && Date.now() < (bot._stepDeadline || Infinity)) {
      _gathering.add(item);
      // try/finally, not a delete on each exit path: the retry below can throw (bot.craft / gridcraft do),
      // and a leaked entry would permanently disable gathering for this item for the life of the process -
      // a silent degradation exactly like the gates that turn a crash into a paralysis.
      try {
        log.skill(`craft ${item}: short of cobblestone and a pick is in the pack - digging the ingredient instead of reporting the shortage`);
        const g = await reg.get('mine').run(bot, { names: ['cobblestone', 'stone'], count: 8, maxDistance: 32 }).catch(e => ({ ok: false, observation: `threw ${e.message}` }));
        log.skill(`craft ${item}: ingredient run -> ${String(g.observation).slice(0, 130)}`);
        if (countItem(bot, 'cobblestone') + countItem(bot, 'cobbled_deepslate') >= 3) {
          const again = await craft(bot, item, want);
          if (again.ok) return again;
        }
      } finally {
        _gathering.delete(item);
      }
    }
    return { ok: false, observation: `cannot craft ${item}: need ${JSON.stringify((require('../gridcraft').RECIPES[item] || {}).key || 'unknown recipe')} have=${ob.invSummary(bot).slots}${shortStone && !anyPick ? ' - and there is NO pickaxe to dig it with: make a wooden one first (planks + sticks)' : ''}` };
  }
  return { ok: have >= 1 && made >= 1, observation: `crafted ${item} x${made} have=${have}/${want}` };
}

// Make planks from whatever logs the bot carries (handles oak/spruce/birch/... uniformly).
// mineflayer's click-dance can leave the crafted stack on the mouse cursor when the follow-up
// "put away" click does not land; the server then keeps the item held, so the inventory count
// never rises and every later craft reports "missing inputs". Put the cursor item away by hand.
async function rescueCursor(bot, expectName) {
  const win = bot.currentWindow || bot.inventory;
  const cur = win.selectedItem;
  if (!cur) return false;
  log.skill(`cursor holds ${cur.name}x${cur.count} after craft -> emptying it`);
  // bot.putAway(cursorItem) throws "invalid operation" for a cursor stack (it has no source slot),
  // which is exactly what stalled the assist-free run at crafting_table: the planks stayed on the
  // cursor and every later craft said "missing ingredient". Click a free slot instead - that is the
  // same packet a player sends - and if there is no room, drop it rather than jam forever.
  try { await bot.putAway(cur); return cur.name === expectName; } catch (e) { log.skill(`putAway cursor: ${e.message}`); }
  try {
    const slot = typeof win.firstEmptySlotRange === 'function' ? win.firstEmptySlotRange(9, 45) : null;
    if (slot !== null && slot !== undefined) {
      await bot.clickWindow(slot, 0, 0);
      await sleep(300);
      if (!(bot.currentWindow || bot.inventory).selectedItem) return countItem(bot, expectName) > 0;
    }
  } catch (e) { log.skill(`clickWindow cursor->slot failed: ${e.message}`); }
  try { await bot.toss(cur.name, null, cur.count); log.warn(`dropped cursor ${cur.name}x${cur.count} to unblock crafting`); } catch {}
  return false;
}

async function craftPlanks(bot) {
  // A leftover crafting-table window makes this whole routine impossible: bot.craft(recipe,1,null)
  // drives the 2x2 inventory grid, but while the table window is open that is not the window the
  // server is answering on, so every attempt "produced nothing ... free=34" with logs in the pack.
  // ensure_tools opens tables for its pick attempts and this stalled the acceptance run at 00:42.
  if (bot.currentWindow) {
    try { await bot.closeWindow(bot.currentWindow); log.skill(`craftPlanks closed stale window ${bot.currentWindow.type}`); } catch {}
    await sleep(150);
  }
  let made = 0;
  for (const l of bot.inventory.items().filter(i => i.name.endsWith('_log'))) {
    const planksName = l.name.replace('_log', '_planks');
    const pid = itemId(bot, planksName);
    if (!pid) continue;
    const r = bot.recipesFor(pid, null, 1, null);
    if (!r.length) { log.skill(`craftPlanks: no 2x2 recipe for ${planksName} (logs=${l.count}); freeSlots=${36 - bot.inventory.items().length}`); continue; }
    for (let n = 0; n < l.count; n++) {
      const before = countItem(bot, planksName);
      try { await bot.craft(r[0], 1, null); } catch (e) { log.skill(`planks threw ${e.message}`); break; }
      for (let w = 0; w < 12 && countItem(bot, planksName) <= before; w++) await sleep(120);
      if (countItem(bot, planksName) <= before) await rescueCursor(bot, planksName);
      if (countItem(bot, planksName) <= before) { log.skill(`planks craft produced nothing (${planksName} still ${before}) - inventory full? free=${36 - bot.inventory.items().length}`); break; }
      made += countItem(bot, planksName) - before;
    }
  }
  log.skill(`craftPlanks made ${made} (verified); slots=${ob.invSummary(bot).slots}`);
  return made;
}

function isAir(name) { return !name || name === 'air' || name === 'cave_air' || name === 'void_air'; }
// A block is "exposed" only if a DRY cell touches it. The old test accepted a face opening into a
// water-filled cave, and that is exactly how this bot ended up drowning at (21,43,-8) over and over
// while chasing iron: movement inside water is what the server rejects, so reaching that face is a
// one-way trip to a reconnect loop.
function isExposed(bot, b) {
  const n = [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0], [0, -1, 0]];
  const wet = (p) => { const x = bot.blockAt(p); return !!x && /water|lava/.test(x.name); };
  for (const [dx, dy, dz] of n) {
    const nb = bot.blockAt(b.position.offset(dx, dy, dz));
    if (!nb) return true; // neighbour not loaded yet: do not block mining on a blind spot
    if (!isAir(nb.name)) continue;
    const stand = b.position.offset(dx, dy, dz);
    if (wet(stand) || wet(stand.offset(0, 1, 0))) continue;
    return true;
  }
  return false;
}
const ARMOR_TIERS = { netherite: 6, diamond: 5, iron: 4, golden: 2, chainmail: 2, turtle: 2, leather: 1 };
const TIER_RANK = { netherite: 5, diamond: 4, iron: 3, golden: 2, stone: 1, wooden: 0, leather: 0 };
async function dropSurplusTools(bot) {
  const byFamily = {};
  for (const it of bot.inventory.items()) {
    const m = it.name.match(/^(.+)_(pickaxe|axe|shovel|sword|hoe)$/);
    if (!m) continue;
    const fam = m[2];
    (byFamily[fam] = byFamily[fam] || []).push({ it, rank: (TIER_RANK[m[1]] ?? 0) * 100 + (ob.wear(bot, it) ?? 50) });
  }
  let dropped = 0;
  for (const [fam, list] of Object.entries(byFamily)) {
    list.sort((a, b) => b.rank - a.rank);
    for (const extra of list.slice(TOOL_KEEP[fam] ?? 2)) {
      if (bot.heldItem && bot.heldItem.slot === extra.it.slot) continue;
      try { await bot.tossStack(extra.it); dropped++; } catch {}
    }
  }
  // at most one bucket of any kind
  const buckets = bot.inventory.items().filter(i => i.name.endsWith('_bucket')).sort((a, b) => (a.name === 'water_bucket' ? -1 : 1));
  for (const extra of buckets.slice(1)) { try { await bot.tossStack(extra); dropped++; } catch {} }
  return dropped;
}

const freeSlots = (bot) => 36 - bot.inventory.items().length;

// Toss whole stacks until the bot has `minFree` empty slots. Pass 1 applies the per-family caps;
// pass 2 is the safety valve: anything neither protected nor a tool/armor goes, biggest stack first.
// `force` runs pass 1 even without pressure (proactive tidying after a big mining run).
// Trash has to LEAVE the world. Tossing at the bot's own feet is not disposal: the drop lands inside the
// pickup radius and comes straight back, so the caps trimmed forever and the slots never opened - 266
// `tidy tossed` lines in two hours with `free` stuck at 4-8, and at 18:00 the pack was full again of the
// rock it had just thrown away, which is why the iron it mined had nowhere to land and the armour gate
// stayed shut. A pit three cells deep is below arm's reach, and lava deletes the entity, so those are the
// two real answers. World interaction only, no commands: identical behaviour under MC_ASSIST=0.
async function trashDisposal(bot) {
  const V = require('vec3');
  const feet = bot.entity.position.floored();
  try {
    const lavaIds = blockIds(bot, ['lava']);
    const under = bot.blockAt(feet.offset(0, -1, 0));
    const lv = lavaIds.length && bot.findBlock({ matching: lavaIds, maxDistance: 8 });
    if (lv && !(under && /lava/.test(under.name))) return { kind: 'lava', pos: lv.position.offset(0.5, 0.2, 0.5) };
  } catch {}
  const NB = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]];
  for (const [dx, dz] of NB) {
    // Never the column we are standing in - that hole takes the bot down with the trash.
    const cx = feet.x + dx, cz = feet.z + dz;
    let dug = 0, blocked = false;
    for (let d = 1; d <= 3; d++) {
      const pos = new V(cx, feet.y - d, cz);
      const b = bot.blockAt(pos);
      if (!b || b.boundingBox === 'none' || /air/.test(b.name)) { dug++; continue; }
      if (/lava|water|bedrock/.test(b.name)) { blocked = true; break; }
      // Never bare-hand dig hard stone/deepslate for a trash pit (takes 7.5s-15s and aborts mid-dig).
      if ((b.hardness || 0) >= 1.2 && usablePickCount(bot) === 0) { blocked = true; break; }
      try { await equipBestToolFor(bot, b); } catch {}
      const digTimeout = Math.max(8500, ((typeof bot.digTime === 'function' ? Number(bot.digTime(b)) : 3000) || 3000) + 3000);
      try { await Promise.race([Promise.resolve(bot.dig(b)).catch(() => {}), sleep(digTimeout)]); } catch {}
      const after = bot.blockAt(pos);
      if (after && after.boundingBox !== 'none' && !/air/.test(after.name)) { blocked = true; break; }
      dug++;
    }
    if (!blocked && dug >= 3) {
      // `pos` is where the trash must LAND; the AIM is deliberately not that point. Looking at the pit
      // floor three blocks below and one across is a ~70° ray, and the stack leaves the hand on that ray
      // only far enough to clip the near lip and drop back at the bot's feet (the operator's own note:
      // 视角抬高一点，扔不进去他挖的洞里). Aiming at the MOUTH, raised about a block, flattens the throw to
      // ~40° so the stack clears the lip and falls in.
      return {
        kind: 'pit',
        pos: new V(cx + 0.5, feet.y - 3 + 0.1, cz + 0.5),
        aim: new V(cx + 0.5, feet.y + 0.7, cz + 0.5),
      };
    }
  }
  return null;
}

async function dropJunk(bot, force, minFree = 6) {
  const pressure = force || freeSlots(bot) <= minFree;
  const goodPick = bot.inventory.items().some(i => i.name.endsWith('_pickaxe') && (ob.wear(bot, i) ?? 100) >= 15);
  const tossed = [];
  // One disposal per tidy call: the pit is dug once and every stack after it aims at the same hole.
  let disposal = null, disposalTried = false;
  const aim = async () => {
    if (!disposalTried) {
      disposalTried = true;
      disposal = await trashDisposal(bot);
      log.skill(disposal
        // floor, not round: `pos` is a cell CENTRE (-99.5 rounds to -98 and points at the next column),
        // and these coordinates are the only record of where the trash went.
        ? `tidy: disposal = ${disposal.kind} in cell ${Math.floor(disposal.pos.x)},${Math.floor(disposal.pos.y)},${Math.floor(disposal.pos.z)}`
        : 'tidy: no lava within 8 and no diggable 3-deep pit here - anything tossed lands at the feet and comes back');
    }
    if (disposal) { try { await bot.lookAt(disposal.aim || disposal.pos, true); } catch {} }
    return disposal;
  };
  const toss = async (it, why) => {
    if (bot.heldItem && bot.heldItem.slot === it.slot) return false; // never drop what is in hand
    const d = await aim();
    const before = countItem(bot, it.name);
    const cnt0 = it.count; // read it BEFORE the throw: the stack object is emptied by the toss, and
    // `sandx0(cap)` is what the log used to say - unreadable as "how much did it actually drop"
    try { await bot.tossStack(it); } catch { try { await bot.toss(it.name, null, it.count); } catch { return false; } }
    let took = true;
    // Prove it left. A pit or lava that the throw missed looks identical to one that worked until the
    // next pass runs out of slots, and "tossed" that came back is the exact loop this replaced.
    if (d) {
      // 400 ms was shorter than the pickup itself: a stack that lands on the bot's own feet is collected
      // about half a second later, so the old check said "tossed" for trash that was back in the pack, and
      // the next pass found the same stack again (the loop the pit was supposed to end).
      await sleep(900);
      if (countItem(bot, it.name) >= before) {
        log.warn(`tidy: the ${d.kind} did not take ${it.name} (still ${countItem(bot, it.name)} after 0.9s) - no more aiming here this call`);
        took = false;
        disposal = null;
      }
    }
    // A stack can leave the pack and still be sitting on the ground two blocks away - which is exactly the
    // complaint about the pit ("扔不进去他挖的洞里") and invisible to a count check. Look for the item entity
    // INSIDE the hole's column and below its lip, so "tossed" means "in the pit" rather than "gone".
    if (d && took && d.kind === 'pit' && bot.entities) {
      let inside = 0, outside = 0;
      try {
        for (const x of Object.values(bot.entities)) {
          if (!x || x.name !== 'item' || !x.position) continue;
          const dxz = Math.abs(x.position.x - d.pos.x) < 1.2 && Math.abs(x.position.z - d.pos.z) < 1.2;
          // BELOW the lip only: a stack resting on the ground beside the hole is at about the standing
          // floor level (pit floor +3.1), and counting that as "inside" would re-create the false success.
          if (dxz && x.position.y <= d.pos.y + 2.0) inside++;
          else if (x.position.distanceTo(bot.entity.position) < 4) outside++;
        }
      } catch {}
      if (!inside && outside) {
        log.warn(`tidy: the ${it.name} stack left the pack but landed OUTSIDE the pit (${outside} loose item(s) near me, none in the hole at ${Math.floor(d.pos.x)},${Math.floor(d.pos.y)},${Math.floor(d.pos.z)}) - the aim is the suspect`);
        disposal = null;
      } else if (inside) {
        log.skill(`tidy: ${it.name} confirmed inside the pit at ${Math.floor(d.pos.x)},${Math.floor(d.pos.y)},${Math.floor(d.pos.z)}`);
      }
    }
    // The label is the only record of where the trash went, so it must not claim a disposal that the
    // verification above just denied - `cobblestonex48(trim->16->pit)` read as success while the stacks
    // sat on the ground at its feet, which is how "扔不进去" looked like a working feature in the log.
    tossed.push(`${it.name}x${cnt0}(${why}${d ? `->${d.kind}${took ? '' : ' REJECTED'}` : ''})`);
    return true;
  };
  // One wood rule for EVERY pass. `woodIsBootstrap`/`pickSupplyThin` below tried to express it and
  // missed the case that keeps happening: the bot is at y=62 with planks in the pack, so both guards
  // read false and pass 2 threw `oak_logx15(room)` (02:13:54, the second time this run ate its own
  // wood chain). A log is the only route to a crafting table, and a 36/36 pack needs that table for
  // every 3x3 recipe the endgame wants (chest, all armour, eyes of ender, the diamond pick itself).
  const logsAllW = () => LOG_NAMES.reduce((s, n) => s + countItem(bot, n), 0);
  const planksAllW = () => bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
  // Always reserve backup wood (logs/planks), >=8 sticks, and >=1 crafting_table so tools/benches never deadlock underground.
  const woodThin = () => countItem(bot, 'crafting_table') < 1 || logsAllW() < 4 || (logsAllW() * 4 + planksAllW()) < 20;
  const WOOD_RE = /_(log|wood|stem|hyphae|planks)$/;
  // Cheap rock is the Nether's bridge kit: it is the ONLY way across a lava sea, and the caps above
  // trim a stack of 64 soul_sand down to 16 - 48 causeway cells thrown away at once. Measured cost:
  // the bot stalled 4 blocks from the first fortress this run has ever found, retreated to refill,
  // ran dry again, and repeated (20:14-20:24, `soul_sand 0, netherrack 0, diorite 0` with the pack
  // otherwise full of coal and pearls). Keep one full stack of fill while in the Nether.
  const FILL_RE = /^(netherrack|cobblestone|cobbled_deepslate|blackstone|diorite|andesite|granite|tuff|gravel|soul_sand|soul_soil|dirt|deepslate|end_stone)$/;
  const inNetherForFill = !!(bot.game && bot.game.dimension === 'the_nether');
  if (pressure) {
    // Buckets are the one item that cannot be trimmed by a count cap: each holds ONE in its own slot, so
    // 19 of them read as 19 stacks of `count 1 <= cap 1` and `tidy` reported "nothing (only kept items)"
    // over a jammed pack (live 12:03-12:16, the End trip never started again after 19 OP BUCKET grants).
    // Keep the working pair - one full, one empty - and let the duplicates go.
    for (const name of ['water_bucket', 'bucket']) {
      const stacks = bot.inventory.items().filter(i => i.name === name);
      const want = name === 'water_bucket' ? 1 : 1;
      while (stacks.length > want && freeSlots(bot) < minFree) {
        const extra = stacks.pop();
        if (bot.heldItem && bot.heldItem.slot === extra.slot) break;
        if (!await toss(extra, 'duplicate bucket')) break;
        tossed.push(`${name}x1(dup)`);
        log.warn(`tidy: a duplicate ${name} left the pack - it holds one slot per item and no count cap can reach it`);
      }
    }
  }
  if (pressure) {
    // NEVER discard the best diamond/netherite pickaxe even at 1% wear: it is the only tool that
    // mines obsidian, and a bot without one cannot build a portal at all. (This fired for real:
    // tidy tossed the last diamond pick as "worn", and the obsidian milestone then became impossible.)
    const pickOrder = ['netherite_pickaxe', 'diamond_pickaxe'];
    for (const it of bot.inventory.items()) {
      const keep = inNetherForFill && FILL_RE.test(it.name) ? 64 : JUNK_CAP[it.name];
      const deadTool = goodPick && it.name.endsWith('_pickaxe') && (ob.wear(bot, it) ?? 100) < 5 && !pickOrder.includes(it.name);
      const junky = deadTool || keep !== undefined || JUNK_DROP_ALL.test(it.name);
      if (!junky) continue;
      if (woodThin() && (/_planks$/.test(it.name) || /_(log|wood|stem|hyphae)$/.test(it.name))) continue;
      if (it.name === 'stick' && countItem(bot, 'stick') <= 16) continue;
      if (it.name === 'crafting_table' && countItem(bot, 'crafting_table') <= 1) continue;
      if (keep !== undefined && it.count <= keep) continue;
      // A capped stack must be TRIMMED, not thrown away: tossStack(all 36 obsidian) because the cap
      // is 16 silently destroyed the portal kit. Only cap-0 junk may leave as a whole stack.
      if (keep !== undefined && keep > 0 && it.count > keep) {
        const excess = it.count - keep;
        // bot.toss takes a numeric item type, not a name ("Invalid itemType" for every trim, so the
        // caps silently did nothing).
        try { await aim(); await bot.toss(itemId(bot, it.name), null, excess); tossed.push(`${it.name}x${excess}(trim->${keep}${disposal ? `->${disposal.kind}` : ''})`); }
        catch (e) { log.skill(`trim ${it.name} x${excess} failed: ${e.message}`); }
        continue;
      }
      await toss(it, deadTool ? 'worn' : 'cap');
      if (freeSlots(bot) >= minFree && !force) break;
    }
  }
  // duplicate tools are worth dropping even when there is no slot pressure
  await dropSurplusTools(bot);
  // Pass 2: still cramped -> drop the least useful unguarded stacks until there is room.
  let passes = 0;
  // A stack tossed at the bot's own feet is picked straight back up again, so "trim until there is
  // room" cannot make room. Measured 00:16-00:39: 266 identical `granitex8(trim->8) / sandx4(cap)`
  // lines in a bit over two hours while `free` stayed at 4-8 - three seconds of the round budget gone
  // each time, forever. Three passes that change nothing is the signal to stop cutting and say that
  // only a chest will do it.
  let lastFree = -1, noProgress = 0;
  while (freeSlots(bot) < minFree && passes++ < 40) {
    const frNow = freeSlots(bot);
    if (frNow === lastFree) {
      if (++noProgress >= 3) {
        tossed.push(`nothing left that makes room: ${frNow} free after ${passes} passes because the drops land at my feet and come straight back - dig/place a CHEST (stash) instead of trimming`);
        break;
      }
    } else { noProgress = 0; lastFree = frNow; }
    // A log is the ONLY route to a crafting table (log -> planks -> table), and every 3x3 recipe -
    // all armour pieces, the bow, eyes of ender - needs that table. Measured: this pass tossed
    // `birch_logx5(room)` at the exact moment the `armor` gate opened, leaving log=0 planks=0
    // table=0 and no recipe it could complete. Same class as eating the last diamond pickaxe.
    const woodIsBootstrap = countItem(bot, 'crafting_table') < 1
      && !bot.inventory.items().some(i => /_planks$/.test(i.name));
    // The second half of that rule, from 05:40:17 today: the guard above did NOT fire (the pack held a
    // table it had just crafted), so pass 2 tossed `birch_logx7(room)` and left log=0 stick=0 planks=4
    // at y=50 with two stone picks. Planks -> sticks -> pickaxe is the only pick supply there is, and
    // underground no tree can be reached, so the last logs are the last picks. Protect the logs whenever
    // the reserve cannot mint another pick.
    const planksAll = () => bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
    const logsAll = () => LOG_NAMES.reduce((s, n) => s + countItem(bot, n), 0);
    let deep = false;
    try { deep = bot.entity.position.y < 60 && (!bot.game || bot.game.dimension === 'overworld'); } catch { deep = false; }
    const pickSupplyThin = deep && countItem(bot, 'stick') < 2 && planksAll() < 6 && logsAll() < 8;
    // "A cap is not a delete": pass 1 trimmed cobblestone to its cap of 16, and the old pass 2 then threw
    // the WHOLE 16-stack as `cobblestonex16(room)` - `smelt` could no longer craft a furnace
    // (`need {"c":["cobblestone"...`), so the raw_iron in the pack could not become ingots. Anything with
    // a positive cap is trimmed to that cap here, never discarded below it.
    const guarded = it => {
      if (KEEP_ALWAYS.has(it.name) || TOOL_RE.test(it.name)) return true;
      // The bed, whatever colour it is. `KEEP_ALWAYS` says 'bed' and 1.21.1 names the item `blue_bed`,
      // so pass 2 threw the bed away every round - measured 17:34-17:37: `blue_bedx1(room)` four times
      // in a row while forward_base stood there with wool, planks and no bed left to place, which is the
      // whole reason this run has never had a respawn point at the portal.
      if (/_bed$/.test(it.name)) return true;
      // the hoisted rule: while the pack cannot pay for a table, no wood or plank leaves at all.
      if (woodThin() && WOOD_RE.test(it.name)) return true;
      if (woodIsBootstrap && /_(log|wood|stem|hyphae)$/.test(it.name)) return true;
      if (pickSupplyThin && /_(log|wood|stem|hyphae)$/.test(it.name)) return true;
      const cap = JUNK_CAP[it.name];
      return cap !== undefined && cap > 0 && it.count <= cap;
    };
    const cands = bot.inventory.items().filter(it => !guarded(it) && !(bot.heldItem && bot.heldItem.slot === it.slot));
    if (cands.length) {
      cands.sort((a, b) => (JUNK_DROP_ALL.test(b.name) ? 1 : 0) - (JUNK_DROP_ALL.test(a.name) ? 1 : 0) || b.count - a.count);
      const top = cands[0];
      const cap = JUNK_CAP[top.name];
      if (cap !== undefined && cap > 0 && top.count > cap) {
        const excess = top.count - cap;
        try { await aim(); await bot.toss(itemId(bot, top.name), null, excess); tossed.push(`${top.name}x${excess}(trim->${cap}${disposal ? `->${disposal.kind}` : ''})`); }
        catch (e) { log.skill(`pass2 trim ${top.name} x${excess} failed: ${e.message}`); }
        if (excess > 0 && freeSlots(bot) >= minFree) break;
        continue;
      }
      if (!(await toss(top, 'room'))) break;
      continue;
    }
    // Nothing left that is safe to throw away: make room by trimming capped stacks instead of
    // quitting, which is how the bot ends up 36/36 and unable to pick up the iron it just mined.
    const trimmable = bot.inventory.items().filter(it => {
      const cap = JUNK_CAP[it.name];
      return cap !== undefined && cap > 0 && it.count > cap && !(bot.heldItem && bot.heldItem.slot === it.slot);
    }).sort((a, b) => b.count - a.count)[0];
    if (!trimmable) break;
    const cut = Math.min(trimmable.count - JUNK_CAP[trimmable.name], trimmable.count - 1);
    if (cut <= 0) break;
    try { await aim(); await bot.toss(itemId(bot, trimmable.name), null, cut); tossed.push(`${trimmable.name}x${cut}(trim->cap${disposal ? `->${disposal.kind}` : ''})`); } catch { break; }
  }
  // Pass 3: the caps are a policy about ITEMS, but a slot is spent per STACK (`freeSlots = 36 - stacks`),
  // so twelve stone families sitting AT their cap plus the kit legally fill all 36 slots and the bot
  // lives at free=0 - which is exactly how a full pack kills every craft (`updateSlot:0 did not fire
  // within timeout`), every pickup and the furnace output. Measured 06:52-06:53: two straight samples at
  // free=0 while tidy kept emitting trim lines. Pass 2 only trims ABOVE cap, so at cap it had nothing to
  // do. My first attempt at this pass trimmed capped stacks DOWN to cap/3 and the self-test caught that
  // it freed ZERO slots (a partial trim moves items between counts, not stacks) - so this drops whole
  // stacks, which is the only thing that actually buys a slot.
  if (freeSlots(bot) < minFree) {
    const ROCK = /^(cobblestone|cobbled_deepslate|deepslate|stone|andesite|diorite|granite|tuff|blackstone|netherrack|basalt|gravel|sand|sandstone|dirt)$/;
    const COBBLE_FAMILY = /^(cobblestone|cobbled_deepslate|blackstone)$/;
    const famTotal = (re) => bot.inventory.items().filter(i => re.test(i.name)).reduce((s, i) => s + i.count, 0);
    let guard3 = 0;
    while (freeSlots(bot) < minFree && guard3++ < 14) {
      const stacks = bot.inventory.items().filter(it => ROCK.test(it.name) && !TOOL_RE.test(it.name)
        && !(bot.heldItem && bot.heldItem.slot === it.slot));
      if (!stacks.length) break;
      // Biggest pile first (fewest toss calls per slot freed), but never one that would take the
      // furnace-grade family below what a furnace costs: `smelt` needs 8 cobble-family blocks and tidy
      // throwing away the last 16 cobble once stopped the whole iron chain for a night.
      const ordered = stacks.sort((a, b) => b.count - a.count);
      const cand = ordered.find(it => !COBBLE_FAMILY.test(it.name) || famTotal(COBBLE_FAMILY) - it.count >= 8) || null;
      if (!cand) { log.skill(`tidy pass3: ${stacks.length} rock stack(s) left but every one is under the 8-block furnace floor - keeping them`); break; }
      if (!(await toss(cand, 'below-cap-stack'))) break;
    }
  }
  // Pass 4 - the desperation tier, and the reason it exists. Measured 2026-11-01 02:00:47: 35 stacks,
  // free=1, and passes 1-3 would not part with ONE item because everything left is capped, a tool, or
  // on KEEP_ALWAYS. `stone_tools` burned 9 attempts on a 2-cobblestone sword with nowhere to land while
  // the pack carried wheat_seeds x22 and a sapling - stock the main chain never asks for again. Slots,
  // not items, are the scarce resource at that moment, so the cheapest renewable stack goes; it stops at
  // 4 free (enough to craft and pick up), never touches food/tools/kit, and logs the tier by name so a
  // later read knows the pack was emptied by necessity rather than by a cap.
  if (freeSlots(bot) < Math.min(minFree, 4)) {
    const OFF_CHAIN = /^(?:(?:oak|birch|spruce|jungle|acacia|dark_oak|cherry|mangrove)_sapling|wheat_seeds|cobweb|bone|rotten_flesh|spider_eye|snowball|moss_carpet|short_grass|fern|clay_ball|ink_sac)$/;
    let guard4 = 0;
    while (freeSlots(bot) < Math.min(minFree, 4) && guard4++ < 8) {
      const cand = bot.inventory.items()
        .filter(it => OFF_CHAIN.test(it.name) && !(bot.heldItem && bot.heldItem.slot === it.slot))
        .sort((a, b) => b.count - a.count)[0];
      if (!cand) break;
      if (!(await toss(cand, 'desperation-off-chain'))) break;
    }
    // Rung 2, for the state rung 1 cannot solve (measured 02:18:56, free=0): every stack left is
    // policy-guarded, and the only guarded things that cost nothing to replace are tool tiers a BETTER
    // tool in the same pack has already superseded. A wooden and a stone pick sitting next to an iron
    // AND a diamond pick are two slots spent on digs the run will never do with them - and `free=0`
    // stops the pickup, the craft and the furnace output, so the slots are worth more than the tiers.
    if (freeSlots(bot) < 2) {
      const holds = (n) => bot.inventory.items().some(i => i.name === n);
      const OBSOLETE = [];
      if (holds('diamond_pickaxe') && holds('iron_pickaxe')) OBSOLETE.push('wooden_pickaxe', 'stone_pickaxe', 'golden_pickaxe');
      if (holds('iron_sword') && holds('diamond_sword')) OBSOLETE.push('wooden_sword', 'stone_sword', 'golden_sword');
      if (holds('iron_axe') && holds('diamond_axe')) OBSOLETE.push('wooden_axe', 'stone_axe', 'golden_axe');
      for (const nm of OBSOLETE) {
        if (freeSlots(bot) >= Math.min(minFree, 3)) break;
        const it = bot.inventory.items().filter(i => i.name === nm && !(bot.heldItem && bot.heldItem.slot === i.slot))[0];
        if (!it) continue;
        if (!(await toss(it, 'desperation-superseded-tier'))) break;
      }
    }
  }
  if (tossed.length) log.skill(`tidy tossed ${tossed.length}: ${tossed.slice(0, 8).join(' ')}`);
  return tossed;
}
// Inventory maintenance. Two kinds of rule:
//  - JUNK_CAP: how many of a family to keep (0 = drop the whole stack). Covers the stone/dirt
//    families the bot mines constantly.
//  - KEEP_ALWAYS: never throw these away, even under slot pressure. The endgame ladder dies
//    without pearls/eyes/obsidian/fuel/food, and a "helpful" tidy that drops them costs hours.
// The old regex-only tidy could not see netherrack / stone_bricks / amethyst / raw_copper, so the
// bot walked out of the Nether with 36/36 slots full and nothing could be crafted or smelted.
const JUNK_CAP = {
  cobblestone: 16, cobbled_deepslate: 16, deepslate: 16, stone: 16, andesite: 8, diorite: 8,
  granite: 8, tuff: 8, blackstone: 16, netherrack: 16, basalt: 8, smooth_basalt: 0, calcite: 0,
  amethyst_block: 0, dripstone_block: 0, pointed_dripstone: 0, rooted_dirt: 0, moss_block: 0,
  stone_bricks: 8, mossy_stone_bricks: 0, cracked_stone_bricks: 0, chiseled_stone_bricks: 0,
  gravel: 8, sand: 0, redstone: 0, raw_copper: 0, raw_gold: 0, clay: 0, snow_block: 0,
  stick: 8, string: 8, gunpowder: 8, flint: 8, bone: 0, spider_eye: 0, rotten_flesh: 0,
  feather: 4, leather: 4, egg: 0, cobweb: 0, vine: 0, oak_planks: 8, spruce_planks: 8,
  birch_planks: 8, jungle_planks: 8, acacia_planks: 8, dark_oak_planks: 8, cherry_planks: 8,
  // The endgame kit is worth keeping, but a whole stack each of 64 eyes / 32 pearls / 36 obsidian /
  // 91 end_stone is 4+ slots burned for material the portal never uses (frame = 12 obsidian,
  // 12-14 eyes). Capping these is what finally leaves room to craft.
  end_stone: 8, obsidian: 24, ender_pearl: 20, ender_eye: 20, arrow: 32, torch: 16,
  glowstone: 8, nether_wart: 8, raw_iron: 64, iron_ingot: 64, diamond: 16, coal: 32, charcoal: 32,
};
const KEEP_ALWAYS = new Set([
  'ender_eye', 'ender_pearl', 'obsidian', 'raw_iron', 'iron_ingot', 'gold_ingot', 'diamond',
  // stick + feather: the bow step lost two rounds because tidy ate every stick under slot pressure
  // (arrows need flint+stick+feather, and flint/feathers were in the pack with stick=0).
  'stick', 'feather', 'flint',
  'coal', 'coal_ore', 'charcoal', 'flint_and_steel', 'bow', 'arrow', 'crafting_table', 'furnace',
  'chest', 'torch', 'lantern', 'bed', 'shield', 'bucket', 'water_bucket', 'lava_bucket',
  'blaze_rod', 'blaze_powder', 'glowstone_dust', 'nether_wart', 'gold_nugget', 'iron_nugget',
  'apple', 'bread', 'wheat', 'wheat_seeds', 'carrot', 'potato', 'baked_potato', 'beef',
  'cooked_beef', 'porkchop', 'cooked_porkchop', 'chicken', 'cooked_chicken', 'mutton',
  'cooked_mutton', 'cod', 'cooked_cod', 'salmon', 'cooked_salmon', 'cookie', 'pumpkin_pie',
  'golden_apple', 'totem_of_undying', 'name_tag', 'saddle',
]);
const TOOL_RE = /_(pickaxe|axe|shovel|sword|helmet|chestplate|leggings|boots)$/;
const JUNK_DROP_ALL = /(_button|_sapling|grass_block|^dirt$|^snowball$|^moss$)/;

// How many of each tool family to keep. Duplicate picks are the classic mineflayer inventory
// killer: each /give or craft adds another stack, and once 36 slots are full of tools nothing
// can be crafted, smelted or picked up - and "tidy" that only knows about stone/junk does nothing.
const TOOL_KEEP = { pickaxe: 3, axe: 2, shovel: 2, sword: 2, hoe: 1 };
let inStash = false; // tidy -> stash -> craft -> dropJunk must never re-enter stash
reg.define('tidy', {
  desc: 'Drop junk AND surplus duplicate tools (keeps 3 picks / 2 swords max) plus spare buckets, freeing slots. Use whenever crafting or pickup fails with 0 free slots.',
  params: { min_free: 'int default 6 - keep tossing until this many inventory slots are empty' },
  async run(bot, a) {
    const before = bot.inventory.items().length;
    const need = Math.max(2, Math.min(16, parseInt(a.min_free, 10) || 6));
    const tossed = await dropJunk(bot, true, need);
    let stashed = '';
    if (freeSlots(bot) < 2 && !inStash) {
      inStash = true;
      try {
        const s = await reg.get('stash').run(bot, { min_free: need });
        stashed = ` | stash: ${String(s.observation).slice(0, 150)}`;
      } catch (e) { stashed = ` | stash threw ${String((e && e.message) || e).slice(0, 60)}`; }
      finally { inStash = false; }
    }
    return { ok: freeSlots(bot) >= 2, observation: `tidy: ${before} -> ${bot.inventory.items().length} slots; free=${freeSlots(bot)}; tossed=${tossed.length ? tossed.join(' ') : 'nothing (only kept items)'}; slots=${ob.invSummary(bot).slots}${stashed}` };
  },
});
// The loss-free half of inventory maintenance. `tidy` can only THROW things away, and once the pack is
// full of items worth keeping it correctly reports `tossed=nothing (only kept items)` and the whole
// ladder stops: measured 2026-11-01 02:00, 35 stacks / free=1 with ender_pearl 16, obsidian 6, iron_ingot 4,
// wheat_seeds 22 and iron_nugget 18 in the pack, `stone_tools` burning 9 attempts because a 2-cobble sword
// had nowhere to land. A chest frees the same slots and keeps every item, so it goes first and tossing
// stays the fallback for a world where no chest can be made.
// What may NEVER go into the chest: the kit the ladder is built on, plus the fuel/food/ammo the next
// hour spends. A chest is loss-free in principle but retrieval costs a walk, so anything the current
// step reads out of its own pack stays in hand. (This list is deliberately a superset of tidy's
// KEEP_ALWAYS: `tidy` may throw away `leather`, `stash` will not spend a retrieval trip on it.)
const STASH_KEEP = /^(?:\w+_pickaxe|\w+_axe|\w+_shovel|\w+_sword|\w+_hoe|\w+_helmet|\w+_chestplate|\w+_leggings|\w+_boots|bucket|water_bucket|lava_bucket|crafting_table|furnace|chest|obsidian|crying_obsidian|ender_pearl|eye_of_ender|ender_eye|blaze_rod|blaze_powder|flint_and_steel|bed|.+_bed|diamond|diamond_.+|iron_ingot|iron_nugget|raw_iron|golden_apple|enchanted_golden_apple|potion|gunpowder|torch|coal|charcoal|bow|arrow|apple|bread|wheat|carrot|potato|baked_potato|beef|cooked_beef|chicken|cooked_chicken|porkchop|cooked_porkchop|mutton|cooked_mutton|cod|cooked_cod|salmon|cooked_salmon|cookie|pumpkin_pie|flint|glowstone_dust|nether_wart)$/;
// What goes FIRST: rock. It is what actually fills a pack (six stone families at their caps are six
// slots), it is infinite at any dig site, and a furnace needs only 8 of the cobble family - which stays
// in the pack below, because a deposit that stops the iron chain is the tidy bug with extra steps.
const STASH_FIRST = /^(?:cobblestone|cobbled_deepslate|deepslate|stone|andesite|diorite|granite|tuff|blackstone|netherrack|basalt|gravel|sand|dirt|snowball|clay_ball)$/;
const STASH_COBBLE_FLOOR = 8;
reg.define('stash', {
  desc: 'Craft/place (or reuse a nearby) chest and DEPOSIT whole stacks into it to free inventory slots. The loss-free version of tidy - use it whenever tidy reports "only kept items" with a full pack.',
  params: { min_free: 'int default 8 - deposit until this many slots are empty', keep: 'optional comma list of extra item names to carry' },
  async run(bot, a) {
    const need = Math.max(2, Math.min(16, parseInt(a.min_free, 10) || 8));
    const extra = new Set(String(a.keep || '').split(',').map(s => s.trim()).filter(Boolean));
    const keep = (it) => STASH_KEEP.test(it.name) || extra.has(it.name)
      || /_planks$|_(log|wood|stem|hyphae)$|^stick$/.test(it.name) // wood is the recipe bootstrap
      || (bot.heldItem && bot.heldItem.slot === it.slot);
    if (freeSlots(bot) >= need) return { ok: true, observation: `free=${freeSlots(bot)} already >= ${need} - nothing stashed` };
    // Every await below goes through a protocol path this version has already hung on (mineflayer#3906
    // equip acks; an 8.5-minute stall at 05:40:30 was one un-acked await). Bound them so a stuck
    // container cannot eat the step's whole budget.
    const raceMs = async (p, ms, what) => {
      let done = false;
      const out = await Promise.race([
        Promise.resolve(p).then(v => { done = true; return { v }; }, e => { done = true; return { e: String((e && e.message) || e) }; }),
        sleep(ms).then(() => (done ? null : { timeout: true })),
      ]);
      if (!out || out.timeout) return { e: `${what} never acked within ${ms}ms` };
      if (out.e) return { e: `${what}: ${out.e}`.slice(0, 160) };
      return { v: out.v };
    };
    const chestId = (data(bot).blocksByName.chest || {}).id;
    // 1. A chest already placed and close by is the cheapest room there is.
    let site = null;
    const nearby = chestId ? bot.findBlocks({ matching: [chestId], maxDistance: 12, count: 4 }) : [];
    if (nearby && nearby.length) {
      site = bot.blockAt(nearby[0]);
      log.skill(`stash: using the chest at ${nearby[0].x},${nearby[0].y},${nearby[0].z}`);
    } else {
      // 2. Otherwise place one from the pack (crafting it if needed) right next to the bot.
      let chestItem = bot.inventory.items().find(i => i.name === 'chest');
      if (!chestItem) {
        const planks = bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
        const r = await craft(bot, 'chest', 1);
        chestItem = bot.inventory.items().find(i => i.name === 'chest');
        if (!chestItem) return { ok: false, observation: `no chest within 12 blocks and crafting one failed (planks=${planks}): ${r.observation}` };
      }
      try { await bot.equip(chestItem, 'hand'); } catch {}
      for (let q = 0; q < 6 && !(bot.heldItem && bot.heldItem.name === 'chest'); q++) await sleep(250);
      const placed = await placeAtFreeNeighbor(bot);
      const spot = chestId ? bot.findBlocks({ matching: [chestId], maxDistance: 12, count: 4 }) : [];
      site = spot && spot.length ? bot.blockAt(spot[0]) : null;
      if (!placed || !site) return { ok: false, observation: `carrying a chest but nothing would take it (placeBlock ${placed ? 'acked' : 'refused'}, chests found: ${(spot || []).length}) - needs a solid dry cell to stand it on` };
      WS.note('stash_chest', { x: site.position.x, y: site.position.y, z: site.position.z }, 'placed by stash');
      log.skill(`stash: placed a chest at ${site.position.x},${site.position.y},${site.position.z} (remembered in runs/workshop.json)`);
    }
    // 3. Deposit the biggest carry-free stacks first: one whole stack buys exactly one slot.
    const opened = await raceMs(bot.openChest(site), 8000, 'openChest');
    if (opened.e) return { ok: freeSlots(bot) >= 2, observation: `chest at ${site.position.x},${site.position.y},${site.position.z} would not open: ${opened.e}` };
    const container = opened.v;
    const put = [];
    try {
      for (let guard = 0; guard < 40 && freeSlots(bot) < need; guard++) {
        // rock first, then the biggest of whatever else is left; `keep()` is the kit wall.
        const cands = bot.inventory.items()
          .filter(it => !keep(it) && it.count > 0)
          .sort((x, y) => ((STASH_FIRST.test(y.name) ? 1 : 0) - (STASH_FIRST.test(x.name) ? 1 : 0)) || y.count - x.count);
        // Never deposit the last cobble-family blocks below a furnace's cost, whoever is paying for the
        // slot: `smelt` dies without 8 of them and the iron chain dies with it.
        const cobbleInPack = bot.inventory.items().filter(i => /^(cobblestone|cobbled_deepslate|blackstone)$/.test(i.name)).reduce((s, i) => s + i.count, 0);
        const pick = cands.find(it => !/^(cobblestone|cobbled_deepslate|blackstone)$/.test(it.name) || cobbleInPack - it.count >= STASH_COBBLE_FLOOR) || null;
        if (!pick) break;
        const it = pick;
        const before = it.count;
        const d = await raceMs(container.deposit(itemId(bot, it.name), 0, before), 5000, 'deposit');
        if (d.e) { log.warn(`stash: deposit ${it.name}x${before} failed - ${d.e}`); break; }
        if (countItem(bot, it.name) >= before) break; // nothing moved: the chest is full
        put.push(`${it.name}x${before}`);
      }
    } finally {
      try { container.close(); } catch {}
    }
    const freeNow = freeSlots(bot);
    return {
      ok: freeNow >= 2,
      observation: `stashed ${put.length ? put.join(' ') : 'nothing'} into the chest at ${site.position.x},${site.position.y},${site.position.z}; free=${freeNow}/${need}; slots=${ob.invSummary(bot).slots}`,
    };
  },
});
reg.define('light', {
  desc: 'Craft torches (coal/charcoal + stick) and place a few on the ground around you. Mobs only spawn in the dark, so this is what makes an underground workshop survivable. Use when standing in a dug-in nook or before a long smelt/craft sequence.',
  params: { count: 'int default 4 - torches to place' },
  async run(bot, a) {
    const want = Math.max(1, Math.min(8, parseInt(a.count, 10) || 4));
    if (!countItem(bot, 'torch')) {
      if (!countItem(bot, 'stick')) await craft(bot, 'stick', 4);
      if (!countItem(bot, 'coal') && !countItem(bot, 'charcoal')) await craft(bot, 'torch', 4);
      const src = countItem(bot, 'coal') ? 'coal' : 'charcoal';
      if (!countItem(bot, src)) return { ok: false, observation: `no ${src} and no torch: cannot make light; coal=${countItem(bot, 'coal')} charcoal=${countItem(bot, 'charcoal')} stick=${countItem(bot, 'stick')}` };
      await craft(bot, 'torch', want * 4);
    }
    if (!countItem(bot, 'torch')) return { ok: false, observation: `torch craft produced none (stick=${countItem(bot, 'stick')} coal=${countItem(bot, 'coal') + countItem(bot, 'charcoal')})` };
    const ti = bot.inventory.items().find(i => i.name === 'torch');
    try { await bot.equip(ti, 'hand'); } catch {}
    let placed = 0;
    const feet = bot.entity.position.floored();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [0, 2], [2, 0]]) {
      if (placed >= want) break;
      const floor = bot.blockAt(feet.offset(dx, -1, dz));
      const cell = bot.blockAt(feet.offset(dx, 0, dz));
      if (!floor || !isSupport(floor) || !cell || !isAir(cell.name)) continue;
      try { await bot.placeBlock(floor, new Vec3(0, 1, 0)); placed++; } catch {}
    }
    const fb = bot.blockAt(feet); // null right after a respawn/teleport while chunks reload
    const light = fb ? Math.round(fb.light || 0) : 'unknown';
    return { ok: placed > 0, observation: `placed ${placed} torch (have ${countItem(bot, 'torch')} left), light at feet=${light}` };
  },
});
reg.define('grid_craft', {
  desc: 'Deterministic crafter with its own recipe table (crafting_table, sticks, torch, furnace, chest, pick/sword/armor, bucket, bow, arrow, flint_and_steel, ender_eye, ladder) that clicks the grid itself. Use whenever "craft" says missing inputs or crafts nothing for a 3x3 recipe - on 1.21 bot.craft() silently delivers nothing for those.',
  params: { item: 'item name', count: 'int default 1' },
  async run(bot, a) {
    const gc = require('../gridcraft');
    const name = a.item;
    if (!name) return { ok: false, observation: 'grid_craft needs {item}' };
    if (!gc.knows(name)) return { ok: false, observation: `no recipe for ${name} in src/gridcraft.js - add it there (shape + key)` };
    // The model happily spends the whole wood budget on decorations: the acceptance run was carrying
    // 18 slabs and 11 pressure plates and still had no pickaxe, so every later craft starved. Until
    // a pick exists, refuse the decorative recipes and point the planner at the tool it needs.
    if (/slab|stairs|pressure_plate|button|fence_gate|door|sign|bowl/.test(name)
      && !bot.inventory.items().some(i => i.name.endsWith('_pickaxe'))) {
      return { ok: false, observation: `no pickaxe yet, so ${name} is a waste of planks - grid_craft wooden_pickaxe first (3 planks + 2 sticks), then mine cobblestone for stone_pickaxe` };
    }
    const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
    const tbl = bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 16 });
    let win = null;
    if (tbl) {
      try { await bot.pathfinder.goto(new GN(tbl.position.x, tbl.position.y, tbl.position.z, 2)); } catch {}
      win = await gc.openTable(bot, tbl);
    }
    const want = Math.max(1, parseInt(a.count, 10) || 1);
    const r = await gc.craftGrid(bot, name, want, win);
    if (win) { try { bot.closeWindow(win); } catch {} }
    // If the click path delivered nothing, ask the recipe book before reporting failure. A dead window
    // handle, a 2x2/3x3 mismatch or a mis-shaped grid all end with made=0 while the ingredients sit in
    // the pack, and `bot.craft` needs none of our clicking - measured 06:00:41 (chestplate: "nothing
    // appeared", then worn two minutes later through exactly this route) and 05:32:39 (diamond pick).
    if (!r.made) {
      const f = await craft(bot, name, want);
      if (f.ok) return { ok: true, observation: `grid_craft ${name}: grid clicks made nothing (${String(r.observation).slice(0, 70)}) but bot.craft delivered (${f.observation})` };
      return { ok: false, observation: `grid_craft ${name}: ${r.observation} | bot.craft fallback also failed: ${f.observation}; free=${freeSlots(bot)}` };
    }
    return { ok: true, observation: `grid_craft ${name}: ${r.observation}; free=${freeSlots(bot)} inv=${ob.invSummary(bot).slots}` };
  },
});
reg.define('workshop', {
  desc: 'Dig a 2-high nook and place a crafting table in it (needed for 3x3 recipes underground where there is no open cell). Use when a craft reports "no reachable table".',
  params: {},
  async run(bot) {
    if (!countItem(bot, 'crafting_table')) {
      const c = await craft(bot, 'crafting_table', 1);
      if (!c.ok && c.observation) log.skill(`workshop: table craft said ${c.observation}`);
    }
    const t = await digWorkshop(bot);
    return t
      ? { ok: true, observation: `workshop ready at ${t.position.x},${t.position.y},${t.position.z}` }
      : { ok: false, observation: `could not place a crafting table here (y=${bot.entity.position.floored().y}); needs an open cavern or surface` };
  },
});
reg.define('inspect', {
  desc: 'Read-only survey: ore/obsidian visible around the bot at its current Y, tool durability, free slots, position. Call it before committing to a long dig.',
  params: { r: 'int horizontal radius, default 14' },
  async run(bot, a) {
    const k = ob.kit(bot);
    return {
      ok: true,
      observation: `inspect y=${bot.entity.position.floored().y} ${ob.census(bot, a.r || 14)} tools=[${k.tools}] worn={${k.armor}} free_slots=${k.freeSlots} inv=${ob.invSummary(bot).slots} status=${JSON.stringify(ob.status(bot))}`,
    };
  },
});
reg.define('ensure_tools', {
  desc: 'Guarantee a usable pickaxe (>=15% durability) plus a melee weapon: repairs worn ones, crafts stone/iron, and only as a last resort uses the OP /give rescue.',
  params: {},
  async run(bot, a, ctx) {
    const before = bot.inventory.items().filter(i => /pickaxe|sword/.test(i.name))
      .map(i => `${i.name}@${ob.wear(bot, i) === null ? '?' : ob.wear(bot, i) + '%'}`).join(',');
    const goodPicks = () => bot.inventory.items().filter(i => i.name.endsWith('_pickaxe'))
      .filter(i => { const w = ob.wear(bot, i); return w === null || w >= 15; });
    // The diamond pick is not a bulk tool: it is the only thing that drops obsidian, and the whole
    // End route depends on it still having uses left. A pack with diamond_pickaxe@52% and
    // stone@7%/iron@11% looked "fine" to goodPicks() for ten straight minutes while the diamond pick
    // ate the shaft (87% -> 52%), so a CHEAP pick is now guaranteed separately.
    const bulkPicks = () => bot.inventory.items().filter(i => /^(wooden|stone|golden|iron)_pickaxe$/.test(i.name))
      .filter(i => { const w = ob.wear(bot, i); return w === null || w >= 15; });
    const usableOf = (nm) => bot.inventory.items().filter(i => i.name === nm && ((ob.wear(bot, i) ?? 100) >= 15)).length;
    // Wood is the one input nothing underground can produce. At 08:09:26 the pack was `y=-55, iron pick
    // worn to nothing, stick=0, planks=0, logs=0`, and every craft answered
    // `cannot craft stick: need {"p":"@planks"}` - the diamond route needs an iron pick, an iron pick
    // needs sticks, sticks need planks, planks need a tree, and there is no tree at y=-55. Nothing in
    // the ladder went and got one, so this was a permanent deadlock, not a slow stretch. A player
    // surfaces and chops; that is what this block does. It stands down as soon as there is enough
    // wood-and-plank mass to mint two more picks, so it cannot become a habit.
    const logs0 = LOG_NAMES.reduce((s, n) => s + countItem(bot, n), 0);
    const planks0 = bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
    let deepY = 0;
    try { deepY = bot.entity.position.y; } catch { deepY = 0; }
    // A pick needs a table, a table needs 4 planks, planks need a log. The old gate asked
    // `deepY<40 && stick<4 && planks+logs*4<8`, and that is exactly how tonight hid the deadlock: the pack
    // read stick=8, cobblestone=9, cobbled_deepslate=12 (a stone pick is 3 + 2) with oak_planks=1,
    // birch_planks=1, NO log and no table in the pack or within 12 blocks - and a 2x2 hand grid cannot lay
    // out a 3x3 recipe. Every craft then answered `no crafting table`, `craftPlanks made 0 (verified)` had
    // nothing to convert, and the run circled 15 minutes with a pick-shaped hole in it (01:23:03 ->
    // 01:24:08 live, the End door open 122 blocks away). The question is not "am I out of sticks", it is
    // "can I pay for the table that this pick has to be crafted on".
    const tableNear = (() => {
      try { if (countItem(bot, 'crafting_table') > 0) return true; } catch {}
      try { if (bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 12 })) return true; } catch { return true; }
      try {
        const rem = WS.at('crafting_table');
        if (rem && bot.entity && bot.entity.position) {
          const d3 = Math.hypot(rem.x - bot.entity.position.x, rem.y - bot.entity.position.y, rem.z - bot.entity.position.z);
          if (d3 <= 24) {
            log.skill(`ensure_tools: bench is on file at ${rem.x},${rem.y},${rem.z} (${Math.round(d3)}m) - craft() walks there, no tree needed`);
            return true;
          }
        }
      } catch {}
      return false;
    })();
    const woodEquiv0 = planks0 + logs0 * 4;
    const canPayForTable = woodEquiv0 >= 4;
    const lowWoodReserve = (!tableNear && !canPayForTable)
      || (woodEquiv0 < 4 && countItem(bot, 'stick') < 2)
      || (deepY >= 52 && (woodEquiv0 < 16 || (countItem(bot, 'crafting_table') < 1 && woodEquiv0 < 20)));
    if (lowWoodReserve && bot.game && bot.game.dimension === 'overworld') {
      log.skill(`ensure_tools: topping up backup wood reserve (logs=${logs0} planks=${planks0} stick=${countItem(bot, 'stick')} table=${countItem(bot, 'crafting_table')} y=${Math.round(deepY)})`);
      if (deepY < 50) {
        try { await reg.get('recover_surface').run(bot, {}); } catch (e) { log.warn(`ensure_tools: recover_surface threw ${String(e.message).slice(0, 80)}`); }
      }
      try { await reg.get('chop_trees').run(bot, { count: 6 }); } catch (e) { log.warn(`ensure_tools: chop_trees threw ${String(e.message).slice(0, 80)}`); }
      // Keep at least 2 logs intact as emergency wood while converting the rest to planks/table/sticks.
      try { await craftPlanks(bot); } catch (e) { log.warn(`ensure_tools: craftPlanks threw ${String(e.message).slice(0, 80)}`); }
      const logsNow = LOG_NAMES.reduce((s, n) => s + countItem(bot, n), 0);
      const planksNow = bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
      log.skill(`ensure_tools: wood resupply -> logs ${logs0}->${logsNow}, planks ${planks0}->${planksNow} (y=${Math.round(bot.entity.position.y)})`);
      if (!tableNear && logsNow * 4 + planksNow < 4) return { ok: false, observation: `no wood at the surface either (logs=${logsNow} planks=${planksNow}) - the pick ladder cannot be re-minted until trees are reachable` };
    }
    // Always keep at least 1 carried crafting_table and 8 backup sticks when wood allows.
    if (countItem(bot, 'crafting_table') < 1 && (bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0) >= 4)) {
      try { await craft(bot, 'crafting_table', 1); } catch {}
    }
    if (countItem(bot, 'stick') < 8 && (bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0) >= 4)) {
      try { await craft(bot, 'stick', 8); } catch {}
    }
    // Tier floor. A wooden pick IS a pickaxe and it was 54% healthy, so the old test said "tools are fine"
    // - but 1.21 drops NOTHING for an under-tier tool on iron ore: 06:28:57 `mine: broke iron_ore at
    // -232,7,1517 and the pack gained 0 (expected one of raw_iron)`, and the armour gate starved for 15
    // minutes on 14 ingots while the bot ate its own iron nodes for free. Stone is the first tier that pays.
    const ironCapable = () => bot.inventory.items().some(i => /^(stone|iron|diamond|netherite)_pickaxe$/.test(i.name)
      && ((ob.wear(bot, i) ?? 100) >= 8));
    if (!goodPicks().length || !bulkPicks().length || !ironCapable()) {
      if (!ironCapable()) log.warn(`ensure_tools: no pick that can harvest iron (picks=${bot.inventory.items().filter(i => /_pickaxe$/.test(i.name)).map(i => `${i.name}@${ob.wear(bot, i) ?? '?'}%`).join(',') || 'none'}) - minting a stone one before touching ore`);
      // mineflayer 4.39 has no repairItem(); an anvil costs XP we would rather spend on
      // enchanting, so a worn pick is simply replaced. But "replaced" was silently skipped for
      // four minutes on the acceptance run: craft(stone_pickaxe, 1) looks at the COUNT, and the
      // bot owned a 2% pick, so every call answered "already have stone_pickaxe x1" and returned.
      // equipPick refuses anything under 15%, so those tools are dead weight - discard them first.
      // A 2x2 grid cannot build a 3x3 recipe, and the fast path only uses a table within reach:
      // walk to the one we already placed so the stone pick craft has somewhere to happen.
      if (!bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 5 })) {
        const far = bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 32 });
        if (far) { try { await bot.pathfinder.goto(new (require('mineflayer-pathfinder').goals ? require('mineflayer-pathfinder').goals.GoalNear : require('mineflayer-pathfinder').pathfinder.Goals.GoalNear)(far.position.x, far.position.y, far.position.z, 2)); } catch {} }
      }
      if (countItem(bot, 'stick') < 2) await craft(bot, 'stick', 4);
      if (!bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 8 })) {
        const c = await craft(bot, 'crafting_table', 1);
        if (c.ok) { try { await bot.equip(bot.inventory.items().find(i => i.name === 'crafting_table'), 'hand'); } catch {} await placeAtFreeNeighbor(bot); }
      }
      // Grid clicks rather than bot.craft(): it still answers "missing ingredient" for recipes
      // whose inputs are plainly in the pack (227 cobblestone + 4 sticks for stone_pickaxe), and
      // that dead-ended the whole iron chain.
      const gcP = require('../gridcraft');
      for (const nm of ['stone_pickaxe', 'wooden_pickaxe', 'iron_pickaxe', 'diamond_pickaxe']) {
        // Cheap tiers are guaranteed against the CHEAP set: breaking on goodPicks() here is what let
        // a lone diamond pick count as "tools are fine". Stone is tried before wooden because this
        // pack has 16 cobblestone and no planks.
        const cheap = nm !== 'diamond_pickaxe';
        // The cheap branch used to break on "some pickaxe exists", which is exactly how a lone wooden pick
        // blocked the stone craft it needed: require the tier that actually harvests iron.
        if (cheap ? (bulkPicks().length && ironCapable()) : goodPicks().length) break;
        if (usableOf(nm) > 0) continue;
        const tbl = bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 6 });
        const win = tbl ? await gcP.openTable(bot, tbl) : null;
        const r = await gcP.craftGrid(bot, nm, 1, win);
        // The grid clicker can be blind to planks that countItem() sees (they sit in the cells of a
        // window that is no longer the one being scanned). bot.craft() reads the recipe book, so let
        // it finish the job rather than spin on "no birch_planks left in inventory" while the pack
        // shows 4 of them.
        if (!r || !r.made) {
          const f = await craft(bot, nm, 1);
          log.skill(`ensure_tools fallback craft ${nm}: ${f.ok ? 'ok' : 'failed'} (${f.observation})`);
        }
        // Close what we opened: a table window left here makes the next routine click the 2x2 grid
        // against the wrong window (see craftPlanks), which is how the plank pre-step froze at 00:42.
        if (win) { try { await bot.closeWindow(win); } catch {} }
        log.skill(`ensure_tools grid ${nm}: made=${r && r.made} have=${countItem(bot, nm)} (${r && r.observation})`);
      }
      // A wooden pick is only a bootstrap - it cannot take iron - so bank the cobble a stone pick
      // needs while we are still holding it. The ladder used to start at stone_pickaxe and answer
      // "no single item can satisfy c" for a pack that plainly had planks and sticks, which is the
      // dead end the acceptance run hit at 00:29 with inv={"birch_log":1,"stick":4}.
      // Exactly the three blocks 1.21.1 accepts for stone tools (three recipes in the data dump:
      // cobblestone / cobbled_deepslate / blackstone, plus 2 sticks). NOT stone, granite, diorite, andesite,
      // stone_bricks or any polished form - so a pack full of granite and bricks cannot make a pickaxe, and
      // the ladder must be told that instead of mining more bricks.
      const STONE_TOOL_MATS = ['cobblestone', 'cobbled_deepslate', 'blackstone'];
      const cobble = STONE_TOOL_MATS.reduce((n, m) => n + countItem(bot, m), 0);
      // Pay for the pick with what is ALREADY in the pack before going to mine more of it: at 10:14 the pack
      // held cobblestone 5 + stick 4 (a stone pickaxe is 3 + 2) and the routine still went off to mine 0
      // blocks and settled for repairing a wooden pick. Stone tools accept cobblestone/cobbled_deepslate.
      const bestPick = bot.inventory.items().filter(i => /_pickaxe$/.test(i.name))
        .sort((a, b) => (['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'].indexOf(a.name.split('_')[0]) - ['wooden', 'stone', 'iron', 'golden', 'diamond', 'netherite'].indexOf(b.name.split('_')[0]))).pop();
      const onlyWooden = !bestPick || bestPick.name.startsWith('wooden');
      if (cobble >= 3 && countItem(bot, 'stick') >= 2 && (!goodPicks().length || onlyWooden)) {
        try {
          const cr = await craft(bot, 'stone_pickaxe', 1);
          log.skill(`ensure_tools: crafted stone_pickaxe from stock (cobble=${cobble} stick=${countItem(bot, 'stick')}) -> ${cr.ok ? 'ok' : 'failed'} have=${countItem(bot, 'stone_pickaxe')}`);
        } catch (e) { log.skill(`ensure_tools stone_pickaxe craft threw: ${e.message}`); }
      } else if (!goodPicks().length || onlyWooden) {
        log.skill(`ensure_tools: cannot make a stone pickaxe - need 3 of cobblestone/cobbled_deepslate/blackstone + 2 sticks` +
          ` (have ctx cobble=${cobble} stick=${countItem(bot, 'stick')}); granite/diorite/andesite/stone_bricks do NOT work`);
      }
      if (goodPicks().length && cobble < 6 && bot.inventory.items().some(i => /_pickaxe$/.test(i.name))) {
        try {
          const m = await reg.get('mine').run(bot, { names: ['cobblestone', 'stone', 'cobbled_deepslate', 'blackstone'], count: 8, maxDistance: 24 });
          log.skill(`ensure_tools cobble bootstrap: ${m.observation}`);
        } catch (e) { log.skill(`ensure_tools cobble bootstrap threw: ${e.message}`); }
      }
      // Two damaged picks combine into one in the 2x2 grid for free, so do that before tossing or
      // re-crafting: the pack had stone_pickaxe@46% + wooden_pickaxe@76% and the ladder was spending
      // cobble and sticks on a third pick instead of merging two halves into a fresh one.
      try {
        const rp = await gcP.repairGear(bot, 55, /_(pickaxe|axe|sword|shovel|hoe)$/);
        if (rp.repaired.length) log.skill(`ensure_tools ${rp.observation}`);
      } catch {}
      // Discard dead picks only AFTER a replacement exists, and only below 5%: tossing everything
      // under 15% first left the bot with NO pickaxe at all - it mined coal bare-handed for six
      // minutes and could not smelt the iron for its own replacement.
      for (const it of bot.inventory.items().filter(i => i.name.endsWith('_pickaxe'))) {
        if (/^(diamond|netherite)_pickaxe$/.test(it.name)) continue;
        const w = ob.wear(bot, it);
        if (w !== null && w < 5 && goodPicks().length) {
          try { await bot.toss(it.type, null, it.count); log.skill(`ensure_tools discarded spent ${it.name}@${w}%`); } catch (e) { log.skill(`discard ${it.name}: ${e.message}`); }
        }
      }
      // Players carry a spare pickaxe; this bot repeatedly lost hours to a pick breaking mid-dig.
      // Keep a second usable one whenever the materials are trivially available.
      if (goodPicks().length < 2 && countItem(bot, 'cobblestone') >= 6 && countItem(bot, 'stick') >= 4) {
        // ask for one MORE than it has, or craft()'s own "already have" short-circuit refuses it
        await craft(bot, 'stone_pickaxe', goodPicks().length + 1);
      }
    }
    // If the pack already holds >=3 iron ingots and no usable iron+ pickaxe, upgrade right here
    // instead of leaving the bot stone-only when downstream diamond mining requires iron tier.
    const hasIronPlus = bot.inventory.items().some(i => /^(iron|diamond|netherite)_pickaxe$/.test(i.name) && ((ob.wear(bot, i) ?? 100) >= 15));
    if (!hasIronPlus && countItem(bot, 'iron_ingot') >= 3) {
      if (countItem(bot, 'stick') < 2) await craft(bot, 'stick', 4);
      if (countItem(bot, 'stick') >= 2) {
        const up = await craft(bot, 'iron_pickaxe', 1);
        log.skill(`ensure_tools: iron_ingot>=3 upgrade -> iron_pickaxe ${up.ok ? 'ok' : 'failed'} (${String(up.observation).slice(0, 80)})`);
      }
    }
    if (!goodPicks().length && ctx?.assist !== false && process.env.MC_ASSIST !== '0') {
      try { bot.chat('/give @s iron_pickaxe 2'); await sleep(1500); } catch {}
    }
    if (!bot.inventory.items().some(i => /sword$/.test(i.name))) {
      if (countItem(bot, 'stick') < 1) await craft(bot, 'stick', 4);
      await craft(bot, 'iron_sword', 1);
      if (!bot.inventory.items().some(i => /sword$/.test(i.name))) await craft(bot, 'stone_sword', 1);
    }
    await equipPick(bot);
    const ok = goodPicks().length > 0;
    return { ok, observation: `ensure_tools ${ok ? 'ok' : 'FAILED'}: picks=${goodPicks().map(i => i.name).join(',') || 'none'} before=[${before}] inv=${ob.invSummary(bot).slots}` };
  },
});

// Equip the best pickaxe the bot owns (also used internally before any digging).
async function equipPick(bot) {
  const picks = bot.inventory.items().filter(i => i.name.endsWith('_pickaxe'))
    .sort((a, b) => (ob.wear(bot, b) ?? 0) - (ob.wear(bot, a) ?? 0));
  if (!picks.length) return false;
  try { await bot.equip(picks[0], 'hand'); return true; } catch { return false; }
}
async function equipBestArmor(bot) {
  const slots = { helmet: 'head', chestplate: 'torso', leggings: 'legs', boots: 'feet' };
  const WORN = { helmet: 5, chestplate: 6, leggings: 7, boots: 8 }; // inventory-window slot ids
  for (const [part, dest] of Object.entries(slots)) {
    const cands = bot.inventory.items().filter(i => i.name.endsWith('_' + part));
    if (!cands.length) continue;
    cands.sort((a, b) => (ARMOR_TIERS[a.name.split('_')[0]] || 0) - (ARMOR_TIERS[b.name.split('_')[0]] || 0));
    const best = cands[cands.length - 1];
    if ((bot.inventory.slots[WORN[part]] || {}).name === best.name) continue;
    try { await bot.equip(best, dest); } catch { /* the click path below handles it */ }
    if (!bot.inventory.slots[WORN[part]]) {
      // 1.21: bot.equip() writes set_equip_slot and then waits for an updateSlot ack that the
      // server frequently never sends (mineflayer#3906). The piece stayed in the pack while the
      // armor milestone reported worn=[none] for twenty minutes with iron_boots in hand. Clicking
      // the slot is what a player does, and it lands.
      const src = bot.inventory.slots.findIndex(s => s && s.name === best.name);
      if (src < 0) continue;
      try {
        await Promise.race([Promise.resolve(bot.clickWindow(src, 0, 0)).catch(() => {}), sleep(2500)]);
        await sleep(150);
        await Promise.race([Promise.resolve(bot.clickWindow(WORN[part], 0, 0)).catch(() => {}), sleep(2500)]);
        await sleep(150);
        if (bot.inventory.cursor) { await Promise.race([Promise.resolve(bot.clickWindow(src, 0, 0)).catch(() => {}), sleep(2500)]); await sleep(120); }
        log.skill(`equipBestArmor clicked ${best.name} -> ${part} (worn=${!!bot.inventory.slots[WORN[part]]})`);
      } catch (e) { log.skill(`equipBestArmor click ${part} failed: ${e.message}`); }
    }
  }
}
// Underground 3x3-crafting workshop: at depth there is no open cell to place a table into,
// so carve a 2-high nook in whichever direction is solid, place the table on its floor and
// stand next to it. Every step logs, because "placed table nearby -> false" was undiagnosable.
// Same guard the endgame skills use: mineflayer calls can hang forever (pathfinder around an
// unreachable goal, a busy window), and a hung skill wedges the whole planner.
async function capped(promise, ms, label, onTimeout) {
  let done = false;
  const p = Promise.resolve(promise).then(v => { done = true; return v; }, e => { done = true; log.warn(`${label} threw ${e.message}`); return null; });
  const r = await Promise.race([p, new Promise(res => setTimeout(() => res({ __timeout: true }), ms))]);
  if (r && r.__timeout && !done) {
    log.warn(`${label} timed out (${ms}ms)`);
    // A capped-off pathfinder call does not die; it keeps owning the goal, so the next goto in the
    // same skill fails with "The goal was changed before it could be completed!" and roam looped on
    // that pair of messages every 20 s without walking anywhere. Give the caller a way to release it.
    try { if (onTimeout) onTimeout(); } catch {}
  }
  return r && r.__timeout ? null : r;
}

async function digWorkshop(bot) {
  const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
  // The bot often ends up on its own cobblestone pillar, where literally no neighbouring cell
  // has a floor to place against. Walk a few steps to level ground before declaring failure.
  const hasSite = () => {
    const f = bot.entity.position.floored();
    for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1]]) {
      const ground = bot.blockAt(f.offset(dx, -1, dz));
      const cell = bot.blockAt(f.offset(dx, 0, dz));
      if (ground && isSupport(ground) && cell && isPlaceable(cell.name)) return true;
    }
    return false;
  };
  // A capped-off goto does not die: it keeps holding the pathfinder goal, so the next attempt
  // throws "The goal was changed before it could be completed!" and this loop burned 5 x 10 s of
  // the armor milestone's 420 s budget without moving once. Stop the path around every attempt and
  // keep the wandering short - the dig-a-niche route below is what actually works underground.
  const stopPath = () => { try { bot.pathfinder.stop(); } catch {} };
  for (let i = 0; i < 2 && !hasSite(); i++) {
    const f = bot.entity.position.floored();
    const ang = Math.random() * Math.PI * 2;
    stopPath();
    await capped(bot.pathfinder.goto(new GN(f.x + Math.round(Math.cos(ang) * 7), f.y, f.z + Math.round(Math.sin(ang) * 7), 1)), 6000, 'walk to flat ground');
    stopPath();
    await sleep(300);
  }
  // Take the table into hand BEFORE any placement attempt. placeAtFreeNeighbor places whatever the
  // bot is holding, so with a pick equipped it tried to "place diamond_pickaxe" into the wall: the
  // server refuses (tools are not placeable), and digWorkshop burned its whole budget on refusals
  // while the milestone above it timed out at 180 s.
  {
    const tb = bot.inventory.items().find(i => i.name === 'crafting_table');
    if (tb) { try { await bot.equip(tb, 'hand'); } catch {} }
  }
  if (hasSite() && await placeAtFreeNeighbor(bot)) {
    const t0 = bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 8 });
    if (t0) return t0;
  }
  const ti = bot.inventory.items().find(i => i.name === 'crafting_table');
  if (!ti) { log.skill('workshop: no table item in inventory'); return null; }
  log.skill(`workshop: table slot=${ti.slot} (hotbar=${ti.slot >= 36 && ti.slot <= 44}) held=${bot.heldItem ? bot.heldItem.name : 'none'}`);
  try { await bot.equip(ti, 'hand'); } catch (e) { log.skill(`workshop: equip threw ${e.message}`); }
  if (!bot.heldItem || bot.heldItem.name !== 'crafting_table') {
    // fall back to selecting the hotbar slot that already holds it
    const hb = bot.inventory.items().find(i => i.name === 'crafting_table' && i.slot >= 36 && i.slot <= 44);
    if (hb) { try { await bot.setQuickBarSlot(hb.slot - 36); } catch {} }
  }
  const feet = bot.entity.position.floored();
  // Order matters: dig with the PICK, then hold the TABLE only for the placement. The old version
  // equipped the table first, so every dig was made swinging a crafting table - "Digging aborted"
  // then "Server refused to place oak_planks at ...: the block is still deepslate", i.e. it dug
  // nothing, placed whatever was actually in hand, and reported no table within reach.
  const pick = bot.inventory.items().filter(i => i.name.endsWith('_pickaxe'))
    .sort((a, b) => (ob.wear(bot, b) ?? 0) - (ob.wear(bot, a) ?? 0))[0];
  const holdTable = async () => {
    if (bot.heldItem && bot.heldItem.name === 'crafting_table') return true;
    const t = bot.inventory.items().find(i => i.name === 'crafting_table');
    if (!t) { log.skill('workshop: holdTable - no crafting_table in inventory'); return false; }
    if (t.slot >= 36 && t.slot <= 44) { try { await bot.setQuickBarSlot(t.slot - 36); } catch {} }
    else {
      const free = [36, 37, 38, 39, 40, 41, 42, 43, 44].find(s => !bot.inventory.slots[s]);
      if (free !== undefined) {
        await capped(bot.clickWindow(t.slot, 0, 0), 3000, 'pick up table');
        await capped(bot.clickWindow(free, 0, 0), 3000, 'table to hotbar');
        try { await bot.setQuickBarSlot(free - 36); } catch {}
      }
    }
    try { await bot.equip(t, 'hand'); } catch {}
    return !!(bot.heldItem && bot.heldItem.name === 'crafting_table');
  };
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const cell = bot.blockAt(feet.offset(dx, 0, dz));
    const head = bot.blockAt(feet.offset(dx, 1, dz));
    const floor = bot.blockAt(feet.offset(dx, -1, dz));
    if (!cell || !floor || !isSupport(floor)) continue;
    if (cell.name.includes('bedrock') || cell.name.includes('lava')) continue;
    if (pick) { try { await bot.equip(pick, 'hand'); } catch {} }
    for (const b of [cell, head]) {
      if (!b || isAir(b.name)) continue;
      for (let attempt = 0; attempt < 3; attempt++) {
        try { if (bot.pathfinder.isMoving()) bot.pathfinder.stop(); } catch {}
        try { await bot.dig(b); } catch (e) { log.skill(`workshop: dig ${b.name} threw ${e.message}`); }
        await sleep(250);
        const now = bot.blockAt(b.position);
        if (now && isAir(now.name)) break;
      }
    }
    await sleep(200);
    const cleared = bot.blockAt(feet.offset(dx, 0, dz));
    if (!cleared || !isPlaceable(cleared.name)) { log.skill(`workshop: cell (${dx},${dz}) still ${cleared ? cleared.name : 'null'} after digging`); continue; }
    if (!await holdTable()) break;
    try { await bot.placeBlock(floor, new Vec3(0, 1, 0)); } catch (e) { log.skill(`workshop: placeBlock threw ${e.message}`); }
    const placed = bot.blockAt(feet.offset(dx, 0, dz));
    log.skill(`workshop: after place (${dx},${dz}) = ${placed ? placed.name : 'null'}`);
    const t = bot.findBlock({ matching: blockIds(bot, ['crafting_table']), maxDistance: 6 });
    if (t) {
      try { await bot.pathfinder.goto(new GN(t.position.x, t.position.y, t.position.z, 1)); } catch {}
      log.skill(`workshop: table at ${t.position.x},${t.position.y},${t.position.z}`);
      return t;
    }
  }
  return null;
}

function isSupport(b) { return !!b && !isAir(b.name) && !b.name.includes('water') && !b.name.includes('lava')
  // plants and snow layers are not placeable faces; use pathfinder's own physical test
  && (b.boundingBox === undefined || b.boundingBox === 'block'); }
// A cell we can place a block INTO (air, or a replaceable plant that the server swaps out).
function isPlaceable(name) {
  return isAir(name) || /short_grass|tall_grass|^grass$|fern|_tulip$|^dandelion$|^poppy$|^blue_orchid$|^allium$|^azure_bluet$|^oxeye_daisy$|^cornflower$|lily_of_the_valley|^sunflower$|^lilac$|^rose_bush$|^peony$|^dead_bush$|^snow$|seagrass|^vine$|_sapling$|^torch$/.test(name || '');
}
// Place held item on a free, supported block adjacent to the bot. If the bot is cramped (e.g. in
// a mined tunnel with no open cell), dig one side block into air and place on its floor. Returns true.
async function placeAtFreeNeighbor(bot) {
  // A tool or weapon in hand cannot be placed, and the server just refuses - which is silent,
  // expensive failure mode for whoever called this expecting their own block to appear. Say so and
  // bail, so the caller's log names the real problem instead of a milestone timeout.
  const h = bot.heldItem;
  if (!h) {
    // An EMPTY hand used to sail past the tool test below and reach `placeBlock` anyway, producing
    // `must be holding an item to place` - the other half of the same silent-failure pair.
    log.skill('placeAtFreeNeighbor: nothing in hand to place - the caller must equip the block first');
    return false;
  }
  if (h && /_(pickaxe|axe|shovel|sword|hoe|shears|bow|trident|shield)$/.test(h.name)) {
    log.skill(`placeAtFreeNeighbor: holding ${h.name}, which is not placeable - equip the block first`);
    return false;
  }
  const feet = bot.entity.position.floored();
  const spots = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1], [2, 0], [0, 2], [-2, 0], [0, -2]];
  // pass 1: a naturally free, supported cell (air or replaceable plant)
  for (const [ox, oz] of spots) {
    const ground = bot.blockAt(feet.offset(ox, -1, oz));
    const above = bot.blockAt(feet.offset(ox, 0, oz));
    if (!ground || !above) continue;
    if (isSupport(ground) && isPlaceable(above.name)) {
      try { await bot.placeBlock(ground, new Vec3(0, 1, 0)); } catch { /* next */ }
      const check = bot.blockAt(feet.offset(ox, 0, oz));
      if (check && !isPlaceable(check.name)) return true;
    }
  }
  // pass 2: clear a side cell then place on its floor
  const held = bot.heldItem; // callers equip the block to place BEFORE calling, so grab the hand
  const pick = () => bot.inventory.items().filter(i => /pickaxe$|axe$/.test(i.name))
    .sort((a, b) => ({ diamond: 4, iron: 3, stone: 2, golden: 1, wooden: 0 }[a.name.split('_')[0]] || 0)
      - ({ diamond: 4, iron: 3, stone: 2, golden: 1, wooden: 0 }[b.name.split('_')[0]] || 0))[0];
  for (const [ox, oz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
    const cell = bot.blockAt(feet.offset(ox, 0, oz));
    const ground = bot.blockAt(feet.offset(ox, -1, oz));
    if (!cell || !ground || isAir(cell.name) || !isSupport(ground)) continue;
    if (cell.name.includes('bedrock') || cell.name.includes('lava') || cell.name.includes('water')) continue;
    // Dig with a pickaxe, then take the block back into hand. This was "furnace not placeable" at
    // y=-43 on the acceptance run: smelt equipped the furnace first, so pass 2 tried to break
    // deepslate holding a furnace - the dig never finished, all four cells failed, and every
    // smelt round (raw iron -> ingots -> gear -> armour) dead-ended behind it.
    const p = pick();
    if (p) { try { await bot.equip(p, 'hand'); } catch {} }
    try { await bot.dig(cell); } catch { if (held) { try { await bot.equip(held, 'hand'); } catch {} } continue; }
    await sleep(250);
    // Take the block back into hand and PROVE it landed there before asking the server to place it.
    // The re-equip is a `catch {}`, so when it failed the next line still ran with the dig pickaxe in
    // hand and the server answered `refused to place iron_pickaxe` - 41 of those in one 4 MB window,
    // every one of them looking like a terrain problem to whoever read the log next.
    if (held) { try { await bot.equip(held, 'hand'); } catch {} }
    if (!bot.heldItem || (held && bot.heldItem.name !== held.name)) {
      log.skill(`placeAtFreeNeighbor: hand holds ${bot.heldItem ? bot.heldItem.name : 'nothing'}, not the ${held ? held.name : 'intended block'} - skipping this cell`);
      continue;
    }
    try { await bot.placeBlock(ground, new Vec3(0, 1, 0)); } catch { continue; }
    const check = bot.blockAt(feet.offset(ox, 0, oz));
    if (check && !isAir(check.name)) return true;
  }
  return false;
}

// Pick up what a dig just dropped. `bot.collectBlock` is deliberately NOT loaded (its itemDrop handler
// auto-hijacks every dropped item and throws unhandled `destination full` / `assert.ok(item)` when the
// pack is full - see src/bot.js), yet two obsidian paths called `bot.collectBlock.collect(x)` inside a bare
// `catch {}`. Every one of those calls was a TypeError swallowed whole, so the drop just stayed where it
// fell: measured 05:09:08 on 2026-11-01, `dug at obsidian 160,65,764 -> count 0 -> 0` with a diamond pick
// in hand and the cell reading air - the block broke, the item never arrived, and the Nether portal's last
// cell stayed unbuilt for the want of one obsidian.
// The door is the one thing with no substitute, and "go up and find the material" recoveries do not know
// that: at 22:56 and 23:21 a `chop_trees` "no tree here" escalation lifted the bot off the portal column at
// y=30 and dropped it at y=63, ~100 blocks away - twice, cancelling a 26-block descent each time. Any
// surface-bound recovery can ask this first: null means "no open door near me, carry on".
function nearOpenDoor(bot, radius) {
  const d = diveAnchor(bot);
  if (!d) return null;
  const p = bot && bot.entity ? bot.entity.position : null;
  if (!p || !Number.isFinite(p.x) || !Number.isFinite(p.z)) return null;
  const dist = Math.round(Math.hypot(p.x - d.x, p.z - d.z));
  return dist <= (radius || 45) ? dist : null;
}

async function collectNear(bot, atPos, itemName, budgetMs = 9000) {
  const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
  const t0 = Date.now();
  for (let t = 0; t < 10 && Date.now() - t0 < budgetMs; t++) {
    const ents = Object.values(bot.entities || {});
    const drops = ents
      .filter(e => {
        try {
          if (e.name !== 'item' || !e.position) return false;
          if (e.position.distanceTo(atPos) > 10) return false;
          return !itemName || !e.item || e.item.name === itemName;
        } catch { return false; }
      })
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    if (!drops.length) { await sleep(250); continue; }
    const d = drops[0];
    try { await capped(bot.pathfinder.goto(new GN(d.position.x, d.position.y, d.position.z, 0.7)), 4000, 'walk to drop', () => { try { bot.pathfinder.stop(); } catch {} }); } catch {}
    if (!d.position || d.position.distanceTo(bot.entity.position) > 1.6) {
      // A goto that cannot path the drop's cell (it is often one inside a wall the bot just broke) used to
      // end the attempt silently, which is the same invisibility that hid `hunt killed cow` x198 with
      // leather=0. Brush toward it by hand instead.
      try {
        await bot.lookAt(d.position.offset(0.5, 0.2, 0.5), true);
        bot.setControlState('forward', true); await sleep(500); bot.setControlState('forward', false);
      } catch {}
    }
    await sleep(300);
    if (!Object.values(bot.entities || {}).includes(d)) return true;
  }
  return false;
}

// `bot.blockAt()` returns a block object for AIR as well, so `blockAt(a) || blockAt(b)` never falls
// through to b whenever a is merely loaded-and-empty. Every "or the cell under me" fallback written that
// way has been dead since the day it was written - live at 05:24:40, where the fortress sweep reported
// `fill=netherrack, the reference cell reads air` while the bot was standing on solid ground: the cell two
// steps ahead is air, so the cell under its feet was never considered and it refused to bridge.
// The first item in the pack that can fill a hole. A NAME allow-list (cobblestone|netherrack|dirt) is the
// wrong shape here: this world's Nether floor is soul_sand, soul_soil, gravel, basalt, andesite, diorite
// and tuff, and at 18:48 the bot that carried 82 soul_sand was told "no fill block in the pack" while
// standing 19 blocks from the first fortress it had found in thirteen hours. Ask the dataset whether the
// item IS a block, then refuse the things worth more than a causeway (tools, ammo, food, the portal's
// obsidian, the planks and sticks every recipe needs).
// `raw_*` and `*_ore` are in here because a raw-iron stack IS a placeable block (the server turns the
// `raw_iron` item into `raw_iron_block`) - which is how the bot built a column of floating ore into the
// sky while pillar-climbing: it mined a vein, the biggest stack in the pack became ore, and the climber
// paid for a ascent with iron it had already bled to smelt. `bed` for the same reason on the other side:
// the 1.21 item is `blue_bed` and `blocksByName.blue_bed` exists, so the bed by the portal was ONE
// biggest-stack away from being used as paving.
const FILL_DENY = /(pickaxe|axe$|sword|shovel|hoe|bucket|bow$|arrow|torch|ender_|_eye$|ingot|nugget|diamond|coal$|flake|ghast|blaze_|gunpowder|pearl|leather|string|feather|seeds|mutton|beef|porkchop|chicken|rabbit|cod|salmon|apple|bread|potato|carrot|melon|wheat$|crafting_table|furnace|chest$|pressure_plate|obsidian|_log$|_planks$|stick$|flint$|egg$|book|gold_nugget|quartz$|^raw_|_ore$|spawner|totem|shulker|dragon_egg|_bed$|beacon)/;
function cheapFill(bot, minCount) {
  let items = [];
  try { items = bot.inventory.items(); } catch { return null; }
  const need = Math.max(1, minCount || 1);
  const byName = (data(bot) || {}).blocksByName || {};
  // The BIGGEST passing stack, not the first one the slot scan happens to hit. Measured 01:53: the pack
  // held 109 netherrack while this returned `soul_sand x2`, so every "am I running dry" gate read the bot
  // as empty and it walked back and forth over its own causeway (136 -> 129 -> ...) instead of extending it.
  const ok = items.filter(i => !FILL_DENY.test(i.name) && !!byName[i.name] && (i.count || 1) >= need);
  return ok.sort((a, b) => (b.count || 1) - (a.count || 1))[0] || null;
}

// How many causeway cells the pack can actually pay for: the SUM over every usable fill stack.
// cheapFill answers "what goes in the hand"; the "about to run dry?" gates ask a different question, and
// answering it with one stack reported 31 while the pack held 62 - so at 02:01 the sweep bailed off its
// own causeway 44 blocks short of the fortress it had spent forty minutes reaching.
function cheapFillTotal(bot) {
  let items = [];
  try { items = bot.inventory.items(); } catch { return 0; }
  const byName = (data(bot) || {}).blocksByName || {};
  return items.reduce((s, i) => s + (!FILL_DENY.test(i.name) && byName[i.name] ? (i.count || 1) : 0), 0);
}

// "no pickaxe in the pack for stone - hand-digging it" is not a warning to shrug at: under-tier hands
// drop NOTHING for stone, deepslate, ore or end stone, so a descent with no pick buys 0 blocks and burns
// the whole step budget. Measured 01:16-01:30 live with the End door open 110 blocks away: `dig_to_y`
// sank y=48 -> y=46 by hand, both stone picks worn under 8%, and the step then went SILENT for 182 s -
// while 16 cobblestone and 9 sticks (a stone pick costs 3 + 2) sat in the pack uncrafted.
function usablePickCount(bot) {
  try {
    return bot.inventory.items().filter(i => /_pickaxe$/.test(i.name) && ((ob.wear(bot, i) ?? 100) >= 8)).length;
  } catch { return 0; }
}

// The nearest cell within `radius` that a body can stand on dry: solid non-fluid support, non-fluid feet,
// two empty cells above. Cubic, not spokes - the spoke version missed 90% of the box (see §29aq).
function nearestDryCell(bot, at, radius) {
  const V = require('vec3');
  const solid = (b) => !!b && b.boundingBox === 'block' && !/lava|water/.test(b.name);
  const fluid = (b) => !!b && /lava|water/.test(b.name);
  let best = null, bestD = Infinity;
  const r = Math.max(4, Math.min(24, radius || 16));
  for (let ax = -r; ax <= r; ax++) {
    for (let az = -r; az <= r; az++) {
      for (let dy = 6; dy >= -6; dy--) {
        const q = at.offset(ax, dy, az);
        let feet = null, floor = null, head = null;
        try { feet = bot.blockAt(q); floor = bot.blockAt(new V(q.x, q.y - 1, q.z)); head = bot.blockAt(new V(q.x, q.y + 1, q.z)); } catch { continue; }
        const sunk = solid(feet);                                   // standing inside a 15/16 block (soul sand)
        const onTop = !sunk && solid(floor) && !fluid(feet) && !(head && (solid(head) || fluid(head)));
        if (!(sunk || onTop)) continue;
        const dist = Math.abs(ax) + Math.abs(az) + Math.abs(dy);
        if (dist < bestD) { bestD = dist; best = { x: q.x, y: q.y, z: q.z, dist }; }
      }
    }
  }
  return best;
}

// mineflayer has NO `bot.yaw` - the rotation lives on `bot.entity.yaw`, and `bot.look(undefined, ...)`
// does not just no-op: physics.js line 347 is `bot.entity.yaw += Math.round((yaw - bot.entity.yaw)/s)*s`,
// so an undefined argument poisons the yaw with NaN, and the physics integrator then turns NaN yaw into a
// NaN position. Paper answered that with `multiplayer.disconnect.invalid_player_movement` at 21:45:25, and
// the 90 seconds before the kick printed `pos=NaN,50,NaN`, `salmon@NaN`, `no room on file` for a door that
// IS on file, and a plan to farm blaze rods. Read the yaw off the entity, and never let a non-finite one out.
function yawNow (bot) {
  const y = bot && bot.entity ? bot.entity.yaw : undefined;
  return typeof y === 'number' && Number.isFinite(y) ? y : 0;
}

// Break the surface BEFORE the breath is gone. Two existing guards were not enough: the planner kills a
// wet step at 20% of the air meter, and bot.js's own swim-up burst only fired at `oxygen <= 8` ticks -
// between those two lines the bot drowned with the escape still in hand (5x "ABORTED mid-step: out of air
// (oxygen=20)" between 16:00 and 16:17 on 2026-11-03, plus the `enter_end` lock on the same signature).
// This is the cooperative version of that burst: the caller keeps ownership of the retry, the path is
// stopped first so nothing fights the movement packets, the wait is bounded, and the log names the phase.
async function breathe (bot, label) {
  const f = bot.entity.position.floored();
  const inFluid = (p) => { const b = bot.blockAt(p); return !!b && /water|kelp_plant|seagrass|lava/.test(b.name); };
  if (!inFluid(f) && !inFluid(f.offset(0, 1, 0))) return { ok: true, dry: true, pulses: 0 };
  const airMax = Math.max(bot._airMax || bot._airMaxSeen || 10, 10);
  const air = (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel >= 0) ? bot.oxygenLevel : airMax;
  if (air > airMax * 0.6) return { ok: true, air, pulses: 0 };
  const until = Date.now() + 12000;
  try { if (bot.pathfinder.isMoving()) bot.pathfinder.stop(); } catch {}
  let surfaced = false, pulses = 0;
  while (Date.now() < until) {
    const g = bot.entity.position.floored();
    const headCell = bot.blockAt(g.offset(0, 1, 0));
    if (!headCell || !/water|lava/.test(headCell.name)) { surfaced = true; break; }
    try {
      await bot.look(yawNow(bot), -Math.PI / 2, true);
      bot.setControlState('jump', true);
      bot.setControlState('forward', true);
      await sleep(700);
      bot.setControlState('forward', false);
      bot.setControlState('jump', false);
      pulses++;
      // deliberately NOT touching bot.oxygenLevel here: the meter is the server's, and a locally inflated
      // reading would hide the very drown the planner guards against. The exit signal is the head cell.
    } catch (e) {
      try { bot.setControlState('forward', false); bot.setControlState('jump', false); } catch {}
      log.warn(`breathe (${label}) threw ${String(e.message).slice(0, 50)} - controls released`);
      break;
    }
  }
  const left = (typeof bot.oxygenLevel === 'number' && bot.oxygenLevel >= 0) ? bot.oxygenLevel : 0;
  log.warn(`breathe (${label}): ${pulses} surface pulse(s) from air=${air} -> ${left}, head ${surfaced ? 'clear of fluid' : `STILL under fluid with ${Math.max(0, Math.round((until - Date.now()) / 1000))}s of budget left`}`);
  return { ok: surfaced, pulses, air: left };
}

reg.define('breathe', {
  desc: 'Surface for air: stop the path, pulse jump until the head clears the fluid, report whether it did. Call it BEFORE a swim leg whenever the air meter is under 60% - not after the step has already been killed for drowning.',
  params: { label: 'what work is wet, for the log line' },
  async run (bot, a) {
    const r = await breathe(bot, a.label || 'wet work');
    return { ok: r.ok, observation: r.dry ? 'not in fluid, nothing to breathe' : (r.ok ? `surfaced after ${r.pulses} pulse(s), air=${r.air}` : `could not clear the fluid after ${r.pulses} pulse(s) - the ceiling is the problem, not the breath`) };
  },
});

function firstPhysical(bot, positions) {
  for (const q of positions) {
    let b = null;
    try { b = bot.blockAt(q); } catch { continue; }
    if (b && b.boundingBox === 'block' && !/lava|water/.test(b.name)) return b;
  }
  return null;
}

// Which cell holds the block the bot is standing ON. `position.floored()` is not that cell whenever the
// support has a sub-full hitbox (soul sand is 15/16 tall, as are farmland, snow layers and carpets): the
// feet position then sits inside the block itself, so p.offset(0,-1,0) reads air and every target computed
// as "one step ahead, one cell down" lands a level below the causeway. Measured 00:45-01:30: a bot on the
// soul-sand bridge it had just laid logged `feet=soul_sand own_floor=air`, so it found 0 usable reference
// faces, could not extend the bridge under its own feet, and spent 700 attempts on blaze_rods standing
// still. The floor cell is wherever the solid block actually is; standY is the air cell above it.
function standCells(bot) {
  const p = bot.entity.position.floored();
  let inFeet = null;
  try { inFeet = bot.blockAt(p); } catch {}
  const sunk = !!inFeet && inFeet.boundingBox === 'block' && !/lava|water/.test(inFeet.name);
  const floor = sunk ? p : p.offset(0, -1, 0);
  return { p, floor, standY: floor.y + 1, sunk: !!sunk };
}

// Step off a ledge the pathfinder refuses to descend: lay one cheap block into an adjacent empty floor
// cell (clicking the SIDE of the cell we stand on) and walk onto it. `roam` already detects "pinned" and
// tells its caller to "dig out sideways first" - but nothing owned the doing, so at -53,43,209 the bot sat
// for fifty minutes receiving a recommendation it could not act on. Pathfinder will not route a drop it
// considers unsafe, and in the Nether almost every ledge is such a drop.
// A recovery action that moves the bot has to be bounded in the dimension it moves through. The dig-down
// escape did its job at y=43 and kept doing it at y=4: with no lateral route and no fortress in sight,
// "dig DOWN" walked the bot to the Nether bedrock floor, which is a lava sea and a wall. The ceiling is
// the depth below which descending costs more than the problem it solves; the counter is total across
// calls and resets once the bot has actually travelled to a new chunk.
// One copy on purpose: the same "dry ground" test written twice in two files is what let a 22:35 fix miss
// the call site that mattered.
const DIG_DOWN_FLOOR = { the_nether: 22, overworld: -53, the_end: 0 };
let _digDown = { at: '', n: 0 };
function digDownAllowed(bot) {
  const p = bot.entity.position.floored();
  const floorY = DIG_DOWN_FLOOR[(bot.game && bot.game.dimension) || 'overworld'];
  const cap = floorY === undefined ? 10 : floorY;
  if (p.y <= cap) return { ok: false, why: `already at y=${p.y}, at or below the ${cap} floor for this dimension - further is bedrock and a lava sea` };
  const tag = `${p.x >> 4},${p.z >> 4}`;
  if (_digDown.at !== tag) _digDown = { at: tag, n: 0 };
  if (_digDown.n >= 6) return { ok: false, why: `already spent 6 dig-down escapes in chunk ${tag} without finding a route` };
  _digDown.n++;
  return { ok: true };
}

// Walk one cell without asking for a route. Pathfinder prices a lava neighbour as impassable, so a
// causeway block that was placed successfully is still "unreachable" to it - measured 19:30:17 at
// -257,25,102, where bridgeOut laid diorite at -256,24,102 with all four neighbours reading lava and
// reported `the pathfinder still would not step onto it`. A player in that spot does not request a path:
// they look at the block and press forward. Physics, not routing - and it is what makes bridging a lava
// sea actually traversable instead of a row of blocks that are laid and never walked.
async function stepOnto(bot, q, opts) {
  const V = require('vec3');
  const o = opts || {};
  const before = bot.entity.position.floored();
  // "垫着走"的前提是那一格已经被垫成干的落脚点。The old version walked toward ANY target, so at
  // -286,26,116 it stepped onto a cell whose support reads lava and landed in the sea: from there it can
  // neither dig (a fluid feet cell aborts every dig), nor place (no face to click), nor path, and the
  // only remaining move was to walk back - which it did, then stepped forward again. 02:58:07-10 is that
  // loop. So a destination with no dry support is refused BEFORE paying the 1.5 s walk.
  let feet = null, floor = null;
  // Callers pass either a Vec3 or a plain {x,y,z}, and `q.offset` on the plain form throws - which used to
  // leave floor null and refuse a perfectly dry destination. Compute the cell below by number, not by method.
  try { feet = bot.blockAt(q); } catch {}
  try { floor = bot.blockAt(new V(Math.floor(q.x), Math.floor(q.y) - 1, Math.floor(q.z))); } catch {}
  const solid = (b) => !!b && b.boundingBox === 'block' && !/lava|water/.test(b.name);
  const fluid = (b) => !!b && /lava|water/.test(b.name);
  // Two ways a cell is a foothold: standing ON a full block (support solid, feet not fluid), or standing
  // INSIDE the cell because that cell holds a sub-full block (soul sand 15/16, farmland, snow, carpets -
  // see standCells). A causeway over the lava sea is exactly the second case, so a flat "support must be
  // solid" rule would forbid walking on the bridges this bot builds.
  const sunk = solid(feet);                                   // the cell itself is the low support
  const onTop = !sunk && solid(floor) && !fluid(feet);         // the cell above a dry support
  if (!o.allowUnsafe && !sunk && !onTop) {
    return { moved: 0, to: before, refused: `destination ${q.x},${q.y},${q.z} is not a dry standing cell (feet=${feet ? feet.name : 'NULL'}, support=${floor ? floor.name : 'NULL'}) - fill it first` };
  }
  try { bot.pathfinder.stop(); } catch {}
  try { await bot.lookAt(new V(q.x + 0.5, q.y + 0.1, q.z + 0.5), true); } catch {}
  try {
    bot.setControlState('forward', true);
    await sleep(900);
    bot.setControlState('jump', true);
    await sleep(250);
    bot.setControlState('jump', false);
    await sleep(400);
  } catch {}
  try { bot.setControlState('forward', false); } catch {}
  const after = bot.entity.position.floored();
  return { moved: Math.abs(after.x - before.x) + Math.abs(after.z - before.z), to: after };
}

async function bridgeOut(bot, prefer) {
  const Vec3 = require('vec3');
  // Same dataset rule as cheapFill (a name allow-list here once told a bot carrying 82 soul_sand that it
  // had "no fill block in the pack"). The reason string now names the inventory read so a false "empty
  // pack" can be told apart from a genuinely blockless one at a glance.
  let items = [];
  try { const byName = (data(bot) || {}).blocksByName || {}; items = bot.inventory.items().filter(i => !FILL_DENY.test(i.name) && !!byName[i.name]); } catch { items = []; }
  if (!items.length) return { ok: false, why: `no fill block in the pack (${(() => { try { return bot.inventory.items().length; } catch (e) { return 'inventory read threw ' + e.message; } })()} stacks read)` };
  const f = bot.entity.position.floored();
  // The support is wherever standCells says it is: on a soul-sand causeway the floored feet position is
  // INSIDE the block being stood on, so `f.offset(0,-1,0)` reads the lava below the bridge and this skill
  // answered "the cell under me reads lava, which is nothing to click" while standing on its own bridge.
  const sc0 = standCells(bot);
  const own = bot.blockAt(sc0.floor);
  if (!own || own.boundingBox !== 'block' || /lava|water/.test(own.name)) {
    return { ok: false, why: `the cell under me reads ${own ? own.name : 'NULL'}, which is nothing to click` };
  }
  // Report the FOOT cells, not just the floors. The old verdict said "every side face refused (each
  // neighbour is already floor...)" at y=3 of a Nether lava sea, which was true and useless: the floors
  // are there, the cells you would walk into are lava. Without this the reader concludes there is
  // nowhere to bridge and the actual blocker - a lava sea at feet level - never appears.
  const why = [];
  const filled = [], noRoom = [], stalledAt = [], refused = [];
  const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
  // Direction ORDER matters. Called from the Nether sweep, the four sides were tried in a fixed order, so on
  // a lava shelf it happily filled the side BEHIND us: it bridged west one cell, bridgeOut stepped east one
  // cell, and 130 blocks of fill went in two minutes with the distance to the fortress pinned at 144-146
  // (04:44-04:46). Try the heading we are actually travelling along first and the reverse last.
  const SIDES = [[1, 0], [-1, 0], [0, 1], [0, -1]];
  const pf = Array.isArray(prefer) ? [(Math.sign(prefer[0]) || 0), (Math.sign(prefer[1]) || 0)] : null;
  const rankOf = ([a, b]) => !pf ? 1 : (a === pf[0] && b === pf[1] ? 0 : (a === -pf[0] && b === -pf[1] && (pf[0] || pf[1]) ? 3 : 1));
  const order = SIDES.slice().sort((x, y) => rankOf(x) - rankOf(y));
  for (const [dx, dz] of order) {
    const t = sc0.floor.offset(dx, 0, dz);   // the floor cell one step over, whatever level that is
    const tb = bot.blockAt(t);
    const foot = bot.blockAt(f.offset(dx, 0, dz));
    const side = dx > 0 ? '+x' : dx < 0 ? '-x' : dz > 0 ? '+z' : '-z';
    why.push(`${side}=${tb ? tb.name : 'NULL'}/${foot ? foot.name : 'NULL'}`);
    if (tb && tb.boundingBox === 'block' && !/lava|water/.test(tb.name)) {
      // A floor that exists is NOT a route. At -53,3,211 all four floors were solid and every FOOT cell
      // was lava or bedrock: the bot stood in a one-cell air pocket with a lava ceiling, and the old code
      // answered "floor already there" for all four sides, so it never once considered filling the cell it
      // would actually have to walk through. Fill the foot cell off the floor beneath it as the reference.
      // Lava only - this server refuses a block placed into water (the obsidian-farm lesson), and the
      // +z side here is bedrock, which no placement can change.
      if (foot && foot.name === 'lava') {
        // Headroom FIRST. Filling a lava cell we cannot stand on spends a block and walls the bot in -
        // that is precisely how -53,3,211 became a sealed pocket on 2026-11-01: three sides filled, all
        // three with bedrock or lava above, and the one open side had a bedrock roof. A fill is only a
        // move if there is somewhere to stand afterwards.
        const above = bot.blockAt(new Vec3(t.x, t.y + 2, t.z));
        if (above && above.boundingBox === 'block') { noRoom.push(`${side}:${above.name}`); continue; }
        const it = cheapFill(bot, 1);
        // No `|| items[0]`: the first slot is whatever the last mine happened to drop. Measured
        // 02:42:52 `Server refused to place beef at (-753,80,1150)` from the sibling climber that used
        // that fallback, and when the biggest stack is `raw_iron` the server does NOT refuse - it builds
        // a raw-iron column in the sky out of the iron this run needs for armour.
        if (!it) { refused.push(`${side}:no fill block in the pack (holds ${items.slice(0, 4).map(i => `${i.count}x${i.name}`).join(',') || 'nothing'})`); continue; }
        try {
          await bot.equip(it, 'hand');
          if (!bot.heldItem || bot.heldItem.name !== it.name) return { ok: false, why: `the hand would not take ${it.name}` };
          await capped(bot.placeBlock(tb, new Vec3(0, 1, 0)), 4000, 'fill foot cell');
        } catch (e) {
          // One refused side is not a refused cell: reach and facing differ per direction, so record it
          // and try the next instead of returning on the first throw.
          refused.push(`${side}:${String(e.message).slice(0, 60)}`);
          continue;
        }
        const now = bot.blockAt(f.offset(dx, 0, dz));
        if (now && now.boundingBox === 'block' && !/lava|water/.test(now.name)) {
          filled.push(`${side}=${now.name}`);
          try {
            await capped(bot.pathfinder.goto(new GN(t.x, t.y + 2, t.z, 1)), 6000, 'step over fill', () => { try { bot.pathfinder.stop(); } catch {} });
          } catch {}
          const p2 = bot.entity.position.floored();
          if (Math.abs(p2.x - f.x) + Math.abs(p2.z - f.z) >= 1 || p2.y > f.y) {
            return { ok: true, moved: `filled the ${side} lava at ${t.x},${t.y + 1},${t.z} with ${now.name} and stepped onto it (${p2.x},${p2.y},${p2.z})` };
          }
          stalledAt.push(`${side}:would not step`);
          continue;
        }
        refused.push(side);   // placement refused by the server for this side; try the next
        continue;
      }
      continue;   // floor already there
    }
    const head = bot.blockAt(new Vec3(t.x, t.y + 1, t.z));
    if (head && !isAir(head.name) && head.boundingBox === 'block') continue;         // no room to stand
    const it = cheapFill(bot, 1);
    // Same rule as the lava fill above: never pave with the first slot. A bridge laid with `raw_iron`
    // looks like progress in the log and costs a stack of armour iron; a bridge that cannot be paid for
    // is an honest `ok:false` that sends the caller to mine cobblestone instead.
    if (!it) return { ok: false, why: `no fill block in the pack to bridge with (holds ${items.slice(0, 4).map(i => `${i.count}x${i.name}`).join(',') || 'nothing'}) - mine cobblestone/dirt for paving, do not spend ore or the bed` };
    try {
      await bot.equip(it, 'hand');
      if (!bot.heldItem || bot.heldItem.name !== it.name) return { ok: false, why: `the hand would not take ${it.name}` };
      await capped(bot.placeBlock(own, new Vec3(dx, 0, dz)), 4000, 'bridge out');
    } catch (e) { return { ok: false, why: `placeBlock threw ${e.message}` }; }
    const now = bot.blockAt(t);
    if (now && now.boundingBox === 'block' && !/lava|water/.test(now.name)) {
      try { await capped(bot.pathfinder.goto(new GN(t.x, t.y + 1, t.z, 1)), 6000, 'step onto bridge', () => { try { bot.pathfinder.stop(); } catch {} }); } catch {}
      const p2 = bot.entity.position.floored();
      if (Math.abs(p2.x - f.x) + Math.abs(p2.z - f.z) >= 1) {
        return { ok: true, moved: `stepped ${p2.x - f.x},${p2.z - f.z} onto the ${now.name} just laid at ${t.x},${t.y},${t.z}` };
      }
      // The router said no, so walk it by hand (see stepOnto). This is the difference between a bridge
      // that exists and a bridge that is crossed.
      const st = await stepOnto(bot, { x: t.x, y: t.y + 1, z: t.z });
      if (st.moved >= 1) return { ok: true, moved: `direct-stepped ${st.moved} onto the ${now.name} laid at ${t.x},${t.y},${t.z} (pathfinder refused it)` };
      return { ok: false, why: `laid ${now.name} at ${t.x},${t.y},${t.z} but neither the pathfinder nor a direct step moved me (now ${st.to.x},${st.to.y},${st.to.z})` };
    }
  }
  // Every outcome gets a clause, including "I did nothing because there was no headroom" - the old shape
  // dropped noRoom entirely when no block had been placed, which is exactly the case the reader needs.
  const bits = [];
  if (filled.length) bits.push(`filled ${filled.join(',')}`);
  if (noRoom.length) bits.push(`no headroom above ${noRoom.join(',')}`);
  if (stalledAt.length) bits.push(`laid but would not step: ${stalledAt.join(',')}`);
  if (refused.length) bits.push(`server refused: ${refused.join(' / ')}`);
  const fillNote = bits.length ? ` | ${bits.join('; ')}` : '';
  return { ok: false, why: `no side to bridge (neighbours as floor/foot: ${why.join(' ')})${fillNote}` };
}

module.exports = { data, blockIds, itemId, countItem, craft, craftPlanks, sleep, LOG_NAMES, placeAtFreeNeighbor, digWorkshop, equipBestToolFor, isAir, isSupport, dropJunk, freeSlots, equipBestArmor, nearestHeadland, nearestLandPatch, collectNear, firstPhysical, standCells, nearestDryCell, bridgeOut, digDownAllowed, cheapFill, cheapFillTotal, usablePickCount, stepOnto, breathe, yawNow, nearOpenDoor };
