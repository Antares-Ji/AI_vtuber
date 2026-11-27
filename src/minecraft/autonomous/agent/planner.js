'use strict';
const cfg = require('../config');
const log = require('../log');
const llm = require('../llm/deepseek');
const notes = require('../memory/notes');
const ob = require('../observe');
const reg = require('../skills/registry');
const P = require('../skills/primitives');
const lease = require('../stepLease');
const pov = require('../pov');
const stageLock = require('../stageLock');
const prompts = require('./prompts');
const bridge = cfg.hostBridge && cfg.hostBridge.enabled ? require('../host/bridge') : null;
require('../skills/primitives');
require('../skills/progression');
require('../skills/base');
const { LADDER } = require('../skills/progression');

// Nothing in the planner loop may be allowed to hang. mineflayer's toss/equip/place/activateItem
// await a 1.21 set_slot ack that sometimes never arrives, and one uncapped await froze the entire
// loop for ten minutes at 22:04 (identical position and inventory, not a single log line). cap()
// gives the call a deadline and moves on. The abandoned promise does NOT finish harmlessly: if it
// was walking, it keeps the pathfinder and poisons the next caller's goto, so cap() cancels the
// path when it stops waiting (CAP_BOT is set by run() because cap() has no bot of its own).
// 1, not 0: every long loop tests Date.now() < (bot._stepDeadline || Infinity), and 0 is falsy, so
// an orphaned loop - one a withTimeout abandoned mid-iteration - would read it as NO LIMIT and keep
// digging. This only softens the orphan; lease.run() above is what actually takes the hand away.
function expireStepDeadline(bot) { bot._stepDeadline = 1; }
// Arm a deadline WITHOUT lengthening one that is already live. Measured 2026-11-01 02:14:39 -> 02:21:44:
// the `armor` milestone step ran 434 s against its own printed 180 s budget, because the nested
// `decide:smelt` step wrote `bot._stepDeadline = now + its own cap` over the outer one - so every inner
// loop re-armed the clock it was supposed to be measured against. The earliest live deadline is the
// authority; a nested worker inherits the budget of whoever holds the hand, and 1 (expired) must stay
// expired or an orphaned loop reads a fresh window and keeps digging.
function armDeadline(bot, ms) {
  const until = Date.now() + ms;
  const cur = bot._stepDeadline;
  if (typeof cur === 'number' && cur > Date.now() && cur < until) return;
  bot._stepDeadline = until;
}

