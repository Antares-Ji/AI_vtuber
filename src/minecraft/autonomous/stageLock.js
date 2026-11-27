'use strict';
// Stage lock: the detector that answers "is it actually getting CLOSER to the goal?", which none of
// the existing fuses do.
//
// Evidence for why this had to exist (2026-10-30, inst1, world seed 52515375): `obsidian` sat at 5/10
// from ~00:00 to 05:16 - five hours - and every monitor called that healthy:
//   - the watchdog's progress test is "milestone flipped OR pack changed OR moved >20 blocks"
//     (tools/watchdog.js:62), and a five-hour obsidian grind changes the pack and the coordinates
//     constantly - diamond pick breaks, iron pick re-minted, shaft dug, surface walk, bucket filled;
//   - LOOP WEDGED only fires when NO log line appears for 5 minutes, and the round wrote lines all night;
//   - the ladder's own failure counter resets every time reflect fires, so nothing accumulated.
// So the run can spend hours on one stage without any component declaring it stuck. This module
// measures the milestone's OWN goal quantity and escalates when attempts burn and that number does
// not move.
//
// Design rules, all learned the hard way in this project (see docs/OPTIMIZATION.md §19-§26dd):
//   1. Fail open. Every probe is wrapped; a probe that throws reads as "no data for that metric", not
//      as "stuck". A stuck-run alarm that fires on healthy work becomes noise, and noise gets ignored.
//   2. Count SUB-progress, not just the target item. For `obsidian`, a fresh diamond pickaxe or one
//      more diamond in the pack IS forward motion, and the run would otherwise be locked out of the
//      exact grind it needs to finish.
//   3. Persist across restarts. The supervisor bounces the bot every 12-24 minutes of quiet, and
//      process-local counters re-learn the same lesson all night (§26dd: the same class of bug as the
//      site cooldowns).
//   4. Escalate by CHANGING THE APPROACH, never by only restarting. Levels 1 and 2 run an unblock
//      skill (a different route through the same wall) and hand the loop dossier to the LLM.
const fs = require('fs');
const path = require('path');
const cfg = require('./config');
const log = require('./log');
const reg = require('./skills/registry');
const shaftRecord = require('./shaftRecord');
const workshopRecord = require('./workshopRecord');
const { countItem, sleep } = require('./skills/primitives');

const FILE = path.join(cfg.paths.runs, 'stage_lock.json');
const REPORT = path.join(cfg.paths.runs, 'stall_report.json');

const cnt = (b, n) => { try { return countItem(b, n); } catch { return null; } };
const held = (b, re) => { try { return b.inventory.items().some(i => re.test(i.name)) ? 1 : 0; } catch { return 0; } };
// A route whose skill can only work in the Overworld. Must be declared ABOVE the route table: `ready:`
// captures the identifier while the module literal is being built, so a `const` further down is still in
// its temporal dead zone there - `node --check` cannot see that and the file throws at require time.
const overworld = (b) => !b.game || !b.game.dimension || b.game.dimension === 'overworld';
// Is the End door standing open? `portalRecord` is the no-TTL record, and `ringComplete` is the only
// honest read of that (the eye count in the pack says nothing about it).
const ringOpen = () => { try { const rec = require('./portalRecord').current(); return !!(rec && rec.ringComplete); } catch { return false; } };
// Does the pack hold any pickaxe at all? `branch_mine` answers in 0 s without one (live 20:50:
// `need pickaxe (pack has none; held=dirt y=53)`), and a route that refuses instantly still eats the
// intervention slot the tool mint needed.
const hasPick = (b) => {
  try { return !!((b.heldItem && /pickaxe/.test(b.heldItem.name)) || (b.inventory.items() || []).some(i => /_pickaxe$/.test(i.name))); } catch { return true; }
};
// Is there actually an undead within reach right now? `#undead` used to be offered whenever a sword was
// in the pack, and on a permanently-day surface it answered in 0 s every cycle - a fast refusal that also
// kept stealing the route slot from the one move that changes the situation (dig down to the dark layer).
const undeadLoaded = (b) => {
  try { return Object.values(b.entities || {}).some(e => e && e.name && /zombie|husk/.test(e.name) && e.position && b.entity.position.distanceTo(e.position) <= 60); } catch { return true; }
};
// A village the run just measured at 4,184 blocks (`/locate`, live 20:14:09) is not a meal tonight.
// Without this the `#village` route re-asks every cooldown and eats another four minutes each time.
const villageTooFar = (b) => !!(b && b._villageFarAt && Date.now() - b._villageFarAt < 25 * 60000);
// A diamond pick is minted from three diamonds, and diamonds only exist in the Overworld depths. Routing
// `ensure_diamond_pick` to a bot standing at 125,25,170 in `the_nether` with 2 diamonds (11:27:20) is a
// route that cannot succeed where the bot is - the same class as §29p's unmatchable `when`, but paid for in
// a 420 s capMs instead of a missed match. If the pack already holds the three, the Nether is fine.
const canMintDiamondPick = (b) => {
  if (overworld(b)) return true;
  let d = -1;
  try { d = b.inventory.items().reduce((s, i) => s + (i.name === 'diamond' ? i.count : 0), 0); } catch { return true; }
  return d >= 3;
};
const wornCount = (b) => {
  try {
    return ['helmet', 'chestplate', 'leggings', 'boots'].filter((pt, i) => {
      const it = b.inventory.slots[5 + i];
      return !!it && it.name.endsWith('_' + pt);
    }).length;
  } catch { return null; }
};


