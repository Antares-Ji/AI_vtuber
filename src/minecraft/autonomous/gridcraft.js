'use strict';
// Deterministic crafting: recipes as DATA + our own grid clicks.
//
// Why this exists: mineflayer's bot.craft() waits for a `set_slot` packet for the craft-result slot
// (slot 0). On 1.21.x Vanilla/Paper that packet does not arrive the way the library expects
// (upstream issue PrismarineJS/mineflayer#3906: "bot.craft() succeeds but delivers nothing for 3x3
// crafting table recipes"), so every 3x3 recipe - crafting table, iron leggings/chestplate, bow,
// eyes of ender - silently produced nothing and the run stalled for a long time.
//
// The workaround is to do what a player does: pick up an ingredient stack, right-click each grid
// cell to drop exactly one, put the remainder back, then SHIFT-click the result slot. We never wait
// on slot 0: success is measured by the inventory delta, which is the only signal the server is
// obliged to send.
const P = require('./skills/primitives');

// shape rows are top-to-bottom, left-to-right. key maps a letter to an item name; '*' is empty.
// `two: true` means the recipe fits the 2x2 player grid (still, mineflayer's 2x2 path loses the
// result onto the cursor, so we click this too).
const RECIPES = {
  crafting_table: { out: 1, two: true, shape: ['pp', 'pp'], key: { p: '@planks' } },
  stick: { out: 4, two: true, shape: ['p', 'p'], key: { p: '@planks' } },
  torch: { out: 4, two: true, shape: ['c', 's'], key: { c: ['coal', 'charcoal'], s: 'stick' } },
  charcoal: null,
  furnace: { out: 1, shape: ['ccc', 'c.c', 'ccc'], key: { c: ['cobblestone', 'cobbled_deepslate', 'stone', 'blackstone'] } },
  chest: { out: 1, shape: ['ppp', 'p.p', 'ppp'], key: { p: '@planks' } },
  wooden_pickaxe: { out: 1, shape: ['ppp', '.s.', '.s.'], key: { p: '@planks', s: 'stick' } },
  wooden_sword: { out: 1, shape: ['p', 'p', 's'], key: { p: '@planks', s: 'stick' } },
  wooden_axe: { out: 1, shape: ['pp', 'ps', '.s'], key: { p: '@planks', s: 'stick' } },
  wooden_shovel: { out: 1, shape: ['p', 's', 's'], key: { p: '@planks', s: 'stick' } },
  stone_pickaxe: { out: 1, shape: ['ccc', '.s.', '.s.'], key: { c: ['cobblestone', 'cobbled_deepslate', 'stone'], s: 'stick' } },
  stone_sword: { out: 1, shape: ['c', 'c', 's'], key: { c: ['cobblestone', 'cobbled_deepslate', 'stone'], s: 'stick' } },
  stone_axe: { out: 1, shape: ['cc', 'cs', '.s'], key: { c: ['cobblestone', 'cobbled_deepslate', 'stone'], s: 'stick' } },
  stone_shovel: { out: 1, shape: ['c', 's', 's'], key: { c: ['cobblestone', 'cobbled_deepslate', 'stone'], s: 'stick' } },
  iron_pickaxe: { out: 1, shape: ['iii', '.s.', '.s.'], key: { i: 'iron_ingot', s: 'stick' } },
  iron_shovel: { out: 1, shape: ['i', 's', 's'], key: { i: 'iron_ingot', s: 'stick' } },
  diamond_pickaxe: { out: 1, shape: ['ddd', '.s.', '.s.'], key: { d: 'diamond', s: 'stick' } },
  iron_sword: { out: 1, shape: ['i', 'i', 's'], key: { i: 'iron_ingot', s: 'stick' } },
  iron_axe: { out: 1, shape: ['ii', 'is', '.s'], key: { i: 'iron_ingot', s: 'stick' } },
  diamond_sword: { out: 1, shape: ['d', 'd', 's'], key: { d: 'diamond', s: 'stick' } },
  iron_helmet: { out: 1, shape: ['iii', 'i.i'], key: { i: 'iron_ingot' } },
  iron_chestplate: { out: 1, shape: ['i.i', 'iii', 'iii'], key: { i: 'iron_ingot' } },
  iron_leggings: { out: 1, shape: ['iii', 'i.i', 'i.i'], key: { i: 'iron_ingot' } },
  iron_boots: { out: 1, shape: ['i.i', 'i.i'], key: { i: 'iron_ingot' } },
  diamond_helmet: { out: 1, shape: ['ddd', 'd.d'], key: { d: 'diamond' } },
  diamond_chestplate: { out: 1, shape: ['d.d', 'ddd', 'ddd'], key: { d: 'diamond' } },
  diamond_leggings: { out: 1, shape: ['ddd', 'd.d', 'd.d'], key: { d: 'diamond' } },
  diamond_boots: { out: 1, shape: ['d.d', 'd.d'], key: { d: 'diamond' } },
  bucket: { out: 1, shape: ['i.i', '.i.'], key: { i: 'iron_ingot' } },
  // mcdata 1.21.1: inShape [[null,iron],[iron,null]] - a diagonal, two ingots. The row used to read
  // `['ii','i.']`, an L of three, which is not shears in any version.
  shears: { out: 1, shape: ['.i', 'i.'], key: { i: 'iron_ingot' } },
  // Leather and gold armor pieces for assist-free early/nether survivability.
  leather_helmet: { out: 1, shape: ['lll', 'l.l'], key: { l: 'leather' } },
  leather_chestplate: { out: 1, shape: ['l.l', 'lll', 'lll'], key: { l: 'leather' } },
  leather_leggings: { out: 1, shape: ['lll', 'l.l', 'l.l'], key: { l: 'leather' } },
  leather_boots: { out: 1, shape: ['l.l', 'l.l'], key: { l: 'leather' } },
  golden_helmet: { out: 1, shape: ['ggg', 'g.g'], key: { g: 'gold_ingot' } },
  golden_chestplate: { out: 1, shape: ['g.g', 'ggg', 'ggg'], key: { g: 'gold_ingot' } },
  golden_leggings: { out: 1, shape: ['ggg', 'g.g', 'g.g'], key: { g: 'gold_ingot' } },
  golden_boots: { out: 1, shape: ['g.g', 'g.g'], key: { g: 'gold_ingot' } },
  shield: { out: 1, shape: ['pop', 'ppp', '.p.'], key: { p: '@planks', o: 'iron_ingot' } },
  white_bed: { out: 1, shape: ['www', 'ppp'], key: { w: ['white_wool', 'light_gray_wool', 'light_blue_wool', 'lime_wool', 'yellow_wool', 'magenta_wool', 'pink_wool', 'gray_wool', 'cyan_wool', 'orange_wool', 'red_wool', 'blue_wool', 'brown_wool', 'green_wool', 'black_wool', 'purple_wool'], p: '@planks' } },
  // Vanilla: mcdata 1.21.1 inShape [[null,stick,string],[stick,null,string],[null,stick,string]].
  // This line used to read `'#': 'string', '*': '@planks'` - both the letter assignment AND the material
  // were wrong (a bow has never needed planks), so the grid got string in the stick cells, was asked for
  // "3 of one species of planks" for the string cells, made nothing, and the run dived without a bow
  // (19:50:04: `gridcraft bow x1: made=0`, then `diving WITHOUT A WORKING BOW`).
  // Vanilla: mcdata 1.21.1 inShape [[null,stick,string],[stick,null,string],[null,stick,string]].
  // This row used to read `key: { '#': 'string', '*': '@planks' }` - a bow has never needed planks, and
  // `'*'` is not usable as a shape letter anyway because planFor treats '.', ' ' and '*' as empty cells,
  // so every string slot was silently dropped: the grid got string in the stick cells, nothing in the
  // string cells, and the bow could not be made at all (19:45:47 `craft bow threw Error: missing
  // ingredient`, 19:50:04 `gridcraft bow x1: made=0`, then a dive without a bow and a fight death).
  bow: { out: 1, shape: [' #s', '# s', ' #s'], key: { '#': 'stick', s: 'string' } },
  fishing_rod: { out: 1, shape: ['..s', '.st', 's.t'], key: { s: 'stick', t: 'string' } },
  bread: { out: 1, shape: ['www'], key: { w: 'wheat' } },
  arrow: { out: 4, shape: ['f', 's', 'e'], key: { f: 'flint', s: 'stick', e: 'feather' } },
  flint_and_steel: { out: 1, shape: ['i', 'f'], key: { i: 'iron_ingot', f: 'flint' } },
  ender_eye: { out: 1, shape: ['p', 'c'], key: { p: 'ender_pearl', c: 'blaze_powder' } },
  ladder: { out: 3, shape: ['s.s', 'sss', 's.s'], key: { s: 'stick' } },
  blaze_powder: null, // shapeless 1 blaze_rod -> 2 powder; handled by the rod special case below
  crafting_table_from_log: null,
};
const PLANK_NAMES = ['oak_planks', 'birch_planks', 'spruce_planks', 'jungle_planks', 'acacia_planks', 'dark_oak_planks', 'cherry_planks', 'mangrove_planks', 'bamboo_planks', 'crimson_planks', 'warped_planks'];
const LOG_TO_PLANK = n => n.endsWith('_log') ? n.replace('_log', '_planks') : null;
const sleep = ms => new Promise(r => setTimeout(r, ms));
// clickWindow waits up to 20 s for a set_slot ack that 1.21 frequently never sends (the same
// upstream bug that made bot.craft() time out). Fire the click and move on: every routine here
// verifies by inventory delta, so a missing ack must not cost 20 s per click.
// NOTE: this calls bot.clickWindow directly and must not be written as click(bot, ...) - a
// bulk rename once made it recurse into itself, every click threw RangeError, the .catch hid it,
// and every grid craft in the run silently produced nothing.
async function click(bot, slot, button, mode) {
  await Promise.race([Promise.resolve(bot.clickWindow(slot, button, mode)).catch(() => {}), sleep(2500)]);
}