let CAP_BOT = null;
async function cap(promise, ms, label) {
  const r = await Promise.race([
    Promise.resolve(promise).then(v => ({ ok: true, v }), e => { log.warn(`${label} threw ${e && e.message ? e.message : e}`); return { ok: true, v: null }; }),
    new Promise(res => setTimeout(() => res(null), ms)),
  ]);
  if (r === null) {
    // Abandoning the promise is not enough: defend()/assistEffects()/dropJunk() each call
    // pathfinder.goto internally, and the abandoned goto keeps walking. The next thing that calls
    // goto then dies with "The goal was changed before it could be completed!" - which is how the
    // food and armour milestones kept failing on a step that was never even at fault. Cancel the
    // path at the moment we stop waiting for it.
    try { if (CAP_BOT && CAP_BOT.pathfinder && CAP_BOT.pathfinder.isMoving && CAP_BOT.pathfinder.isMoving()) CAP_BOT.pathfinder.stop(); } catch {}
    log.warn(`${label} hung past ${Math.round(ms / 1000)}s - path cancelled, skipped this round`);
    return undefined;
  }
  return r.v;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Every pre-milestone helper (pin escape, wet escape, survive, death-spiral rebuild, night hold,
// stageLock unblock) invokes skills whose inner loops test `Date.now() < (bot._stepDeadline || Infinity)`.
// Without arming a fresh deadline here, the expired sentinel `1` left by the previous milestone's
// `finally { expireStepDeadline(bot); }` makes `climbOut` / `walk_to` / `hunt` return in 0 ms,
// creating a tight synchronous spin loop (measured 2026-11-05 inst3: 3 ms/iter, 130 KB/s log flood).
async function runHelper(bot, ms, label, fn) {
  const prev = bot._stepDeadline;
  const freshBudget = Math.max(10000, ms - 5000);
  // Always override an expired deadline (<= Date.now()), while preserving a tighter live outer deadline.
  if (!(typeof prev === 'number' && prev > Date.now() && prev < Date.now() + freshBudget)) {
    bot._stepDeadline = Date.now() + freshBudget;
  }
  try {
    return await cap(fn(), ms, label);
  } finally {
    if (typeof prev === 'number' && prev > Date.now()) bot._stepDeadline = prev;
    else expireStepDeadline(bot);
  }
}

function startLiveBeat(bot) {
  const everyMs = Math.max(2000, (cfg.bot && cfg.bot.liveBeatMs) || 15000);
  const t = setInterval(() => {
    try {
      const p = typeof bot._liveBuild === 'function' ? bot._liveBuild() : bot._livePayload;
      if (!p) return;
      if (typeof bot._liveBuild !== 'function') p.ts = Date.now(); // legacy fallback: keep the age honest at least
      bot._livePayload = p;
      require('fs').writeFileSync(require('../config').paths.runs + '/live.json', JSON.stringify(p));
    } catch { /* never let a heartbeat break a step */ }
  }, everyMs);
  return () => clearInterval(t);
}

function withTimeout(promise, ms, bot) {
  return new Promise(resolve => {
    let done = false;
    let drownTimer = null;
    const stepStart = Date.now();
    const t = setTimeout(() => {
      if (done) return;
      done = true;
      // Only stop the pathfinder while this step still owns the hand. A late timer calling stop()
      // cancels whatever the NEXT step is walking: `walk_to: leg cancelled by Timeout._onTimeout
      // (planner.js:75)` at 21:51:57 is that cross-step cancellation, and it is the same mechanism as
      // the twelve 15 ms "Path was stopped" refusals that burned an obsidian field at 21:47:56.
      if (!lease.stale()) { try { bot.pathfinder.stop(); } catch {} }
      else log.warn(`step timeout in phase "${bot._loopPhase || '?'}" did NOT stop the pathfinder - that step no longer owns the hand`);
      cleanup();
      // Name the phase the step died in. A bare `timeout after 180s` is blind: the 02:02:12 ->
      // 02:05:12 armor round logged NOTHING at all for its whole budget, and "timeout" alone cannot
      // tell whether the wait was in dig, mine, smelt, craft or a window click.
      resolve({ ok: false, observation: `timeout after ${ms / 1000}s in phase "${bot._loopPhase || '?'}"` });
    }, ms);
    // A kicked bot does not kill the step it was running: the promise stays pending until its
    // 420 s timer fires, and that timer then called pathfinder.stop() on whatever the NEXT session
    // was doing. That cross-talk is what produced "milestone iron_gear not done: timeout after
    // 420s" five times inside 100 seconds, and the earlier "Path was stopped" wave. End the step
    // the moment the connection dies, and leave the new session's pathfinder alone.
    const die = () => {
      if (done) return;
      done = true;
      clearTimeout(t);
      cleanup();
      resolve({ ok: false, observation: 'connection ended mid-step' });
    };
    const cleanup = () => { try { if (drownTimer) clearInterval(drownTimer); bot.removeListener('end', die); bot.removeListener('kicked', die); } catch {} };
    bot.on('end', die);
    bot.on('kicked', die);
    // A running skill is never preempted, so a milestone step that ends up inside a water column just
    // drowns there while the planner's escape waits for the step to return: measured 05:36-05:39, the
    // bot sat at y=68 with `air=1` for four minutes while the obsidian step kept running. Hand the step
    // back when the air is genuinely gone - restricted to long steps (>=120 s), because the escape paths
    // themselves (dry_escape 20 s, recover_surface 90 s) run WHILE wet and must never be cut off for it.
    // `_wet` plus a real low oxygen reading is the discriminator: oxygenLevel is a known false 0/-1 for
    // ~1.3 s after login while chunks load, and `_wet` is deliberately armed true by respawn.
    drownTimer = setInterval(() => {
      if (done) return;
      // A step that stops talking is stuck, whatever its declared budget. `obsidian` now declares 25
      // minutes for honest work, and the wedge at 05:40:30 sat inside that budget with NO output at all
      // (an equip whose set_slot ack never arrives), so a long budget cannot double as a liveness test.
      // Silence ends the step early, by name, and it counts as a failed attempt for the stage lock.
      const QUIET_MS = Number(process.env.STEP_QUIET_MS || 180000);
      const silent = Date.now() - Math.max(log.lastAt(), stepStart);
      if (silent > QUIET_MS) {
        done = true; clearTimeout(t); cleanup();
        try { bot.pathfinder.stop(); } catch {}
        log.warn(`STEP QUIET ABORT: nothing logged for ${Math.round(silent / 1000)}s in phase "${bot._loopPhase || '?'}" - a step that stopped talking is not a step that is working`);
        resolve({ ok: false, observation: `SILENT for ${Math.round(silent / 1000)}s in phase "${bot._loopPhase || '?'}" (the last await never acked; the lease keeps the orphan from steering the bot)` });
        return;
      }
      if (ms < 120000) return;
      const air = bot.oxygenLevel;
      // Soft tier first: 16 steps were killed on 2026-10-30 by the hard abort alone (`out of air
      // (oxygen=2)`), each one throwing away a whole obsidian round when the bot still had 3-10 bubbles
      // and could have surfaced itself. This is a LOG only - the consumer is the wet work itself
      // (`obsidian_farm` refuses to start a 45-150 s submerged dig at <=6 bubbles). I first wrote it as
      // a `bot._lowAir` flag, then found nothing read the flag: a signal nobody consumes is a fake
      // signal, so the flag is gone and the warning line is what a human reads.
      // Scale-relative, because `bot.oxygenLevel` is NOT 0-10 here: the heartbeat read 303 and 314 at
      // 22:55, i.e. this server reports air in TICKS (~300 when dry), while these thresholds were written
      // for bubbles. `air <= 5` then means "5 ticks = half a second of air left" and `<= 2` means the
      // abort fires after drowning already started - which is why every air emergency still ended in a
      // 60-110 block `recover_surface` displacement instead of a calm swim up. Keep the highest value
      // seen as the denominator so the rule works on either scale, and print the percentage so nobody
      // has to guess which unit the number is in.
      if (typeof air === 'number' && air > (bot._airMax || 0)) bot._airMax = air;
      const airMax = Math.max(bot._airMax || 0, 10);
      const airPct = Math.round((air / airMax) * 100);
      if (bot._wet === true && typeof air === 'number' && air >= 0 && air <= airMax * 0.5 && !(bot._lowAirLogged && Date.now() - bot._lowAirLogged < 30000)) {
        bot._lowAirLogged = Date.now();
        log.warn(`LOW AIR: oxygen=${air} (${airPct}% of ${airMax}) in phase "${bot._loopPhase || '?'}" - wet work must surface before its next click (hard abort at 20%)`);
      }
      if (bot._wet === true && bot._chunksOk !== false && typeof air === 'number' && air >= 0 && air <= airMax * 0.2) {
        done = true; clearTimeout(t); cleanup();
        try { bot.pathfinder.stop(); } catch {}
        log.warn(`STEP AIR ABORT: oxygen=${air} in phase "${bot._loopPhase || '?'}" after ${Math.round(ms / 1000)}s - the breath ran out even with the early warning`);
        resolve({ ok: false, observation: `ABORTED mid-step: out of air (oxygen=${air}) in phase "${bot._loopPhase || '?'}" - the water escape needs the hand` });
      }
    }, 2000);
    Promise.resolve(promise)
      .then(r => { if (!done) { done = true; clearTimeout(t); cleanup(); resolve(r); } })
      .catch(e => {
        if (done) return;
        done = true; clearTimeout(t); cleanup();
        log.err('skill threw', e && e.stack ? e.stack : (e && e.message ? e.message : String(e)));
        resolve({ ok: false, observation: 'threw: ' + (e && e.message ? e.message : String(e)) });
      });
  });
}

function nextMilestone(bot, state) {
  let changed = false;
  // "Done" is not forever - but only for kit-shaped milestones whose items get spent, lost or
  // thrown away (a stale `done` walked the bot up to the stronghold with 0 eyes and 0 obsidian).
  // Early-game steps are deliberately NOT re-validated: a wooden pickaxe is legitimately gone once
  // it has been replaced by iron/diamond, and re-opening it parked the run back at milestone 3.
  // Only `food` may re-open. Every other milestone on this list is a thing that WEARS OUT or gets
  // CONSUMED by being used: iron armour breaks (2 fall deaths an hour plus melee), the diamond
  // pickaxe breaks, obsidian disappears into the portal frame it was collected to build, ender
  // pearls disappear into the eyes, flint_and_steel loses durability lighting portals. Re-checking
  // their conditions therefore deleted hard-won progress every time the item wore out, and the run
  // oscillated 13<->14<->15<->16 for hours re-crafting the same gear instead of walking to the End.
  // The steps themselves still fail honestly when an item is missing (mine's tier guard, make_obsidian
  // demanding a diamond pick), so nothing proceeds on a false premise - it just no longer rewinds.
  // `armor` is deliberately NOT revalidated any more. Iron armour survives roughly 30 minutes of deep
  // mining, so re-checking it every loop rewound the milestone three times in one hour today (05:43,
  // 06:18, 07:25), each rewind re-spending ~12 ingots it had to mine and smelt again - and the ladder
  // never got past `obsidian` while that tax existed. The protection moved to where a wipe actually
  // costs the trip: `enter_end` now builds a set itself if it arrives under-equipped (see the
  // provisioning loop in src/skills/progression.js), so nothing can dive into the End naked - which was
  // the only reason `armor` was in this list to begin with.
  // 'armor' has to be IN this set or the danger branch below is dead code - it was: `worn=[]` for
  // hours, three deaths in 60 s at 18:43 (zombie, creeper, fall) in a cave at y=13-31, and the
  // re-open never fired because the `continue` above filtered armor out before its own check ran.
  // Re-check ONLY what cannot be legitimately consumed. This list was the cause of a 9-hour regression
  // on 2026-10-31 16:30 -> 2026-11-01 01:33: I added the tool milestones (wooden_pickaxe, stone_tools,
  // iron_gear, diamond_pick, diamond_gear) because `diamond_pick` stayed falsely done after the pick
  // wore out - but every one of those predicates is "the pack holds an unbroken tool of tier X", and
  // tools BREAK. So the ladder re-opened them constantly, `ms` oscillated 12<->16, `cur` bounced among
  // wooden_pickaxe/stone/iron/diamond, and the head of the ladder never reached `nether` even after the
  // bot built a diamond pickaxe at 00:08. The lesson is the one already written below: a stock quantity
  // that can be spent is not a fact to re-assert; only an unobservable-now state (dimension, hunger,
  // nothing worn) is. A missing pick is fixed by the step that needs it (make_obsidian's prerequisite,
  // ensure_diamond_pick, the stage routes), not by rewinding the ladder.
  const REVALIDATE = new Set(['food', 'armor', 'nether', 'enter_end']);
  for (const m of LADDER) {
    if (!state.done[m.id] || !REVALIDATE.has(m.id)) continue;
    // Never judge a milestone from a world that has not finished loading. On every boot/reconnect the
    // first sweep ran within ~1-2 s of `planner started`, before the inventory packet lands: slots 5-8
    // read empty, so `armor` RE-OPENED at 05:43:02 and again at 06:18:27 while the bot was still
    // wearing the set it had crafted minutes earlier - and the ladder then re-spent ~12 ingots on
    // armour it already owned. `_chunksOk` is false on spawn/respawn and fails open ~15 s later, so a
    // genuinely empty pack (a real death on inst2) is still revalidated seconds later, not skipped.
    if (bot._chunksOk === false) continue;
    // `armor` is re-checked, but only when NOTHING is worn. Measured reason: the run sat at 17/23 with
    // `armor` flagged done while `worn=[]` - the gate condition is "4 pieces worn", so a false flag
    // here walked the bot toward a fortress and the End with no protection at all, and keepInventory
    // does not make those deaths free (respawn on the surface, portal trip back, re-descend).
    // The 13<->16 oscillation that made me exclude it came from PARTIAL wear, which is survivable and
    // normal, so partial armour stays accepted and only a total wipe re-opens the gate.
    if (m.id === 'armor') {
      // Re-open on the DANGER state, not on the completion complement (the gate now passes at torso +
      // one piece, so "not 4 pieces" is no longer the thing worth rewinding for). Danger = nothing
      // worn at all, or the chest is bare with no spare chestplate to put on.
      const wornNow = ['helmet', 'chestplate', 'leggings', 'boots'].filter((pt, i) => {
        const it = bot.inventory.slots[5 + i];
        return !!it && it.name.endsWith('_' + pt);
      }).length;
      const torso = bot.inventory.slots[6];
      const torsoCovered = !!torso && /_chestplate$/.test(torso.name);
      const spareChest = bot.inventory.items().some(i => /_chestplate$/.test(i.name));
      if (wornNow > 0 && (torsoCovered || spareChest)) continue;
      // ...and do NOT re-open unless this round can actually clothe the bot. keepInventory=true
      // (server2/server.properties, checked 19:10) means a death costs the walk back, not the pack, so
      // rewinding the ladder for armor puts a ~12-ingot mine-and-smelt errand IN FRONT of `obsidian`.
      // That is what happened 18:50-19:05: the re-open fired, the bot held 1 ingot, 3 raw iron and 0
      // planks at y=-52, and the whole obsidian budget went to `armor:smelt` and `ensure_tools`.
      const cnt = n => bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0);
      const canClothe = spareChest || torsoCovered || cnt('leather') >= 8 || cnt('iron_ingot') >= 8;
      if (!canClothe) {
        if (wornNow === 0) log.warn(`armor gate left closed: nothing worn but the pack cannot pay for a chestplate now (leather=${cnt('leather')} iron_ingot=${cnt('iron_ingot')}) - with keepInventory a death is a walk, not a re-mine; obsidian stays the priority`);
        continue;
      }
    }
    // Same reasoning for `food`, but on the hunger side: the milestone's own condition is "3 edible
    // items OR a full bar", so eating dinner re-opens it every single time, and the ladder then
    // diverts to hunting on a bare plateau where hunt answers "no REACHABLE animal" for minutes
    // (measured 16:31:18: `edible=2 meter=16/20 hp=20` - a healthy, fed bot sent off to chase cows).
    // Re-open only when food is genuinely at risk: a low hunger bar or an empty pack.
    if (m.id === 'food' && bot.food >= 10) {
      let stock = 0;
      try { stock = bot.inventory.items().filter(i => /(cooked_)?(beef|porkchop|chicken|mutton|rabbit|cod|salmon)|apple|bread|baked_potato|potato|carrot|rotten_flesh|melon_slice/.test(i.name)).length; } catch {}
      if (stock > 0) continue;
    }
    let stillTrue = true; // a throwing predicate must not silently delete progress
    try { stillTrue = m.done(bot); } catch { stillTrue = true; }
    if (!stillTrue) {
      delete state.done[m.id]; changed = true;
      log.warn(`milestone ${m.id} RE-OPENED (its condition is no longer true)`);
    }
  }
  // First sweep: any milestone whose condition is already true is locked, even if an earlier
  // one is still open. Without this, a bot that reaches The End by a non-linear route would
  // stay parked on `nether` forever (done() only checks dimension), and the ladder could
  // never notice enter_end / kill_dragon being satisfied.
  for (const m of LADDER) {
    if (state.done[m.id]) continue;
    let isDone = false;
    try { isDone = m.done(bot); } catch { isDone = false; }
    if (isDone) { state.done[m.id] = true; changed = true; }
  }
  if (changed) notes.saveState(state);
  // The manual's §4 rule ("主世界准备过度：已满足铁 + 打火石/熔岩源 + 基本食物，仍在挖钻石 → 立即进入下一环")
  // as a decision instead of a comment. A frame cell can be POURED (lava source + water) with no pickaxe
  // tier, so once both buckets are actually in hand the diamond ladder is not a prerequisite for the
  // Nether - and keeping it first is exactly what spent 20 hours on "re-mint the pickaxe". Deliberately
  // narrow: it only jumps past the OPTIONAL preparation steps, only when the pour is possible right now,
  // and never past food / iron / flint&steel, which the pour itself depends on.
  const heldCount = (n) => { try { return bot.inventory.items().filter(i => i.name === n).reduce((s, i) => s + i.count, 0); } catch { return 0; } };
  const GATE_SKIP = new Set(['armor', 'diamond_pick', 'diamond_gear', 'bow', 'obsidian']);
  // The water may be an EMPTY bucket: filling it at a source is the pour step's own first job
  // (ensure_bucket), and requiring a filled water bucket here made the rule unenterable - the pack at
  // 16:16 held lava_bucket + an empty bucket, so the gate could have been poured today and the ladder
  // kept walking to diamond_pick instead.
  const bucketInHand = heldCount('water_bucket') > 0 || heldCount('bucket') > 0;
  if (!state.done.nether && heldCount('lava_bucket') > 0 && bucketInHand) {
    const gate = LADDER.find(m => m.id === 'nether');
    const firstOpen = LADDER.find(m => !state.done[m.id]);
    if (gate && firstOpen && GATE_SKIP.has(firstOpen.id)) {
      log.info(`ladder: both buckets in hand and the frame can be poured - running nether BEFORE ${firstOpen.id} (a frame cell needs no pickaxe tier)`);
      return gate;
    }
  }
  for (const m of LADDER) {
    if (state.done[m.id]) continue;
    return m;
  }
  return null; // ladder complete -> endgame
}

// Survival gate: the milestone loop must not run while the bot is dying. It reached the
// stronghold column at 8 HP / 9 food and kept mining until it died, losing the descent.
async function survive(bot, state) {
  // The operator's MC_PERMA_FED (src/bot.js) declares hunger out of scope for this session. If the OP
  // effect does not hold - the meter dropped 20 -> 13 at 03:25:39 with the cast already logged - the gate
  // must not spend the fight re-opening the food milestone and hunting chickens on an ocean reef; that is
  // the exact treadmill the operator asked to switch off. Health still gates.
  const permaFed = process.env.MC_PERMA_FED === '1' && process.env.MC_ASSIST !== '0';
  const starving = permaFed ? false : bot.food < 8;
  // Vanilla regeneration needs FOOD > 18, not merely "not starving". At food 17 / health 8.5 the
  // old test passed both thresholds and the bot sat wounded forever while mobs kept hitting it, so
  // a hurt bot now has to top the meter up before anything else.
  const minFood = bot.health < 20 ? 19 : 12;
  if (bot.health >= 12 && (bot.food >= minFood || permaFed)) return false;
  if (permaFed && bot.food < minFood) {
    // Infinite saturation HOLDS the hunger bar but cannot RAISE it, and vanilla regen needs food >= 18 - so
    // bypassing the meter entirely would also have bypassed the only healing it has between End deaths
    // (food sat at 12 after the 06:24 void fall). Eating from the pack is free: no travel, no herd, no
    // kelp bed. What stays switched off is the foraging.
    try { await reg.get('eat').run(bot, { target: minFood }).catch(() => {}); } catch {}
    if (bot._fedGateLogged !== Math.floor(bot.food / 5)) {
      bot._fedGateLogged = Math.floor(bot.food / 5);
      log.warn(`survive gate: food=${bot.food} hp=${bot.health} - ate from the pack only (MC_PERMA_FED: no hunt, no kelp, no village march); regen needs the meter above 18`);
    }
    return bot.health >= 12;
  }
  log.warn(`survive gate: health=${bot.health} food=${bot.food} (needs ${minFood})`);
  const nowPos = bot.entity && bot.entity.position ? bot.entity.position.floored() : { x: 0, y: 64, z: 0 };
  const dim = (bot.game && bot.game.dimension) || 'overworld';
  const prevFail = bot._surviveFail || null;
  const sameSpotNoGain = prevFail
    && Math.hypot((nowPos.x - prevFail.x), (nowPos.z - prevFail.z)) < 8
    && Math.abs(nowPos.y - prevFail.y) <= 2
    && bot.health <= prevFail.hp + 0.5
    && bot.food <= prevFail.food;

  if (bot.food < minFood) {
    const e = await reg.get('eat').run(bot, { target: minFood }).catch(err => ({ ok: false, observation: `eat threw ${err.message}` }));
    if (!e.ok && /nothing edible/.test(String(e.observation))) {
      const cause = (dim === 'overworld' && nowPos.y < 62) ? 'no_food_underground' : 'no_food_surface';
      const cooled = sameSpotNoGain && prevFail.cause === cause && (Date.now() - prevFail.at < 30000);
      if (cooled) {
        log.warn(`survive gate: ${cause} cooldown active (${Math.round((30000 - (Date.now() - prevFail.at)) / 1000)}s left, pos/hp/food unchanged) - yielding to food milestone`);
      } else {
        // In a dry cave below sea level, passive livestock cannot spawn; only hunt zombies if one is
        // actually loaded nearby, otherwise yield straight to the food milestone (which knows how to
        // surface, roam, fish, harvest kelp, or raid villages).
        let huntArgs = { count: 2 };
        let shouldHunt = true;
        if (cause === 'no_food_underground') {
          const nearbyZombie = bot.entities && Object.values(bot.entities).some(en => en && /zombie|husk/.test(en.name || '') && en.position && bot.entity.position.distanceTo(en.position) <= 24);
          if (nearbyZombie) huntArgs = { count: 2, kind: 'zombie' };
          else {
            shouldHunt = false;
            log.warn(`survive gate: underground at y=${nowPos.y} with nothing edible and no nearby zombie - skipping passive hunt and yielding to ladder`);
          }
        }
        if (shouldHunt) {
          try { await reg.get('hunt').run(bot, huntArgs); } catch {}
          try { await reg.get('eat').run(bot, { target: minFood }); } catch {}
        }
      }
      if (bot.food < minFood) {
        bot._surviveFail = { cause, at: Date.now(), x: nowPos.x, y: nowPos.y, z: nowPos.z, hp: bot.health, food: bot.food };
      } else {
        bot._surviveFail = null;
      }
    }
    if (bot.food < minFood) {
      if (state.done && state.done.food) { delete state.done.food; notes.saveState(state); }
      log.warn(`survive gate could not raise food (=${bot.food} hp=${bot.health}) - re-opening the food milestone and falling through to the ladder`);
      return false;
    }
  }
  bot._surviveFail = null;
  if (starving) {
    // Do NOT wall in and wait: with food 0 there is nothing to regenerate from, and the gate
    // was masking the one step that could help. Re-open the food milestone and fall through so
    // the ladder goes hunting/cooking now. Underground, come up first - animals live on grass.
    if (state.done && state.done.food) { delete state.done.food; notes.saveState(state); log.warn('food exhausted - re-opened the food milestone'); }
    if (bot.entity.position.y < 30 && bot.game && bot.game.dimension === 'overworld') {
      try { await reg.get('recover_surface').run(bot, {}); } catch {}
    }
    return false;
  }
  if (bot.health < 12) {
    // Hard Minecraft rule: regeneration only ticks above 18 hunger, and auto-eat stops eating well
    // below that. The gate used to wall in and wait at food=13, so health stayed at 10 and the loop
    // re-entered itself forever (~80s per pass, no ladder progress). Eat UP TO the regen threshold
    // first, and if there is nothing to eat, go feed instead of waiting.
    if (bot.food < 18) {
      const FOODS = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'cooked_cod', 'cooked_salmon', 'baked_potato', 'bread', 'apple', 'beef', 'porkchop', 'chicken', 'mutton', 'cod', 'salmon', 'carrot', 'potato'];
      let guard = 0;
      while (bot.food < 19 && guard++ < 14) {
        const item = FOODS.map(n => bot.inventory.items().find(i => i.name === n)).find(Boolean);
        if (!item) break;
        try { await bot.equip(item, 'hand'); await bot.activateItem(); await sleep(1300); } catch { break; }
      }
      if (bot.food < 18) {
        if (state.done && state.done.food) { delete state.done.food; notes.saveState(state); }
        log.warn(`health=${bot.health} but food=${bot.food} < 18 and nothing left to eat - falling through so the ladder hunts/cooks instead of waiting forever`);
        return false;
      }
      log.info(`ate up to food=${bot.food} so regeneration can run`);
    }
    // wall himself in with a real block (equipping the held pickaxe and "placing" it is a
    // server-refused no-op) and wait for regeneration instead of fighting while half-dead
    const fill = bot.inventory.items().find(i => /(cobblestone|cobbled_deepslate|dirt|netherrack|blackstone|stone|andesite|diorite|granite|tuff)$/.test(i.name));
    if (fill) {
      try { await bot.equip(fill, 'hand'); } catch {}
      for (let i = 0; i < 4; i++) { try { await P.placeAtFreeNeighbor(bot); } catch {} }
    }
    for (let i = 0; i < 12 && bot.health < 14 && bot.food > 0; i++) {
      await sleep(5000);
      try { await defend(bot); } catch {}
    }
  }
  log.info(`survive gate done: health=${bot.health} food=${bot.food}`);
  return true;
}

