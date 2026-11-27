'use strict';
// Wire mineflayer + the plugin ecosystem into a live bot.
const mineflayer = require('mineflayer');
const { pathfinder, Movements, goals } = require('mineflayer-pathfinder');
const pvp = require('mineflayer-pvp').plugin;
const tool = require('mineflayer-tool').plugin;
const cfg = require('./config');
const log = require('./log');
const lease = require('./stepLease');

// mineflayer's own craft() dereferences a missing crafting table inside a promise nobody awaits
// (lib/plugins/inventory.js: `block.position.offset(...)` with block undefined). That unhandled
// rejection killed the acceptance bot twice at 01:33/01:36 mid-ensure_tools, and every such death
// costs the reconnect backoff plus whatever milestone was in flight. Stay alive and shout: the
// planner's per-step caps already treat a failed craft as an ordinary result.
let netStated = false;
process.on('unhandledRejection', (e) => {
  const m = String((e && e.message) || e).slice(0, 160);
  if (/set_equip_slot|updateSlot:0/.test(m)) {
    if (!netStated) { netStated = true; log.warn(`1.21 equip-slot ack never arrived (mineflayer#3906): ${m} - ignored, run continues`); }
    return;
  }
  // The message alone names nothing: 300 identical `Cannot read properties of undefined (reading
  // 'offset')` lines since 2026-10-28 with nowhere to look. Attribute the thrower or the noise is useless.
  log.err('unhandled rejection (kept alive)', m + (e && e.stack
    ? ' @ ' + String(e.stack).split('\n').slice(1, 4).map(s => s.trim()).join(' <- ').slice(0, 220) : ''));
});
process.on('uncaughtException', (e) => log.err('uncaught exception (kept alive)', String((e && e.stack) ? e.stack.split('\n')[0] : e).slice(0, 200)));

// Conservation-aware tool selector shared by mineflayer-pathfinder and unit tests:
// - Reserves diamond/netherite pickaxes strictly for obsidian/crying_obsidian/ancient_debris
//   (and diamond_ore only when no iron pickaxe with >=8 digs is available).
// - Prefers iron -> stone -> wooden -> golden pickaxes for ordinary stone/ores/netherrack.
// - Automatically switches to shovel/axe/sword for dirt/wood/cobweb.
// - Never hands over a diamond pickaxe to grind cobblestone, and never uses picks with <8 digs left.
const DIAMOND_ONLY_BLOCKS = /^(obsidian|crying_obsidian|respawn_anchor|ancient_debris)$/;
const IRON_PLUS_ORES = /^(diamond_ore|deepslate_diamond_ore|gold_ore|deepslate_gold_ore|redstone_ore|deepslate_redstone_ore|emerald_ore|deepslate_emerald_ore)$/;
const SHOVEL_BLOCKS = /(dirt|grass_block|sand|gravel|clay|soul_sand|soul_soil|snow|mycelium|podzol|mud|farmland)/;
const AXE_BLOCKS = /(_log|_wood|_planks|crafting_table|chest|barrel|bookshelf|_fence|_stairs|melon|pumpkin|crimson_stem|warped_stem|hyphae)/;

function itemDigsLeft(item) {
  if (!item) return 0;
  return item.maxDurability ? item.maxDurability - (item.durabilityUsed || 0) : 999;
}

function hasUsableBulkPick(bot) {
  try {
    return bot.inventory.items().some(i =>
      /^(iron|stone|wooden|golden)_pickaxe$/.test(i.name) && itemDigsLeft(i) >= 8);
  } catch { return false; }
}

function selectConservativeTool(bot, block) {
  if (!bot || !block || !bot.inventory) return null;
  const items = bot.inventory.items() || [];
  const name = String(block.name || '');
  const pickByOrder = (order) => {
    for (const nm of order) {
      const cands = items.filter(i => i.name === nm && itemDigsLeft(i) >= 8)
        .sort((a, b) => itemDigsLeft(b) - itemDigsLeft(a));
      if (cands.length) return cands[0];
    }
    return null;
  };
  if (name === 'cobweb' || name === 'bamboo') {
    return pickByOrder(['iron_sword', 'stone_sword', 'diamond_sword', 'wooden_sword', 'netherite_sword']);
  }
  if (DIAMOND_ONLY_BLOCKS.test(name)) {
    return pickByOrder(['diamond_pickaxe', 'netherite_pickaxe']);
  }
  if (IRON_PLUS_ORES.test(name)) {
    return pickByOrder(['iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe']);
  }
  if (SHOVEL_BLOCKS.test(name) && !/_ore$/.test(name)) {
    return pickByOrder(['iron_shovel', 'stone_shovel', 'wooden_shovel', 'diamond_shovel', 'golden_shovel']);
  }
  if (AXE_BLOCKS.test(name) && !/stone_brick|cobblestone|deepslate|blackstone|nether_brick/.test(name)) {
    return pickByOrder(['iron_axe', 'stone_axe', 'wooden_axe', 'diamond_axe', 'golden_axe']);
  }
  // Pickaxe / rock blocks: keep diamond_pickaxe strictly reserved for obsidian!
  if (block.material === 'mineable/pickaxe' || (block.harvestTools && Object.keys(block.harvestTools).length > 0) || (block.hardness || 0) >= 1.2) {
    return pickByOrder(['iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe', 'golden_pickaxe']);
  }
  return null;
}

function hasPathMoved(anchor, pos) {
  if (!anchor || !pos) return false;
  const horiz = Math.hypot(pos.x - anchor.x, pos.z - anchor.z);
  // A normal jump bounces y by ~1.25 blocks in place. Counting |dy| > 0.4 as progress let an
  // in-place jumping bot defeat the 60s path stall guard forever; require real horizontal motion
  // (>= 0.9 blocks) or sustained vertical climb (>= 2.0 blocks).
  const vert = Math.abs(pos.y - anchor.y);
  return horiz >= 0.9 || vert >= 2.0;
}

function syncPathfinderPolicy(bot, mov, opts = {}) {
  if (!mov) return;
  const wet = !!opts.wet;
  const dryNear = opts.dryNear !== undefined ? !!opts.dryNear : true;
  const bulkPick = hasUsableBulkPick(bot);
  // Real mineflayer-pathfinder 2.4.5 Movements fields (previously bot.pathfinder.costs.liquid was a dead no-op!).
  mov.liquidCost = wet ? (dryNear ? 85 : 8) : 35;
  // Never allow pathfinder to bare-hand dig stone (7.5s/block) or dig sideways while submerged (37s/block -> drown).
  mov.canDig = !wet && bulkPick;
  mov.digCost = bulkPick ? 4 : 40;
  // Paper 1.21.1 rejects mineflayer-pathfinder's built-in 1x1 tower placements (entity hitbox overlap
  // + un-acked hotbar swap -> infinite jumping in place). Explicit vertical climbs use climbOut().
  mov.allow1by1towers = false;
}