// Which item names can satisfy a recipe letter, right now, in the inventory.
function optionsFor(bot, spec) {
  if (Array.isArray(spec)) return spec.slice();
  if (spec === '@planks') {
    return PLANK_NAMES.filter(n => P.countItem(bot, n) > 0)
      // one species must cover the whole recipe, so prefer the species we hold most of
      .sort((a, b) => P.countItem(bot, b) - P.countItem(bot, a));
  }
  return [spec];
}

function countLetter(shape, letter) {
  let n = 0;
  for (const row of shape) for (const ch of row) if (ch === letter) n++;
  return n;
}

// Resolve the recipe into a concrete cell -> item-name plan (single species per letter).
function planFor(bot, name) {
  const rec = RECIPES[name];
  if (!rec) return null;
  const need = {}; // ingredient name -> count
  const letterItem = {};
  for (const [letter, spec] of Object.entries(rec.key)) {
    const per = countLetter(rec.shape, letter);
    if (!per) continue;
    const opts = optionsFor(bot, spec);
    const pick = opts.find(n => P.countItem(bot, n) >= per);
    if (!pick) return { ok: false, observation: `no single item can satisfy "${letter}" of ${name} (want ${per} of one of ${JSON.stringify(Array.isArray(spec) ? spec : spec === '@planks' ? 'any planks' : spec)}; have planks=${PLANK_NAMES.map(n => P.countItem(bot, n)).filter(x => x).join('/')} other=${opts.map(n => P.countItem(bot, n)).join('/')})` };
    letterItem[letter] = pick;
    need[pick] = (need[pick] || 0) + per;
  }
  const size = rec.shape.length > 2 || Math.max(...rec.shape.map(r => r.length)) > 2 ? 3 : 2;
  const cells = [];
  for (let y = 0; y < rec.shape.length; y++) {
    for (let x = 0; x < rec.shape[y].length; x++) {
      const ch = rec.shape[y][x];
      if (ch === '.' || ch === ' ' || ch === '*') continue;
      const item = letterItem[ch];
      if (!item) return { ok: false, observation: `unknown recipe letter "${ch}" in ${name}` };
      cells.push({ x, y, item });
    }
  }
  return { ok: true, size, cells, need, out: rec.out, two: !!rec.two };
}