// The bot kept dying to cave mobs while grinding coal/iron at y<0 (3 deaths in 90s), which
// burns the descent progress even with keepInventory. With MC_ASSIST on, keep damage
// reduction + slow falling refreshed while it is underground - the same two effects the
// staged harness used, and the reason it stopped dying. Set MC_ASSIST=0 for a hardcore run.
let lastAid = 0;
async function assistEffects(bot) {
  if (process.env.MC_ASSIST === '0') return;
  // It used to fire only when deep, so a bot standing at y=92 on the plateau got shredded by night
  // mobs down to hp 2 with no protection at all. Low health is the trigger, not altitude.
  const lowHp = bot.health <= 14;
  const deep = bot.entity.position.y < 25 || (bot.game && bot.game.dimension === 'the_nether');
  if (!(lowHp || deep) || Date.now() - lastAid < 60_000) return;
  lastAid = Date.now();
  try {
    bot.chat('/effect give @s minecraft:resistance 200 4 true');
    bot.chat('/effect give @s minecraft:slow_falling 200 0 true');
    bot.chat('/effect give @s minecraft:regeneration 60 1 true');
    if (lowHp) log.info(`assist: low hp=${bot.health} food=${bot.food} at y=${Math.round(bot.entity.position.y)} -> resistance+regen`);
  } catch {}
}