// Per milestone: which numbers mean "closer to done". `dir` +1 = up is good, -1 = down is good.
// null from a probe = that metric is blind this round and simply does not vote.
const STAGES = {
  obsidian: {
    metrics: [
      { name: 'obsidian', dir: 1, get: b => cnt(b, 'obsidian') },
      { name: 'diamond', dir: 1, get: b => cnt(b, 'diamond') },
      { name: 'diamond_pick', dir: 1, get: b => held(b, /^diamond_pickaxe$/) },
      { name: 'water_bucket', dir: 1, get: b => cnt(b, 'water_bucket') },
      // The tool ladder IS the obsidian route right now (no iron pick -> no diamond drop -> no diamond
      // pick -> no obsidian), measured 06:06-06:10 while raw_iron climbed 0->2->4. Without these the
      // stage would read as frozen while it was paying for the pick, and lock itself out of its own
      // supply chain - the false-lock direction I care about more than a missed one.
      { name: 'raw_iron', dir: 1, get: b => cnt(b, 'raw_iron') },
      { name: 'iron_ingot', dir: 1, get: b => cnt(b, 'iron_ingot') },
      { name: 'iron_pick', dir: 1, get: b => held(b, /^iron_pickaxe$/) },
      // The descent itself. From 05:52 to 21:00 this stage re-minted picks, filled buckets and walked
      // coasts while the shaft head never went below y=45 - and every one of those side wins reset the
      // clock, because a pick in hand IS progress for a tool ladder but NOT for "get 3 diamonds". This
      // metric is blind (null) while no shaft is on file, so it can only veto a lock, never cause one.
      { name: 'shaft_depth', dir: 1, get: () => { const r = shaftRecord.current(); return r ? -r.y : null; } },
    ],
    // Rotating routes, each one a real player move against the wall this stage hits:
    // no dry place to stand by a submerged pool, a 700-block respawn tax, and a pick that wears out.
    unblock: [
      // FIRST, ahead of both `re-pick` entries: obsidian drops only from a diamond/netherite pick, and
      // the generic `/pickaxe/i` shop below answers this by minting iron and stone picks - which drop
      // nothing on obsidian. Measured 02:56 -> 03:01 three callers reported `no diamond-tier pickaxe`
      // and the model went to smelt MORE IRON each time.
      { alt: 'diamond-pick', when: /no diamond-tier pick|diamond pickaxe|obsidian cannot be collected|iron drops nothing|needs a diamond pickaxe/i, skill: 'ensure_diamond_pick', args: {}, capMs: 420000, ready: canMintDiamondPick, why: 'obsidian only drops from a diamond pick - go get 3 diamonds, sticks and a table, and verify the hand' },
      { alt: 'pour-frame', when: /cell\(s\) still missing|frame needs|cells still need filling|obsidian cannot be collected|no obsidian cell in reach/i, skill: 'pour_portal_cell', args: {}, capMs: 300000, ready: () => !!workshopRecord.at('nether_portal_frame'), why: 'a frame cell can be MADE where it stands - lava source plus water, no pickaxe tier and no carried obsidian' },
      // "no diamond pickaxe yet" is the answer this stage has been giving since 05:52 (kit at 06:00:
      // stick=0, birch_log=0, 2 stone picks, iron_pickaxe=0, diamond=1). That is a TOOL-SUPPLY wall, and
      // the response is to re-mint picks - not a shelf beside a pool the bot is not standing at.
      // Order matters, because `routes.find(r => r.when.test(obs))` takes the FIRST match and
      // "no diamond pickaxe yet (diamonds=0)" also matches the generic /pickaxe/ line below it. At
      // 07:38:52 that sent the lock to `ensure_tools`, which minted three more stone picks - right for a
      // rock problem, useless for the real shortage, which is the three diamonds the pick is crafted
      // FROM. A missing diamond is a vein trip, not a pick shop.
      // `find_diamonds` answers this in 2 ms when the hand has no pick, so routing a "need pickaxe"
      // answer back to the vein is a route that cannot succeed (caught live 07:45:34 -> 07:48:16).
      // The pick shop has to come first for exactly that phrase; the vein is for the diamond shortage.
      { alt: 're-pick', when: /need pickaxe|no pickaxe in hand/i, skill: 'ensure_tools', args: {}, capMs: 200000, why: 'the hunt refuses to run without a pick in hand - mint the pick ladder first' },
      // The pour dies without ONE item: 01:22-01:45 on 2026-10-31 the farm warned `no bucket in the
      // pack` 71 times in 23 minutes and every warning just returned false, with pickaxe in hand and
      // sites chosen. Bucket loss is a supply task (mine iron -> smelt -> craft -> fill), so it gets
      // its own route rather than being re-routed into the vein or the shelf.
      { alt: 'rebucket', when: /no bucket in the pack|cannot forge a bucket|forge and fill one|no bucket left/i, skill: 'ensure_bucket', args: {}, capMs: 300000, why: 'the bucket is gone - forge and fill one, because no pour can happen without it' },
      // BEFORE `vein`, because `when:/diamond/i` also matches "Diamonds need y<=-25" and re-running
      // find_diamonds is what re-opened the loop: 25 rounds on 2026-10-30 each ended by surfacing and
      // roaming 200 blocks, deleting the descent the previous round had paid for, and the diamond count
      // sat at 1 the whole time. The move against a half-dug shaft is to finish that shaft.
      { alt: 'deepen', when: /SHAFT OPEN|descent to go|blocks of descent|continue THIS column/i, skill: 'resume_shaft', args: {}, capMs: 240000, ready: (b) => overworld(b) && !!shaftRecord.current(), why: 'a shaft is already on file part-way down - spend the window going down it instead of opening another' },
      { alt: 'vein', when: /diamond/i, skill: 'find_diamonds', args: { count: 3 }, capMs: 240000, ready: overworld, why: 'the shortage is the diamonds themselves - walk a remembered vein with an iron-tier pick' },
      { alt: 're-pick', when: /pickaxe|no pick|iron\+ pick|stick/i, skill: 'ensure_tools', args: {}, capMs: 200000, why: 'the stage is blocked on a tool it cannot currently make - re-mint the pick ladder first' },
      { alt: 'ledge', when: /submerged|breathable|no dry|rim/, skill: 'build_ledge', args: { radius: 10 }, capMs: 120000, ready: (b) => nearBlock(b, 'lava', 24), why: 'the pool has no dry place to stand - pile a shelf into its edge' },
      { alt: 'base', skill: 'forward_base', args: {}, capMs: 180000, why: 'every death costs a 700-block walk back - set a bed at the working pocket' },
      { alt: 'hunt-pool', when: /lava|bucket|pool|fill/i, skill: 'make_obsidian', args: { count: 12 }, capMs: 180000, why: 'the remembered pool is spent - go find another lava+water pair' },
    ],
  },
  blaze_rods: {
    metrics: [
      { name: 'blaze_rod', dir: 1, get: b => cnt(b, 'blaze_rod') },
      { name: 'arrow', dir: 1, get: b => cnt(b, 'arrow') },
      // What this stage actually dies on is the price of ENTRY, not rods. 02:16 -> 02:40 it repeated
      // `cannot reach the Nether for blaze rods (dim=overworld, obsidian=6, flint_and_steel=1) -
      // obsidian/flint_steel must be re-made first` while the only route on offer was `portal` - a
      // route that cannot succeed until the 10-block frame can be afforded at all. So the stage's
      // dossier tracks the entry cost too: a fresh obsidian, a new pick, or a bucket IS forward
      // motion here.
      { name: 'obsidian', dir: 1, get: b => cnt(b, 'obsidian') },
      { name: 'diamond_pick', dir: 1, get: b => held(b, /^diamond_pickaxe$/) },
      { name: 'water_bucket', dir: 1, get: b => cnt(b, 'water_bucket') },
    ],
    unblock: [
      { alt: 'pour-frame', when: /cell\(s\) still missing|frame needs|cells still need filling|obsidian cannot be collected|cannot reach the Nether/i, skill: 'pour_portal_cell', args: {}, capMs: 300000, ready: () => !!workshopRecord.at('nether_portal_frame'), why: 'the gate to the Nether is 4-10 frame cells, and a cell can be poured into existence without a pickaxe tier' },
      // Ahead of `frame`: at 03:01:36 the `frame` route fired, make_obsidian answered `no diamond-tier
      // pickaxe`, and the lock would have kept re-asking the same skill that cannot do anything without
      // the pick. The pick chain is the prerequisite, so it goes first.
      { alt: 'diamond-pick', when: /no diamond-tier pick|diamond pickaxe|obsidian cannot be collected|iron drops nothing|needs a diamond pickaxe/i, skill: 'ensure_diamond_pick', args: {}, capMs: 420000, ready: canMintDiamondPick, why: 'the frame cannot be filled without a diamond pick - 3 diamonds, sticks, table, craft' },
      // Ordered by what the failure actually says: a missing bucket is a forge job (iron + smelt), a
      // missing pick is a diamond job (and diamonds live at the depth of the recorded shaft), and
      // only then does the frame itself get topped up. `portal` stays as the rotation fallback.
      // ready: () => true was wrong twice over, and it is what ate the last twenty minutes: the route's
      // own `when` regex matches the phrase its failure prints (`cannot forge a bucket yet`), so once it
      // fires it re-ignites itself every round; and its precondition is false anyway - the pack has three
      // buckets. Require the actual need, and require the Overworld, because the errand it runs (mine
      // iron, smelt, craft) calls recover_surface, which outside the Overworld is a portal ride HOME.
      { alt: 'rebucket', when: /no bucket in the pack|forge a bucket|cannot forge a bucket|mined 0 of \["iron_ore/i, skill: 'ensure_bucket', args: {}, capMs: 300000, ready: (b) => overworld(b) && cnt(b, 'bucket') === 0, why: 'the pour cannot run without a bucket - and the forge needs iron from DEPTH, not the surface band' },
      { alt: 'deepen', when: /SHAFT OPEN|descent to go|no diamond-tier pick|diamonds=0|cannot be collected/i, skill: 'resume_shaft', args: {}, capMs: 240000, ready: (b) => overworld(b) && !!shaftRecord.current(), why: 'the pick that cuts obsidian needs 3 diamonds, and diamonds only exist down the recorded shaft - continue that column' },
      { alt: 'vein', when: /diamond/i, skill: 'find_diamonds', args: { count: 3 }, capMs: 240000, ready: overworld, why: 'no diamond pick exists to be minted without three diamonds' },
      // ready: overworld, because casting obsidian means pouring water on lava, and there is no water in
      // the Nether: at 18:13:39 a bot standing at 19,67,98 the_nether got `make_obsidian` as its unblock
      // route (its lastObs contained "obs=3"), answered `no diamond-tier pick to collect with`, and the
      // step burned itself on an errand that cannot exist in that dimension.
      { alt: 'frame', when: /obsidian=|need 10 obsidian|cannot reach the Nether|frame needs 10/i, skill: 'make_obsidian', args: { count: 10 }, capMs: 300000, ready: overworld, why: 'the frame costs 10 obsidian in hand - state the total, not a guess' },
      // `ready` matters here: every other alt in this list is gated on a state, and this one was not, so a
      // bot ALREADY in the Nether got "use_portal (rods only drop in the Nether)" as its unblock route -
      // measured 18:12:18, at 19,67,98 the_nether, it walked to its own portal and tried to step into it,
      // which is the ride OUT. The route means "get to the Nether", so it may only run when that is missing.
      // A `when` is now required: the chooser no longer rotates through unrelated routes (see runUnblock),
      // so a route with no trigger would be unreachable. These are the phrases that actually mean
      // "you are not in the Nether" - and `ready` still refuses to run it when the bot is already there.
      { alt: 'portal', when: /not in the Nether|cannot reach the Nether|no blaze in sight|rods only drop|dim=overworld/i, skill: 'use_portal', args: {}, capMs: 180000, ready: (b) => !!(b.game && b.game.dimension !== 'the_nether'), why: 'rods only drop in the Nether' },
    ],
  },
  pearls: {
    metrics: [{ name: 'ender_pearl', dir: 1, get: b => cnt(b, 'ender_pearl') }],
    unblock: [{ alt: 'hunt-pearl', skill: 'farm_pearl', args: { count: 14 }, capMs: 180000, why: 'no pearls in the pack' }],
  },
  eyes: {
    metrics: [
      { name: 'ender_eye', dir: 1, get: b => cnt(b, 'ender_eye') },
      { name: 'blaze_rod', dir: 1, get: b => cnt(b, 'blaze_rod') },
    ],
    unblock: [{ alt: 'craft-eyes', skill: 'craft_eyes_of_ender', args: {}, capMs: 120000, why: 'inputs are in the pack but the eyes are not made' }],
  },
  armor: {
    metrics: [
      { name: 'worn', dir: 1, get: b => wornCount(b) },
      { name: 'iron_ingot', dir: 1, get: b => cnt(b, 'iron_ingot') },
      { name: 'raw_iron', dir: 1, get: b => cnt(b, 'raw_iron') },
      { name: 'leather', dir: 1, get: b => cnt(b, 'leather') },
    ],
    unblock: [{ alt: 'refuel', skill: 'ensure_tools', args: {}, capMs: 150000, why: 'the smelt chain needs fuel and a working pick' }],
  },
  diamond_pick: {
    metrics: [
      { name: 'diamond_pick', dir: 1, get: b => held(b, /^diamond_pickaxe$/) },
      { name: 'diamond', dir: 1, get: b => cnt(b, 'diamond') },
      { name: 'shaft_depth', dir: 1, get: () => { const r = shaftRecord.current(); return r ? -r.y : null; } },
    ],
    unblock: [
      // A table is owned property, not a recipe to redo: 05:15 the pack had no bench while one sat 37
      // blocks away at y=36, and the ladder's answer was to go hunt logs (impossible on a reef).
      { alt: 'carry-table', when: /no crafting table|no reachable table|bench within|no logs for a crafting_table/i, skill: 'stow_workshop', args: { take: 'crafting_table', radius: 96 }, capMs: 200000, why: 'break the placed table it already owns and carry it, instead of building a second one from wood that is not in this biome' },
      { alt: 'deepen', when: /SHAFT OPEN|descent to go|blocks of descent|continue THIS column/i, skill: 'resume_shaft', args: {}, capMs: 240000, ready: (b) => overworld(b) && !!shaftRecord.current(), why: 'the three diamonds are under a shaft that is already half dug - finish it' },
      { alt: 'vein', skill: 'find_diamonds', args: { count: 3 }, capMs: 240000, ready: overworld, why: 'no pick and no stones - go to a remembered vein' },
    ],
  },
  stronghold: {
    metrics: [{ name: 'ender_eye', dir: 1, get: b => cnt(b, 'ender_eye') }],
    unblock: [{ alt: 'locate', skill: 'locate_stronghold', args: {}, capMs: 180000, why: 'the stronghold column is still unknown' }],
  },
  // food is where the ladder actually sat at 05:37 (re-opened by revalidation, 3 attempts with the
  // pack's edible count unchanged). The historical answer was 264x "edible=0 meter=17/20 (raw meat=none)"
  // - the biome it was standing in has no animals, so the routes are a LONG walk and a bed, not another
  // short hunt of the same empty chunk.
  food: {
    metrics: [
      { name: 'edible', dir: 1, get: b => ['beef', 'cooked_beef', 'chicken', 'cooked_chicken', 'porkchop', 'cooked_porkchop', 'mutton', 'cooked_mutton', 'rotten_flesh', 'bread', 'apple', 'baked_potato', 'rabbit', 'cod', 'cooked_cod', 'salmon', 'cooked_salmon', 'dried_kelp'].reduce((s, n) => s + (cnt(b, n) || 0), 0) },
      { name: 'leather', dir: 1, get: b => cnt(b, 'leather') },
      { name: 'wool', dir: 1, get: b => ['white_wool', 'red_wool', 'black_wool'].reduce((s, n) => s + (cnt(b, n) || 0), 0) },
    ],
    unblock: [
      { alt: 'kelp', when: /standing in (kelp|seagrass|water)|pinned at|no REACHABLE cow/i, ready: b => nearBlock(b, 'kelp_plant', 10) || nearBlock(b, 'kelp', 10), skill: 'harvest_kelp', args: { count: 16 }, capMs: 150000, why: 'the bot is standing in a kelp bed with coal and a furnace - cook the seaweed instead of walking out the biome for a cow' },
      // Open water with no bed and no herd. Measured 14:18-15:25 at -300,64,1667: `#kelp` was not ready
      // (no bed loaded), `#fish` ran 6 times and died on `string=1` (a rod wants 2), `#long-walk` roamed
      // 0 blocks because every heading tripped the water guard. A village hay bale is 9 wheat and bread
      // needs no animal, no rod and no furnace - and the march itself now swims, which roam could not.
      { alt: 'village', when: /no kelp column|not a kelp bed|no REACHABLE cow|raw meat=none|no livestock|nothing in sight|open water|village scan is on cooldown/i, ready: (b) => overworld(b) && !villageCooled(b) && !villageTooFar(b) && ['beef', 'cooked_beef', 'bread', 'chicken', 'mutton', 'porkchop', 'cod', 'salmon'].reduce((s, n) => s + (cnt(b, n) || 0), 0) < 3, skill: 'raid_village', args: { need: 3 }, capMs: 300000, why: 'this biome has neither animals nor seaweed - a village hay bale is 9 wheat, and bread is the only food chain that needs no herd, no rod and no furnace' },
      // The dark-corridor food route, decided by code instead of by the model. Live 19:24 the food stage
      // held 26 min on an ocean islet with permanent day: `#kelp` not ready (no bed loaded), `#village`
      // cooled down and unpaid for (/locate answered "none" for every type), `#fish` could not buy a rod
      // (string=1), `#long-walk` roamed 500 blocks and found nothing - while the stronghold two cells away
      // is full of zombies and rotten_flesh is on the edible list in both gates and in `eat`.
      {
        alt: 'undead',
        when: /no REACHABLE cow|raw meat=none|nothing in sight|no livestock|open water|not path-reachable|no kelp column/i,
        skill: 'hunt_spider',
        args: { kind: 'zombie', count: 3 },
        capMs: 180000,
        ready: (b) => overworld(b) && held(b, /_sword$/) > 0 && undeadLoaded(b),
        why: 'a sword plus a dark corridor is food: zombies need no herd, no wheat, no rod and no furnace, and rotten flesh counts as an edible ration',
      },
      // `ready` used to ask only "is there water", so this route won the lock six times in a row and each
      // run ended in `no fishing_rod and could not make one (sticks=9 string=1)`. A route can only be
      // offered if it can actually pay for itself now.
      // Starving ABOVE an open End door: the larder is down, not up. Permanent day means the surface loads
      // no hostile mob and this biome has no herd, no kelp bed and no village inside a walkable distance
      // (live 20:19, food stage held 81 min, food=0 hp=10 at y=74) - while the dark slabs at y=15-30 are
      // full of zombies and spiders, and the portal the run is trying to reach sits at y=15 anyway.
      // Going down is therefore one move that serves both the meal and the dive.
      {
        alt: 'deep-larder',
        when: /no REACHABLE cow|raw meat=none|nothing in sight|no livestock|do NOT climb to grass|edible=0 meter=[0-9]/i,
        skill: 'dig_to_y',
        args: { toY: 22, max: 18 },
        capMs: 240000,
        ready: (b) => overworld(b) && held(b, /_sword$/) > 0 && ringOpen() && ((b.entity && b.entity.position && b.entity.position.y) || 0) > 40 && (b.health || 20) >= 8,
        why: 'the surface has no animals, no kelp and no village tonight; the dark layers do, and the End door is down there anyway',
      },
      { alt: 'fish', when: /no REACHABLE cow|standing in (water|kelp)|raw meat=none|nothing in sight|open gra|leave (the|this) (turtle|water)/i, skill: 'fish', args: { count: 2 }, capMs: 200000, ready: (b) => nearBlock(b, 'water', 6) && (cnt(b, 'fishing_rod') > 0 || (cnt(b, 'string') >= 2 && cnt(b, 'stick') >= 3)), why: 'on open water a rod needs no bait and no herd - fish instead of roaming 420 blocks for a cow that does not spawn here' },
      { alt: 'long-walk', when: /raw meat=none|no (cow|sheep|animal)|nothing in sight/i, skill: 'roam', args: { look_for: 'cow,pig,sheep', distance: 420, arrive: 20 }, capMs: 180000, why: 'this biome is empty of animals - walk a real distance, not another leg' },
      { alt: 'cook', when: /edible=0.*fuel|raw meat=(?!none)|need (fuel|coal)/i, skill: 'smelt', args: { item: 'beef', count: 4 }, capMs: 180000, why: 'there is raw meat in the pack and nothing cooked - the furnace is the answer' },
      { alt: 'base', skill: 'forward_base', args: {}, capMs: 180000, why: 'a bed by the herds makes the night huntable instead of fatal' },
      { alt: 'kind-chicken', when: /chicken|feather/i, skill: 'hunt', args: { count: 3, kind: 'chicken' }, capMs: 150000, why: 'cows are absent but chickens feed it (and drop feathers)' },
    ],
  },
  nether: {
    metrics: [
      { name: 'in_nether', dir: 1, get: b => (b.game && b.game.dimension === 'the_nether' ? 1 : 0) },
      { name: 'obsidian', dir: 1, get: b => cnt(b, 'obsidian') },
    ],
    unblock: [{ alt: 'portal', skill: 'build_nether_portal', args: {}, capMs: 240000, why: 'the frame is the only door to the Nether' }],
  },
  flint_steel: {
    metrics: [{ name: 'flint_and_steel', dir: 1, get: b => cnt(b, 'flint_and_steel') }, { name: 'flint', dir: 1, get: b => cnt(b, 'flint') }],
    unblock: [{ alt: 'gravel', skill: 'mine', args: { names: ['gravel'], count: 8 }, capMs: 150000, why: 'flint only comes from digging gravel' }],
  },
  enter_end: {
    metrics: [
      { name: 'in_end', dir: 1, get: b => (b.game && b.game.dimension === 'the_end' ? 1 : 0) },
      // Report the RING, not the pack. As `cnt(b,'ender_eye')` this line showed the brief saying
      // `ender_eye 3` for a door that was filled 12/12 and standing open, and the model read it as an unmet
      // requirement: at 23:06 and 23:21 it planned `use_portal -> search_nether_fortress -> farm_blaze` with
      // the words "enter_end blocked: 3 eyes vs 12 frames" - nine errands in a dimension the dive does not
      // need, while a shaft it had already dug sat behind it. Pinned to 12 when the ring is complete, so the
      // number the model sees is the fact. `in_end` stays the metric that has to MOVE for the lock to clear.
      {
        name: 'ender_eye', dir: 1, get: b => {
          try {
            const rec = require('./portalRecord').current();
            if (rec && rec.ringComplete) return 12;
          } catch { /* fall back to the pack count */ }
          return cnt(b, 'ender_eye');
        },
      },
    ],
    unblock: [
      // The one failure this stage has had since 21:10 is distance: the ring is complete, the door is
      // open, and the bot stands 219 blocks from the column inside solid deepslate. No route above
      // describes that, so the chooser fell through to a blind rotation of iron/eyes errands while the
      // actual wall was the walk. This route names the walk - and its args come from the world, because
      // the door column lives in portalRecord, not in this table.
      {
        alt: 'travel',
        when: /blocks off|WALK TO THE ROOM|close the rest with|no route existed|Took to long to decide/i,
        skill: 'tunnel_to',
        args: (b) => {
          const rec = require('./portalRecord').current();
          return rec && Number.isFinite(rec.x) ? { x: rec.x, z: rec.z, tolerance: 6 } : {};
        },
        capMs: 240000,
        // Applicability is the second question, and it is the one that matters here: below y=58 the
        // corridor is the only verb that moves the bot, above it the open air is faster to walk, and at
        // the column already this route must not re-dig the last 16 blocks of a room it can see.
        ready: (b) => {
          try {
            const rec = require('./portalRecord').distanceTo(b);
            if (!rec || !Number.isFinite(rec.dist) || rec.dist <= 16) return false;
            return !!b.entity && b.entity.position.floored().y < 58 && b.food >= 8;
          } catch { return false; }
        },
        why: 'the door is open and the only thing between the bot and the dive is 200 blocks of rock - cut through it instead of asking pathfinder for a route it cannot produce',
      },
      // The dive gate closes on armour after two End deaths (the operator's own rule). When it does, the
      // way forward is iron, and iron is mined - not eyes.
      // A tool mint comes FIRST when the failure is the tool. Live 20:50: `branch_mine -> failed: need
      // pickaxe (pack has none; held=dirt y=53)` in 0 s - the same shape as the empty-corridor `#undead`
      // refusal above: a route that cannot pay for itself still wins the slot, and the run spins.
      {
        alt: 'pick-first',
        when: /need pickaxe|no pickaxe|pack has none|needs? a? ?pickaxe|pickaxe tier/i,
        skill: 'ensure_tools',
        args: {},
        capMs: 180000,
        why: 'iron cannot be mined with a bare hand - mint the pick ladder (planks + sticks are in the pack) before any mining route is offered',
      },
      {
        alt: 'iron-for-armour',
        when: /exemption closed|no chestplate|armour stall|not ready to dive/i,
        skill: 'branch_mine',
        args: { names: ['iron_ore', 'deepslate_iron_ore'], length: 24 },
        capMs: 240000,
        // Read the ARMOUR SLOTS, not the verdict text. At 17:41 the route fired off a stale `worn=1/4`
        // line from 17:32 while the bot was standing at the portal column wearing chestplate+boots - and
        // `armourShort()` in the gate is satisfied at chestplate + one more piece, so that 4-minute
        // branch-mine detour cost a dive window for nothing. Same class as the `eyes` route above.
        ready: (b) => {
          const n = wornCount(b);
          if (n === null) return true;                     // armour slots unreadable: don't block the errand
          let chest = false;
          try { const it = b.inventory.slots[6]; chest = !!it && /_chestplate$/.test(it.name); } catch {}
          return hasPick(b) && !(chest && n >= 2);          // and only with a tool that can cut the ore
        },
        why: 'the dive gate wants a worn chestplate plus one more piece and the armour slots do not hold them',
      },
      {
        alt: 'eyes',
        skill: 'craft_eyes_of_ender',
        args: {},
        capMs: 150000,
        why: 'the portal needs eyes before it can be opened',
        // Measured 09:55:57 - with the ring 12/12 and the portal already opened eight times, this route
        // still fired and burned 150 s answering `eyes=3/12`, every time the dive gate refused. The ring
        // state is what says whether eyes are the wall at all.
        ready: () => {
          try {
            const rec = require('./portalRecord').current();
            return !(rec && rec.ringComplete);
          } catch { return true; }
        },
      },
    ],
  },
  kill_dragon: {
    metrics: [{ name: 'crystals_gone', dir: 1, get: b => (b._crystalsDown || 0) }],
    unblock: [],
  },
};

// Generic safety net for milestones with no table entry: things that at least prove the run is not
// standing still. Deliberately weak - it can only ever DELAY a lock, never cause one.
const FALLBACK = [
  { name: 'xp_level', dir: 1, get: b => (b.experience ? b.experience.level : null) },
  { name: 'free_slots', dir: 1, get: b => { try { return b.inventory.items().length >= 0 ? 36 - b.inventory.items().length : null; } catch { return null; } } },
];

let mem = { stages: {} };
try { mem = JSON.parse(fs.readFileSync(FILE, 'utf8')); if (!mem || !mem.stages) mem = { stages: {} }; } catch { /* first run */ }

const save = () => { try { fs.writeFileSync(FILE, JSON.stringify(mem, null, 1)); } catch (e) { log.warn(`stage_lock save threw ${e.message}`); } };
const saveReport = (r) => { try { fs.writeFileSync(REPORT, JSON.stringify(r, null, 1)); } catch (e) { log.warn(`stall_report save threw ${e.message}`); } };

function snap(bot, id) {
  const defs = (STAGES[id] && STAGES[id].metrics) || FALLBACK;
  const out = {};
  for (const d of defs) {
    let v = null;
    try { v = d.get(bot); } catch { v = null; }
    out[d.name] = (typeof v === 'number' && isFinite(v)) ? v : null;
  }
  return out;
}

function entry(id) {
  if (!mem.stages[id]) mem.stages[id] = { tries: 0, idle: 0, since: Date.now(), altIndex: 0, cycles: 0, lastObs: '', topObs: {}, history: [] };
  return mem.stages[id];
}

// The verdict the planner acts on. Called once per milestone attempt that did NOT complete it.
// Returns { idle, level, alt } where level is '' | 'loop' | 'lock'.
function noteFailure(bot, m, res, ctx) {
  const id = m.id;
  const e = entry(id);
  const after = snap(bot, id);
  const defs = (STAGES[id] && STAGES[id].metrics) || FALLBACK;
  let moved = [];
  for (const d of defs) {
    const a = ctx && ctx.before ? ctx.before[d.name] : null;
    const b = after[d.name];
    if (a === null || a === undefined || b === null || b === undefined) continue;
    const delta = b - a;
    if (delta === 0) continue;
    if (d.dir > 0 ? delta > 0 : delta < 0) moved.push(`${d.name} ${a}->${b}`);
  }
  const durS = Math.round((Date.now() - (ctx ? ctx.at : Date.now())) / 1000);
  const obs = String((res && res.observation) || '?').slice(0, 140);
  e.lastObs = obs;
  e.topObs[obs] = (e.topObs[obs] || 0) + 1;
  e.history.push({ at: new Date().toISOString(), durS, moved: moved.join(','), obs });
  while (e.history.length > 10) e.history.shift();
  e.tries++;
  const level = { idle: e.idle, level: '', alt: null };
  if (moved.length) {
    // Real forward motion, however small: the clock restarts so an honest grind is never locked out.
    if (e.idle > 0) log.info(`stage ${id}: progress (${moved.join(', ')}) - stage-lock clock reset`);
    e.idle = 0;
    e.since = Date.now();
    e.spentMs = 0;
    save();
    return level;
  }
  // Effort accounting, not calendar time: a stage that is not current is not "stuck", it is simply not
  // being worked on. At 08:23:08 the pure-calendar version locked `food` on its FIRST attempt because
  // 100 minutes had passed since its metric last moved - most of which the ladder spent on obsidian.
  // Summing the durations actually spent on this stage keeps the anti-laundering property (each hop
  // adds its own minutes) without punishing a stage for time given to another.
  e.spentMs = (e.spentMs || 0) + Math.max(0, Date.now() - (ctx && ctx.at ? ctx.at : Date.now()));
  e.idle++;
  const spanMin = Math.round((Date.now() - e.since) / 60000);
  const spentMin = Math.round((e.spentMs || 0) / 60000);
  const st = STAGES[id];
  const spanHard = st && st.spanHardMin ? st.spanHardMin : 50;
  // Two shapes of stuck, each with its own gate. A 25-minute obsidian round that changes nothing is only
  // provably a loop after several minutes of effort; a 12-second spin (§26t, 10:51-10:55) needs no
  // clock at all, because five identical no-progress attempts IS the verdict.
  const SPAN_GATE_MIN = Number(process.env.SL_SPAN_GATE_MIN || 8);
  // The attempt-count gate alone is too slow for a stage that declares a 25-minute step (obsidian's
  // budgetMs is 1500000): three attempts would be 75 minutes of nothing moved before the first route
  // change - exactly the "stuck in one stage for a long time" the objective is against. So effort gets
  // its own trigger, repeatable while the quantity stays frozen.
  // Effort, not calendar: at 08:23:08 the calendar gate locked `food` on its FIRST attempt because 100
  // min had passed since its quantity moved - minutes the ladder had actually handed to obsidian.
  const SPAN_TRIGGER_MIN = Number(process.env.SL_SPAN_TRIGGER_MIN || 30);
  const timeDue = spentMin >= SPAN_TRIGGER_MIN && (Date.now() - (e.lastRouteAt || 0)) > (SPAN_TRIGGER_MIN - 8) * 60000;
  const due = (e.idle >= 3 && e.idle % 3 === 0 && (spentMin >= SPAN_GATE_MIN || e.idle >= 5)) || timeDue;
  if (due) {
    const second = e.idle >= 6 || spentMin >= spanHard;
    // Failure-AWARE route choice. A stage has several distinct walls, and rotating blindly through them
    // wastes the one intervention window a lock gives: obsidian's first route is the dry shelf for a
    // submerged pool, but at 05:58 the repeated answer was "no diamond pickaxe yet" - and a shelf beside
    // a pool it is not standing at can only burn the 2 minutes. So a route whose `when` matches the last
    // observation goes first, and the plain rotation remains the fallback when nothing matches.
    const routes = (st && st.unblock) || [];
    // A route whose `when` matches but whose subject is not here cannot be run either, and choosing it
    // anyway is what handed the food lock to `#kelp` (no bed loaded) and then to the one unconditional
    // entry - `forward_base` - three times on 2026-11-03 while the bot starved in open ocean. Match on
    // the failure AND on applicability; the old one-key find only asked the first question.
    const rotMatched = routes.find(r => r.when && r.when.test(obs) && readyNow(r, bot))
      || routes.find(r => r.when && r.when.test(obs) && !r.ready);
    const rot = rotMatched || (routes.length ? routes[e.altIndex % routes.length] : null);
    if (rot && !rotMatched) e.altIndex++;
    e.pendingAlt = rot ? rot.alt : null;
    e.lastRouteAt = Date.now();
    log.warn(`STAGE ${second ? 'LOCK' : 'LOOP'}: ${id} has burned ${e.idle} attempts / ${spentMin} min of effort (calendar ${spanMin} min) with the goal quantity unchanged${timeDue && e.idle < 3 ? ' (effort trigger, not attempt count)' : ''}${rotMatched ? ` - route matched by its when-pattern (${rot.alt})` : ''}; last: "${obs}"`);
    e.cycles++;
    level.level = second ? 'lock' : 'loop';
    level.alt = rot ? rot.alt : 'reflect';
    saveReport({
      at: new Date().toISOString(), stage: id, level: level.level, attempts: e.idle, spanMin, spentMin,
      alt: level.alt, dominant: Object.entries(e.topObs).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${v}x ${k}`),
      position: (() => { try { const p = bot.entity.position.floored(); return `${p.x},${p.y},${p.z} ${bot.game.dimension}`; } catch { return '?'; } })(),
      metrics: after, history: e.history.slice(-4),
    });
    save();
  } else {
    save();
  }
  return level;
}

// A route is only worth running when its subject exists nearby. 07:01:52 proved it: the obsidian lock
// fired `route #ledge -> build_ledge` while the bot was in the middle of the ocean, and the skill
// correctly answered "no lava cell within 10 blocks" in 0 s - a wasted intervention that also consumed
// the altIndex slot the bed route needed. Fail-open: a probe that throws counts as "ready", because
// losing the route is worse than trying it.
const { blockIds } = require('./skills/primitives');
const nearBlock = (b, name, r) => {
  try { return b.findBlocks({ matching: blockIds(b, [name]), maxDistance: r, count: 1 }).length > 0; } catch { return true; }
};
const readyNow = (r, bot) => {
  if (!r.ready) return true;
  try { return !!r.ready(bot); } catch { return true; }
};

// The village scan re-arms on travel, not only on the clock (src/skills/base.js raid_village). The route
// has to use the same rule or the lock keeps spending interventions on a call that will refuse itself.
const villageCooled = (b) => {
  const tr = b && b._villageTried;
  if (!tr || Date.now() >= (tr.retryAt || 0)) return false;
  try {
    const V = require('vec3');
    return Math.round(b.entity.position.distanceTo(new V(tr.x, b.entity.position.y, tr.z))) < 64;
  } catch { return true; }
};

// Run the rotation step itself. Capped and fail-open: an unblock routine that hangs must never become
// the new wedge, so a cap simply skips it and the ladder continues with the dossier still recorded.
// A route's args may be a function of the world (`travel` needs the door column, and that lives in
// portalRecord, not in this table). A thrower must not eat the intervention, so it falls back to the
// static args / empty object - the same fail-open rule every other gate here follows.
function routeArgs(r, bot) {
  try { return typeof r.args === 'function' ? (r.args(bot) || {}) : (r.args || {}); }
  catch { return r.args && typeof r.args === 'object' ? r.args : {}; }
}

async function runUnblock(bot, m) {
  const st = STAGES[m.id];
  if (!st || !st.unblock || !st.unblock.length) return null;
  const e = entry(m.id);
  const routes = st.unblock;
  const pending = e.pendingAlt ? routes.find(r => r.alt === e.pendingAlt) : null;
  e.pendingAlt = null;
  const eligible = routes.filter(r => readyNow(r, bot));
  if (!eligible.length) {
    log.warn(`stage lock: ${m.id} has no route available right now (${routes.map(r => `${r.alt}:${readyNow(r, bot) ? 'ok' : 'absent'}`).join(' ')}) - skipping the intervention`);
    return null;
  }
  // The chooser used to do `eligible[(altIndex++) % eligible.length]` whenever the observation matched no
  // route, so a bot whose failure was "no blaze in sight" was sent off to forge a bucket or pour a portal
  // cell - errands that cannot be finished in that dimension and each burn up to 300 s of the stage
  // budget (measured 19:52-19:53 at -260,27,105: 16 blocks from the first fortress this run has ever
  // found, and the intervention spent the round on `pour_portal_cell` -> `ensure_bucket` -> `mine` ->
  // "no crafting table"). A route that does not describe the failure is a distraction.
  // Routes written WITHOUT a `when` are the deliberate defaults (several stages have only one), so they
  // stay reachable; what is gone is picking a route whose `when` did not match.
  const unconditional = eligible.filter(r => !r.when);
  let pick = null;
  if (pending && eligible.includes(pending)) pick = pending;
  else if (unconditional.length) pick = unconditional[(e.altIndex || 0) % unconditional.length];
  else {
    log.warn(`stage lock: ${m.id} has no route for this failure${pending ? ` (only #${pending.alt} matched and it is not applicable now)` : ''} - skipping the intervention instead of running an unrelated errand (routes: ${routes.map(r => r.alt).join(',')})`);
    return null;
  }
  if (pick !== pending && pending) log.info(`stage lock: ${m.id} wanted route ${pending.alt} but it is not applicable now - using ${pick.alt}`);
  const sk = reg.get(pick.skill);
  if (!sk) { log.warn(`stage lock: unblock skill "${pick.skill}" is not registered - skipping the route change`); return null; }
  log.warn(`stage lock: ${m.id} route #${pick.alt} -> ${pick.skill} (${pick.why})`);
  const done = bot._stepBusy;
  bot._stepBusy = true;
  bot._stageAlt = pick.alt;
  const t0 = Date.now();
  try {
    const r = await Promise.race([
      Promise.resolve(sk.run(bot, routeArgs(pick, bot))).catch(e => ({ ok: false, observation: 'threw ' + e.message })),
      sleep(pick.capMs || 120000).then(() => null),
    ]);
    if (r === null) { log.warn(`stage lock: ${pick.skill} hung past ${Math.round((pick.capMs || 120000) / 1000)}s - abandoned, ladder continues`); try { if (bot.pathfinder && bot.pathfinder.isMoving && bot.pathfinder.isMoving()) bot.pathfinder.stop(); } catch {} return { ok: false, observation: 'unblock route timed out' }; }
    log.warn(`stage lock: ${pick.skill} -> ${r.ok ? 'ok' : 'failed'}: ${String(r.observation).slice(0, 180)} (${Math.round((Date.now() - t0) / 1000)}s)`);
    try { bot._notes = bot._notes || []; bot._notes.push(`route ${pick.alt} for ${m.id}: ${String(r.observation).slice(0, 120)}`); if (bot._notes.length > 6) bot._notes.shift(); } catch {}
    return r;
  } catch (e) {
    log.warn(`stage lock: ${pick.skill} threw ${e.message} - skipping the route change`);
    return null;
  } finally {
    bot._stageAlt = null;
    if (!done) bot._stepBusy = false;
  }
}

// One paragraph for the LLM: which stage, how many attempts, what the repeated answer was.
function brief(m) {
  const e = mem.stages[m.id];
  if (!e || !e.idle) return '';
  const top = Object.entries(e.topObs || {}).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k, v]) => `  - ${v}x ${k}`).join('\n');
  return `STAGE LOCK REPORT: "${m.id}" has failed ${e.idle} attempts in a row over ${Math.round((Date.now() - e.since) / 60000)} min with NO movement on its own goal quantity. The same answer keeps coming back:\n${top}\nDo not repeat the action that produced it - change the route.`;
}

function clear(m) {
  const e = entry(m.id);
  if (e.idle || Object.keys(e.topObs || {}).length) {
    log.info(`stage ${m.id}: cleared after ${e.tries} attempts (${Math.round((Date.now() - e.since) / 60000)} min since the last movement)`);
  }
  mem.stages[m.id] = { tries: 0, idle: 0, since: Date.now(), altIndex: 0, cycles: 0, lastObs: '', topObs: {}, history: [] };
  save();
}

function readReport() { try { return JSON.parse(fs.readFileSync(REPORT, 'utf8')); } catch { return null; } }

// ---- stage age ----
// Attempts-moved is not the same question as "how long has this one stage owned the run", and the second
// one is what the user actually asked for (不要卡在一个环节很久). obsidian has been the ladder's current
// milestone for the better part of a day; every existing counter could be reset by a completion, a
// reflect, or a supervisor restart while that clock kept running. So the age is measured from the moment
// a milestone BECAME current, persisted, and tiered so the response grows instead of repeating:
//   40 min -> write the dossier (cheap, no behaviour change)
//   80 min -> run a helper route, but only one that can pay for itself now (`onlyIfReady` guards inside)
//  120 min -> say it to the human playing alongside, because by then the machine has exhausted its own
//             vocabulary and a person can see the world in a way the log does not show.
const AGE_TIERS = [
  { at: 40, key: 'report' },
  { at: 80, key: 'route' },
  { at: 120, key: 'human' },
];
let lastAgeFired = null;
function trackStage(bot, m) {
  if (!m) return null;
  try {
    if (!mem.current || mem.current.id !== m.id) {
      if (mem.current && mem.current.id) {
        const mins = Math.round((Date.now() - mem.current.since) / 60000);
        log.info(`STAGE AGE closed: ${mem.current.id} held the ladder for ${mins} min (tiers fired: ${Object.keys(mem.current.tiers || {}).join(',') || 'none'})`);
      }
      mem.current = { id: m.id, since: Date.now(), tiers: {} };
      save();
      lastAgeFired = null;
      return { ageMin: 0, fired: null };
    }
    const ageMin = Math.round((Date.now() - mem.current.since) / 60000);
    // Loophole I left in my own design: a ladder that ping-pongs obsidian -> food -> obsidian would
    // restart the segment clock every hop, so a stage could sit at 119 "minutes of segment" forever and
    // never reach the human tier. `spentMs` is the effort accumulated while THIS stage's goal quantity
    // stayed frozen, and it survives those hops, so the tier clock is the LARGER of the two. Effort, not
    // the calendar gap since the quantity moved: a stage must not be graded on time given to another.
    const spentMin = Math.round(((mem.stages[m.id] || {}).spentMs || 0) / 60000);
    const tierMin = Math.max(ageMin, spentMin);
    mem.current.tiers = mem.current.tiers || {};
    let fired = null;
    for (const t of AGE_TIERS) {
      if (tierMin >= t.at && !mem.current.tiers[t.key]) {
        mem.current.tiers[t.key] = Date.now();
        fired = t.key;
      }
    }
    if (fired) {
      log.warn(`STAGE AGE: ${m.id} has owned the run for ${tierMin} min of effort (segment ${ageMin}, spent on this stage ${spentMin}) -> tier ${fired}`);
      saveReport({
        at: new Date().toISOString(), stage: m.id, level: 'age-' + fired, ageMin: tierMin, segmentMin: ageMin, spentMin,
        attemptsIdle: (mem.stages[m.id] || {}).idle || 0,
        position: (() => { try { const p = bot.entity.position.floored(); return `${p.x},${p.y},${p.z} ${bot.game.dimension}`; } catch { return '?'; } })(),
        lastObs: (mem.stages[m.id] || {}).lastObs || '',
      });
    }
    save();
    lastAgeFired = fired;
    return { ageMin: tierMin, segmentMin: ageMin, spentMin, fired };
  } catch (e) { log.warn(`stage age tracking failed: ${e.message}`); return null; }
}

module.exports = { snap, noteFailure, runUnblock, brief, clear, readReport, trackStage, STAGES, FILE, REPORT, canMintDiamondPick };