// Grid slot index inside an open window. Player-inventory window: 0=result,1-4=grid.
// Crafting-table window: 0=result,1-9=grid,10+ = inventory.
function gridSlot(win, size, x, y) {
  if (size === 2) return 1 + y * 2 + x;
  return 1 + y * 3 + x;
}
function storageRange(win) {
  return win === null ? [9, 45] : [10, win.slots.length];
}
function findSource(win, itemName, lo, hi, reserved) {
  for (let s = lo; s < hi; s++) {
    const it = win.slots[s];
    if (!it || it.name !== itemName || it.count < 1) continue;
    // The window's own count is authoritative and already drops as items move into the grid. A
    // reservation Map double-subtracted that: the leggings craft placed 4 of 8 ingots, the window
    // then reported 28x4 while the Map still claimed 4 consumed, so `left` was 0 and the craft
    // answered "no iron_ingot left in inventory" with 4 ingots visibly in front of it.
    if (reserved && typeof reserved.has === 'function' && reserved.has(s)) continue;
    return s;
  }
  return -1;
}
// Combine two damaged pieces of the same gear in the crafting grid. Vanilla repairs them into one
// item (durabilities add, +5% bonus) with no anvil and no extra ingots - the recipe is computed
// client-side, so it is not in the recipe book and bot.recipesFor() will never show it.
// This is the answer to the iron treadmill measured at 10:40: iron armour burns through in ~25
// minutes of deep mining, re-crafting four pieces costs 24 ingots the world does not give that
// fast, and the run oscillated 13<->14 milestones for 40 minutes with coal 9->1 and one iron ingot.
// Works in the 2x2 inventory grid (slots 1 and 2), so no crafting table is required.
async function repairGear(bot, minPct = 55, onlyRe = null) {
  const done = [];
  for (let pass = 0; pass < 4; pass++) {
    const groups = {};
    for (const it of bot.inventory.items()) {
      if (!it.maxDurability) continue;
      // Merging two pieces into one is right for a pickaxe and wrong for armour: the `armor`
      // milestone requires four WORN pieces, so merging a chestplate with a chestplate quietly
      // destroys the set it is trying to complete. Callers pass onlyRe to say which family to merge.
      if (onlyRe && !onlyRe.test(it.name)) continue;
      const pct = 100 - Math.round((it.damage / it.maxDurability) * 100);
      if (pct > minPct) continue;
      (groups[it.name] = groups[it.name] || []).push(it);
    }
    const name = Object.keys(groups).find(n => groups[n].length >= 2);
    if (!name) break;
    const [a, b] = groups[name];
    try {
      await click(bot, a.slot, 0, 0); await sleep(110);
      await click(bot, 1, 0, 0); await sleep(110);
      await click(bot, b.slot, 0, 0); await sleep(110);
      await click(bot, 2, 0, 0); await sleep(110);
      await click(bot, 0, 0, 1); await sleep(350);
      if ((bot.inventory.slots[1] || bot.inventory.slots[2])) { // grid not consumed -> no recipe
        for (const s of [1, 2]) { if (bot.inventory.slots[s]) { const f = bot.inventory.firstEmptyInventorySlot(); if (f >= 0) { await click(bot, s, 0, 0); await sleep(90); await click(bot, f, 0, 0); await sleep(90); } } }
        break;
      }
      done.push(name);
    } catch (e) { return { repaired: done, observation: `repair ${name} threw ${e.message}` }; }
  }
  return { repaired: done, observation: done.length ? `repaired by combining: ${done.join(', ')}` : 'no two damaged pieces of a kind to combine' };
}