async function run(bot) {
  CAP_BOT = bot; // cap() cancels an abandoned walk and needs the live bot (see CAP_BOT above)
  pov.start(bot);
  const state = notes.loadState(); state.done = state.done || {};
  notes.saveState(state);
  // Restore a recorded dragon kill before anything reads the flag: mineflayer hands every reconnect a
  // NEW bot object (documented for _dryLand/_home), so `kill_dragon`'s done-condition - which is
  // exactly `!!bot._dragonKilled` - would go back to false after a kick and the run would fight a
  // dead dragon forever while reporting "not cleared".
  try {
    const d = JSON.parse(require('fs').readFileSync(require('../config').paths.runs + '/dragon.json', 'utf8'));
    if (d && d.killedAt) { bot._dragonKilled = true; log.info(`dragon kill restored from disk (${d.evidence || '?'} at ${d.killedAt})`); }
  } catch {}
  log.info('planner started; milestones=', LADDER.map(m => m.id).join(','));

  // Wait for spawn.
  let _ended = false;
  bot.on('end', () => { _ended = true; });
  bot.on('kicked', () => { _ended = true; });
  while (!bot.entity || !bot.entity.position) { await sleep(1000); if (_ended) return; }

  // Health watchdog. A milestone routine can run for up to PROGRAM_TIMEOUT_MS (420s) and never
  // re-reads hp - that is how it came out of a step at hp 2. Every few seconds: on low hp stop
  // walking, take the assist effects, and eat up to the regen threshold.
  let wdBusy = false;
  const FOOD_ITEMS = ['cooked_beef', 'cooked_porkchop', 'cooked_chicken', 'cooked_mutton', 'bread', 'cooked_cod', 'cooked_salmon', 'baked_potato', 'apple', 'beef', 'porkchop', 'chicken', 'mutton', 'cod', 'salmon', 'carrot', 'potato'];
  setInterval(() => {
    if (wdBusy || !bot.entity || bot.health > 12 && bot.food > 14) return;
    // Yield the hand to whatever milestone step is running (see bot._stepBusy) unless we are close to
    // dying - then eat anyway, because that is the one thing worth interrupting a craft for.
    if (bot._stepBusy && bot.health > 6) return;
    wdBusy = true;
    (async () => {
      try {
        if (bot.health <= 12) { try { bot.pathfinder.stop(); } catch {} await assistEffects(bot); }
        if (bot.food < 15) {
          const it = bot.inventory.items().find(i => FOOD_ITEMS.includes(i.name));
          if (it) { try { await bot.equip(it, 'hand'); await bot.activateItem(); await sleep(1200); } catch {} }
        }
      } catch {} finally { wdBusy = false; }
    })();
  }, 4000);

  let fail = 0;
  let backoff = 1500;
  const reflectTs = {};
  // A kicked bot that returns to the same hole spends its whole ~50 s session on a milestone that
  // cannot finish before the next disconnect, which is how this run sat at (-7,26,5) for nine
  // straight "connection ended mid-step" rounds. Track it and dig out first.
  const pin = { pos: null, same: 0 };
  // One wedged await stops the whole loop while the connection stays up, so from the outside the
  // bot looks healthy and does nothing (this run froze for 6 minutes at 00:44 with hp draining and
  // not one log line). Beat + phase turns that into a named stall instead of a mystery.
  let beat = Date.now(); let warnedAt = 0;
  // One iteration can legitimately last as long as a milestone step (PROGRAM_TIMEOUT_MS) plus the
  // reflect and survive caps on top of it - measured 463 s - so the alarm has to sit above that
  // floor or it cries wolf 48 times a night and stops meaning anything. Warn once on crossing, then
  // every 5 minutes while still stuck.
  // WEDGE sits above the budget of the step that is actually running. A fixed global+120s read a
  // legitimate 25-minute obsidian round (LADDER declares budgetMs 1500000) as a wedge once every 5
  // minutes all night, which is the "cried wolf" failure mode again - 05:15:57 today fired at 310 s
  // inside a step that had 20 minutes of honest work left.
  const wedgeMs = () => Math.max(cfg.bot.programTimeoutMs, bot._stepBudgetMs || 0) + 120000;
  let gateSince = 0;
  // Attribute every pathfinder cancellation. Ten-odd call sites call `pathfinder.stop()`, and a step
  // that dies on "Path was stopped before it could be completed!" has no suspect - it cannot say whether
  // it was a step timeout, the low-health handler, a `capped()` helper or a stale loop. Record who and
  // when on the bot so the victim can print it (make_obsidian does).
  const pfw = bot.pathfinder;
  if (pfw && !pfw._stopTraced) {
    const origStop = pfw.stop.bind(pfw);
    pfw.stop = function (reason) {
      const fr = ((new Error().stack || '').split('\n')[2] || '?').trim().replace(/^at\s+/, '').slice(0, 90);
      try { bot._lastPathStop = { at: Date.now(), where: fr, reason: reason || '' }; } catch {}
      return origStop();
    };
    pfw._stopTraced = true;
  }
  const ph = (s) => { bot._loopPhase = s; };
  const wedgeTimer = setInterval(() => {
    const silent = Date.now() - beat;
    if (silent > wedgeMs() && Date.now() - warnedAt > 300000) {
      warnedAt = Date.now();
      log.warn(`LOOP WEDGED: no iteration for ${Math.round(silent / 1000)}s in phase "${bot._loopPhase || '?'}" (step budget ${Math.round((bot._stepBudgetMs || cfg.bot.programTimeoutMs) / 1000)}s)`);
      // Warn AND hand the wheel back, cooperatively. `_planDeadline` is checked between plan steps and
      // `cap()`/`withTimeout` read `_stepDeadline`, so nothing is killed mid-await (a killed await is
      // precisely the orphan that refuses the next step's gotos). Measured 18:22:04 on 2026-10-30: the
      // alarm fired 329 s into `decide:build_ledge` while the obsidian step's 180 s budget was already
      // spent; the shelf completed at 18:22:41 (`dry work shelf at 113,9,775 - obsidian here can be
      // taken`) and the pour that needed it had already been orphaned (gen 2 vs live gen 7). A warning
      // nobody acts on is a log line, not a guard.
      bot._planDeadline = Date.now();
      if (bot._stepBusy) bot._stepDeadline = Date.now();
    }
  }, 30000);
  bot.once('end', () => clearInterval(wedgeTimer));
  while (true) {
    const iterStart = Date.now();
    const pace = async (minMs = 1000) => {
      const elapsed = Date.now() - iterStart;
      if (elapsed < minMs) await sleep(minMs - elapsed);
    };
    try {
      beat = Date.now();
      if (_ended || !bot.entity) { log.warn('planner stopping: bot disconnected'); return; }
      if (bot._chunksOk === false) {
        ph('chunks-gate');
        if (!gateSince) gateSince = Date.now();
        if (Date.now() - gateSince > 30000) { log.warn('world still unreadable 30 s after login - running without the gate'); gateSince = 0; }
        else { await sleep(600); continue; }
      } else gateSince = 0;
      if (bot.health <= 0) { log.warn('respawning...'); await sleep(4000); try { bot.respawn(); } catch {} await sleep(4000); await runHelper(bot, 45000, 'respawn surface', () => reg.get('recover_surface').run(bot, {})); await pace(); continue; }
      try {
        const pp = bot.entity.position.floored();
        if (pin.pos && Math.abs(pp.x - pin.pos.x) <= 2 && Math.abs(pp.z - pin.pos.z) <= 2 && pp.y === pin.pos.y) pin.same++;
        else pin.same = 0;
        pin.pos = pp;
        if (pin.same >= 2 && pp.y < 58 && bot.game && bot.game.dimension === 'overworld') {
          log.warn(`pinned at ${pp.x},${pp.y},${pp.z} for ${pin.same} rounds - digging out before touching any milestone`);
          pin.same = 0;
          await runHelper(bot, 45000, 'escape dig', () => reg.get('recover_surface').run(bot, {}));
          await pace();
          continue;
        }
      } catch (e) { log.warn('pin check:', e.message); }
      ph('helpers'); await cap(defend(bot), 15000, 'defend');
      await cap(assistEffects(bot), 15000, 'assistEffects');
      await cap(P.equipBestArmor(bot), 15000, 'equipBestArmor');
      const inWater = (() => {
        try {
          const f = bot.entity.position.floored();
          const a = bot.blockAt(f), b = bot.blockAt(f.offset(0, 1, 0));
          return (a && a.name === 'water') || (b && b.name === 'water');
        } catch { return false; }
      })();
      const lowAir = typeof bot.oxygenLevel === 'number' && bot.oxygenLevel >= 0 && bot.oxygenLevel <= 8;
      if (bot._wet && !inWater && !lowAir) {
        bot._wet = false;
        bot._wetLoopFails = 0;
        log.skill(`wet flag set but standing dry at y=${Math.round(bot.entity.position.y)} (air=${bot.oxygenLevel}) - not aborting the dive`);
      } else if (bot._wet) {
        log.skill('wet - escaping the water before any milestone');
        await runHelper(bot, 20000, 'dry_escape', () => reg.get('dry_escape').run(bot, { max: 6 }));
        if (bot._wet) { await runHelper(bot, 90000, 'wet recover_surface', () => reg.get('recover_surface').run(bot, {})); }
        // Refresh live heartbeat even while wet so monitoring/HUD never go stale during water recovery.
        try { if (typeof bot._liveBuild === 'function') fs.writeFileSync(path.join(cfg.paths.runs, 'live.json'), JSON.stringify(bot._liveBuild())); } catch {}
        if (!bot._wet) {
          bot._wetLoopFails = 0;
          await sleep(800);
          continue;
        }
        bot._wetLoopFails = (bot._wetLoopFails || 0) + 1;
        // If standing in shallow ankle-deep water with full air (NOT drowning) and dry_escape failed twice,
        // yield to the milestone/roam instead of spinning forever in dry_escape -> climbOut.
        if (bot._wetLoopFails >= 2 && !lowAir && (typeof bot.oxygenLevel !== 'number' || bot.oxygenLevel >= 16)) {
          log.warn(`wet escape failed ${bot._wetLoopFails}x in shallow water (air=${bot.oxygenLevel}) - yielding to ladder so movement can walk out`);
          bot._wetLoopFails = 0;
        } else {
          await sleep(1200);
          continue;
        }
      } else {
        bot._wetLoopFails = 0;
      }
      ph('survive'); if (await runHelper(bot, 90000, 'survive', () => survive(bot, state))) { await sleep(2000); continue; }
      await cap(P.dropJunk(bot), 25000, 'dropJunk');
      const m = nextMilestone(bot, state);
      const isVictory = !m && Boolean((state.done && state.done.kill_dragon) || bot._dragonKilled);
      if (m) pov.setMilestone(m.id);
      try {
        bot._liveBuild = () => {
          const p = bot.entity.position.floored();
          const worn = ['helmet', 'chestplate', 'leggings', 'boots'].map((piece, i) => {
            const it = bot.inventory.slots[5 + i];
            return it && it.name.endsWith('_' + piece) ? piece : null;
          }).filter(Boolean);
          return {
            ts: Date.now(), username: cfg.mc.username, pos: p, dim: bot.game.dimension,
            hp: Math.round(bot.health * 2) / 2, food: Math.round(bot.food), saturation: Math.round(bot.saturation * 10) / 10,
            air: typeof bot.oxygenLevel === 'number' ? bot.oxygenLevel : null,
            level: bot.experience ? bot.experience.level : 0,
            worn, deaths: Number.isFinite(bot._deaths) ? bot._deaths : (bot.stats && bot.stats.death ? bot.stats.death.value : null),
            inv: ob.invSummary(bot).slots, freeSlots: P.freeSlots(bot),
            victory: isVictory,
            milestones: {
              done: Object.keys(state.done || {}).filter(k => state.done[k]).sort(),
              current: m ? m.id : null,
              currentCn: m ? cn(m.id) : null,
            },
          };
        };
        const payload = bot._liveBuild();
        bot._livePayload = payload;
        require('fs').writeFileSync(require('../config').paths.runs + '/live.json', JSON.stringify(payload));
      } catch (e) { log.warn('live.json write failed:', e.message); }
      // Post-victory halt: once all 23 milestones (including kill_dragon) are verified complete,
      // do NOT re-enter endgame() / re-plan kill_dragon in a tight loop. Park cleanly and stay online for chat.
      if (isVictory) {
        await handleVictory(bot, state);
        await sleep(30000);
        continue;
      }
      try {
        const hasEdible = bot.inventory.items().some(i => /(cooked_)?(beef|porkchop|chicken|mutton|rabbit|cod|salmon)|apple|bread|baked_potato|potato|carrot/.test(i.name));
        const starving = bot.food < 8 && !hasEdible;
        const noTools = !bot.inventory.items().some(i => /pickaxe|axe$/.test(i.name));
        const wornNow = ['helmet', 'chestplate', 'leggings', 'boots'].filter((pt, i) => {
          const it = bot.inventory.slots[5 + i];
          return !!it && it.name.endsWith('_' + pt);
        }).length;
        const dimNow = (bot.game && bot.game.dimension) || 'overworld';
        const arrowCount = bot.inventory.items().filter(i => i.name === 'arrow').reduce((n, i) => n + i.count, 0);
        const canFight = bot.inventory.items().some(i => /sword$/.test(i.name))
          || (bot.inventory.items().some(i => i.name === 'bow') && arrowCount > 0);
        if (dimNow !== 'overworld') {
          const helpless = starving || bot.health < 12 || (noTools && !canFight);
          if (helpless && Date.now() >= (bot._spiralCooledUntil || 0)) {
            bot._spiralCooledUntil = Date.now() + 180000;
            log.warn(`cannot fight in ${dimNow} (bow/arrows=${arrowCount} sword=${canFight ? 'y' : 'n'} hp=${Math.round(bot.health)} food=${Math.round(bot.food)}) - walking home through the portal once, then cooling this guard down for 3 min`);
            await runHelper(bot, 120000, 'nether exit', () => reg.get('return_overworld').run(bot, {}));
            await pace(1500);
            continue;
          }
        } else if (bot.entity.position.y < 62 && wornNow === 0 && (starving || noTools || bot.health < 16)) {
          if (Date.now() >= (bot._overworldSpiralCoolUntil || 0)) {
            ph('death-spiral');
            const cause = starving ? 'starving' : noTools ? 'tool-less' : `hp=${(Math.round(bot.health * 10) / 10)}`;
            const beforePos = bot.entity.position.floored();
            const logsBefore = bot.inventory.items().filter(i => /_log$/.test(i.name)).reduce((s, i) => s + i.count, 0);
            log.warn(`broke and ${cause} underground at y=${beforePos.y} with no armour - surfacing to rebuild from trees before any milestone`);
            const surfRes = await runHelper(bot, 90000, 'surface rebuild', () => reg.get('recover_surface').run(bot, {}));
            const afterPos = bot.entity.position.floored();
            const climbed = afterPos.y >= 62 || afterPos.y >= beforePos.y + 2;
            if (climbed && logsBefore < 6) {
              await runHelper(bot, 90000, 'surface wood', () => reg.get('chop_trees').run(bot, { count: 6 }));
            } else if (!climbed) {
              bot._overworldSpiralCoolUntil = Date.now() + 60000;
              log.warn(`death-spiral rebuild could not surface (${beforePos.y} -> ${afterPos.y}, res=${String(surfRes && surfRes.observation || 'none').slice(0, 90)}) - cooling guard for 60s and falling through to ladder`);
            } else {
              bot._overworldSpiralCoolUntil = Date.now() + 45000;
              log.info(`death-spiral rebuild surfaced (${beforePos.y} -> ${afterPos.y}, logs=${logsBefore}) - cooling guard 45s so milestone can proceed`);
            }
            await pace(1500);
            if (climbed) continue;
          }
        }
      } catch (e) { log.warn('death-spiral guard:', e.message); }
      if (m) {
        const DAYLIGHT_SAFE = new Set(['wood', 'crafting_table', 'wooden_pickaxe', 'stone', 'stone_tools', 'food']);
        const t = bot.time && typeof bot.time.day === 'number' ? bot.time.day : null;
        const SLOTS = ['helmet', 'chestplate', 'leggings', 'boots'];
        const wornNow = SLOTS.filter((pt, i) => { const it = bot.inventory.slots[5 + i]; return !!it && it.name.endsWith('_' + pt); }).length;
        if (t !== null && t > 13200 && t < 23400 && wornNow === 0 && bot.health < 18 && !DAYLIGHT_SAFE.has(m.id)) {
          log.warn(`night (day=${Math.round(t)}) with no armour, hp=${Math.round(bot.health)}: riding it out instead of running ${m.id}`);
          if (require('../skills/base').loadBase().bed) {
            const sl = await runHelper(bot, 70000, 'bed sleep', () => reg.get('forward_base').run(bot, { sleepOnly: true }));
            if (sl && sl.ok) { log.info('slept through the night at the forward base'); await pace(); continue; }
            log.warn(`bed sleep did not take (${String(sl && sl.observation || 'no answer').slice(0, 110)}) - digging in the open instead`);
          }
          try { await runHelper(bot, 60000, 'night hunt', () => reg.get('hunt').run(bot, { count: 1 })); } catch {}
          await sleep(25000);
          continue;
        }
      }
      if (!m) { await endgame(bot, state); await sleep(20000); continue; }
      const age = stageLock.trackStage(bot, m);
      if (age && (age.fired === 'route' || age.fired === 'human')) {
        if (age.fired === 'human') humanChatTarget(bot, `我在【${cn(m.id)}】上已经花了 ${age.ageMin} 分钟还没走完 - 原因写在 stall_report.json，卡住的话帮我看一眼。`);
        await runHelper(bot, Number(process.env.STAGE_ROUTE_CAP_MS || 100000), 'stage-age-route', () => stageLock.runUnblock(bot, m));
      }

      log.skill(`-> ${m.id}`);
      ph('step:' + m.id);
      if (bridge) bridge.publishEvent({ kind: 'milestone_started', milestone: m.id, milestoneCn: cn(m.id), skill: m.id, skillCn: cn(m.id) });
      bot._stepBusy = true;
      const stepMs = Math.max(cfg.bot.programTimeoutMs, m.budgetMs || 0);
      bot._stepBudgetMs = stepMs;
      armDeadline(bot, Math.max(30000, stepMs - 25000));
      const stageCtx = { at: Date.now(), before: stageLock.snap(bot, m.id) };
      const stopMilestoneBeat = startLiveBeat(bot);
      let res; try { res = await lease.run(() => withTimeout(m.run(bot), stepMs, bot)); } finally { stopMilestoneBeat(); bot._stepBusy = false; bot._stepBudgetMs = 0; expireStepDeadline(bot); }
      let nowDone = false; try { nowDone = m.done(bot); } catch {}
      if (nowDone) {
        state.done[m.id] = true; notes.saveState(state);
        log.skill(`OK ${m.id}: ${res.observation}`);
        humanChatTarget(bot, `达成里程碑：【${cn(m.id)}】✅`, { kind: 'milestone_done', milestone: m.id });
        if (bridge) bridge.publishEvent({ kind: 'milestone_done', milestone: m.id, milestoneCn: cn(m.id), skill: m.id, skillCn: cn(m.id), verified: true, summary: res.observation });
        stageLock.clear(m);
        fail = 0;
      } else if (m.optional && res && res.skipped) {
        state.done[m.id] = true; notes.saveState(state);
        log.warn(`milestone ${m.id} CLOSED as optional (${String(res.skipped).slice(0, 130)}) - its condition is still false and the main chain does not need it`);
        humanChatTarget(bot, `跳过【${cn(m.id)}】（不在主链条上）`, { kind: 'milestone_skipped', milestone: m.id });
        if (bridge) bridge.publishEvent({ kind: 'milestone_done', milestone: m.id, milestoneCn: cn(m.id), skill: m.id, skillCn: cn(m.id), verified: false, summary: res.skipped });
        stageLock.clear(m);
        fail = 0;
      } else {
        fail++;
        log.warn(`milestone ${m.id} not done (fail ${fail})${res.ok ? ' [routine said ok but the condition is still false]' : ''}: ${res.observation}`);
        if (bridge) bridge.publishEvent({ kind: 'skill_failed', milestone: m.id, milestoneCn: cn(m.id), skill: m.id, skillCn: cn(m.id), verified: false, partial: /partial|again|dug/i.test(String(res.observation || '')), summary: res.observation });
        const verdict = stageLock.noteFailure(bot, m, res, stageCtx);
        if (verdict.level) {
          await runHelper(bot, Number(process.env.STAGE_ROUTE_CAP_MS || 100000), `stage-${verdict.level}-unblock`, () => stageLock.runUnblock(bot, m));
          bot._stageBrief = stageLock.brief(m);
          reflectTs[m.id] = 0;
        }
        const since = Date.now() - (reflectTs[m.id] || 0);
        if (since >= cfg.bot.reflectCooldownMs) { reflectTs[m.id] = Date.now(); await cap(reflect(bot, state, m, res, fail), 90000, 'reflect'); fail = 0; }
      }
      backoff = nowDone ? 1500 : Math.min(backoff * 2, 30000);
      await sleep(backoff);
    } catch (e) {
      log.err('planner loop error', e.message);
      await sleep(5000);
    }
  }
}

