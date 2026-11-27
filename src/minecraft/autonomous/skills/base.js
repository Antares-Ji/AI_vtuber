'use strict';
// Base-camp skills: the two moves a player makes that this run had no word for -
//  (1) sleep somewhere near the work, so a death costs two seconds instead of 700 blocks, and
//  (2) carry the workshop, so a descent does not abandon a crafting table it will need an hour later.
// Both are pure survival mechanics: no /give, no /tp, no /setblock, so they hold on the acceptance
// instance too (docs/OPTIMIZATION.md §26bb names the respawn point as the single biggest remaining tax;
// §19 blames the craft chain's 3x3 recipes on tables left behind underground).
const cfg = require('../config');
const fs = require('fs');
const path = require('path');
const Vec3 = require('vec3');
const reg = require('./registry');
const log = require('../log');
const P = require('./primitives');
const { countItem, craft, blockIds, sleep, isAir } = P;
const WS = require('../workshopRecord');

const BASE_FILE = path.join(cfg.paths.runs, 'base.json');
const loadBase = () => { try { return JSON.parse(fs.readFileSync(BASE_FILE, 'utf8')) || {}; } catch { return {}; } };
const saveBase = (o) => { try { fs.writeFileSync(BASE_FILE, JSON.stringify(o, null, 1)); } catch (e) { log.warn(`base.json save threw ${e.message}`); } };

const isReplaceable = (b) => !b || (b.name !== 'bedrock' && (b.boundingBox === 'empty' || /grass|flower|snow|water|air/.test(b.name)));
const isFloor = (b) => !!(b && b.boundingBox === 'block' && !/lava|water/.test(b.name));
const NIGHT = (b) => { try { const t = b.time && b.time.day; return typeof t === 'number' && t >= 12541 && t <= 23458; } catch { return false; } };

reg.define('forward_base', {
  desc: 'Set a respawn point at the work site the survival way: gather 3 wool (hunt sheep, or craft from spider string) + 3 planks, craft a bed, place it on dry flat ground near where the bot is actually working, and sleep. Sleeping also skips the night. Call with {sleepOnly:true} just to sleep in a bed that already exists, or {carry:true} to make the bed and KEEP it in the pack (the End dive wants it carried to the portal room, not spent wherever this call landed).',
  params: { sleepOnly: 'bool - only try to sleep in the recorded bed', radius: 'int default 40 - how far to look for a level dry site from here', wool: 'int default 3', onlyIfReady: 'bool - fail instantly unless the bed inputs are ALREADY in the pack (no wandering for wool mid-a-job)', carry: 'bool - craft the bed and stop; do not place or sleep' },
  async run(bot, a) {
    const base = loadBase();
    const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
    const deadline = bot._stepDeadline && bot._stepDeadline > Date.now() + 5000
      ? bot._stepDeadline - 5000 : Date.now() + 150000;
    const woolCount0 = () => ['white_wool', 'red_wool', 'blue_wool', 'green_wool', 'black_wool']
      .reduce((s, n) => s + countItem(bot, n), 0);
    // A bed already in the pack IS the thing this step exists to place. 1.21.1 names it `blue_bed`, not
    // `bed`, so nothing used to look for it: with a bed in hand the step still asked for wool, then for
    // planks, and went off to chop a tree at (-172,64,1475) - 40 blocks from the stronghold shaft - because
    // `acacia_planks` had been trimmed to 1. Ask for the bed first, everywhere.
    const ownsBed = () => bot.inventory.items().some(i => /_bed$/.test(i.name));
    if (a.onlyIfReady) {
      // A bed is worth minutes once and hours saved forever, but not worth turning a harvest round into
      // a sheep hunt. Only proceed when the inputs are already carryable from this pack.
      const craftable = Math.floor(countItem(bot, 'string') / 4);
      let planks = bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
      // Planks are ONE 2x2 click away from the logs sitting in the same pack. Refusing the bed at
      // `planks=2` while `oak_log:4` was in slot 9 (live 07:52:32, wool=4 planks=2) is the same shape as
      // the old "wool=0" refusal: the inputs were carried, just not minted - and the cost of skipping the
      // bed is a 46-block climb back to the surface after every death in the End.
      if (planks < 3 && (P.LOG_NAMES || []).some(n => countItem(bot, n) > 0)) {
        const cp = await P.craftPlanks(bot);
        planks = bot.inventory.items().filter(i => /_planks$/.test(i.name)).reduce((s, i) => s + i.count, 0);
        log.skill(`forward_base: minted planks from the carried logs -> planks=${planks} (craftPlanks ${cp && cp.ok ? 'ok' : 'no'})`);
      }
      // A bed already carried satisfies this guard on its own - it is the thing being placed.
      if ((woolCount0() + craftable < 3 || planks < 3) && !ownsBed()) {
        return { ok: false, observation: `bed inputs not in hand (wool=${woolCount0()} +string-craftable=${craftable}, planks=${planks}) - do not detour for a bed now` };
      }
    }

    const bedAt = async (blockPos) => {
      const blk = bot.blockAt(blockPos);
      if (!blk || !/_bed$|^bed$/.test(blk.name)) return { ok: false, observation: `nothing bed-like at ${blockPos.x},${blockPos.y},${blockPos.z}` };
      try { await bot.pathfinder.goto(new GN(blockPos.x, blockPos.y, blockPos.z, 2)); } catch {}
      // mineflayer's sleep() THROWS outside night instead of waiting, and refuses when a hostile mob is
      // within its own monster box. Neither is a dead end, so name which one it was.
      if (!NIGHT(bot)) return { ok: false, observation: `bed is set but it is day (day=${Math.round(bot.time.day)}) - cannot sleep yet` };
      try {
        await Promise.race([bot.sleep(blk), sleep(30000).then(() => { throw new Error('sleep ack never came') })]);
        try { bot.isSleeping = false; await bot.wake(); } catch {}
        // Positive evidence, not optimism: after a real sleep the server advances time to dawn.
        const t = Math.round(bot.time.day);
        const slept = t < 12541 || t > 23458;
        log.skill(`forward_base: slept in the bed at ${blockPos.x},${blockPos.y},${blockPos.z} -> day=${t} (${slept ? 'time advanced, respawn point is set' : 'time did NOT advance - the bed probably did not take'})`);
        return { ok: slept, observation: slept ? `slept at ${blockPos.x},${blockPos.y},${blockPos.z}, day=${t}` : `bed accepted the sleep but the clock did not move (day=${t})` };
      } catch (e) {
        return { ok: false, observation: `sleep refused: ${e.message}` };
      }
    };

    if (a.sleepOnly) {
      if (!base.bed) return { ok: false, observation: 'no bed on file - run forward_base without sleepOnly to build one' };
      return await bedAt(new Vec3(base.bed.x, base.bed.y, base.bed.z));
    }

    // ---- inputs ----
    const needWool = a.wool || 3;
    const woolCount = () => ['white_wool', 'red_wool', 'blue_wool', 'green_wool', 'black_wool']
      .reduce((s, n) => s + countItem(bot, n), 0);
    if (!ownsBed() && woolCount() < needWool) {
      if (countItem(bot, 'string') >= 4) {
        const want = Math.ceil((needWool - woolCount()) / 1);
        const c = await craft(bot, 'white_wool', Math.min(want, Math.floor(countItem(bot, 'string') / 4)));
        log.skill(`forward_base: string -> wool (${String(c.observation).slice(0, 120)})`);
      }
      if (woolCount() < needWool) {
        // Sheep live on Overworld grass, and shopping for a bed at the door costs the descent: measured
        // 17:35:18 the roam walked toward a herd 200 blocks away from the shaft, and `locate_stronghold`
        // answered by /tp-ing the bot 86 blocks back - walk away, teleport back, repeat. A bed has to be
        // carried in from the surface, so where the bot is standing decides whether the hunt is allowed.
        const dim = (bot.game && bot.game.dimension) || 'overworld';
        if (dim !== 'overworld' || bot.entity.position.y < 60) {
          return { ok: false, observation: `no bed and no wool here (dim=${dim}, y=${Math.round(bot.entity.position.y)}, string=${countItem(bot, 'string')}): sheep are not walked for from the shaft - carry a bed down from the surface BEFORE the descent instead of hunting at the door` };
        }
        log.skill(`forward_base: ${woolCount()} wool, need ${needWool} - walking the herds`);
        try { await reg.get('roam').run(bot, { look_for: 'sheep,cow', distance: 200, arrive: 18 }); } catch {}
        try { await reg.get('hunt').run(bot, { count: 3, kind: 'sheep' }); } catch {}
        if (woolCount() < needWool) {
          try { await reg.get('roam').run(bot, { look_for: 'spider,cave_spider', distance: 120, arrive: 14 }); } catch {}
          const sp = bot.nearestEntity(e => e && /spider/.test(e.name) && e.position && bot.entity.position.distanceTo(e.position) < 20);
          if (sp) { try { const sw = bot.inventory.items().find(i => /_sword$/.test(i.name)); if (sw) await bot.equip(sw, 'hand'); await Promise.race([bot.pvp.attack(sp), sleep(12000)]); } catch {} }
          if (countItem(bot, 'string') >= 4) await craft(bot, 'white_wool', Math.floor(countItem(bot, 'string') / 4));
        }
      }
    }
    if (!ownsBed() && woolCount() < needWool) return { ok: false, observation: `only ${woolCount()} wool and ${countItem(bot, 'string')} string - no bed yet (hunt sheep or spiders)` };
    if (!ownsBed() && P.countItem(bot, 'birch_planks') + P.countItem(bot, 'oak_planks') + P.countItem(bot, 'spruce_planks') + P.countItem(bot, 'jungle_planks') + P.countItem(bot, 'acacia_planks') + P.countItem(bot, 'dark_oak_planks') + P.countItem(bot, 'mangrove_planks') + P.countItem(bot, 'cherry_planks') < 3) {
      try { await P.craftPlanks(bot); } catch {}
    }

    // ---- craft the bed ----
    let bedItem = bot.inventory.items().find(i => /_bed$/.test(i.name));
    if (!bedItem) {
      const c = await craft(bot, 'white_bed', 1);
      log.skill(`forward_base: craft bed -> ${String(c.observation).slice(0, 160)}`);
      bedItem = bot.inventory.items().find(i => /_bed$/.test(i.name));
    }
    if (!bedItem) return { ok: false, observation: `cannot craft a bed (wool=${woolCount()} planks=${countItem(bot, 'birch_planks') + countItem(bot, 'oak_planks')}: see the craft line above)` };
    // `carry` stops here: the End route wants the bed IN the pack so it can be planted beside the
    // portal, not spent on whatever spot this call happened to stand in.
    if (a.carry) {
      log.skill(`forward_base: bed carried (${bedItem.name}) - not placed, the portal room is where it is wanted`);
      return { ok: true, observation: `carrying a bed (${bedItem.name}) - not placed here; place it at the portal room before the dive` };
    }

    // ---- site: dry, flat, two cells of headroom, near where the work actually is ----
    const here = bot.entity.position.floored();
    const rad = Math.max(4, a.radius || 40);
    // Stronghold masonry has to count as a floor or the bed can never be placed where it is
    // wanted: the portal room and its corridors are stone brick, and without these four the
    // search only answers "no dry flat site within 40 blocks" while standing in the room.
    const floorIds = blockIds(bot, ['grass_block', 'dirt', 'stone', 'cobblestone', 'sand', 'gravel', 'cobbled_deepslate', 'deepslate', 'moss_block', 'podzol', 'mycelium',
      'stone_bricks', 'mossy_stone_bricks', 'cracked_stone_bricks', 'chiseled_stone_bricks']);
    let site = null;
    for (let r = 0; r <= rad && !site; r += 3) {
      for (const [dx, dz] of [[r, 0], [-r, 0], [0, r], [0, -r], [r, r], [-r, -r], [r, -r], [-r, r]]) {
        const x = here.x + dx, z = here.z + dz;
        for (let y = Math.min(here.y + 4, 90); y >= here.y - 6; y--) {
          const fl = bot.blockAt(new Vec3(x, y - 1, z));
          if (!isFloor(fl) || !floorIds.includes(fl.type)) continue;
          const c1 = bot.blockAt(new Vec3(x, y, z));
          const c2 = bot.blockAt(new Vec3(x, y + 1, z));
          const c3 = bot.blockAt(new Vec3(x, y + 2, z));
          if (isReplaceable(c1) && isReplaceable(c2) && isReplaceable(c3)) { site = { x, y, z, floor: fl }; break; }
        }
      }
    }
    if (!site) return { ok: false, observation: `no dry flat two-cell-high site within ${rad} blocks of ${here.x},${here.y},${here.z} - the ground here is water or roofed in` };
    try { await bot.pathfinder.goto(new GN(site.x, site.y, site.z, 1)); } catch (e) { log.warn(`forward_base: walk to the bed site threw ${e.message}`); }
    // The bed needs its second half free too; place against the floor we verified.
    // 17:53:09 measured the failure - `bed did not land at -220,14,1483 (the second half was blocked or
    // the hand was not the bed)` - and that guess was the whole diagnosis. On 1.21 the half that usually
    // dies is `bot.equip` (the set_equip ack never arrives, mineflayer#3906), so verify the hand before
    // spending the click and say which of the two it was.
    let handOk = false;
    for (let t = 0; t < 2 && !handOk; t++) {
      try { await bot.equip(bedItem, 'hand'); } catch {}
      handOk = !!(bot.heldItem && /_bed$/.test(bot.heldItem.name));
    }
    if (!handOk) {
      return { ok: false, observation: `the hand would not take the ${bedItem.name} (it holds ${bot.heldItem ? bot.heldItem.name : 'nothing'}) - the bed is still in the pack at site ${site.x},${site.y},${site.z}; this is the equip path, not a missing bed` };
    }
    try {
      await bot.placeBlock(site.floor, new Vec3(0, 1, 0));
    } catch (e) { log.skill(`forward_base: place at ${site.x},${site.y},${site.z} threw ${String(e.message).slice(0, 90)}`); }
    await sleep(500);
    let placed = null;
    for (const [dx, dz] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const b = bot.blockAt(new Vec3(site.x + dx, site.y, site.z + dz));
      if (b && /_bed$|^bed$/.test(b.name)) { placed = b.position; break; }
    }
    if (!placed) return { ok: false, observation: `bed did not land at ${site.x},${site.y},${site.z} (the second half was blocked or the hand was not the bed)` };
    saveBase({ bed: { x: placed.x, y: placed.y, z: placed.z }, at: new Date().toISOString(), dim: bot.game.dimension });
    log.skill(`forward_base: bed placed at ${placed.x},${placed.y},${placed.z} - respawn point is the work site now once it sleeps`);
    const s = await bedAt(placed);
    return s.ok ? s : { ok: true, observation: `bed placed at ${placed.x},${placed.y},${placed.z}; ${s.observation}` };
  },
});