function firstEmpty(win, lo, hi, gridStart, gridEnd) {
  for (let s = lo; s < hi; s++) {
    if (s >= gridStart && s <= gridEnd) continue;
    if (!win.slots[s]) return s;
  }
  return -1;
}

// Craft `times` of `name`. tableWin = an open crafting-table window, or null for the 2x2 grid.
async function craftGrid(bot, name, times, tableWin) {
  times = Math.max(1, times || 1);
  // A leftover open window desyncs every click: while a crafting-table window is open, inventory
  // indices 9..45 do not mean what our plan assumes, and clickWindow then waits out its full 20 s
  // timeout ("place oak_planks: updateSlot:0 did not fire"). Close anything we were not told to use.
  if (bot.currentWindow && bot.currentWindow !== tableWin && !/^minecraft:crafting/.test(String(bot.currentWindow.type))) {
    // A furnace window left open from a smelt round makes EVERY craft impossible: the server
    // answers clicks in the furnace's slot space, so mineflayer reports "missing ingredient" while
    // eight iron ingots sit in the pack - which is exactly how the armor step circled for 20 minutes.
    try { await bot.closeWindow(bot.currentWindow); log(`craftGrid closed ${bot.currentWindow.type} before ${name}`); } catch {}
    await sleep(200);
  }
  if (!tableWin && bot.currentWindow) {
    try { await bot.closeWindow(bot.currentWindow); log(`craftGrid closed stale window ${bot.currentWindow.type}`); } catch (e) { log(`craftGrid close stale window: ${e.message}`); }
    await sleep(200);
  }
  // A 2x2 craft can leave its result on the mouse cursor, and no inventory count sees that stack:
  // the bot starved on "no planks" while physically holding 4 oak_planks on its cursor. Stash it.
  try {
    const cur = bot.inventory.cursor;
    if (cur && cur.name) {
      const free = bot.inventory.firstEmptyInventorySlot();
      if (free >= 0) { await click(bot, free, 0, 0); await sleep(120); }
    }
  } catch {}
  // Sweep any leftovers out of the crafting cells before planning this craft. An aborted craft
  // leaves its inputs sitting in the grid, and those items count toward countItem() but are not
  // visible to the source scan over the inventory slots - that split ("have=4 planks" yet "no
  // birch_planks left in inventory for the stick grid") is what bounced the opening chain.
  {
    const win = tableWin || bot.inventory;
    const gEnd = tableWin ? 9 : 4;
    const lo = tableWin ? 10 : 9, hi = tableWin ? win.slots.length : 45;
    // Slot 0 is included on purpose. A measured dump after craftPlanks:
    //   slots 0:birch_planksx4  9:birch_planksx12  10:birch_planksx4  11:birch_logx2
    // - items() counts the stack parked in the RESULT slot, so countItem() says 16 while the
    // source scan over 9..45 (or 10..) sees 12 usable and, when the whole batch landed there,
    // sees none at all: "stick x4 made=0 (no birch_planks left in inventory)" one line after
    // "pre-step birch_log -> birch_planks: made=12 have=12". Sweeping only cells 1..4 left it.
    for (let s = 0; s <= gEnd; s++) {
      try {
        if (!win.slots[s]) continue;
        const empty = firstEmpty(win, lo, hi, 1, gEnd);
        if (empty < 0) break;
        await click(bot, s, 0, 0);
        await sleep(90);
        await click(bot, empty, 0, 0);
        await sleep(90);
        log(`craftGrid swept leftover ${((win.slots[empty] || {}).name) || 'item'} out of grid cell ${s}`);
      } catch { break; }
    }
  }
  // Every early recipe wants planks and a fresh bot always has logs: turn one into planks here
  // instead of answering "no single item can satisfy p" and bouncing the ladder to the LLM.
  // Top up planks whenever the best single wood species cannot fill a grid cell (a pick wants 3, a
  // table wants 4). The old test was "carries no planks at all", so a pack holding 2 planks and 5
  // logs answered "want 3 of one of any planks; have planks=2" and never chopped the logs it was
  // standing on - which is where the acceptance run sat for 30 straight minutes.
  const bestSpecies = PLANK_NAMES.reduce((m, n) => Math.max(m, P.countItem(bot, n)), 0);
  if (name !== 'planks' && bestSpecies < 4) {
    // `|block` was a lie: nothing ending in _block makes planks, and the alternation matched the
    // bot's souvenir magma_block, so this pre-step burned ~5 s per ensure_tools call on
    // "magma_block -> magma_planks: made=0 have=0" (measured 14:35) instead of chopping real wood.
    const logItem = bot.inventory.items().find(i => /_(log|wood|stem|hyphae)$/.test(i.name));
    if (logItem) {
      const out = logItem.name.replace(/_(log|wood|stem|hyphae)$/, '_planks');
      // Use the plank routine that is proven on this server (it verifies the inventory delta and
      // rescues the result off the mouse cursor); my own shapeless clicker reported "now 0" over
      // and over here, which starved the whole opening chain (no planks -> no table -> no pick).
      let made = 0;
      if (tableWin) {
        // NOT `bot.craft(rows[0], 1, tableWin)`. This mineflayer version's craftOnce() takes the third
        // argument as a BLOCK and calls bot.activateBlock(craftingTable) WITHOUT awaiting it, so handing it
        // a Window (no .position) throws `Cannot read properties of undefined (reading 'offset')` as an
        // unhandled rejection and the craft then waits forever on a windowOpen that never arrives.
        // Measured 18:02:17 and 18:06:23: `pre-step birch_log -> birch_planks: made=0` with the log still
        // in the pack and ensure_tools timing out at 61 s - the first link of the tool chain after a death
        // took the only crafting table, and the reason 158 crafts today delivered nothing.
        // Log -> planks is shapeless, so click it in the window we were handed.
        const b4all = P.countItem(bot, out);
        for (let t = 0; t < 3 && P.countItem(bot, logItem.name) > 0; t++) {
          const b4 = P.countItem(bot, out);
          const r = await craftShapeless(bot, out, tableWin, logItem.name);
          if (P.countItem(bot, out) <= b4) { log(`craftGrid pre-step ${out} stalled: ${String(r.observation).slice(0, 80)}`); break; }
        }
        made = P.countItem(bot, out) - b4all;
      } else made = await P.craftPlanks(bot);
      let have = P.countItem(bot, out);
      if (!have) { const r = await craftShapeless(bot, out, tableWin || null, logItem.name); have = P.countItem(bot, out); log(`craftGrid pre-step shapeless fallback: ${r.observation}`); }
      log(`craftGrid pre-step ${logItem.name} -> ${out}: made=${made} have=${have}`);
    }
  }
  // Sticks are half of every early recipe (pick, sword, arrow, torch, ladder) and nothing topped them
  // up. Measured 02:27:28: cobblestone 20, oak_planks 8, stick 1 -> `stone_pickaxe` failed on
  // `want 2 of one of "stick"` three times in one round, the mine tier guard therefore had no stone
  // pick, and branch_mine spent 180 s digging with a wooden pick that drops no iron. Two planks make
  // four sticks, so the material for the fix was in the pack the whole time.
  {
    const rec = RECIPES[name];
    if (rec && name !== 'stick') {
      for (const [letter, spec] of Object.entries(rec.key)) {
        const wants = countLetter(rec.shape, letter);
        const isStick = spec === 'stick' || (Array.isArray(spec) && spec.includes('stick'));
        if (!isStick || !wants) continue;
        if (P.countItem(bot, 'stick') >= wants) break;
        const r = await P.craft(bot, 'stick', 4);
        log(`craftGrid pre-step stick top-up for ${name}: ${r.ok ? 'ok' : 'failed'} want=${wants} have=${P.countItem(bot, 'stick')} (${String(r.observation).slice(0, 70)})`);
        break;
      }
    }
  }
  // Re-attach to a table if the pre-step killed our window handle. bot.craft(recipe,1,window)
  // closes the window it used, so every click after it landed on a dead window id: the dump said
  // "cells 0:_ 1:_ 2:_ ..." with 48 planks in the pack, while the fallback craft one line later
  // succeeded. Every 3x3 milestone (armour, bow, eyes of ender, and the leggings that took 20
  // minutes to get) depended on this.
  if (tableWin && bot.currentWindow !== tableWin) {
    const again = await walkToTable(bot, log);
    if (again) { tableWin = again; log(`craftGrid re-opened table window for ${name} after the pre-step`); }
    else log(`craftGrid: table window died after the pre-step and no usable table within 64 for ${name}`);
  }
  // Never click a window that is not the open one. Every click then lands nowhere, and the dump is
  // "cells 0:_ 1:_ ... result=empty; cursor=none" - the same signature as a missing ingredient, but
  // the fix is the opposite (measured 05:32:39 diamond_pickaxe, 06:00:29 iron_chestplate). Say what
  // is wrong and hand back, so the caller's `bot.craft` path - which reads the recipe book and does
  // not need this window - gets the round instead of burning it on phantom clicks.
  if (tableWin && bot.currentWindow !== tableWin) {
    return { made: 0, observation: `table window is dead (open=${bot.currentWindow ? bot.currentWindow.type : 'none'}, wanted id ${tableWin.id}) for ${name} - use bot.craft, or re-open a table within 16` };
  }
  // While a 3x3 crafting table window is open on Paper 1.21, server set_slot packets for the
  // player's inventory section land in `tableWin.slots[10..45]` and may NOT mirror into
  // `bot.inventory.items()` until the window closes. Counting only `bot.inventory` made `craftGrid`
  // wait 4 s, report `made=0` while all 9 grid cells had already emptied (live 2026-11-27 06:32:03
  // iron_pickaxe/iron_sword), and caused the caller to fall through and double-craft iron gear.
  const countHeld = (w, loIdx, hiIdx) => {
    let inWin = 0;
    if (w && Array.isArray(w.slots)) {
      for (let i = loIdx; i < Math.min(hiIdx, w.slots.length); i++) {
        if (w.slots[i] && w.slots[i].name === name) inWin += w.slots[i].count;
      }
      if (w.selectedItem && w.selectedItem.name === name) inWin += w.selectedItem.count;
    }
    return Math.max(inWin, P.countItem(bot, name));
  };
  let before = countHeld(tableWin || bot.inventory, tableWin ? 10 : 9, tableWin ? (tableWin.slots || []).length : 45);
  let made = 0;
  for (let n = 0; n < times; n++) {
    const plan = planFor(bot, name);
    if (!plan.ok) { bot._gridCraftWhy = plan.observation; return { made, observation: plan.observation }; }
    if (plan.size === 3 && !tableWin) {
      // A 3x3 recipe needs a PLACED table, and the bot routinely carries one it never puts down -
      // the grid then answered "cells 0:_ 1:_ 2:_ ..." for wooden_pickaxe while the pack held a
      // crafting_table. Place the one we have, open it, and keep going rather than bounce the
      // ladder: obsidian, bow, armour and eyes of ender are all 3x3.
      // A 3x3 recipe needs a PLACED table, and the bot may be carrying one or be able to make one:
      // 4 planks in the 2x2 is a table, which needs nothing but the planks it always has. Without
      // this it sat at 18 iron ingots and 8 planks and could not craft a chestplate at all, because
      // the only table it ever placed was back at an old camp and its pack had no spare -
      // "iron_chestplate needs a 3x3 table (carried table could not be placed)" over and over.
      let held = bot.inventory.items().find(i => i.name === 'crafting_table');
      if (!held) {
        const c = await P.craft(bot, 'crafting_table', 1);
        log(`craftGrid: no table carried, crafted one from planks: ${c.ok ? 'ok' : 'failed'} (${c.observation})`);
        held = bot.inventory.items().find(i => i.name === 'crafting_table');
      }
      if (held) { try { await bot.equip(held, 'hand'); await P.placeAtFreeNeighbor(bot); } catch {} }
      // `bot.registry` is there on a live client but not on every harness, and an unguarded read took the
      // whole craft down with it (the 3x3 branch is exactly where a carried-bench attempt lands).
      const ct = (bot.registry && bot.registry.blocksByName && bot.registry.blocksByName.crafting_table)
        || (require('minecraft-data')(bot.version || '1.21.1').blocksByName || {}).crafting_table;
      const near = ct ? bot.findBlock({ matching: ct.id, maxDistance: 8 }) : null;
      if (near) {
        const w2 = await openTable(bot, near);
        if (w2) { tableWin = w2; log(`craftGrid placed+opened a table for the 3x3 ${name}`); }
      }
    }
    if (plan.size === 3 && !tableWin) { bot._gridCraftWhy = `${name} needs a 3x3 table`; return { made, observation: `${name} needs a 3x3 table (carried table could not be placed)` }; }
    const win = tableWin || bot.inventory;
    const lo = tableWin ? 10 : 9, hi = tableWin ? win.slots.length : 45;
    const gridEnd = tableWin ? 9 : 4;
    if (n === 0) before = countHeld(win, lo, hi);
    let fail = null;
    for (const cell of plan.cells) {
      const gs = gridSlot(win, plan.size, cell.x, cell.y);
      const src = findSource(win, cell.item, lo, hi, null);
      if (src < 0) {
        // Say what was scanned and where the item actually lives, in both windows. This failure
        // ("no iron_ingot left in inventory" with 8 ingots in the pack) has been argued about three
        // times tonight by reading code; one line of real geometry ends it.
        const where = (w) => w.slots.map((s, i) => (s && s.name === cell.item ? i + 'x' + s.count : null)).filter(Boolean).join(',') || 'none';
        fail = `no ${cell.item} left in inventory for the ${name} grid [scanned ${lo}..${hi} of ${win.slots.length}${win === bot.inventory ? ' inventory' : ' table'}; in-window ${where(win)}; in-inventory ${where(bot.inventory)}]`;
        break;
      }
      // pick up the stack
      try { await click(bot, src, 0, 0); } catch (e) { fail = 'pick up ' + cell.item + ': ' + e.message; break; }
      await sleep(90);
      // drop exactly one into the grid cell (right-click with a held stack places a single item)
      try { await click(bot, gs, 1, 0); } catch (e) { fail = 'place ' + cell.item + ': ' + e.message; break; }
      await sleep(90);
      const held = win.selectedItem;
      if (held) {
        // Put the cursor remainder straight back where it came from before touching the next cell.
        // Leaving a stack on the cursor makes the following left-click a *swap* instead of a
        // pick-up: the "stick" craft on the acceptance run consumed 9 birch planks this way and
        // produced nothing, because only one of its two cells ever held a plank.
        try { await click(bot, src, 0, 0); } catch {}
        await sleep(80);
      }
    }
    // Stow the cursor remainder FIRST: clearing a cell is a left-click, and a loaded cursor would
    // turn that into a swap that drops the item into the grid instead of taking it out.
    try {
      if (win.selectedItem) {
        const empty = firstEmpty(win, lo, hi, 1, gridEnd);
        if (empty > 0) await click(bot, empty, 0, 0);
        else await click(bot, 1, 0, 0); // worst case: swap into a grid cell and clean after
      }
    } catch (e) { fail = 'stow cursor: ' + e.message; }
    // A foreign item in any cell this recipe does not use makes the pattern not match, and the server
    // then answers with an empty result slot and no error. Measured 01:19:20: a stone_pickaxe laid out
    // perfectly (ccc / .s. / .s.) with `8:dirtx2` parked there by a craft the 180s step timeout had
    // abandoned, and craftGrid could only report "nothing appeared" - which the ladder read as a
    // missing-ingredient problem and bounced for three rounds. Clear what does not belong before
    // asking for the result, and name it if the clear cannot be done.
    {
      const wanted = new Set(plan.cells.map(c => gridSlot(win, plan.size, c.x, c.y)));
      for (let s = 1; s <= gridEnd; s++) {
        if (wanted.has(s) || !win.slots[s]) continue;
        const foreignName = win.slots[s].name;
        const empty = firstEmpty(win, lo, hi, 1, gridEnd);
        if (empty < 0) { fail = `foreign ${foreignName} stuck in unused grid cell ${s}, no free slot to stow it`; break; }
        await click(bot, s, 0, 0); await sleep(90);
        await click(bot, empty, 0, 0); await sleep(90);
        log(`craftGrid cleared foreign ${foreignName} out of unused cell ${s} for ${name}`);
      }
    }
    // shift-click the result: crafts and moves it into the inventory in one packet
    try { await click(bot, 0, 0, 1); } catch (e) { log(`grid craft click result: ${e.message}`); }
    // Poll both the open crafting table window slots (10..45) and bot.inventory so 1.21 table
    // window set_slot updates are detected immediately without waiting 4s or double-crafting.
    for (let w = 0; w < 28 && countHeld(win, lo, hi) <= before + made * RECIPES[name].out; w++) await sleep(140);
    const now = countHeld(win, lo, hi);
    if (now > before + made * RECIPES[name].out) { made = Math.floor((now - before) / RECIPES[name].out); continue; }
    // Dump what actually landed in the cells. "grid clicks sent but nothing appeared" has two very
    // different causes (a mis-shaped grid vs a result click the server never answers), and only
    // knowing which one it is tells us whether to fix placement or the result click.
    const cells = win.slots.slice(1, gridEnd + 1).map((s, i) => `${i}${s ? ':' + s.name.split('_')[0] + 'x' + s.count : ':_'}`).join(' ');
    // The ingredients are still IN the grid when we get here, and an abandoned window is where paid-for
    // material goes to die. Measured 21:39:37 -> 21:40:56: the pack went `diamonds=4 -> 1 -> 0` across
    // two failed diamond_pickaxe attempts, and the second attempt reported `no diamond left in inventory
    // ... in-window 1x4` - four diamonds sitting in the table's cells, invisible to every count the
    // milestone makes, so the ladder concluded it had to mine more diamonds. Pull each non-empty cell
    // back with a shift-click before handing the failure up, and say honestly what is still stranded
    // (a full pack cannot receive anything - `free=0` in the same window).
    const swept = [];
    for (let i = 1; i <= gridEnd; i++) {
      const it = win.slots[i];
      if (!it) continue;
      swept.push(`${it.name}x${it.count}`);
      try { await click(bot, i, 0, 1); await sleep(140); } catch (e) { log(`grid sweep ${it.name}: ${e.message}`); }
    }
    const still = win.slots.slice(1, gridEnd + 1).filter(Boolean).map(s => `${s.name}x${s.count}`);
    if (swept.length) log(`GRID SWEEP: withdrew [${swept.join(', ')}] from the ${name} grid${still.length ? ` - STILL STRANDED [${still.join(', ')}], the pack has no room for them` : ''}`);
    return { made, observation: (fail || `grid clicks sent for ${name} but nothing appeared [cells ${cells}; result=${(win.slots[0] || {}).name || 'empty'}; cursor=${(win.selectedItem || {}).name || 'none'}; ${plan.size}x${plan.size} in ${win === bot.inventory ? 'inventory' : 'table'}]`)
      + (swept.length ? ` [grid was holding ${swept.join(', ')}; ${still.length ? `STILL STRANDED: ${still.join(', ')} - they are in the crafting table, not missing, empty a few slots and craft again` : 'returned to the pack'}]`
        : (still.length ? ` [STILL IN THE GRID: ${still.join(', ')} - the pack is full, so nothing can be crafted until slots are freed]` : '')) };
  }
  return { made, observation: `made ${made} of ${name}` };
}