async function reflect(bot, state, m, res, fail) {
  bot._planDeadline = Date.now() + 70000; // cap('reflect') abandons at 90 s; stop the plan before that
  const brief = bot._stageBrief || '';
  try {
    await decide(bot, state, {
      target: m.id,
      header: `STUCK on milestone "${m.id}" (attempt ${fail}). Last result: ${res.observation}` + (brief ? `\n${brief}` : ''),
      ask: 'Diagnose why it failed and give the plan that fixes the root cause. You may return up to 6 sequential actions.',
    });
  } finally { bot._planDeadline = 0; bot._stageBrief = ''; }
}

async function handleVictory(bot, state) {
  bot._loopPhase = 'victory-idle';
  if (bot._victoryAnnounced) return false;
  bot._victoryAnnounced = true;
  const done = Object.keys((state && state.done) || {}).filter(k => state.done[k]).sort();
  const payload = {
    clearedAt: new Date().toISOString(),
    username: cfg.mc.username,
    assistFree: process.env.MC_ASSIST === '0',
    milestones: done.length,
    deaths: Number.isFinite(bot._deaths) ? bot._deaths : 0,
  };
  try {
    const fs = require('node:fs');
    const path = require('node:path');
    fs.mkdirSync(cfg.paths.runs, { recursive: true });
    fs.writeFileSync(path.join(cfg.paths.runs, 'victory.json'), JSON.stringify(payload, null, 2));
  } catch (e) { log.warn('victory.json write failed:', e.message); }
  log.info(`*** VICTORY HALT: ${done.length}/${LADDER.length} milestones complete; idling cleanly (no post-victory replan spin) ***`);
  humanChatTarget(bot, '🎉 全部 23 级阶梯完成，末影龙已核验击败！自主通关达成。', { kind: 'victory' });
  if (bridge) bridge.publishEvent({ kind: 'victory', milestone: 'kill_dragon', milestoneCn: '打龙', skill: 'kill_dragon', skillCn: '打龙', verified: true, summary: '末影龙已核验击杀，自主通关达成' });
  return true;
}