reg.define('stow_workshop', {
  desc: 'Break a nearby placed crafting_table / furnace and take it back into the pack, so a descent does not leave the 3x3 recipes stranded in a tunnel (the obsidian/armor chains kept paying a 45 s walk back - or a whole surfacing - for a table it had already placed and forgotten). Verifies the item actually lands in the inventory.',
  params: { radius: 'int default 24', take: 'e.g. crafting_table,furnace default both', leaveBed: 'bool - do not break the bed' },
  async run(bot, a) {
    // 24 was too small to be useful: the tables this run leaves behind sit 30-60 blocks away, and a
    // caller that does not pass a radius got `no crafting_table within 24 blocks to pick up` every time.
    const radius = Math.max(4, a.radius || 64);
    const want = String(a.take || 'crafting_table,furnace').split(',').map(s => s.trim());
    const before = {};
    for (const n of ['crafting_table', 'furnace']) before[n] = countItem(bot, n);
    let taken = [];
    for (const name of want) {
      let blk = null;
      try { blk = bot.findBlock({ matching: blockIds(bot, [name]), maxDistance: radius }); } catch { blk = null; }
      if (!blk) {
        // Blind in the loaded chunks is not "it does not exist". The craft chain prints the coordinates
        // of every table it has ever seen; walk back to that cell and look again before giving up.
        const rem = WS.at(name);
        if (rem) {
          const off = Math.round(Math.hypot(rem.x - bot.entity.position.x, rem.y - bot.entity.position.y, rem.z - bot.entity.position.z));
          log.skill(`stow_workshop: no ${name} loaded within ${radius} - walking to the remembered cell ${rem.x},${rem.y},${rem.z} (${off} away)`);
          try { await reg.get('walk_to').run(bot, { x: rem.x, y: rem.y, z: rem.z, tolerance: 4 }); } catch { }
          try { blk = bot.findBlock({ matching: blockIds(bot, [name]), maxDistance: Math.max(radius, 24) }); } catch { blk = null; }
          if (!blk) { const b2 = bot.blockAt(new Vec3(rem.x, rem.y, rem.z)); if (b2 && b2.name === name) blk = b2; }
          if (!blk) {
            // The chunk says otherwise -> the memory is wrong, not the world. Drop it so the next round
            // does not keep walking to a cell that holds air, obsidian or somebody else's block.
            const seen = bot.blockAt(new Vec3(rem.x, rem.y, rem.z));
            log.warn(`stow_workshop: the remembered ${name} at ${rem.x},${rem.y},${rem.z} reads ${seen ? seen.name : 'NULL'} - forgetting it`);
            try { WS.forget(name); } catch { }
          }
        }
      }
      if (!blk) continue;
      try {
        const pick = bot.inventory.items().find(i => /_pickaxe$|_axe$/.test(i.name)) || bot.inventory.items().find(i => /pickaxe|axe/.test(i.name));
        if (pick) await bot.equip(pick, 'hand');
        await bot.pathfinder.goto(new ((require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear)(blk.position.x, blk.position.y, blk.position.z, 1));
        await bot.dig(blk);
      } catch (e) { log.warn(`stow_workshop: digging the ${name} at ${blk.position.x},${blk.position.y},${blk.position.z} threw ${String(e.message).slice(0, 80)}`); continue; }
      await sleep(400);
      const now = countItem(bot, name);
      if (now > before[name]) { try { WS.forget(name); } catch { } taken.push(`${name}@${blk.position.x},${blk.position.y},${blk.position.z} (+${now - before[name]})`); }
      else log.warn(`stow_workshop: broke a ${name} at ${blk.position.x},${blk.position.y},${blk.position.z} but the pack count stayed ${now} - it did not come back`);
    }
    return taken.length
      ? { ok: true, observation: `stowed ${taken.join('; ')}; free slots=${P.freeSlots(bot)}` }
      : { ok: false, observation: `no ${want.join('/')} within ${radius} blocks to pick up` };
  },
});

module.exports = { BASE_FILE, loadBase };

// Crossing open water is what actually kills this run's schedule. At 07:01:52 the obsidian step was
// aborted `out of air (oxygen=0)` while wading, and the documented history is full of crossings that
// cost hours or a dozen deaths. A player does not swim 400 blocks with a bucket - they lay a causeway
// at the surface and walk. Sea level here is y=62-63, so a block placed at 63 replaces the water and
// leaves the cell above it (feet at 64) dry air: that is a walkway.
reg.define('bridge_to', {
  desc: 'Lay a causeway of cheap stone across open water toward an absolute target, one block per step at the surface, and walk on it. Use when a crossing is long (>50 blocks) instead of swimming it. Keeps 8 blocks of rock in reserve and stops when the pack has nothing to build with.',
  params: { x: 'int', z: 'int', max: 'int default 40 blocks', y: 'int default the bot`s own level' },
  async run(bot, a) {
    const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
    const V = (x, y, z) => new Vec3(x, y, z);
    const BUILD = ['cobblestone', 'cobbled_deepslate', 'granite', 'andesite', 'diorite', 'tuff', 'stone', 'netherrack', 'blackstone'];
    const reserve = 8;
    const available = () => BUILD.reduce((s, n) => s + countItem(bot, n), 0);
    const totalExceptReserve = () => Math.max(0, available() - reserve);
    const max = Math.max(1, a.max || 40);
    const budgetMs = Number(process.env.BRIDGE_BUDGET_MS || 150000);
    const t0 = Date.now();
    let placed = 0, why = 'goal reached', consecutiveRefusals = 0;
    let prevPos = bot.entity.position.floored();
    while (placed < max && Date.now() - t0 < budgetMs && Date.now() < (bot._stepDeadline || Infinity)) {
      const f = bot.entity.position.floored();
      if (Math.hypot(f.x - prevPos.x, f.z - prevPos.z) > 14 || Math.abs(f.y - prevPos.y) > 8) {
        why = `relocated/respawned mid-bridge (${prevPos.x},${prevPos.y},${prevPos.z} -> ${f.x},${f.y},${f.z})`;
        log.warn(`bridge_to: ${why}`);
        break;
      }
      prevPos = f;
      const dx = a.x - f.x, dz = a.z - f.z;
      if (Math.hypot(dx, dz) <= 6) { why = 'within 6 of the target'; break; }
      if (totalExceptReserve() <= 0) { why = `build rock exhausted (keeping ${reserve} in reserve)`; break; }
      // Head toward the target on the dominant axis, one cell at a time.
      const sx = Math.abs(dx) >= Math.abs(dz) ? Math.sign(dx) : 0;
      const sz = sx === 0 ? Math.sign(dz) : 0;
      // "Below sea level, bridge at y=63" is an Overworld rule: down there the point of a causeway is to
      // get UP to the surface. The Nether has no such surface - for a bot at y=31 the rule picked a level
      // 32 blocks overhead, so the blocks it laid could not be walked and the errand ended as "build rock
      // exhausted". Build at the level actually under the bot's feet (its own support cell, which is not
      // f.y-1 on a soul-sand bridge), and honour an explicit y.
      const nether = !!(bot.game && bot.game.dimension === 'the_nether');
      const level = Number.isInteger(a.y) ? a.y : (nether ? require('./primitives').standCells(bot).floor.y : (f.y >= 62 ? f.y : 63));
      const cell = V(f.x + sx, level, f.z + sz);
      const here = bot.blockAt(V(f.x, level, f.z));
      const cur = bot.blockAt(cell);
      const up = bot.blockAt(V(cell.x, cell.y + 1, cell.z));
      const dry = cur && cur.boundingBox === 'block' && !/water|lava/.test(cur.name);
      if (dry && up && isReplaceable(up)) {
        // The next cell is already walkable: just move onto it.
        try { await bot.pathfinder.goto(new GN(cell.x, cell.y + 1, cell.z, 0)); } catch {
          try { await bot.setControlState('forward', true); await sleep(350); await bot.setControlState('forward', false); } catch {}
        }
        placed++;
        continue;
      }
      // A SUBMERGED target is not buildable here, and pretending otherwise is the stall: the old code
      // treated water as "replaceable", attempted it, took `Server refused to place cobblestone at
      // (62, 61, 34): the block is still water` (08:24) / the same at (117,61,22) (09:17), then
      // `continue`d and burned the whole 150 s budget re-refusing. Fail fast and name the reason, so
      // the crossing is planned around dry columns instead of around a build the server forbids.
      if (cur && /water/.test(cur.name)) {
        const land = P.nearestHeadland(bot);
        why = `cell ${cell.x},${cell.y},${cell.z} is a submerged water source and this server will not let a block replace it - no causeway here${land ? `, but dry standing rock is at ${land.x},${land.y},${land.z} (${land.d} blocks)` : ', and no rock with its top above y=62 within 24 blocks'}; a crossing needs dry columns end to end`;
        log.warn(`bridge_to: ${why}`);
        break;
      }
      if (!cur || !isReplaceable(cur) || (up && !isReplaceable(up) && up.boundingBox === 'block')) { why = `cell ${cell.x},${cell.y},${cell.z} reads ${cur ? cur.name : 'null'} (not fillable)`; break; }
      // Reference: only ORTHOGONALLY adjacent solid non-liquid blocks with valid non-zero face normals
      // (previously index 1 was diagonal (f.x, level-1, f.z) with face=(0,0,0), causing an infinite loop
      // of "invalid direction vector (0, 0, 0)" refusals!).
      const cands = [
        [V(cell.x, cell.y - 1, cell.z), new Vec3(0, 1, 0)],
        [V(cell.x - sx, cell.y, cell.z - sz), new Vec3(sx, 0, sz)],
        [V(cell.x, cell.y + 1, cell.z), new Vec3(0, -1, 0)],
      ];
      let ref = null, face = null;
      for (const [p, normal] of cands) {
        if (!normal || (normal.x === 0 && normal.y === 0 && normal.z === 0)) continue;
        const b = bot.blockAt(p);
        if (b && b.boundingBox === 'block' && !/water|lava/.test(b.name)) {
          ref = b;
          face = normal;
          break;
        }
      }
      if (!ref) { why = `nothing solid to build against near ${cell.x},${cell.y},${cell.z} (deep water)`; break; }
      const item = bot.inventory.items().filter(i => BUILD.includes(i.name)).sort((x, y) => y.count - x.count)[0];
      if (!item) { why = `no ${BUILD.slice(0, 3).join('/')} left in the pack`; break; }
      try { await bot.equip(item, 'hand'); } catch {}
      if (!bot.heldItem || bot.heldItem.name !== item.name) { why = `hand is ${bot.heldItem ? bot.heldItem.name : 'empty'}, not ${item.name}`; break; }
      try { await bot.placeBlock(ref, face); consecutiveRefusals = 0; } catch (e) {
        why = `place at ${cell.x},${cell.y},${cell.z} refused: ${String(e.message).slice(0, 70)}`;
        log.warn(`bridge_to: ${why}`);
        if (++consecutiveRefusals >= 3) break;
        // One refusal is not the end - nudge sideways and try once more from a different reference.
        try { await bot.setControlState('forward', true); await sleep(250); await bot.setControlState('forward', false); } catch {}
        continue;
      }
      await sleep(200);
      const put = bot.blockAt(cell);
      if (!put || put.boundingBox !== 'block') { log.warn(`bridge_to: ${cell.x},${cell.y},${cell.z} still reads ${put ? put.name : 'null'} after placing`); continue; }
      placed++;
      if (placed % 5 === 0 || placed === 1) {
        const left = Math.hypot(a.x - bot.entity.position.x, a.z - bot.entity.position.z);
        log.skill(`bridge_to: ${placed} block(s) laid, causeway at ${cell.x},${cell.y},${cell.z}, ${Math.round(left)} left to ${a.x},${a.z} (rock ${available()})`);
      }
      try { await bot.pathfinder.goto(new GN(cell.x, cell.y + 1, cell.z, 0)); } catch {
        try { await bot.setControlState('forward', true); await sleep(350); await bot.setControlState('forward', false); } catch {}
      }
    }
    const left = Math.round(Math.hypot(a.x - bot.entity.position.x, a.z - bot.entity.position.z));
    return { ok: placed > 0, observation: `causeway laid ${placed} block(s), ${left} left to ${a.x},${a.z}, stopped: ${why}` };
  },
});

// The last metre of the obsidian chain, as a player does it. docs/OPTIMIZATION.md §26y/§26dd: the pool
// chemistry works (pour -> obsidian in ~10 s) but every collection attempt ends either drowned
// (`ABORTED mid-step: out of air (oxygen=2)`) or in a 240 s wet dig that never breaks the block, because
// the cells around the lava are water. The run's only answer so far has been "cool the site and give up",
// which is how obsidian sat at 5/10 for five hours. A player piles two cobblestones into the pool edge
// and stands on them. That is this skill.
reg.define('build_ledge', {
  desc: 'Place a dry standing shelf beside a lava pool so the obsidian can be broken with the head above water. Picks a water/air cell within reach of a lava source whose top is level with the bot and dry, fills it with whatever stone is in the pack, then stands on it. Use before giving up on a submerged pool.',
  params: { x: 'int - lava cell x (optional; else nearest lava source)', y: 'int', z: 'int', radius: 'int default 10', blocks: 'default cobblestone,cobbled_deepslate,granite,andesite,diorite,tuff,netherrack' },
  async run(bot, a) {
    const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
    const V = (x, y, z) => new Vec3(x, y, z);
    const STONE = String(a.blocks || 'cobblestone,cobbled_deepslate,granite,andesite,diorite,tuff,netherrack').split(',');
    const haveStone = () => STONE.map(n => ({ n, c: countItem(bot, n) })).filter(s => s.c > 0).sort((x, y) => y.c - x.c)[0] || null;
    const lavaCells = () => {
      if (a.x !== undefined && a.y !== undefined && a.z !== undefined) {
        const b = bot.blockAt(V(a.x, a.y, a.z));
        return b && /lava/.test(b.name) ? [b] : [];
      }
      let ps = [];
      try { ps = bot.findBlocks({ matching: blockIds(bot, ['lava']), maxDistance: a.radius || 10, count: 24 }); } catch { return []; }
      return ps.map(p => bot.blockAt(p)).filter(b => b && /lava/.test(b.name));
    };
    const lv = lavaCells();
    if (!lv.length) return { ok: false, observation: `no lava cell within ${a.radius || 10} blocks to build beside` };
    const st = haveStone();
    if (!st) return { ok: false, observation: `nothing to build a shelf with - pack has no ${STONE.join('/')}` };
    const feet = bot.entity.position.floored();
    // Try the cells a player would fill: the ring around the lava at the level that puts the bot's head
    // above water - one below its own feet, same as feet, and the lava's own level.
    const cands = [];
    for (const l of lv) {
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2], [1, 1], [-1, -1], [1, -1], [-1, 1]]) {
        for (const dy of [-1, 0, 1, 2]) {
          const y = feet.y + dy;
          const cell = V(l.position.x + dx, y, l.position.z + dz);
          const c = bot.blockAt(cell);
          const up1 = bot.blockAt(V(cell.x, cell.y + 1, cell.z));
          const up2 = bot.blockAt(V(cell.x, cell.y + 2, cell.z));
          if (!isReplaceable(c) || !isReplaceable(up1) || !isReplaceable(up2)) continue;
          // The two cells ABOVE the shelf must be AIR, not water. The first version accepted
          // "replaceable" there, so it happily built the standing shelf at the water surface line and
          // the bot stood in the flow - and moving in water cancels a dig at its very start:
          // 07:28:02 -> 07:30:24 burned a full 150 s cap on 112,9,772 with `Digging aborted`.
          if (!isAir(up1 && up1.name) || !isAir(up2 && up2.name)) continue;
          if (up1 && /lava/.test(up1.name)) continue;
          const below = bot.blockAt(V(cell.x, cell.y - 1, cell.z));
          const ref = isFloor(below) ? { blk: below, face: V(0, 1, 0) } : (() => {
            for (const [rx, ry, rz] of [[1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1]]) {
              const nb = bot.blockAt(V(cell.x + rx, cell.y + ry, cell.z + rz));
              if (isFloor(nb)) return { blk: nb, face: V(-rx, -ry, -rz) };
            }
            return null;
          })();
          if (!ref) continue;
          const reach = bot.entity.position.distanceTo(V(cell.x, cell.y + 1, cell.z));
          const lavaGap = Math.hypot(cell.x - l.position.x, (cell.y + 1 - l.position.y), cell.z - l.position.z);
          if (reach > 4.5 || lavaGap > 4.2) continue;
          cands.push({ cell, ref, reach, lavaGap, dry: !/water/.test(up1.name) && !/water/.test(up2.name) });
        }
      }
    }
    cands.sort((x, y) => (y.dry - x.dry) || (x.lavaGap - y.lavaGap) || (x.reach - y.reach));
    // 06:52:54 named this skill in a wedge (`LOOP WEDGED: no iteration for 389s in phase
    // "decide:build_ledge" (step budget 180s)`) - a helper that outruns the step calling it is the old
    // "recovery action becomes the fault" pattern, so it stops inside its own budget instead of stacking
    // four 60 s path waits.
    // helper that outruns the step it was called from is the old "recovery action becomes the fault"
    // pattern, so it now stops inside its own budget and says so instead of stacking four 60s path waits.
    const BUDGET = Number(process.env.LEDGE_BUDGET_MS || 75000);
    const startedAt = Date.now();
    const spent = () => Date.now() - startedAt;
    if (!cands.length) return { ok: false, observation: `no fillable shelf cell within reach of the lava at ${lv[0].position.x},${lv[0].position.y},${lv[0].position.z} (floor/air/reach all failed) - this pool really is walled in` };
    let lastWhy = '';
    for (const c of cands.slice(0, 4)) {
      if (spent() > BUDGET) {
        lastWhy = `out of budget after ${Math.round(spent() / 1000)}s before reaching ${c.cell.x},${c.cell.y},${c.cell.z}`;
        log.warn(`build_ledge: ${lastWhy} - stopping with whatever shelf already exists`);
        break;
      }
      const item = bot.inventory.items().find(i => i.name === st.n);
      if (!item) { lastWhy = 'stone vanished from the pack'; break; }
      try { await bot.equip(item, 'hand'); } catch (e) { lastWhy = `equip ${st.n} threw ${e.message}`; continue; }
      if (!bot.heldItem || bot.heldItem.name !== st.n) { lastWhy = `hand is ${bot.heldItem ? bot.heldItem.name : 'empty'}, not ${st.n}`; continue; }
      try { await bot.placeBlock(c.ref.blk, c.ref.face); } catch (e) { lastWhy = `place at ${c.cell.x},${c.cell.y},${c.cell.z} refused: ${String(e.message).slice(0, 70)}`; continue; }
      await sleep(300);
      const put = bot.blockAt(c.cell);
      if (!put || put.boundingBox !== 'block') { lastWhy = `${c.cell.x},${c.cell.y},${c.cell.z} still reads ${put ? put.name : 'null'} after the place`; continue; }
      try { await bot.pathfinder.goto(new GN(c.cell.x, c.cell.y + 1, c.cell.z, 0)); } catch (e) { lastWhy = `could not step onto the new shelf: ${String(e.message).slice(0, 70)}`; }
      await sleep(250);
      const f2 = bot.entity.position.floored();
      const fBlk = bot.blockAt(f2), hBlk = bot.blockAt(V(f2.x, f2.y + 1, f2.z));
      const dryHead = !(fBlk && /water|lava/.test(fBlk.name)) && !(hBlk && /water|lava/.test(hBlk.name));
      if (dryHead && Math.abs(f2.y - (c.cell.y + 1)) <= 1) {
        log.skill(`build_ledge: shelf built at ${c.cell.x},${c.cell.y},${c.cell.z} (${put.name}), standing at ${f2.x},${f2.y},${f2.z} with a dry head - obsidian here can be taken`);
        // The shelf outlives the step that built it - the cobblestone is in the world. Recording it
        // means a later round (or a step that ran out of budget before the pour, 18:22:41-43) can go
        // straight back to the workable interface instead of cooling the pool as "no dry stand".
        try {
          // `lv[0]` is a Block in one call path and a position in another; reading `.x/.y/.z` off the
          // wrong shape wrote `"lava":{}` (seen at 20:34:59), which silently disabled the pairing half of
          // the shelf waiver in obsidian_farm. Normalize through `.position` when present.
          const l0 = lv[0], lq = l0 && (l0.position || l0);
          fs.writeFileSync(path.join(cfg.paths.runs, 'shelf.json'), JSON.stringify({
            x: c.cell.x, y: c.cell.y, z: c.cell.z,
            stand: { x: f2.x, y: f2.y, z: f2.z },
            lava: lq && Number.isFinite(lq.x) ? { x: Math.floor(lq.x), y: Math.floor(lq.y), z: Math.floor(lq.z) } : null,
            ts: Date.now(),
          }));
        } catch (e) { log.warn(`shelf.json save threw ${e.message}`); }
        return { ok: true, observation: `dry work shelf at ${c.cell.x},${c.cell.y},${c.cell.z}, bot at ${f2.x},${f2.y},${f2.z}` };
      }
      lastWhy = `stood at ${f2.x},${f2.y},${f2.z} but feet/head read ${fBlk ? fBlk.name : 'null'}/${hBlk ? hBlk.name : 'null'}`;
      log.warn(`build_ledge: shelf at ${c.cell.x},${c.cell.y},${c.cell.z} placed yet ${lastWhy} - trying the next cell`);
    }
    return { ok: false, observation: `tried ${Math.min(4, cands.length)} shelf cells beside the lava and none ended dry (${lastWhy})` };
  },
});