function log(msg) { try { require('./log').skill(msg); } catch { console.log(msg); } }

// Convenience for the caller: is this item even in our table?
const knows = name => !!RECIPES[name];
// Usable in the player's own 2x2 grid (no crafting table needed).
const fits2x2 = name => {
  const r = RECIPES[name];
  if (!r) return false;
  return r.two === true || (r.shape.length <= 2 && Math.max(...r.shape.map(s => s.length)) <= 2);
};

// blaze_rod -> blaze_powder is shapeless and single-ingredient; handle it explicitly.
async function craftShapeless(bot, name, tableWin, sourceName) {
  const win = tableWin || bot.inventory;
  const lo = tableWin ? 10 : 9, hi = tableWin ? win.slots.length : 45;
  const src = findSource(win, sourceName || (name === 'blaze_powder' ? 'blaze_rod' : name), lo, hi, new Set());
  if (src < 0) return { made: 0, observation: `no source item for ${name}` };
  const cell = 1;
  try { await click(bot, src, 0, 0); await sleep(90); await click(bot, cell, 1, 0); await sleep(90); } catch (e) { return { made: 0, observation: 'shapeless clicks: ' + e.message }; }
  try { if (win.selectedItem) { const e2 = firstEmpty(win, lo, hi, 1, tableWin ? 9 : 4); if (e2 > 0) await click(bot, e2, 0, 0); } } catch {}
  try { await click(bot, 0, 0, 1); } catch {}
  const key = name === 'blaze_powder' ? 'blaze_powder' : name;
  await sleep(600);
  return { made: P.countItem(bot, key), observation: `shapeless ${key}: now ${P.countItem(bot, key)}` };
}