// Beyond the scripted ladder (Nether, stronghold, dragon) the LLM drives step-by-step
// using the same skills, escalating only as needed.
async function endgame(bot, state) {
  if ((state && state.done && state.done.kill_dragon) || bot._dragonKilled) {
    return handleVictory(bot, state);
  }
  await decide(bot, state, {
    target: 'ENDGAME: reach The End and kill the Ender Dragon',
    header: 'Endgame. The scripted ladder is complete.',
    ask: 'Pick the next steps toward: obsidian -> flint&steel -> nether portal -> fortress -> blaze rods + ender pearls -> eyes of ender -> stronghold -> End -> dragon. You may return up to 6 sequential actions.',
  });
}

// One LLM call -> a plan -> run the steps until one fails, then hand control back to the loop.
async function decide(bot, state, o) {
  // The End door's own state, in the prompt. At 04:03:05 the model planned
  // `use_portal -> farm_blaze -> craft_eyes_of_ender` because the pack shows `ender_eye: 3` and NOTHING in
  // the context said those 3 are SPARES beside a ring that already holds 12/12 eyes. Every field of the
  // world it is asked about is here except the one that decides the plan - so a door that has stood open
  // since 00:08 reads to the planner as "still building the frame".
  let doorLine = '';
  try {
    const rec = require('../portalRecord').current();
    const d = require('../portalRecord').distanceTo(bot);
    const dim = (bot.game && bot.game.dimension) || 'overworld';
    if (dim === 'the_end') {
      doorLine = `END DOOR: the bot is IN THE END. Crystals this dive: ${bot._crystalsDown || 0}. Plan kill_dragon steps only - no obsidian, no portal, no eyes.`;
    } else if (rec && rec.ringComplete) {
      doorLine = `END DOOR: OPEN. The portal room is at ${rec.x},${rec.y},${rec.z} (${d && d.dist != null ? d.dist + ' blocks off' : 'distance unreadable'}), 12/12 eyes are IN THE FRAMES (ringComplete), the pack's ${require('./primitives').countItem(bot, 'ender_eye')} eye(s) and ${require('./primitives').countItem(bot, 'ender_pearl')} pearl(s) are SPARES, not a shortage. Forbidden plan steps: use_portal, farm_blaze, craft_eyes_of_ender, make_obsidian, mine obsidian - the ONLY move is enter_end (drop to y=${rec.y} at that column and step into the pool).`;
    } else if (rec) {
      doorLine = `END DOOR: room remembered at ${rec.x},${rec.y},${rec.z} (${d && d.dist != null ? d.dist + ' blocks off' : 'distance unreadable'}), ring NOT complete on file - fill the frames with the eyes in the pack (enter_end does this) before any Nether trip.`;
    } else {
      doorLine = 'END DOOR: no portal room on file yet - locate_stronghold / dig to it. Do not plan blaze rods while the stronghold is unmapped.';
    }
  } catch (e) { doorLine = `END DOOR: state unreadable (${String(e.message).slice(0, 40)}) - ask enter_end, which re-derives it from the world`; }
  try {
    const k = ob.kit(bot);
    const sys = prompts.plannerSystem({ done: state.done, target: o.target });
    const user = [
      o.header,
      `Status: ${JSON.stringify(ob.status(bot))}`,
      doorLine,
      `Inv(${k.freeSlots} free slots): ${ob.invSummary(bot).slots}`,
      `Tools: ${k.tools} | Worn: ${k.armor}`,
      `Census: ${ob.census(bot)}`,
      `Grid(6):\n${ob.grid(bot, 6)}`,
      `Notes:\n${notes.recentNotes(900)}`,
      o.ask,
    ].join('\n');
    bot._loopPhase = 'llm:plan';
    const dec = await llm.json([{ role: 'system', content: sys }, { role: 'user', content: user }], { maxTokens: cfg.deepseek.maxTokens });
    // Both instances went silent at 00:44 and 00:48 exactly here: the ledger shows the call
    // completing, then no "plan(...)" line. This marks whether we ever got back from the await.
    bot._loopPhase = 'plan-parsed';
    if (dec.note) notes.appendLesson(`${o.target}: ${dec.note}`);
    const steps = (Array.isArray(dec.actions) && dec.actions.length ? dec.actions : (dec.skill ? [{ skill: dec.skill, args: dec.args || {} }] : [])).slice(0, 6);
    if (!steps.length) { log.warn('LLM returned no skill'); return; }
    const brief = steps.map(s => cn(s.skill)).join(' -> ');
    log.info(`plan(${o.target}): ${brief}${dec.reason ? ' | ' + String(dec.reason).slice(0, 100) : ''}`);
    // 给玩家的那句只留中文计划名：括号里的 reason 是模型写的英文，16:53:04 播报成
    // `下一步: 拿好装备 -> 挖矿 -> 拿好装备 -> 打龙（Crystals were never dropped: no blocks t）`
    // ——半中半英更难读。理由继续进日志/面板，玩家只看中文。
    humanChatTarget(bot, `下一步: ${brief}`);
    for (const st of steps) {
      const sk = reg.get(st.skill);
      if (!sk) { log.warn('unknown skill from LLM:', st.skill); continue; }
      // Enforcement, not advice. The door-facts line went into the prompt at 04:04 and the very next plan
      // (04:07:52) still said `use_portal -> farm_blaze -> craft_eyes_of_ender | 3 eyes cannot open 12
      // frames` - the model reads the PACK (3 spare eyes) as a shortage and ignores a sentence, while the
      // ring has been 12/12 since 00:08. Verdict text can guide; only a refused call guarantees.
      if (/^(use_portal|farm_blaze|farm_pearl|craft_eyes_of_ender|make_obsidian|pour_portal_cell|obsidian_farm|build_nether_portal)$/.test(st.skill)) {
        try {
          const recD = require('../portalRecord').current();
          const dimNow = (bot.game && bot.game.dimension) || 'overworld';
          if (recD && recD.ringComplete && dimNow !== 'the_end') {
            const why = `refused by the door state, not by the skill: the portal room at ${recD.x},${recD.y},${recD.z} has 12/12 eyes in its frames and the pool is OPEN, so ${st.skill} would buy material this run already spent. The ONLY next move is enter_end (walk/tunnel to that column, drop to y=${recD.y}, step into the pool). Do not plan anything about obsidian, portals, blaze rods or eyes again while ringComplete is on file.`;
            log.warn(`${st.skill} refused: ${why.slice(0, 240)}`);
            humanChatTarget(bot, `跳过【${cn(st.skill)}】：门已经开了（12/12 眼在框里），只剩【进末地】走进池子`);
            break;
          }
        } catch {}
      }
      // reflect() is capped at 90 s while a 6-step plan needs minutes, so the cap used to abandon the
      // plan mid-`deep_shaft` and the main loop resumed on top of a still-running skill (the residual
      // goal-changed bursts). Run the plan only as far as its own window allows, then hand back
      // cleanly; the next plan continues from wherever the bot ended up.
      if (bot._planDeadline && Date.now() >= bot._planDeadline) {
        log.info('plan window closing, handing back to the ladder');
        break;
      }
      log.info(`plan -> ${st.skill}`, JSON.stringify(st.args || {}));
      bot._loopPhase = `decide:${st.skill}`; bot._stepBusy = true;
      if (bridge) bridge.publishEvent({ kind: 'skill_started', skill: st.skill, skillCn: cn(st.skill) });
      const skMs = Math.max(cfg.bot.programTimeoutMs, sk.budgetMs || 0);
      const hardMs = bot._planDeadline ? Math.max(20000, bot._planDeadline - Date.now()) : skMs;
      armDeadline(bot, Math.max(15000, hardMs - 20000));
      const stopPlanBeat = startLiveBeat(bot);
      let r; try { r = await lease.run(() => withTimeout(sk.run(bot, st.args || {}, { bot, state }), hardMs, bot)); } finally { stopPlanBeat(); bot._stepBusy = false; expireStepDeadline(bot); }
      log.info(`${st.skill} ${r.ok ? 'ok' : 'failed'}: ${String(r.observation).slice(0, 1200)}`);
      if (bridge) bridge.publishEvent({ kind: r.ok ? 'skill_done' : 'skill_failed', skill: st.skill, skillCn: cn(st.skill), verified: false, summary: r.observation });
      if (!r.ok) break;
    }
  } catch (e) {
    if (e instanceof llm.BudgetError) log.warn('decide skipped (budget)'); else log.err('decide', e.message);
  }
}