// Fishing: the ocean answer to "no livestock nearby", which this bot did not have.
// 04:37-04:43 on 2026-10-31: `food` kept re-opening with `edible=0 meter=0/20 fuel coal=17 logs=0` while
// the bot stood at y=63 in open sea, roaming 200-block legs for a cow that does not exist on a turtle
// bay; hp fell to 10 and it stayed alive only because the assist cast resistance. It had coal AND a
// furnace the entire time. A rod needs no bait in Minecraft and the sea is full of fish, so the missing
// thing was the move, not another roam.
reg.define('fish', {
  desc: 'Craft a fishing rod if the pack lacks one, cast into adjacent open water and reel the catch in. The ocean-biome answer to "no land animal reachable"; cook the catch after (the pack usually has coal and a furnace).',
  params: { count: 'int default 2', timeoutSec: 'int default 75' },
  budgetMs: 240000,
  async run(bot, a) {
    const want = a.count ?? 2;
    const capMs = Math.max(20000, (a.timeoutSec ?? 75) * 1000);
    const FISH = ['cod', 'salmon', 'tropical_fish', 'pufferfish'];
    const fishCount = () => FISH.reduce((s, n) => s + countItem(bot, n), 0);
    const before = fishCount();
    // Announce the attempt immediately. The first live run (route #fish at 04:51:04) produced NO line
    // at all until a cast finished, and a cast can wait 60 s for a bite - so a firing route was
    // indistinguishable from one that never ran, which is exactly the blind spot I keep getting told to
    // close. Every early return below also names itself.
    log.skill(`fish: enter - have ${before} fish, want ${want}, hp=${Math.round(bot.health * 10) / 10} at ${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)}, rod=${bot.inventory.items().some(i => i.name === 'fishing_rod') ? 'yes' : 'no'}`);
    if (bot.health < 8) return { ok: false, observation: `hp=${Math.round(bot.health * 10) / 10} is too low to stand still and fish - heal first` };
    let rod = bot.inventory.items().find(i => i.name === 'fishing_rod');
    if (!rod) {
      if (countItem(bot, 'stick') < 3) {
        const st = await reg.get('grid_craft').run(bot, { item: 'stick', count: 4 });
        log.skill(`fish: sticks for a rod -> (${String(st.observation).slice(0, 110)})`);
      }
      const c = await craft(bot, 'fishing_rod', 1);
      log.skill(`fish: craft fishing_rod -> ${c.ok ? 'ok' : 'failed'} (${String(c.observation).slice(0, 120)})`);
      rod = bot.inventory.items().find(i => i.name === 'fishing_rod');
      if (!rod) return { ok: false, observation: `no fishing_rod and could not make one (sticks=${countItem(bot, 'stick')} string=${countItem(bot, 'string')}; the recipe wants 3 sticks + 2 string): ${String(c.observation).slice(0, 120)}` };
    }
    const findAdjacentWater = async (allowIceBreak = false) => {
      const f = bot.entity.position.floored();
      for (const [dx, dz] of [[2, 0], [-2, 0], [0, 2], [0, -2], [1, 0], [-1, 0], [0, 1], [0, -1], [3, 0], [-3, 0], [0, 3], [0, -3]]) {
        for (const dy of [0, 1, -1, -2]) {
          const b = bot.blockAt(f.offset(dx, dy, dz));
          if (!b || b.name !== 'water') continue;
          const above = bot.blockAt(b.position.offset(0, 1, 0));
          if (!above || isAir(above.name)) return b.position;
        }
      }
      if (allowIceBreak) {
        // Frozen ocean/river: break 1-2 adjacent ice blocks covering water to open a clear sky-lit ice-fishing hole.
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
          for (const dy of [0, -1, 1, -2]) {
            const ice = bot.blockAt(f.offset(dx, dy, dz));
            if (!ice || ice.name !== 'ice') continue;
            const under = bot.blockAt(ice.position.offset(0, -1, 0));
            const top = bot.blockAt(ice.position.offset(0, 1, 0));
            if (under && under.name === 'water' && (!top || isAir(top.name) || top.name === 'snow')) {
              try {
                await P.equipBestToolFor(bot, ice);
                await bot.dig(ice);
                // Widen by 1 neighboring ice block so the bobber arcs cleanly into open water
                for (const [nx, nz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                  const adj = bot.blockAt(ice.position.offset(nx, 0, nz));
                  const adjUnder = adj && bot.blockAt(adj.position.offset(0, -1, 0));
                  if (adj && adj.name === 'ice' && adjUnder && adjUnder.name === 'water'
                    && bot.entity.position.distanceTo(adj.position) <= 4.0) {
                    try { await bot.dig(adj); } catch {}
                    break;
                  }
                }
                await sleep(250);
                const opened = bot.blockAt(ice.position);
                if (opened && opened.name === 'water') {
                  log.skill(`fish: broke ice at ${ice.position.x},${ice.position.y},${ice.position.z} to open fishing hole`);
                  return opened.position;
                }
                return under.position;
              } catch {}
            }
          }
        }
      }
      return null;
    };
    let water = await findAdjacentWater(true);
    if (!water) {
      // Water is often 8-30 blocks away on coastal islands (live 23:10: bot stood at 155,65,-324
      // holding a rod while open ocean sat 10 blocks away at 155,-334). Walk to a dry shoreline cell
      // next to open (or ice-covered) surface water instead of failing on the 3-block check.
      try {
        const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
        const pts = (bot.findBlocks({ matching: blockIds(bot, ['water']), maxDistance: 36, count: 64 }) || [])
          .map(p => bot.blockAt(p))
          .filter(b => {
            if (!b || b.name !== 'water') return false;
            const ab = bot.blockAt(b.position.offset(0, 1, 0));
            return !ab || isAir(ab.name) || ab.name === 'ice';
          })
          .sort((a, b) => {
            const aa = bot.blockAt(a.position.offset(0, 1, 0));
            const ba = bot.blockAt(b.position.offset(0, 1, 0));
            const aOpen = (!aa || isAir(aa.name)) ? 0 : 1;
            const bOpen = (!ba || isAir(ba.name)) ? 0 : 1;
            // Always prefer sky-lit surface water (y>=56) over underground dark cave pools (2x bite penalty + drowning trap)!
            const aSurf = a.position.y >= 56 ? 0 : 1;
            const bSurf = b.position.y >= 56 ? 0 : 1;
            return aSurf - bSurf
              || aOpen - bOpen
              || bot.entity.position.distanceTo(a.position) - bot.entity.position.distanceTo(b.position);
          });
        if (pts.length) {
          // Prefer a dry solid bank cell 1-2 blocks beside the open water so we cast from shore instead of swimming.
          let target = null;
          for (const w of pts.slice(0, 12)) {
            for (const [ox, oz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [2, 0], [-2, 0], [0, 2], [0, -2]]) {
              const bank = bot.blockAt(w.position.offset(ox, 0, oz));
              const head1 = bot.blockAt(w.position.offset(ox, 1, oz));
              const head2 = bot.blockAt(w.position.offset(ox, 2, oz));
              if (isFloor(bank) && (!head1 || isAir(head1.name) || head1.name === 'snow') && (!head2 || isAir(head2.name))) {
                target = { x: bank.position.x, y: bank.position.y + 1, z: bank.position.z, r: 1 };
                break;
              }
            }
            if (target) break;
          }
          if (!target) target = { x: pts[0].position.x, y: pts[0].position.y + 1, z: pts[0].position.z, r: 2 };
          log.skill(`fish: walking to shoreline ${target.x},${target.y},${target.z} to cast into open water at ${pts[0].position.x},${pts[0].position.y},${pts[0].position.z}`);
          let shoreTimer = null;
          try {
            await Promise.race([
              bot.pathfinder.goto(new GN(target.x, target.y, target.z, target.r)),
              new Promise((_, rej) => { shoreTimer = setTimeout(() => rej(new Error('goto shore timed out')), 18000); }),
            ]);
          } catch {} finally {
            if (shoreTimer) clearTimeout(shoreTimer);
          }
          water = await findAdjacentWater(true);
        }
      } catch {}
    }
    const f = bot.entity.position.floored();
    if (!water) return { ok: false, observation: `no water cell within 3 blocks to cast into (standing at ${f.x},${f.y},${f.z}) - this is a land spot, hunt or find kelp instead` };
    try { await bot.equip(rod, 'hand'); } catch {}
    if (!bot.heldItem || bot.heldItem.name !== 'fishing_rod') {
      return { ok: false, observation: `the rod never reached the hand (holding ${bot.heldItem ? bot.heldItem.name : 'nothing'}) - refusing to report a cast that could not happen` };
    }
    let totalCaught = 0, eatenDuring = 0, casts = 0, lastErr = '';
    const t0 = Date.now();
    const lease = require('../stepLease');
    // 1.21.1-safe cast helper: Mineflayer's built-in bot.fish() only checks particle.amount===6 and never
    // listens to 1.21.1 fishing_bobber metadata[9] (biting=true), nor does it reel in on timeout (so every
    // timeout leaves the bobber floating and immediately cancels the next cast). Listen to BOTH metadata[9]
    // and splash particles, and always reel in cleanly on bite or timeout!
    const HOSTILE_FISH_FOES = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|spider|cave_spider|creeper|witch|pillager|phantom|slime)$/;
    const nearestThreat = (r = 7) => {
      try {
        return bot.nearestEntity(e => e && e.position && HOSTILE_FISH_FOES.test(e.name || '')
          && bot.entity.position.distanceTo(e.position) <= r
          && Math.abs(e.position.y - bot.entity.position.y) <= 4);
      } catch { return null; }
    };
    const castOnce = (castCap) => {
      if (!bot._client || typeof bot.activateItem !== 'function' || typeof bot.on !== 'function') {
        let fishTimer = null;
        return Promise.race([
          bot.fish(),
          new Promise((_, rej) => { fishTimer = setTimeout(() => rej(new Error(`no bite within ${Math.round(castCap / 1000)}s`)), castCap); }),
        ]).finally(() => { if (fishTimer) clearTimeout(fishTimer); });
      }
      return new Promise((resolve, reject) => {
        let done = false;
        let bobber = null;
        let timer = null;
        let threatPoll = null;
        const hpStart = typeof bot.health === 'number' ? bot.health : 20;
        const cleanup = () => {
          if (timer) { clearTimeout(timer); timer = null; }
          if (threatPoll) { clearInterval(threatPoll); threatPoll = null; }
          try { bot.removeListener('entitySpawn', onSpawn); } catch {}
          try { bot.removeListener('entityUpdate', onUpdate); } catch {}
          try { bot.removeListener('entityGone', onGone); } catch {}
          try { bot._client.removeListener('world_particles', onParticles); } catch {}
        };
        const finish = (err, reel = false) => {
          if (done) return;
          done = true;
          cleanup();
          if (reel) { try { bot.activateItem(); } catch {} }
          if (err) reject(err);
          else resolve();
        };
        const onSpawn = (ent) => {
          if (!ent || bobber) return;
          const nm = String(ent.name || '').toLowerCase();
          if (nm === 'fishing_bobber' || nm === 'fishing_hook') {
            if (!ent.position || !bot.entity?.position || ent.position.distanceTo(bot.entity.position) < 8) {
              bobber = ent;
            }
          }
        };
        const onUpdate = (ent) => {
          if (!ent) return;
          if (!bobber && /fishing_(bobber|hook)/i.test(String(ent.name || ''))) bobber = ent;
          if (!bobber || ent.id !== bobber.id) return;
          // Minecraft 1.21.1 FishingHook DATA_BITING = metadata index 9 (boolean true while fish is biting!)
          if (Array.isArray(ent.metadata) && ent.metadata[9] === true) {
            finish(null, true);
          }
        };
        const onParticles = (pkt) => {
          if (!bobber || !bobber.position || !pkt) return;
          const pType = String(pkt.particle?.type || pkt.particleName || '');
          const cnt = pkt.amount ?? pkt.particles ?? 0;
          if ((pType === 'fishing' || pType === 'bubble' || pType === 'splash') && cnt >= 4) {
            const dx = (pkt.x || 0) - bobber.position.x;
            const dz = (pkt.z || 0) - bobber.position.z;
            if (Math.hypot(dx, dz) <= 1.6) finish(null, true);
          }
        };
        const onGone = (ent) => {
          if (bobber && ent && ent.id === bobber.id) {
            bobber = null;
            finish(new Error('bobber vanished before bite'), false);
          }
        };
        bot.on('entitySpawn', onSpawn);
        bot.on('entityUpdate', onUpdate);
        bot.on('entityGone', onGone);
        if (typeof bot._client.on === 'function') bot._client.on('world_particles', onParticles);
        // Never stand defenseless holding a fishing rod while a zombie/spider attacks at night!
        threatPoll = setInterval(() => {
          if (lease.stale()) return finish(new Error('lease stale'), !!bobber);
          if (typeof bot.health === 'number' && (bot.health <= 0 || bot.health < hpStart - 2.5)) {
            return finish(new Error('attacked while fishing'), !!bobber);
          }
          if (bot.entity?.position && bot.entity.position.distanceTo(water) > 7) {
            return finish(new Error('moved away from fishing water'), !!bobber);
          }
          const foe = nearestThreat(6.5);
          if (foe) return finish(new Error(`hostile ${foe.name} within 6.5m`), !!bobber);
        }, 500);
        timer = setTimeout(() => finish(new Error(`no bite within ${Math.round(castCap / 1000)}s`), !!bobber), castCap);
        try { bot.activateItem(); } catch (e) { finish(e, false); }
      });
    };
    while (before + totalCaught < want && Date.now() - t0 < capMs && Date.now() < (bot._stepDeadline || Infinity) && !lease.stale()) {
      if (typeof bot.health === 'number' && bot.health <= 8) {
        lastErr = `hp=${Math.round(bot.health)} too low to keep fishing`;
        break;
      }
      if (bot.entity?.position && bot.entity.position.distanceTo(water) > 7) {
        lastErr = 'drifted/respawned away from fishing hole';
        break;
      }
      const foe = nearestThreat(7.5);
      if (foe) {
        if (foe.name === 'creeper') { lastErr = 'creeper nearby'; break; }
        log.skill(`fish: defending against ${foe.name} (${Math.round(bot.entity.position.distanceTo(foe.position))}m away) before next cast`);
        try {
          const sw = bot.inventory.items().find(i => /_sword$|_axe$/.test(i.name));
          if (sw) await bot.equip(sw, 'hand').catch(() => {});
          await P.meleeKill(bot, foe, 6500);
        } catch {}
        rod = bot.inventory.items().find(i => i.name === 'fishing_rod');
        if (!rod) break;
        try { await bot.equip(rod, 'hand'); } catch {}
        if (!bot.heldItem || bot.heldItem.name !== 'fishing_rod') break;
        continue;
      }
      casts++;
      const packBefore = fishCount();
      const foodBefore = typeof bot.food === 'number' ? bot.food : null;
      // Aim slightly above water surface so bobber arcs cleanly into open water instead of snagging the shore bank
      try { await bot.lookAt(water.offset(0.5, 0.85, 0.5), true); } catch {}
      const castCap = Math.min(45000, Math.max(15000, capMs - (Date.now() - t0)));
      try {
        await castOnce(castCap);
        await sleep(500); // let reeled-in fish fly into inventory
      } catch (e) { lastErr = String(e.message).slice(0, 60); }
      // If a fish drop fell near our feet instead of direct-pickup, sweep it with collectNear
      if (fishCount() <= packBefore) {
        try { await P.collectNear(bot, bot.entity.position, FISH, 2500); } catch {}
      }
      const packDelta = Math.max(0, fishCount() - packBefore);
      if (packDelta > 0) {
        totalCaught += packDelta;
        log.skill(`fish: ${totalCaught} fish caught (${fishCount()} in pack) after ${casts} cast(s)`);
      } else if (foodBefore !== null && typeof bot.food === 'number' && bot.food > foodBefore) {
        // Auto-eat immediately consumed the raw fish when food was critical (e.g. food 1 -> 3 at 23:28).
        totalCaught += 1;
        eatenDuring += 1;
        log.skill(`fish: caught & auto-ate fish (food ${foodBefore} -> ${bot.food}, total=${totalCaught}) after ${casts} cast(s)`);
      }
      if (Date.now() - t0 > capMs) break;
      await sleep(700);
    }
    const have = fishCount();
    const produced = Math.max(have, totalCaught);
    try { bot._lastFish = { at: Date.now(), casts, have, totalCaught, eatenDuring }; } catch {}
    if (produced === 0) return { ok: false, observation: `cast ${casts} time(s) into the water at ${water.x},${water.y},${water.z} and landed nothing${lastErr ? ` (last: ${lastErr})` : ''} - fishing is bite-random, so this is a retry-or-leave call, not a broken rod` };
    return { ok: produced >= want || (typeof bot.food === 'number' && bot.food >= 19), observation: `caught ${produced} fish in ${casts} cast(s) (${have} in pack${eatenDuring ? `, ${eatenDuring} auto-eaten -> food=${bot.food}` : ''}); raw cod/salmon are edible but weak - cook them with the ${countItem(bot, 'coal')} coal${countItem(bot, 'furnace') ? ' and the furnace already in the pack' : ' (a furnace must be placed first)'}` };
  },
});