// Open a placed crafting table and return its window (0=result, 1-9=grid, 10+=inventory).
async function openTable(bot, tableBlock) {
  if (!tableBlock) return null;
  try {
    const opened = new Promise(resolve => { bot.once('windowOpen', w => resolve(w)); setTimeout(() => resolve(null), 6000); });
    await bot.activateBlock(tableBlock);
    const win = await opened;
    if (!win || !String(win.type).startsWith('minecraft:crafting')) { try { if (win) bot.closeWindow(win); } catch {} return null; }
    return win;
  } catch { return null; }
}

// A crafting table the bot PLACED an hour ago is the only route to any 3x3 recipe - diamond pickaxe,
// armour, eyes of ender. The re-attach looked 16 blocks out and gave up, so at 09:47 on 2026-10-30,
// with the first diamond already in the pack and `diamond_pick` needing three more plus a grid,
// `table window died after the pre-step and no table within 16` answered twice in one minute.
// Walking 64 blocks costs ~20 s; a locked 3x3 milestone costs the 25-minute budget. Fail-open: no
// table found, or an unroutable walk, returns null and the caller hands back to the recipe-book path.
async function walkToTable (bot, log) {
  const ct = bot.registry && bot.registry.blocksByName && bot.registry.blocksByName.crafting_table;
  if (!ct) return null;
  for (const r of [16, 64]) {
    let tbl = null;
    try { tbl = bot.findBlock({ matching: ct.id, maxDistance: r }); } catch { tbl = null; }
    if (!tbl) continue;
    if (r > 16) {
      const GN = (require('mineflayer-pathfinder').goals || require('mineflayer-pathfinder').pathfinder.Goals).GoalNear;
      try { await bot.pathfinder.goto(new GN(tbl.position.x, tbl.position.y, tbl.position.z, 1)); }
      catch (e) {
        log(`craftGrid: the table at ${tbl.position.x},${tbl.position.y},${tbl.position.z} is not walkable (${String(e.message).slice(0, 40)}) - handing back instead of clicking a dead window`);
        return null;
      }
      log(`craftGrid: walked out to the placed table at ${tbl.position.x},${tbl.position.y},${tbl.position.z} (search radius ${r})`);
    }
    const w = await openTable(bot, tbl);
    if (w) return w;
  }
  return null;
}

module.exports = { RECIPES, craftGrid, craftShapeless, planFor, openTable, knows, fits2x2, repairGear, PLANK_NAMES, LOG_TO_PLANK, walkToTable };