// ---- companion chat ----
function parsePlayerChat(text) {
  const m = String(text || '').match(/^<([^>]+)>\s+([\s\S]+)$/);
  if (!m) return null;
  return { speaker: m[1].trim(), body: m[2].trim() };
}

let lastReply = 0;
function attachChat(bot) {
  bot.on('message', async (msg) => {
    let text = '';
    try { text = msg.toString(); } catch { return; }
    if (!text) return;
    // Only answer real player chat lines (`<PlayerName> message`). Paper system broadcasts like
    // `SuiGeBot has made the advancement [Stone Age]`, `joined the game`, death announcements, or
    // gamerule confirmations have no `<...>` speaker and used to trigger handleChat as "friend",
    // burning LLM tokens and replying to our own advancements.
    const parsed = parsePlayerChat(text);
    if (!parsed) return;
    const selfName = cfg.mc.username;
    if (parsed.speaker === selfName || parsed.speaker === bot.username) return;
    if (cfg.bot && cfg.bot.talk === 'off') return;
    const now = Date.now();
    if (now - lastReply < 3000) return;
    lastReply = now;
    handleChat(bot, parsed.speaker, parsed.body).catch(e => { if (!(e instanceof llm.BudgetError)) log.err('chat', e.message); });
  });
}

async function handleChat(bot, username, text) {
  try {
    const dec = await llm.json(
      [{ role: 'system', content: prompts.chatSystem(bot.username) }, { role: 'user', content: `${username}: ${text}` }],
      { maxTokens: 180, temperature: 0.7, think: false });
    if (dec.say) { lastReply = Date.now(); bot.chat(String(dec.say).slice(0, 120)); }
    // Take the hand or do nothing. This ran with no await and no mutex, so a chat-triggered skill
    // could dig/walk/open a window while a milestone step was mid-action.
    if (dec.skill && reg.get(dec.skill) && !bot._stepBusy) {
      bot._stepBusy = true;
      armDeadline(bot, Math.max(30000, cfg.bot.programTimeoutMs - 25000));
      try { await lease.run(() => withTimeout(reg.get(dec.skill).run(bot, dec.args || {}), cfg.bot.programTimeoutMs, bot)); }
      finally { bot._stepBusy = false; expireStepDeadline(bot); }
    }
  } catch (e) {
    if (e instanceof llm.BudgetError) { /* stay quiet to save cost */ }
    else log.err('chat handle', e.message);
  }
}