// Ocean pantry. At 08:23-08:40 on 2026-10-30 the food stage starved the bot on an ocean shard:
// hunt answered "no REACHABLE cow/pig/sheep/chicken within 70 blocks (standing in kelp, y=62)",
// roam answered "pinned - 3 legs moved <3 blocks", and smelt answered "no beef in inventory".
// Every one of those is true of a kelp forest, which is the one food source that needs no animal,
// no wood, and no fishing rod - the pack already held coal=32 and a furnace. Kelp is the move a
// human makes in that biome, and the bot had no word for it.
const KELP_BUDGET_MS = Number(process.env.KELP_BUDGET_MS || 110000);
reg.define('harvest_kelp', {
  desc: 'Food where there are no animals: break the kelp columns around the bot (the lowest block of a column roots the whole column loose) and smelt the harvest into dried kelp. Use it when hunt says the biome is empty of livestock and the bot is standing in water or kelp.',
  params: { count: 'int default 16 - kelp to gather before smelting', smelt: 'bool default true - run the furnace on what was gathered', radius: 'int default 8' },
  async run(bot, a) {
    const want = Math.max(4, Math.min(32, a.count || 16));
    const stepEnd = bot._stepDeadline && bot._stepDeadline > Date.now() + 8000 ? bot._stepDeadline - 4000 : Infinity;
    const until = Math.min(Date.now() + KELP_BUDGET_MS, stepEnd);
    const had = countItem(bot, 'kelp');
    const dried = () => countItem(bot, 'dried_kelp');
    const columns = () => {
      let ps = [];
      try { ps = bot.findBlocks({ matching: blockIds(bot, ['kelp_plant', 'kelp']), maxDistance: a.radius || 8, count: 120 }); } catch { return []; }
      const byCol = new Map();
      for (const p of ps) {
        const b = bot.blockAt(p);
        if (!b || !/kelp/.test(b.name)) continue;
        const k = `${b.x},${b.z}`;
        const cur = byCol.get(k);
        if (!cur || b.y < cur.y) byCol.set(k, b);
      }
      const f = bot.entity.position;
      return [...byCol.values()].sort((u, v) => (Math.abs(u.x - f.x) + Math.abs(u.z - f.z)) - (Math.abs(v.x - f.x) + Math.abs(v.z - f.z)));
    };
    let broke = 0, refused = '', collected = 0;
    let cols = columns();
    if (!cols.length) {
      // The bed is not gone, it is just not under the bot's feet. The old version returned here with
      // "the food has to be walked to" and nothing ever walked: measured 15:13-15:17 at -300,64,1667 the
      // LLM re-planned `harvest_kelp` at radius 8, 10 and 12, each answer arriving in 40 ms. findBlocks is
      // section-palette cheap, so scan wide ONCE, swim to the bed, and re-scan where we stand.
      const GNW = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
      let far = [];
      try { far = bot.findBlocks({ matching: blockIds(bot, ['kelp_plant', 'kelp']), maxDistance: 64, count: 40 }); } catch { far = []; }
      const here0 = bot.entity.position.floored();
      if (!far.length) {
        const land = P.nearestLandPatch(bot, { reach: 200 });
        return { ok: false, observation: land
          ? `no kelp column within 64 blocks of ${here0.x},${here0.y},${here0.z}, but there is dry ground at ${land.x},${land.z} (${land.d} blocks, biome=${land.biome || '?'}${land.village ? ', a village biome' : ''}) - walk_to there and hunt or raid a village, this tile has no seaweed`
          : `no kelp column within 64 blocks of ${here0.x},${here0.y},${here0.z} and no land biome within 200 - no food of any kind is reachable from this cell` };
      }
      const t = far.sort((u, v) => bot.entity.position.distanceTo(u) - bot.entity.position.distanceTo(v))[0];
      log.skill(`harvest_kelp: no bed at hand, ${Math.round(bot.entity.position.distanceTo(t))} blocks of water between - swimming to the kelp at ${t.x},${t.y},${t.z}`);
      await P.breathe(bot, 'harvest_kelp swim');
      const g = bot.pathfinder.goto(new GNW(t.x, t.y, t.z, 3));
      const won = await Promise.race([Promise.resolve(g).then(() => true).catch(() => true), sleep(30000).then(() => false)]);
      if (!won) { try { bot.pathfinder.stop(); } catch {} }
      cols = columns();
      if (!cols.length) return { ok: false, observation: `swam toward the kelp at ${t.x},${t.y},${t.z} and ended at ${bot.entity.position.floored()} with ${columns().length} columns in reach - the water route did not close the distance` };
    }
    for (const col of cols) {
      if (countItem(bot, 'kelp') - had >= want || Date.now() > until || broke >= 20) break;
      try { await bot.dig(col); broke++; } catch (e) { refused = `dig ${col.x},${col.y},${col.z} threw ${String(e.message).slice(0, 50)}`; continue; }
      const landed = countItem(bot, 'kelp');
      // Drops in open water drift instead of flying into the inventory, and an uncollected stack is
      // not food. Brush the items the way hunt does, but only while nothing has landed by itself.
      for (let t = 0; t < 6; t++) {
        if (countItem(bot, 'kelp') > landed) break;
        const it = Object.values(bot.entities || {}).find(e => e.name === 'item' && e.item && /kelp/.test(e.item.name) && e.position.distanceTo(bot.entity.position) < 8);
        if (!it) { await sleep(350); continue; }
        try { await bot.collectEntity(it); collected++; } catch (e) { refused = `collect threw ${String(e.message).slice(0, 40)}`; break; }
      }
    }
    const got = countItem(bot, 'kelp') - had;
    if (got <= 0) return { ok: false, observation: `broke ${broke} kelp column(s) and none landed in the pack${refused ? ` (${refused})` : ''} - bot at ${bot.entity.position.x.toFixed(0)},${bot.entity.position.y.toFixed(0)},${bot.entity.position.z.toFixed(0)}` };
    let cooked = 0;
    if (a.smelt !== false && got > 0) {
      const sm = reg.get('smelt');
      for (let round = 0; round < 3 && countItem(bot, 'kelp') > 0 && Date.now() < until; round++) {
        const before = dried();
        const r = await sm.run(bot, { item: 'kelp', count: Math.min(6, countItem(bot, 'kelp')) });
        cooked += Math.max(0, dried() - before);
        if (!r || !r.ok) { refused = String(r && r.observation || 'smelt failed').slice(0, 90); break; }
      }
    }
    if (cooked > 0) return { ok: true, observation: `kelp pantry: ${got} kelp from ${broke} column(s) (${collected} picked up by hand), ${cooked} dried kelp out of the furnace - that is ${cooked} hunger point(s) the pack can eat` };
    return { ok: false, observation: `${got} kelp harvested but ${cooked} dried kelp made (${refused || 'the furnace has not finished yet'}) - raw kelp is not food, so the milestone stays open until the cook lands` };
  },
});