// Event-driven dig confirmation wrapper:
// Mineflayer's bot.dig() resolves on a local client-side digTime() timer, NOT on Paper's server-side
// blockUpdate confirmation. A 50-200ms client/server tick or RTT drift causes Paper to reject the
// early STOP_DESTROY_BLOCK while the caller immediately rotates its head ("挖没完就转头").
// Instead of adding a blind 500ms sleep to every action (which slows combat/movement), we:
//   1. Return in 0ms when the block is already air/replaced.
//   2. Wait up to 320ms for Paper's actual blockUpdate event (resolves immediately on arrival).
//   3. If the block is STILL intact after 320ms (early-stop rejected), settle 150ms and retry ONCE.
function installSafeDig(bot) {
  if (!bot || typeof bot.dig !== 'function' || bot._safeDigInstalled) return;
  bot._safeDigInstalled = true;
  const origDig = bot.dig.bind(bot);
  const waitMs = (ms) => new Promise(r => setTimeout(r, ms));
  const isGone = (pos, origType) => {
    try {
      const now = bot.blockAt(pos);
      if (!now) return true;
      if (now.name === 'air' || now.name === 'cave_air' || now.name === 'void_air') return true;
      return origType !== undefined && now.type !== origType;
    } catch { return true; }
  };
  const waitForBreak = (pos, origType, maxMs = 320) => new Promise((resolve) => {
    if (isGone(pos, origType)) return resolve(true);
    const ev = `blockUpdate:(${pos.x}, ${pos.y}, ${pos.z})`;
    let done = false;
    const finish = (ok) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      clearInterval(poll);
      try { bot.removeListener(ev, onUpd); } catch {}
      resolve(ok);
    };
    const onUpd = () => { if (isGone(pos, origType)) finish(true); };
    try { bot.on(ev, onUpd); } catch {}
    const poll = setInterval(() => { if (isGone(pos, origType)) finish(true); }, 40);
    const timer = setTimeout(() => finish(isGone(pos, origType)), maxMs);
  });

  bot.dig = async (block, ...rest) => {
    if (!block || !block.position) return origDig(block, ...rest);
    const pos = block.position;
    const origType = block.type;
    const ae = bot.autoEat || bot.autoeat;
    const pauseEat = !!(ae && typeof ae.disableAuto === 'function' && typeof ae.enableAuto === 'function' && ae.enabled);
    if (pauseEat) { try { ae.disableAuto(); } catch {} }
    try {
      await origDig(block, ...rest);
      const broke = await waitForBreak(pos, origType, 320);
      if (broke) return;
      // Block snapped back intact after local timer expired (RTT/tick/airborne drift) — retry once cleanly.
      if (bot._stepDeadline && Date.now() >= bot._stepDeadline - 1500) return;
      const fresh = typeof bot.blockAt === 'function' ? bot.blockAt(pos) : null;
      if (!fresh || isGone(pos, origType) || (fresh.name && /bedrock|water|lava/.test(fresh.name))) return;
      if (bot.entity && bot.entity.position && bot.entity.position.distanceTo(pos) > 5.5) return;
      await waitMs(150);
      await origDig(fresh, ...rest);
      await waitForBreak(pos, origType, 320);
    } finally {
      if (pauseEat) { try { ae.enableAuto(true); } catch {} }
    }
  };
}