// 播报给玩家的中文名字表（面板/日志继续用英文技能 id，这里只管游戏里那几句话）。
// 为什么要有这张表：16:40 之后我看到的播报是 `下一步: ensure_tools -> mine -> kill_dragon`，
// 玩家看不出到底在干什么；技能 id 是给机器看的，播报是给人看的。
const CN_SKILL = {
  status: '看状态', look: '观察', find_block: '找方块', goto: '走过去', follow: '跟着你', chat: '说话', wait: '等待',
  chop_trees: '砍树', mine: '挖矿', craft: '合成', equip: '拿好装备', eat: '吃东西', hunt: '打猎', hunt_spider: '打蜘蛛取线',
  roam: '巡视', place: '放方块', tidy: '清背包', stash: '存箱子', light: '插火把', grid_craft: '桌上合成', workshop: '整理工作台',
  inspect: '检查', ensure_tools: '补工具', breathe: '换气', forward_base: '推进前进基地', stow_workshop: '收起工作台',
  bridge_to: '搭桥过去', build_ledge: '搭平台', fish: '钓鱼', harvest_kelp: '采海带', raid_village: '搜村庄',
  deep_shaft: '挖竖井', walk_to: '走过去', tunnel_to: '挖隧道过去', ensure_diamond_verify: '补钻石镐', ensure_diamond_pick: '补钻石镐',
  resume_shaft: '回到竖井', ensure_bucket: '弄铁桶', find_diamonds: '找钻石', branch_mine: '挖分支矿道',
  dry_escape: '离开水面', pillar_up: '搭柱往上爬', recover_surface: '回到地面', obsidian_farm: '采黑曜石',
  make_obsidian: '造黑曜石', build_nether_portal: '搭下界传送门', pour_portal_cell: '浇黑曜石格', use_portal: '进传送门',
  return_overworld: '回主世界', search_nether_fortress: '找下界要塞', farm_blaze: '打烈焰人', farm_pearl: '打末影人取珍珠',
  craft_eyes_of_ender: '合成末影之眼', locate_stronghold: '定位要塞', probe_stronghold: '探查要塞',
  enter_end: '进末地', kill_dragon: '打龙', smelt: '烧炼', dig_to_y: '往下挖到指定高度', strip_mine: '平巷采矿',
  // 里程碑 id 与技能同名时共用上面的译名；这里补上只有里程碑才有的项。
  wood: '木头', stone: '石头', iron_ore: '铁矿石', flint_steel: '燧石与火', pearls: '末影珍珠',
  crafting_table: '工作台', coal: '煤', iron_ingots: '铁锭', bow: '弓', obsidian: '黑曜石', diamond_pick: '钻石镐',
  iron_gear: '铁装备', wooden_pickaxe: '木镐', stone_tools: '石制工具', diamond_gear: '钻石装备', blaze_rods: '烈焰棒',
  eyes: '末影之眼', nether: '下界', stronghold: '要塞', food: '食物', armor: '护甲',
};
const cn = (id) => CN_SKILL[String(id)] || String(id);

function humanChatTarget(bot, text, meta) {
  // Single-speaker discipline (MC_TALK=off|game|host): when AI_vtuber is attached (`host`),
  // route narration to the streamer bridge + log instead of double-voicing via in-game bot.chat().
  const mode = (process.env.MC_TALK || (cfg.bot && cfg.bot.talk) || 'game').toLowerCase();
  if (bridge) bridge.publishAnnouncement(text, meta || {});
  if (mode !== 'game') {
    log.info(`ANNOUNCED (${mode}): ${String(text).slice(0, 160)}`);
    return false;
  }
  let sent = true;
  try { bot.chat(text); } catch (e) { sent = false; log.warn(`chat to the player failed: ${String(e && e.message || e).slice(0, 90)}`); }
  log.info(`ANNOUNCED to player${sent ? '' : ' (send failed)'}: ${String(text).slice(0, 160)}`);
  return sent;
}

const HOSTILE = ['zombie', 'zombie_villager', 'husk', 'drowned', 'skeleton', 'stray', 'spider', 'cave_spider', 'witch', 'pillager', 'enderman', 'blaze', 'zombified_piglin'];
// Defensive combat between milestones: kill adjacent hostiles if armed; never melee a creeper.
async function defend(bot) {
  if (!bot.nearestEntity) return;
  const h = bot.nearestEntity(e => e && e.name && HOSTILE.includes(e.name) && e.position && bot.entity.position.distanceTo(e.position) < 5);
  if (!h) return;
  if (h.name === 'creeper') return; // let it not explode on us; day-lock + distance mostly prevent this
  const wpn = bot.inventory.items().find(i => /_(sword|axe)$/.test(i.name));
  if (!wpn) return;
  try { await bot.equip(wpn, 'hand'); await bot.pvp.attack(h); } catch {}
}

module.exports = { run, attachChat, withTimeout, nextMilestone, LADDER, armDeadline, expireStepDeadline, runHelper, survive, handleVictory, humanChatTarget, parsePlayerChat, cn };