// The move a player makes when the biome itself has no food. Measured 2026-11-03 14:18-15:25: the run
// starved at food=0 in open ocean with hunt saying "no REACHABLE cow/pig/sheep", harvest_kelp saying
// "no bed within 12 blocks", and fish blocked because a rod needs 2 string and the pack had 1. Livestock,
// seaweed and spiders are all absent out here, but a village keeps hay bales, and a hay bale is 9 wheat -
// three loaves, no herd, no furnace, no rod. Villages are also the one food source that generates in a
// known set of biomes, so a coarse biome look-ahead can point at one from 240 blocks away.
// `/locate structure minecraft:<type>` read back from the chat line it prints. Same shape as the
// stronghold helper in endgame.js:6258, but parameterised - a village type is a biome guess, and a wrong
// guess costs only the 10 s timeout. Assist-gated by the caller, because on the strict instance (/locate)
// is not information the run is allowed to buy.
async function locateStructure(bot, type, waitMs) {
  // A wrong village type is a common answer, and the old flat 10 s wait meant a five-type sweep spent
  // 50 s of a 30 s step - the march never started (live 20:15 the bearing was chosen and then the loop
  // found its own deadline already past). Three and a half seconds is enough for Paper to answer.
  const WAIT = Math.max(1200, Math.min(10000, waitMs || 3500));
  return await new Promise(resolve => {
    let got = 0;
    const finish = (v) => { try { bot.removeListener('message', handler); } catch {} clearTimeout(t); resolve(v); };
    const handler = (msg) => {
      let text = '';
      try { text = msg.toString(); } catch {}
      try { text += ' ' + JSON.stringify(msg); } catch {}
      got++;
      // What actually arrived, twice per call. `produced no answer (saw 2 messages)` cannot be debugged
      // without the text - live 20:05-20:06 every village type "answered nothing", and whether that is
      // Paper's wording, a system-channel message, or genuinely no generated village changes the fix.
      if (got <= 2) log.info(`/locate ${type} raw #${got}: ${text.slice(0, 170)}`);
      // Match on the COORDINATE TRIPLE, not on the sentence. Live 19:23:08-19:23:28 every village type
      // answered "produced no answer (saw 1-2 messages)": the server does print a `[x, y, z]`, but the words
      // around it are not the ones this run's stronghold matcher was written against, and a name-anchored
      // regex throws away a perfectly good bearing.
      if (/could not find|no matching|not generated|no structure/i.test(text)) {
        log.info(`/locate ${type} answered "none": ${text.slice(0, 120)}`);
        return finish(null);
      }
      const m = /\[\s*(-?\d+|~)\s*[;,]\s*(-?\d+|~)\s*[;,]\s*(-?\d+|~)\s*\]/.exec(text);
      if (!m || !/village|structure|located|found/i.test(text)) return;
      // Paper prints the vertical as `~`: "The nearest minecraft:village_snowy is at [-3680, ~, -1520]".
      // A digits-only match threw every one of those answers away - all night every /locate read as
      // "produced no answer (saw 2 messages)" while the coordinates sat in the message. The stronghold
      // matcher has folded `~` since it was written; this one had never seen the real text.
      const num = (v, d) => (v === '~' ? d : Number(v));
      const here = bot.entity.position;
      log.info(`/locate ${type} answered: ${m[1]},${m[2]},${m[3]}`);
      finish({ x: num(m[1], here.x), z: num(m[3], here.z) });
    };
    // One sample of what actually arrives, so the next stall read is evidence rather than speculation.
    const t = setTimeout(() => { log.warn(`/locate ${type} produced no answer (saw ${got} message(s))`); finish(null); }, WAIT);
    bot.on('message', handler);
    try { bot.chat(`/locate structure minecraft:${type}`); } catch (e) { log.warn(`/locate ${type} send threw ${e.message}`); finish(null); }
  });
}