function createBot() {
  const bot = mineflayer.createBot({
    host: cfg.mc.host,
    port: cfg.mc.port,
    username: cfg.mc.username,
    version: cfg.mc.version,
    auth: cfg.mc.auth === 'microsoft' ? 'microsoft' : 'offline',
    // Paper rejects a move packet whose delta is bigger than one tick of legitimate motion. The
    // ring buffer showed exactly that shape: y 18 -> 17 in five packets ~55 ms apart, i.e. the
    // client teleport-snapping the player down a block instead of falling it over ~12 ticks.
    // mineflayer does that in its physics catch-up loop after any stall (chunk load, kick-rejoin);
    // one catch-up tick per frame keeps the simulated motion inside what the server will accept.
    maxCatchupTicks: 1,
  });
  // Must run before the planner ever writes a deadline: it replaces the plain property with one that
  // answers an abandoned worker with an expired clock. See stepLease.bindDeadline.
  lease.bindDeadline(bot);

  // Load plugins before spawn so their event handlers register in order.
  bot.loadPlugin(pathfinder);
  bot.loadPlugin(tool);
  try { bot.loadPlugin(require('mineflayer-armor-manager')); } catch (e) { log.warn('armor-manager:', e.message); }
  bot.loadPlugin(pvp);
  // mineflayer-collectblock is deliberately NOT loaded. Its `itemDrop` handler auto-hijacks every
  // dropped item, and when the inventory is full it throws `destination full` / `assert.ok(item)`
  // as an *unhandled* rejection (its own promise, no call site for us to catch). Skills now dig
  // with mineBlockHere + pathfinder, and normal pickup already happens on the block-break packet.
  try { if (process.env.MC_AUTOEAT !== '0') { const ae = require('mineflayer-auto-eat'); bot.loadPlugin(ae.loader || ae.plugin || ae); } } catch (e) { log.warn('auto-eat:', e.message); }
  // Hold back stock. The plugin's real trigger is `bot.food < opts.minHunger || health < minHealth`
  // with defaults 15/14, and it keeps eating until it crosses 15 - so after a hunt it devoured the
  // entire stack (raw beef is 3 points each) and the pack ended with leather and wool but
  // raw meat=none. The `food` milestone asks for 3 edible items as travel rations for the Nether and
  // the End, so it could never pass: the ladder burned 5 hours on eat->hunt->eat->timeout while the
  // bot was actually well fed. Eating only below 8 leaves a real stock; the planner's survive gate
  // still tops the meter up to 19 by hand when regeneration is wanted (regen needs food > 18).
  try {
    const apply = () => {
      const ae = bot.autoEat || bot.autoeat;
      if (!ae) return false;
      if (typeof ae.setOpts === 'function') {
        ae.setOpts({
          minHunger: Number(process.env.MC_AUTOEAT_MIN_HUNGER || 8),
          minHealth: Number(process.env.MC_AUTOEAT_MIN_HEALTH || 8),
          // Rotten flesh only when nothing else is left: the bot fights zombies in every shaft it
          // digs, so it accumulates flesh constantly, and the `food` milestone kept failing
          // ("raw meat=none" on a hill with no animals) while that stack went unused. The plugin
          // treats fallbackFood as last-resort, so normal meat still wins.
          fallbackFood: 'rotten_flesh',
        });
        log.info(`auto-eat thresholds -> minHunger=${ae.opts.minHunger} minHealth=${ae.opts.minHealth} (keeps edible rations in the pack)`);
      } else log.warn('auto-eat thresholds: plugin has no setOpts, keeping its defaults');
      return true;
    };
    // The auto-eat util injects after mineflayer's plugin dependencies resolve, so `bot.autoEat` is
    // still undefined right here (measured: my first attempt logged "no bot.autoEat object" while
    // the eat skill reported "auto-eat on" seconds later). Applying on spawn is what makes the
    // threshold actually stick - otherwise the plugin keeps eating until the bar is full and the
    // pack never holds the 3 rations the `food` milestone asks for.
    if (!apply()) bot.once('spawn', () => { if (!apply()) setTimeout(apply, 1500); });
  } catch (e) { log.warn('auto-eat options:', e.message); }

  // 1.21's move packets carry an on-ground flag; a real client in water never asserts it, and
  // asserting it is one of the things this server has disconnected over. We stop asserting it:
  // the flag is advisory for moving the player, and our own ground guess has been wrong twice
  // (the ring buffer prints params BEFORE this shim runs, so it never actually proved the flag
  // was the reject reason - the login-kick stasis below is what unblocked the run).
  // Honest result of the A/B at the pinned spot (-7,42,5): forcing onGround=false on every move
  // packet did NOT stop the disconnects - both modes lost the connection about once a minute
  // (10 kicks in 8 min with the shim off, a kick at ~2 s uptime with it on). The 5 quiet minutes
  // that first looked like proof were the bot standing still in the hole, not the shim working.
  // It is off by default because passing the flag through is what a real client does, and because
  // an unproven intervention in the packet path is a bad thing to leave switched on by accident.
  // The kick itself tracks self-computed movement in a 1-wide shaft, not this flag.
  const GROUND_SHIM = process.env.MC_GROUND_SHIM === '1';
  const rawClientWrite = bot._client.write.bind(bot._client);
  let shimTrace = 0;
  bot._client.write = (name, params) => {
    if (GROUND_SHIM && params && params.onGround && (name === 'position' || name === 'position_look' || name === 'look')) {
      params = Object.assign({}, params, { onGround: false });
      if (process.env.MC_MOVE_DEBUG === '1' && ++shimTrace <= 5) log.warn(`shim rewrote outgoing ${name} onGround->false (post-shim proof)`);
    }
    return rawClientWrite(name, params);
  };

  // Login-window handling lives with the wet guard below (physics follows wet/dry); a fixed timer
  // here resumed physics at exactly 3 s and the bot, standing in water, was kicked on the tick.

  // Packet-level evidence for the invalid_player_movement kick. Guessing at the cause cost two
  // wrong fixes (water physics, then a swim burst - a bare client does either one and survives),
  // so when MC_MOVE_DEBUG=1 we keep the last C->S movement packets next to the server's own
  // position updates and dump the ring on kick/end.
  if (process.env.MC_MOVE_DEBUG === '1') {
    const fsys = require('fs');
    const dbgFile = require('./config').paths.logs + '/move_debug.log';
    const ring = [];
    const push = (o) => { ring.push(Object.assign({ t: new Date().toISOString().slice(11, 23) }, o)); if (ring.length > 150) ring.shift(); };
    const dump = (why) => { try { fsys.appendFileSync(dbgFile, `\n=== ${why} ${new Date().toISOString()} ===\n` + ring.map(r => JSON.stringify(r)).join('\n') + '\n'); } catch {} };
    const rawWrite = bot._client.write.bind(bot._client);
    bot._client.write = (name, params) => {
      if (name === 'position' || name === 'position_look' || name === 'look' || name === 'teleport_confirm') {
        push({ dir: '->S', pkt: name, x: params && params.x, y: params && params.y, z: params && params.z, g: params && params.onGround, id: params && params.teleportId });
      }
      return rawWrite(name, params);
    };
    bot._client.on('login', (p) => push({ dir: 'S->', pkt: 'login', x: p.x, y: p.y, z: p.z }));
    bot._client.on('position', (p) => push({ dir: 'S->', pkt: 'position', x: p.x, y: p.y, z: p.z, id: p.teleportId }));
    bot.on('kicked', () => dump('KICKED'));
    bot.on('end', (r) => dump('END ' + String(r)));
    bot.on('spawn', () => { push({ dir: 'bot', pkt: 'spawn', x: bot.entity.position.x, y: bot.entity.position.y, z: bot.entity.position.z }); });
  }

  bot.once('spawn', () => {
    const mov = new Movements(bot, require('minecraft-data')(bot.version));
    bot._movements = mov;
    // Balanced Movements policy:
    // - digCost=4 (was 0.4, which made digging straight into cliffs/aquifers 2.5x cheaper than walking!)
    // - liquidCost=35 when dry (was silently left at default 1 because pf.costs.liquid didn't exist!)
    // - maxDropDown=3 & infiniteLiquidDropdownDistance=false to stop jumping off ravine cliffs into pools
    // - canDig dynamically disabled when underwater or carrying zero non-diamond pickaxes
    mov.canDig = hasUsableBulkPick(bot);
    mov.digCost = 4;
    mov.placeCost = 2.5;
    mov.liquidCost = 35;
    mov.maxDropDown = 3;
    mov.infiniteLiquidDropdownDistance = false;
    mov.allow1by1towers = false;
    mov.allowParkour = false;
    mov.allowSprinting = false;
    mov.dontCreateFlow = true;
    mov.canSwim = true;
    mov.blocksCantBreak.add(require('minecraft-data')(bot.version).blocksByName.bedrock.id);
    bot.pathfinder.setMovements(mov);
    // Override pathfinder's greedy tool selector so walking/pathing NEVER wears down or swaps the
    // obsidian-reserved diamond_pickaxe onto ordinary stone, and uses the right tool per block class.
    bot.pathfinder.bestHarvestTool = (block) => selectConservativeTool(bot, block);
    // 10 of 11 deaths in one observation window were "fell from a high place": the workshop sits on
    // a plateau rim and the bot repeatedly walks off it while roaming/hauling blocks. Catch actual
    // freefall and cast slow falling before the landing, throttled so the log stays readable.
    let lastFallCast = 0;
    bot.on('physicsTick', () => {
      if (process.env.MC_ASSIST === '0') return;
      try {
        const v = bot.entity && bot.entity.velocity;
        if (!v || v.y > -0.8) return;
        if (Date.now() - lastFallCast < 15000) return;
        lastFallCast = Date.now();
        bot.chat('/effect give @s minecraft:slow_falling 20 0 true');
        log.info(`freefall v.y=${v.y.toFixed(2)} at ${bot.entity.position.floored()} -> slow_falling`);
      } catch {}
    });
    // The pinned respawn point ended up on a plateau RIM above a ravine: 38 deaths in 6 minutes,
    // every one "fell from a high place" at the same x,z. Armor is cleared on death, so protection
    // has to be granted the instant the bot is back on its feet, before it walks off again.
    // Water is the one place where our client-side model and Paper reliably disagree: any
    // self-computed movement in a fluid gets rejected (invalid_player_movement, and `flying` when
    // it is a swim burst). Timeline evidence: paused while wet = connected through every
    // submersion; resumed on a 3 s timer while it stood in water = kicked on that very tick.
    // So physics follows wet/dry. The cost is that pathfinder and the drowning watchdog go quiet
    // while submerged - which is acceptable, because a flooded 1-wide column cannot be climbed
    // anyway (the server refuses to place a block into the cell the player occupies) and
    // keepInventory=true turns drowning into a 15 s trip back to the surface. Prevention is the
    // real fix and lives in deep_shaft: it now probes down the column for an aquifer before
    // stepping into it, and records flooded columns in runs/flooded_columns.json.
    let wetSince = 0;
    let loginAt = 0;
    let chunksReady = false;
    const wetHere = () => {
      try {
        if (!bot.entity || bot.health <= 0) return false;
        const f = bot.entity.position.floored();
        const wet = (p) => { const b = bot.blockAt(p); return !!b && b.name.includes('water'); };
        return wet(f) || wet(f.offset(0, 1, 0));
      } catch { return false; }
    };
    // Is there dry standing ground within `r` of the bot? Coarse (stride 3) and cached for 20 s, because
    // `setWet` flips several times a minute while the bot bobs on the surface and this feeds the routing
    // cost, not a decision that needs a perfect answer.
    let dryProbe = { at: 0, x: null, z: null, within: false };
    const dryGroundNear = (r) => {
      try {
        const f = bot.entity.position.floored();
        if (dryProbe.x !== null && Math.abs(f.x - dryProbe.x) < 6 && Math.abs(f.z - dryProbe.z) < 6 && Date.now() - dryProbe.at < 20000) return dryProbe.within;
        const solid = (b) => !!b && b.boundingBox === 'block' && !/lava|water/.test(b.name);
        let found = false;
        for (let dx = -r; dx <= r && !found; dx += 3) {
          for (let dz = -r; dz <= r && !found; dz += 3) {
            for (let dy = 4; dy >= -4; dy--) {
              const q = f.offset(dx, dy, dz);
              let feet = null, floor = null, head = null;
              try { feet = bot.blockAt(q); floor = bot.blockAt(q.offset(0, -1, 0)); head = bot.blockAt(q.offset(0, 1, 0)); } catch { continue; }
              if (!floor || !solid(floor)) continue;
              if (!feet || solid(feet) || /lava|water/.test(feet.name)) continue;
              if (head && (solid(head) || /lava|water/.test(head.name))) continue;
              found = true; break;
            }
          }
        }
        dryProbe = { at: Date.now(), x: f.x, z: f.z, within: found };
        return found;
      } catch { return true; }
    };
    const setWet = (on, why) => {
      if (bot._wet === on) return;
      bot._wet = on;
      // Physics is no longer switched off here: a paused simulation is precisely what produced the
      // stale-position-with-onGround=true packet above. Wet now means "planner, stop touching
      // controls", which keeps pathfinder/jump/forward out of the fluid without freezing the clock.
      // ...and the route must stop choosing water in the first place. The pause is reactive: the
      // pathfinder plans a path THROUGH the lake, the bot enters it, gets paused, drowns to ~6% air,
      // the step is aborted, and the next step plans the same path - 30 minutes of `moved=0b` at
      // -310..-342,61,1526-1542 (night_watch 09:40:38 `HELD 30 min on cur=food`) with the bot starving
      // beside a lake it cannot cross. Raising the liquid cost makes the planner route around the shore
      // like a player does, instead of re-planning the same swim once the step restarts.
      try {
        syncPathfinderPolicy(bot, mov, { wet: on, dryNear: on ? dryGroundNear(12) : true });
      } catch {}
      if (on) { wetSince = Date.now(); const f = bot.entity.position.floored(); log.warn(`submerged at ${f.x},${f.y},${f.z}${why ? ' (' + why + ')' : ''} - movement policy paused, liquidCost=${mov.liquidCost}, canDig=${mov.canDig}`); }
      else log.info(`movement policy resumed${why ? ' (' + why + ')' : ''}${wetSince ? ` after ${Math.round((Date.now() - wetSince) / 1000)}s wet` : ''} (liquidCost=${mov.liquidCost}, canDig=${mov.canDig})`);
    };
    const wetTick = () => {
      const ok = (chunksReady || Date.now() - loginAt > 15000) && Date.now() - loginAt >= 2500;
      bot._chunksOk = ok;
      if (!ok) return;
      const wet = wetHere();
      setWet(wet, wet ? 'in water' : 'standing dry');
      // Keep mov.canDig / mov.liquidCost synced whenever picks break or are newly crafted.
      try { syncPathfinderPolicy(bot, mov, { wet, dryNear: wet ? dryGroundNear(12) : true }); } catch {}
    };
    bot._chunksOk = false;
    bot.on('spawn', () => {
      loginAt = Date.now(); chunksReady = false;
      // Do NOT freeze physics here. The move ring caught exactly what freezing does: the bot held
      // the login teleport coordinate byte-identical for 1.2 s while gravity ran server-side, then
      // reported that stale position with onGround=true, and Paper cut the connection on that very
      // packet. A bare client left in physics mode idled at the same spawn for 20 s without a kick,
      // so the trigger was our frozen position, not the fluid. _wet is still armed true for the
      // first 2.5 s so the planner keeps its hands off, but nothing pauses the simulation.
      bot._wet = true; bot.physicsEnabled = true; bot._chunksOk = false;
      let settled = false;
      const done = () => { if (settled) return; settled = true; chunksReady = true; wetTick(); };
      try { bot.waitForChunksToLoad().then(done, done); } catch { done(); }
      setTimeout(done, 8000);
    });
    bot.on('respawn', () => { loginAt = Date.now(); chunksReady = false; bot._wet = true; bot.physicsEnabled = true; bot._chunksOk = false; });
    setInterval(wetTick, 700);
    // Drowning watchdog: the assist-free run died 3 times in the same underground lake while
    // digging, and each death scattered its pickaxe/ingots on the lake floor. Swim out on low air
    // (and dig the ceiling if that is what is overhead) instead of relying on OP effects.
    let lastAir = 0;
    let lastStaleAir = 0;
    bot.on('physicsTick', () => {
      try {
        // The air meter is not trustworthy before the world around us is loaded. Measured: a bare
        // client read oxygenLevel `undefined` at its first spawn and 20 after the server's own
        // position push, i.e. the value that arrives in the first second is not the live one.
        // Acting on it is what killed both instances all night: the swim burst fired ~1.3 s after
        // every login and its force-look packet carried onGround=true while our position was still
        // frozen at the login coordinate, so Paper answered invalid_player_movement and the loop
        // restarted. Gate: loaded chunks, a login older than 3 s, and water we can actually see.
        if (!chunksReady || Date.now() - loginAt < 3000) return;
        const ox = bot.oxygenLevel;
        if (typeof ox !== 'number') return;
        // Scale-relative, and EARLY. This server reports air in ticks (~300 dry), so `ox > 8` meant the
        // burst only fired once the bot was already drowning - while the planner killed the wet step at
        // 20% of the meter (~60 ticks). That gap is the 5x "ABORTED mid-step: out of air (oxygen=20)" of
        // 16:00-16:17 and the `enter_end` lock on the same line: the escape existed and never got the hand.
        if (ox > (bot._airMaxSeen || 0)) bot._airMaxSeen = ox;
        const airMax = Math.max(bot._airMaxSeen || bot._airMax || 10, 10);
        if (ox > airMax * 0.5) return;
        if (!wetHere()) {
          if (Date.now() - lastStaleAir > 15000) {
            lastStaleAir = Date.now();
            const f = bot.entity.position.floored();
            log.warn(`air=${ox} but no water in the body cells at ${f.x},${f.y},${f.z} - stale reading, not swimming`);
          }
          return;
        }
        if (Date.now() - lastAir < 3000) return;
        lastAir = Date.now();
        const f = bot.entity.position.floored();
        const above = bot.blockAt(f.offset(0, 1, 0));
        const head = bot.blockAt(f.offset(0, 2, 0));
        (async () => {
          try {
            // dig upward through soil/gravel so a water-filled ceiling cannot trap us
            for (const b of [above, head]) {
              if (b && b.name !== 'air' && b.name !== 'cave_air' && !/water|lava|bedrock/.test(b.name)) {
                try { await bot.dig(b); } catch {}
              }
            }
            await bot.look(Number.isFinite(bot.entity.yaw) ? bot.entity.yaw : 0, -Math.PI / 2, true); // straight up
            bot.setControlState('jump', true);
            bot.setControlState('forward', true);
            await new Promise(r => setTimeout(r, 1400));
            bot.setControlState('forward', false);
            bot.setControlState('jump', false);
            log.warn(`low air (${ox}) at ${f.x},${f.y},${f.z} - swimming up${above ? ' past ' + above.name : ''}`);
          } catch {}
        })();
      } catch {}
    });
    bot.on('spawn', () => {
      // One-shot position rescue, independent of MC_ASSIST because the situation it fixes is one
      // where no policy applies: the saved spot at (21,43,-8) sits in flowing water, the server
      // pushes the player out while our model cannot follow, and every single login died with
      // invalid_player_movement inside ~15 s - 14 kicks in 6 minutes, planner never reached a
      // skill. MC_RESCUE_TP="x y z" runs /tp on the first spawn of a process and then clears
      // itself. It IS an admin command: using it makes that run not assist-free, so say so loudly.
      const rescue = (process.env.MC_RESCUE_TP || '').trim();
      if (rescue && /^\-?\d+(\.\d+)?(\s+\-?\d+(\.\d+)?){2}$/.test(rescue)) {
        process.env.MC_RESCUE_TP = '';
        log.warn(`ASSIST: one-shot MC_RESCUE_TP -> /tp @s ${rescue} (this run is no longer strictly assist-free)`);
        try { bot.chat(`/tp @s ${rescue}`); } catch {}
        setTimeout(() => { try { bot.chat('/effect give @s minecraft:slow_falling 30 0 true'); } catch {} }, 1500);
        return;
      }
      if (process.env.MC_ASSIST === '0') return;
      try { bot.chat('/effect give @s minecraft:slow_falling 90 0 true'); } catch {}
      // Self-dug trap: the pinned respawn column was the very shaft it digs, so every respawn put
      // it in mid-air above a 100-block hole (49 deaths at the same x,z in 10 minutes). Step
      // sideways onto solid plateau instead of falling in again.
      setTimeout(() => {
        try {
          const f = bot.entity.position.floored();
          const below = bot.blockAt(new (require('vec3'))(f.x, f.y - 1, f.z));
          if (below && (below.name === 'air' || below.name === 'cave_air' || below.name === 'void_air')) {
            log.warn(`respawned over a hole at ${f.x},${f.y},${f.z} - stepping 12 blocks aside`);
            bot.chat(`/tp @s ${f.x + 12} ~ ${f.z}`);
          }
        } catch {}
      }, 900);
    });
    // "No silent failure" instrumentation: a broken call inside `try { ... } catch {}` had hid
    // for the whole project (22 goto sites were throwing a JS parse error and nobody saw it).
    // Log the first few failures of each kind, then stay quiet.
    const seen = {};
    const instrument = (obj, name) => {
      if (!obj || typeof obj[name] !== 'function') return;
      const orig = obj[name].bind(obj);
      obj[name] = (...args) => {
        // The hand belongs to the live step only. A worker whose step was abandoned by withTimeout
        // keeps running (awaiting does not cancel it) and its gotos/digs cancel whatever the next
        // step is trying to do - the two-driver churn at 09:47 on 2026-10-29. AsyncLocalStorage
        // tells us which generation this call came from; calls from outside any lease (chat
        // replies, the wet-escape helpers) are always allowed, so this cannot freeze the bot.
        if (lease.stale()) return lease.refuse(name);
        // bedrock, liquids, and air are unbreakable: bot.dig() on them either warns forever or computes
        // digTime=Infinity and hangs the whole milestone until STEP QUIET ABORT (live 10:36:53 hung on lava).
        if (name === 'dig' && args[0] && args[0].name) {
          const bn = args[0].name;
          if (bn.includes('bedrock') || bn === 'lava' || bn === 'water' || bn === 'air' || bn === 'cave_air' || bn === 'void_air') {
            return Promise.reject(new Error(`refusing to dig unbreakable/liquid block ${bn}`));
          }
        }
        // A `goto` whose promise never lands is the fault that froze the obsidian step twice today
        // (05:40:30 and 05:52:04 both logged `mine: heading to iron_ore ... (try 1)` and then nothing at
        // all until the step's own 25-minute budget expired). Bound it by LACK OF PROGRESS, not by wall
        // clock: a 400-block route legitimately runs for a minute, while a path that has not moved the
        // position for a full minute never will. Dig-in-path keeps the position still, so the window sits
        // above the slowest honest block break (obsidian ~10 s) with a wide margin.
        let guard = null;
        if (name === 'goto') {
          const STALL_MS = Number(process.env.PATH_STALL_MS || 28000);
          return new Promise((resolve, reject) => {
            let settled = false;
            const t0 = Date.now();
            let anchor = { x: 0, y: 0, z: 0 };
            try { const p0 = bot.entity.position; anchor = { x: p0.x, y: p0.y, z: p0.z }; } catch {}
            let lastMove = Date.now();
            const finish = (err, val) => {
              if (settled) return;
              settled = true;
              if (guard) { clearInterval(guard); guard = null; }
              if (err) {
                const key = name + ':' + (err && err.message ? err.message.slice(0, 60) : String(err));
                seen[key] = (seen[key] || 0) + 1;
                if (seen[key] <= 3) log.warn(`silent-failure guard ${key} (x${seen[key]})`);
                reject(err);
              } else {
                resolve(val);
              }
            };
            guard = setInterval(() => {
              try {
                const p = bot.entity.position;
                if (hasPathMoved(anchor, p)) {
                  anchor = { x: p.x, y: p.y, z: p.z };
                  lastMove = Date.now();
                }
                if (Date.now() - lastMove > STALL_MS) {
                  const elapsedS = Math.round((Date.now() - t0) / 1000);
                  const stillS = Math.round((Date.now() - lastMove) / 1000);
                  log.warn(`path guard: goto outstanding ${elapsedS}s with no movement for ${stillS}s - cancelling the path so the step can hand back`);
                  try { bot.setControlState('jump', false); } catch {}
                  try { obj.stop('no-progress path guard'); } catch {}
                  // mineflayer-pathfinder's stop() does not always reject a hung goto() promise (measured
                  // 09:33:28 -> 09:36:29: 181s silent hang after stop()). Reject explicitly so the step hands back immediately.
                  finish(new Error(`path guard: goto stalled with no progress for ${stillS}s`));
                }
              } catch { if (guard) { clearInterval(guard); guard = null; } }
            }, 2000);
            const rawP = Promise.resolve().then(() => orig(...args));
            rawP.then(v => finish(null, v), e => finish(e));
          });
        }
        const dropGuard = () => { if (guard) { clearInterval(guard); guard = null; } };
        return Promise.resolve(orig(...args)).then(v => { dropGuard(); return v; }, e => {
          dropGuard();
          const key = name + ':' + (e && e.message ? e.message.slice(0, 60) : String(e));
          seen[key] = (seen[key] || 0) + 1;
          if (seen[key] <= 3) log.warn(`silent-failure guard ${key} (x${seen[key]})`);
          throw e;
        });
      };
    };
    instrument(bot.pathfinder, 'goto');
    installSafeDig(bot);
    instrument(bot, 'dig');
    instrument(bot, 'placeBlock');
    instrument(bot, 'equip');
    instrument(bot, 'craft');
    instrument(bot, 'activateBlock');
    instrument(bot, 'clickWindow');
    instrument(bot, 'toss');
    instrument(bot, 'tossStack');
    instrument(bot, 'openBlock');
    instrument(bot, 'openContainer');
    instrument(bot, 'openFurnace');
    // A non-finite number that reaches the engine is not a bad read, it is a dead client. Live 21:41:38 the
    // bot logged in clean at (-286,56,1404); by 21:43:28 `status` printed `pos=NaN,50,NaN` AND every nearby
    // animal read `salmon@NaN` - so the shared coordinate space had gone, not one entity - and at 21:45:25
    // Paper cut the connection with `invalid_player_movement` because the client was REPORTING those
    // numbers. The 90 s of NaN before the kick cost more than the kick did: portalRecord answered `no room
    // on file` for a door that IS on file, bridge_to laid 0 blocks reading `cell NaN,63,NaN`, and the model
    // planned `use_portal -> farm_blaze` for a stronghold it could no longer measure. The writer IS now
    // named: mineflayer has no `bot.yaw` at all (0 occurrences in the package), and physics.js:347 is
    // `bot.entity.yaw += Math.round((yaw - bot.entity.yaw) / sensitivity) * sensitivity` - so the
    // `bot.look(bot.yaw, ...)` calls poisoned the rotation with NaN, and the integrator poisoned the
    // position with it. Four call sites are fixed to read `bot.entity.yaw`; the guards below stay, because
    // a boundary that refuses the number is cheaper than a kick, and it prints the caller if it recurs.
    const fin = (n) => typeof n === 'number' && Number.isFinite(n);
    const whoAsked = () => { try { const s = String(new Error().stack).split('\n'); return (s[4] || s[3] || '').trim().replace(/^at\s+/, '').replace(/.*[\\/]/, '').slice(0, 70); } catch { return '?'; } };
    const rawLook = bot.look.bind(bot);
    bot.look = (yaw, pitch, force, ...rest) => {
      const e = bot.entity || {};
      const y = fin(yaw) ? yaw : (fin(e.yaw) ? e.yaw : 0);
      const p = fin(pitch) ? pitch : 0;
      if (y !== yaw || p !== pitch) log.warn(`LOOK GUARD: refused non-finite rotation (yaw=${yaw} pitch=${pitch}) from ${whoAsked()} - substituted (${y.toFixed(2)}, ${p.toFixed(2)})`);
      return rawLook(y, p, force, ...rest);
    };
    const rawLookAt = bot.lookAt.bind(bot);
    bot.lookAt = (pos, ...rest) => {
      if (!pos || !fin(pos.x) || !fin(pos.y) || !fin(pos.z)) {
        log.warn(`LOOKAT GUARD: refused non-finite target (${pos && pos.x},${pos && pos.y},${pos && pos.z}) from ${whoAsked()}`);
        return Promise.resolve();
      }
      return rawLookAt(pos, ...rest);
    };
    const rawGoto = bot.pathfinder.goto.bind(bot.pathfinder);
    bot.pathfinder.goto = (goal, ...rest) => {
      const g = goal && goal.position;
      if (g && (!fin(g.x) || !fin(g.y) || !fin(g.z))) {
        log.warn(`GOTO GUARD: refused non-finite goal (${g.x},${g.y},${g.z}) from ${whoAsked()}`);
        return Promise.reject(new Error('non-finite goto goal'));
      }
      return rawGoto(goal, ...rest);
    };
    let desync = 0;
    setInterval(() => {
      let p = null;
      try { p = bot.entity && bot.entity.position; } catch { p = null; }
      if (!p) { desync = 0; return; }   // not spawned yet is not a desync
      if (fin(p.x) && fin(p.y) && fin(p.z)) { desync = 0; return; }
      desync++;
      if (desync === 1) log.warn(`POSITION DESYNC: ${p.x},${p.y},${p.z} - controls released; the server still holds the real coordinates`);
      try { for (const k of ['forward', 'back', 'left', 'right', 'jump', 'sneak', 'sprint']) bot.setControlState(k, false); } catch {}
      try { bot.pathfinder.stop(); } catch {}
      if (desync >= 4) { log.warn('POSITION DESYNC held ~6s - exiting so the supervisor can log back in with a clean position'); process.exit(43); }
    }, 1500);
    if (bot.autoEat && bot.autoEat.enableAuto) { try { bot.autoEat.enableAuto(true); } catch {} }
    if (!bot._home) { try { bot._home = bot.entity.position.floored(); log.info('home set', bot._home); } catch {} }
    // Companion bootstrap: with OP (ops.json), lock daylight to day so night-mob deaths don't stall it.
    // Harmless no-op if not OP. Disable with MC_DAY_LOCK=0 (e.g. when playing with a human who wants real nights).
    if (process.env.MC_DAY_LOCK !== '0') {
      // World rules the operator chooses (not item grants). MC_WORLD_RULES=0 turns them off so an
      // acceptance run also gets real night cycles and death drops - state the exact config when
      // claiming an autonomous clear.
      if (process.env.MC_WORLD_RULES !== '0') {
        try { bot.chat('/time set day'); bot.chat('/gamerule doDaylightCycle false'); bot.chat('/gamerule keepInventory true'); } catch {}
      }
    }
    // Operator's call 2026-11-05: "给自己加个永久饱和，不要去找食物了，现在只验证打龙过程". Saturation is
    // the one effect that makes the hunger bar unspendable, so every food errand - hunt, kelp, village,
    // the zombie corridor, the deep-larder descent - becomes pointless on its own rather than something I
    // have to argue the planner out of, and tonight those errands are exactly what ate the dives (a
    // 112-minute stage lock, then a 14-minute hand-dig descent while the door stood open 122 blocks away).
    // Re-cast on every spawn because DEATH CLEARS STATUS EFFECTS and the End has eaten it a dozen times.
    // This is an OP effect: it exists only while MC_ASSIST != 0, so inst2's strict acceptance run never
    // sees it, and any run that uses it is a fight test, not evidence of a self-sufficient speedrun.
    if (process.env.MC_PERMA_FED === '1' && process.env.MC_ASSIST !== '0') {
      // Two forms, because `infinite` is 1.19+ syntax and a rejected argument is invisible otherwise: the
      // meter fell 20 -> 13 by 03:25:39 with the `infinite` cast logged at 03:12:13. A numeric duration is
      // unambiguous, and the SERVER'S OWN REPLY is now logged - that is the only proof of what the command
      // parser thought of it.
      const castSat = (dur) => { try { bot.chat(`/effect give @s minecraft:saturation ${dur} 255 true`); } catch {} };
      const reply = (msg) => {
        let t = '';
        try { t = msg.toString(); } catch { return; }
        if (/saturated|saturation|effect|unknown|Incomplete|Unable to|couldn't|not found|must be/i.test(t)) log.info(`PERMA-FED server reply: ${t.slice(0, 140)}`);
      };
      bot.on('message', reply);
      setTimeout(() => { try { bot.removeListener('message', reply); } catch {} }, 8000);
      castSat(1000000);
      log.warn(`PERMA-FED (operator's call, disclosed): saturation cast on spawn for 1000000 s - finite ON PURPOSE, because an "infinite" duration is applied once and never re-settled, so the meter still drained 20 -> 9 with "Applied effect Saturation" logged; a finite duration ticks and refills every game tick. The food milestone and both ration gates stand down; picks, arrows and the bench are still earned the hard way`);
      // The cast is judged by the thing it is supposed to hold, not by the packet: `bot.entity.effects`
      // is not reliably populated, and a rejected argument (`infinite` is 1.19+ syntax) is otherwise
      // invisible. So: watch the hunger bar, and if it moves, say that the effect is NOT holding and
      // re-cast with a numeric duration. Silent saturation would look like success while the food
      // errands came back.
      let lastFedCasts = 0;
      bot._fedWatch = setInterval(() => {
        try {
          if (!(bot.health > 0)) return;   // `bot.isAlive` is a BOOLEAN in mineflayer's health plugin, not a
                                    // method: `!bot.isAlive || !bot.isAlive()` threw on every tick and the
                                    // catch cleared the interval, so all three of these watchdogs were dead
                                    // code from the first spawn (`VOID GUARD threw bot.isAlive is not a
                                    // function` at 10:17:57-10:18:00 is what proved it).
          // Judged on the meter, not on `bot.entity.effects`: that field reports numeric registry ids
          // (`effects=[10,22,27]` at 02:34:29), so a name test on it can never match and would hide a
          // failed cast.
          if (bot.food >= 19) return;
          if (Date.now() - lastFedCasts < 30000) return;
          lastFedCasts = Date.now();
          log.warn(`PERMA-FED re-cast: food=${bot.food} hp=${Math.round(bot.health)} - the spawn cast is not holding, re-issuing /effect give`);
          castSat(1000000);
        } catch (e) {
          // A watchdog that clears itself on the first throw turns one bug into permanent silence: this
          // one swallowed `bot.isAlive is not a function` every 15 s and never logged, so the saturation
          // re-cast has never once run. Log it, keep the interval, and only give up after five in a row.
          bot._fedWatchErr = (bot._fedWatchErr || 0) + 1;
          if (bot._fedWatchErr <= 3 || bot._fedWatchErr % 20 === 0) log.warn(`PERMA-FED watchdog threw (${bot._fedWatchErr}x): ${String(e.message).slice(0, 80)} - still running`);
          if (bot._fedWatchErr >= 5) { log.warn('PERMA-FED watchdog: 5 consecutive throws, standing down'); clearInterval(bot._fedWatch); }
        }
      }, 15000);
      setTimeout(() => {
        try {
          const eff = (bot.entity && bot.entity.effects) ? Object.keys(bot.entity.effects).join(',') : 'unreadable';
          log.info(`PERMA-FED probe 5 s after spawn: effects=[${eff}] food=${bot.food} hp=${Math.round(bot.health)} - food has to sit near 20 through a fight for this cast to be real`);
        } catch {}
      }, 5000);
    }
    // VOID GUARD (operator's call, disclosed; MC_ASSIST=0 never installs it). The End kills a slipped bot
    // faster than any skill loop can notice: `end footing unsafe ... rescue gained nothing` needs three
    // iterations to escalate, and by the third the bot is past y=-91 - which is how 31 of tonight's 59
    // deaths were counted in the End (`DIED at {"x":3,"y":-91,"z":-86}`, r=3 UNDER the island). So a 1 s
    // heartbeat, owning nothing and waiting for no lease, puts it back on an island cell the client can
    // actually see. The lift verifies its own landing, so a probe into unloaded rock is logged and retried
    // at the next ring radius rather than reported as a rescue.
    if (process.env.MC_ASSIST !== '0') {
      clearInterval(bot._voidWatch);
      bot._voidWatch = setInterval(async () => {
        try {
          if (!require('./skills/endgame').inEnd(bot)) return;   // `game.dimension` goes stale across the
                                                                   // portal flip; decide from the world
          if (!(bot.health > 0)) return;                          // see the note on the fed watchdog
          if (bot._voidLiftBusy) return;
          const p = bot.entity.position;
          if (p.y > 50) return;                                     // above the island rim: ordinary work
          const below = bot.blockAt(new (require('vec3'))(Math.floor(p.x), Math.floor(p.y - 1), Math.floor(p.z)));
          const falling = !below || below.boundingBox === 'none' || /air/.test(below.name);
          if (!falling) return;
          if (bot._voidLiftAt && Date.now() - bot._voidLiftAt < 9000) return;
          bot._voidLiftAt = Date.now();
          bot._voidLiftBusy = true;
          try {
            const ok = await require('./skills/endgame').opVoidLift(bot, `heartbeat: y=${Math.round(p.y)} with ${below ? below.name : 'NULL'} under it at r=${Math.round(Math.hypot(p.x, p.z))}`);
            if (!ok) log.warn('VOID GUARD: no island cell readable below the rim - the fall stands and the dive pays for it');
          } finally { bot._voidLiftBusy = false; }
        } catch (e) { log.warn(`VOID GUARD threw ${String(e.message).slice(0, 70)}`); }
      }, 1000);
    }
    // Respawn inside a block is a death sentence on a loop: at 04:36:02 the pinned portal-room anchor had
    // since been built over, the bot materialised inside it and read `Numen suffocated in a wall` 13 s
    // after the End death - two deaths in fifteen seconds, and every future End death would pay the same.
    // The anchor is re-derived on the next dive, but the escape has to exist for the round it happens in.
    setTimeout(async () => {
      try {
        if (!(bot.health > 0)) return;                          // see the note on the fed watchdog
        const f = bot.entity.position.floored();
        const V = require('vec3');
        const at = (dy) => { try { return bot.blockAt(new V(f.x, f.y + dy, f.z)); } catch { return null; } };
        const feet = at(0), head = at(1);
        const solid = (b) => !!b && b.boundingBox === 'block';
        if (!solid(feet) && !solid(head)) return;
        const stuck = [feet, head].filter(solid).map(b => b.name).join('+');
        if (process.env.MC_ASSIST !== '0') {
          log.warn(`spawned inside ${stuck} at ${f.x},${f.y},${f.z} - lifting out (disclosed /tp; the anchor cell was built over since it was pinned)`);
          for (const dy of [1, 2, 3, 4]) {
            if (solid(at(dy)) || solid(at(dy + 1))) continue;
            try { bot.chat(`/tp @s ${f.x + 0.5} ${f.y + dy} ${f.z + 0.5}`); } catch {}
            return;
          }
        } else {
          log.warn(`spawned inside ${stuck} at ${f.x},${f.y},${f.z} - MC_ASSIST=0, digging out directly`);
        }
        // nowhere clear above (or assist disabled): dig the cell we are in and the one overhead
        try { const pick = bot.inventory.items().find(i => /_pickaxe$/.test(i.name)); if (pick) { await bot.equip(pick, 'hand'); } if (solid(feet)) await bot.dig(feet); if (solid(head)) await bot.dig(head); } catch (e) { log.warn(`spawned-inside dig out threw ${String(e.message).slice(0, 60)}`); }
      } catch {}
    }, 1500);
    log.info('spawned at', bot.entity.position.floored(), 'dim', bot.game && bot.game.dimension);
  });

  bot.on('kicked', (r) => log.err('kicked', String(r).slice(0, 200)));
  bot.on('error', (e) => log.err('bot error', e.message));
  bot.on('end', (r) => log.warn('connection end', String(r)));
  // Unattended runs die; "DIED at {x,y,z}" without a cause was undiagnosable across several
  // sessions. The server announces the reason in chat, so keep the latest one and print it.
  bot.on('message', (msg) => {
    let t = ''; try { t = msg.toString(); } catch { return; }
    const esc = String(cfg.mc.username || 'Numen').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const nameRe = new RegExp(`\\b(${esc}|Numen|you)\\b`, 'i');
    if (/\b(was slain|fell from|drowned|burned|was killed|by|exploded|went off|starved|was poisoned|suffocated|hit the ground|tried to swim|withered|froze|fell out of the world)\b/i.test(t) && nameRe.test(t)) bot._lastDeathMsg = t.slice(0, 120);
  });
  // Bring the End-death tally back on login: the dive gate raises its armour bar off this number, and a
  // gate that forgets why it was angry is just a door.
  try {
    const ed = JSON.parse(require('fs').readFileSync(require('./config').paths.runs + '/end_deaths.json', 'utf8')) || {};
    bot._endDeaths = ed.endDeaths || 0; bot._deaths = ed.deaths || 0;
    // The armour relaxation is anchored to the death count when it was granted; if that anchor is lost on
    // redeploy the "release for now" becomes "release forever", which is not what was agreed.
    bot._armourRelaxedAt = Number.isFinite(ed.armourRelaxedAt) ? ed.armourRelaxedAt : undefined;
    // The dive gate's counted last resort runs off this too; without it every redeploy restarts the
    // countdown and "kept trying for 30 minutes" never reads as true (20:43 stall 8 -> 20:53 stall 0).
    bot._enterEndArmorStall = ed.armorStall || 0;
    bot._enterEndArmorLast = Number.isFinite(ed.armorLast) ? ed.armorLast : undefined;
    if (bot._endDeaths) log.info(`restored death memory: endDeaths=${bot._endDeaths} deaths=${bot._deaths} armourStall=${bot._enterEndArmorStall} (from ${new Date(ed.at || 0).toISOString()})`);
  } catch {}
  bot.on('death', (cause, message) => {
    // The chat parse above is best-effort (two deaths tonight printed "(no death message captured)").
    // What supervision actually needs at the moment of dying: mineflayer's own `cause`, and whether the
    // worn set and the pack were still there - the difference between "keepInventory kept it" and "the
    // armour went with the death", which cost two re-crafts (05:43, 06:18) and was invisible before.
    const worn = [5, 6, 7, 8].map(s => (bot.inventory.slots[s] || {}).name || '-').join(',');
    // Counted, because the dive gate now fails open on a stall: "one more try" and "it has been dying
    // in the End all night" are different facts, and the exemption has to close again on the second one.
    bot._deaths = (bot._deaths || 0) + 1;
    if (require('./skills/endgame').inEnd(bot)) {
      bot._endDeaths = (bot._endDeaths || 0) + 1;
      // Persisted, because `bot._endDeaths` alone is erased by every redeploy - and the dive gate's
      // "two deaths in the End means get a chestplate first" rule is exactly the kind of promise that
      // must survive a restart. 3 deaths were counted, then reset by my own bot-restart twice tonight.
      try { require('fs').writeFileSync(require('./config').paths.runs + '/end_deaths.json', JSON.stringify({ endDeaths: bot._endDeaths, deaths: bot._deaths, armourRelaxedAt: Number.isFinite(bot._armourRelaxedAt) ? bot._armourRelaxedAt : null, armorStall: bot._enterEndArmorStall || 0, armorLast: Number.isFinite(bot._enterEndArmorLast) ? bot._enterEndArmorLast : null, at: new Date().toISOString() })); } catch {}
    }
    log.warn('DIED at', bot.entity.position.floored(), 'reason:', bot._lastDeathMsg || '(no chat message)',
      'cause:', cause || '?', 'deathMsg:', message ? String(message).slice(0, 90) : '-',
      '| worn=[' + worn + ']', 'packItems=' + bot.inventory.items().length,
      'air=', bot.oxygenLevel, 'dim=', bot.game && bot.game.dimension,
      'deaths=', bot._deaths, 'endDeaths=', bot._endDeaths || 0);
  });
  bot.on('finishedAchievement', (a) => {
    const id = (a && (a.id || a.name || a.achievements)) ? JSON.stringify(a) : '';
    log.info('achievement', id.slice(0, 120));
    if (/free[_ ]?end|end\/dragon/i.test(id)) { bot._dragonKilled = true; log.info('*** ENDER DRAGON DEFEATED — game cleared ***'); }
  });

  return bot;
}

module.exports = { createBot, goals, selectConservativeTool, syncPathfinderPolicy, hasUsableBulkPick, installSafeDig, hasPathMoved };