reg.define('raid_village', {
  desc: 'Long-distance food when the biome has no livestock and no kelp: find the nearest village (hay bales, wheat farmland, bell/composter, or just a village biome) and take its grain - break hay bales for wheat, craft bread from 3 wheat, eat it. Use when hunt reports no reachable animals and harvest_kelp reports no bed, or when the food stage has been failing for minutes.',
  params: { reach: 'int default 96 - how far to look for grain already loaded', need: 'int default 3 - loaves of bread', travel: 'int default 240 - how far to walk toward a village biome when none is loaded', eat: 'bool default true' },
  async run(bot, a) {
    const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
    // Cooldown, because a fast honest refusal is still a refusal. The moment the scan cost dropped under a
    // second, both the plan and the stage lock re-asked it every ~35 s from the same cell (live
    // 16:37-16:47: 23 identical "ALREADY standing on dry ground" answers at -318,64,1514) - rounds that
    // should have been spent walking. A repeat is allowed after 4 minutes OR once the bot has actually
    // travelled 64 blocks, which is the thing the verdict itself asks for.
    const COOLDOWN_MS = Number(process.env.MC_VILLAGE_COOLDOWN_MS || 240000);
    const tr = bot._villageTried;
    const travelled = tr ? Math.round(bot.entity.position.distanceTo(new Vec3(tr.x, bot.entity.position.y, tr.z))) : Infinity;
    if (tr && Date.now() < tr.retryAt && travelled < 64) {
      return { ok: false, observation: `village scan is on cooldown for another ${Math.ceil((tr.retryAt - Date.now()) / 1000)}s (asked ${Math.round((Date.now() - tr.at) / 1000)}s ago from ${tr.x},${tr.z}, only ${travelled} blocks travelled) - the move now is a long roam/hunt across ground that has not been walked, not another scan of this cell` };
    }
    const here0 = bot.entity.position.floored();
    bot._villageTried = { x: here0.x, z: here0.z, at: Date.now(), retryAt: Date.now() + COOLDOWN_MS };
    let reach = Math.max(24, Math.min(128, parseInt(a.reach, 10) || 96));
    const need = Math.max(1, Math.min(9, parseInt(a.need, 10) || 3));
    const travel = Math.max(60, Math.min(320, parseInt(a.travel, 10) || 240));
    const deadline = bot._stepDeadline && bot._stepDeadline > Date.now() + 20000
      ? bot._stepDeadline - 15000 : Date.now() + 240000;
    const wheat = () => countItem(bot, 'wheat');
    const bread = () => countItem(bot, 'bread');
    // Hay is the target; a mature wheat crop is the same meal one step earlier; bell/composter only prove
    // the village is here. Reading them by name keeps this off the "any grass block" false-positive path.
    const grainIds = P.blockIds(bot, ['hay_block', 'wheat']);
    const poiIds = P.blockIds(bot, ['bell', 'composter']);
    const scan = (r) => {
      try { return bot.findBlocks({ matching: grainIds, maxDistance: r, count: 24 }); } catch { return []; }
    };
    const walkTo = async (p, rad, label) => {
      await P.breathe(bot, label);
      const won = await Promise.race([
        Promise.resolve(bot.pathfinder.goto(new GN(p.x, p.y, p.z, rad))).then(() => true).catch(() => true),
        sleep(30000).then(() => false),
      ]);
      if (!won) { try { bot.pathfinder.stop(); } catch {} return false; }
      return true;
    };
    const start = bot.entity.position.floored();
    let found = scan(reach);
    let via = `scanned ${reach} blocks`;
    if (!found.length) {
      // Are we already standing on the ground this search is looking for? The lattice probe deliberately
      // skips the bot's own cell, so a bot on a dry islet used to answer "no land biome is loaded in
      // range" and then march 8 legs of 10 blocks around it (live 15:59). On dry land with no grain
      // loaded, the move is a NEW heading for hunt/roam, not another circle.
      const airish = (b) => !b || b.name === 'air' || b.name === 'cave_air' || b.name === 'void_air';
      const onDryGround = () => {
        const f = bot.entity.position.floored();
        try {
          const floor = bot.blockAt(new Vec3(f.x, f.y - 1, f.z));
          if (!floor || floor.boundingBox !== 'block' || /water|lava/.test(floor.name)) return false;
          return airish(bot.blockAt(f)) && airish(bot.blockAt(new Vec3(f.x, f.y + 1, f.z)));
        } catch { return false; }
      };
      // One heading per call, and only a heading that is actually travel: re-asking "nearest land" every
      // leg made the bot shuffle between two patches 13 blocks apart (live 15:59:06-15:59:25: 8 legs of
      // 10 blocks, ending 20 blocks from where it started) - a village is a couple of hundred blocks out,
      // so a 10-block step onto the next dirt clump is not a search, it is a stall with log lines.
      const MIN_LEG = 24;
      const pickTarget = (r) => P.nearestLandPatch(bot, { reach: r, villageOnly: true })
        || P.nearestLandPatch(bot, { reach: r });
      let target = pickTarget(travel) || pickTarget(Math.max(travel, 320));
      // Ask WORLDGEN before answering "there is no village around here". The order matters: live 18:14:30
      // stood on dry ground at -265,64,1513, the onDryGround() sentence below fired in 0.2 s, and the
      // locate branch that had been added underneath was unreachable - which is also what a stub with
      // solid feet could never have caught. Standing on the only loaded land IS the case to ask about.
      let aim = null;
      const villageBearing = async () => {
        if (process.env.MC_ASSIST === '0') return null;
        let bio = '';
        try { const bb = bot.blockAt(new Vec3(start.x, start.y - 1, start.z)); bio = (bb && bb.biome && bb.biome.name) || ''; } catch {}
        const BY_BIOME = { savanna: 'village_savanna', badlands: 'village_savanna', plains: 'village_plains', sunflower_plains: 'village_plains', meadow: 'village_plains', desert: 'village_desert', taiga: 'village_taiga', old_growth_pine_taiga: 'village_taiga', snowy_plains: 'village_snowy', ice_spikes: 'village_snowy', snowy_taiga: 'village_snowy' };
        const tries = [...new Set([BY_BIOME[bio], 'village_plains', 'village_savanna', 'village_taiga', 'village_desert', 'village_snowy'].filter(Boolean))];
        // Ask every plausible type and take the NEAREST. The first answer can be 4500 blocks out
        // (`village_snowy is at [-3680, ~, -1520]`, live 20:09) while a savanna village sits 300 blocks
        // away, and marching on the first reply is a night lost on a snowy plain.
        const found = [];
        // Stop asking once something close enough to walk to has turned up, and never start a type the
        // remaining step budget cannot finish.
        const nearEnough = () => found.length && Math.min(...found.map(f => f.d)) < 500;
        const budgetLeft = () => !bot._stepDeadline || Date.now() < bot._stepDeadline - 12000;
        for (const t of tries) {
          if (!budgetLeft() || nearEnough()) break;
          const p = await locateStructure(bot, t, 3000);
          if (!p) continue;
          const d = Math.round(bot.entity.position.distanceTo(new Vec3(p.x, bot.entity.position.y, p.z)));
          found.push({ x: p.x, z: p.z, d, biome: `${t} (/locate)` });
        }
        if (!found.length) return null;
        const best = found.sort((a, b) => a.d - b.d)[0];
        // A village 2000 blocks out is not tonight's meal: the march is 8 legs of 44 and the run has a
        // dragon to kill two hundred blocks away. Say the number so the verdict is a fact, not a hope.
        if (best.d > 900) {
          // Remember the veto: the stage lock asks `raid_village` again after every cooldown, and without
          // this it re-spends the sweep (and 4 minutes of lock rotation) on a 4,000-block walk.
          bot._villageFarAt = Date.now();
          log.skill(`raid_village: /locate answers ${found.map(f => `${f.biome}=${f.d}b`).join(', ')} - none is walkable tonight, so the meal has to come from a corridor (hunt_spider kind:zombie) or the herd, not a march`);
          return null;
        }
        log.skill(`raid_village: /locate nearest village ${best.biome} at ${best.x},${best.z}, ${best.d} blocks - marching on that bearing (asked ${found.length} type(s))`);
        return best;
      };
      if ((!target || target.d < MIN_LEG || onDryGround()) && process.env.MC_ASSIST !== '0') {
        const v = await villageBearing();
        if (v) {
          aim = { x: v.x, z: v.z };
          target = { x: v.x, y: bot.entity.position.y, z: v.z, biome: v.biome, located: true, d: v.d };
        }
      }
      if (!aim && onDryGround()) {
        const f0 = bot.entity.position.floored();
        let bio0 = '';
        try { const bb = bot.blockAt(new Vec3(f0.x, f0.y - 1, f0.z)); bio0 = (bb && bb.biome && bb.biome.name) || ''; } catch {}
        return { ok: false, observation: `no hay bale or wheat crop within ${reach} blocks, and the bot is ALREADY standing on dry ground at ${f0.x},${f0.y},${f0.z}${bio0 ? ` (${bio0})` : ''} - there is no village loaded around here: roam a heading that has not been walked yet and hunt on land, instead of circling this cell` };
      }
      let legs = 0;
      const heading = [];
      while (!found.length && target && legs < 8 && Date.now() < deadline) {
        heading.push(`${target.x},${target.z}(${target.biome || '?'})`);
        if (target.d < MIN_LEG) {
          // Already standing on it. Widening once is fair; shuffling around it is not.
          if (legs === 0) { reach = 128; found = scan(128); }
          if (!found.length) {
            return { ok: false, observation: `no hay bale or wheat crop within ${reach} blocks, and the nearest dry ground (${target.biome || 'unknown biome'}, ${target.d} blocks) is already under our feet - no village biome is loaded in this direction; roam a new heading (land that has not been walked over yet) before another village call` };
          }
          break;
        }
        // A located village is usually a few hundred blocks out, often across open water. Pathfind to a
        // 44-block step along that bearing instead of the destination itself: one unreachable far goal is
        // what makes pathfinder return nothing at all, while a near goal keeps the march moving.
        const step = target.located && target.d > 44
          ? { x: Math.round(bot.entity.position.x + (aim.x - bot.entity.position.x) * 44 / Math.max(1, target.d)), z: Math.round(bot.entity.position.z + (aim.z - bot.entity.position.z) * 44 / Math.max(1, target.d)), y: bot.entity.position.y, d: 44, biome: target.biome, located: true }
          : target;
        log.skill(`raid_village: no grain within ${reach} - leg ${++legs} toward ${target.village ? 'village biome at' : 'dry ground at'} ${step.x},${step.y},${step.z} (${target.d} blocks to go)`);
        const before = bot.entity.position.clone();
        await walkTo(step, 4, 'village approach');
        const moved = Math.round(bot.entity.position.distanceTo(before));
        if (moved < 4) { log.skill(`raid_village: leg ${legs} moved ${moved} blocks - the route is closed, stopping the march`); break; }
        found = scan(Math.max(reach, 64));
        reach = Math.max(reach, 64);
        const left = bot.entity.position.distanceTo(new Vec3(target.x, bot.entity.position.y, target.z));
        if (left > target.d - 4) { log.skill(`raid_village: leg ${legs} closed only ${Math.round(target.d - left)} of ${target.d} blocks - stopping instead of swinging at the same wall`); break; }
        target.d = Math.round(left);
        if (legs >= 3 && bot.entity.position.distanceTo(new Vec3(start.x, bot.entity.position.y, start.z)) < 20) {
          log.skill(`raid_village: ${legs} legs and net travel under 20 blocks from ${start.x},${start.z} - this cell will not march out; needs a boat or a new region`);
          break;
        }
      }
      via = legs ? `walked ${legs} leg(s) toward ${heading[heading.length - 1]} from ${start.x},${start.z}` : 'no land biome is loaded in range';
    }
    if (!found.length) {
      return { ok: false, observation: `no hay bale or wheat crop within ${reach} blocks of ${bot.entity.position.floored()} (${via}) - there is no village here to loot; the food has to come from a herd on land (roam/hunt) or a boat to a distant shore` };
    }
    // Take the grain. A hay bale drops 9 wheat, so one bale covers three loaves; crops go seed for seed.
    let bales = 0, crops = 0, refused = '';
    for (const p of found) {
      if (wheat() >= need * 3 || Date.now() > deadline) break;
      const b = bot.blockAt(p);
      if (!b) continue;
      // A crop is only food at the last stage; green wheat gives seeds and nothing else.
      if (b.name === 'wheat') {
        const age = b.stateProperties && b.stateProperties.d ? parseInt(b.stateProperties.d.age, 10) : 7;
        if (!Number.isNaN(age) && age < 7) continue;
      }
      const near = await walkTo(p, 2, 'grain reach');
      if (!near) { refused = `could not walk to ${p.x},${p.y},${p.z}`; continue; }
      const beforeW = wheat();
      try { await bot.dig(b); } catch (e) { refused = `dig ${b.name} threw ${String(e.message).slice(0, 40)}`; continue; }
      if (b.name === 'hay_block') bales++; else crops++;
      try { await P.collectNear(bot, b.position, ['wheat', 'wheat_seeds'], 9000); } catch {}
      if (wheat() <= beforeW) refused = `broke ${b.name} at ${p.x},${p.y},${p.z} and no wheat landed`;
    }
    if (wheat() < 3) {
      return { ok: false, observation: `broke ${bales} hay bale(s) + ${crops} crop(s) and holds wheat=${wheat()} (${refused || 'nothing'}) - bread needs 3 wheat per loaf, so the village is not feeding this bot yet` };
    }
    const made = await craft(bot, 'bread', Math.min(need, Math.floor(wheat() / 3)));
    const loaves = bread();
    if (loaves <= 0) return { ok: false, observation: `wheat=${wheat()} in the pack but ${String((made && made.observation) || 'the bread craft failed')} - a crafting table is needed (3 wheat in a row)` };
    try { WS.note('village', found[0], `${bales} hay + ${crops} crops, wheat=${wheat()}`); } catch {}
    let ate = '';
    if (a.eat !== false) {
      const r = await reg.get('eat').run(bot, { target: 19 }).catch(e => ({ observation: 'threw ' + e.message }));
      ate = String((r && r.observation) || '').slice(0, 110);
    }
    bot._villageTried = null;   // grain found: the next call must not be locked out
    return { ok: true, observation: `village grain: ${bales} hay bale(s) + ${crops} crop(s) at ${found[0].x},${found[0].y},${found[0].z} -> wheat=${wheat()}, bread=${loaves} (${via}) | eat: ${ate}` };
  },
});
