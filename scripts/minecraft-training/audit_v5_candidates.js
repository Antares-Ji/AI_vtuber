'use strict';

// CPU-only semantic/contract preflight for v5 candidate files. Never reads holdout.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mcData = require('minecraft-data')('1.21.11');
const { decisionMessages, compactObservation } = require('../../src/minecraft/survival-planner');
const { validateAction, CRAFT_ITEMS, FOODS } = require('../../src/minecraft/survival-skills');

const ROOT = path.resolve(__dirname, '../..');
const DATA = path.join(ROOT, 'data/minecraft-training');
const OUT = path.join(ROOT, 'output/minecraft-training');
const errors = [];
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const readRows = name => fs.readFileSync(path.join(DATA, name), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const count = (row, names) => (row.state.inventory || []).filter(i => names.includes(i.name)).reduce((sum, i) => sum + i.count, 0);
const pickTier = row => {
  const tiers = ['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'];
  const inv = row.state.inventory || [];
  return Math.max(-1, ...tiers.map((name, index) => inv.some(i => i.name === name && i.count > 0) ? index : -1));
};
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

const train = readRows('train-v5-candidates.jsonl');
const dev = readRows('development-v5-candidates.jsonl');
const replay = readRows('train-v5-replay-candidates.jsonl');
const originalBytes = fs.readFileSync(path.join(DATA, 'train-v4r1-replay-candidates.jsonl'));
const replayBytes = fs.readFileSync(path.join(DATA, 'train-v5-replay-candidates.jsonl'));
const manifest = JSON.parse(fs.readFileSync(path.join(DATA, 'manifest-v5-candidates.json'), 'utf8'));
const originalRows = readRows('train-v4r1-replay-candidates.jsonl');

for (const [setName, rows, devSet] of [['train', train, false], ['dev', dev, true]]) {
  for (const row of rows) {
    try { validateAction(row.action); } catch (e) { errors.push(`${row.id}: schema ${e.message}`); }
    if (row.provenance !== manifest.provenance) errors.push(`${row.id}: provenance mismatch`);
    if (!Array.isArray(row.labelBasis) || !row.labelBasis.length) errors.push(`${row.id}: labelBasis missing`);
    if (row.messages.length !== 3 || row.messages[0].role !== 'system' || row.messages[1].role !== 'user' || row.messages[2].role !== 'assistant') errors.push(`${row.id}: message shape mismatch`);
    if (row.messages[2].content !== JSON.stringify(row.action)) errors.push(`${row.id}: assistant/action mismatch`);
    let user;
    try { user = JSON.parse(row.messages[1].content); } catch { errors.push(`${row.id}: malformed user JSON`); continue; }
    if (!same(user.state, compactObservation(row.state))) errors.push(`${row.id}: prompt state differs from runtime compactObservation`);
    if ((user.recentResults || []).length !== 6) errors.push(`${row.id}: expected exactly six recent results`);
    if (devSet && !row.expectedActionSet) errors.push(`${row.id}: dev expected action set missing`);
    if (row.state.food === 20 && row.action.action === 'eat') errors.push(`${row.id}: full-food no-op label`);
    if (row.action.action === 'eat') {
      if (!(row.state.food < 20)) errors.push(`${row.id}: eat label is not low-food`);
      if (!row.state.inventory.some(i => FOODS.includes(i.name) && i.count > 0)) errors.push(`${row.id}: eat label has no safe edible item`);
    }
    if (row.action.action === 'gather_wood' && !(row.state.resources.wood || []).length) errors.push(`${row.id}: gather_wood without observed wood`);
    if (row.action.action === 'mine') {
      const tier = pickTier(row);
      const required = { stone: 0, coal: 0, gravel: -1, iron: 1, diamond: 2, obsidian: 3 }[row.action.resource];
      if (tier < required) errors.push(`${row.id}: ${row.action.resource} mining lacks required pickaxe tier ${required}`);
      if (!(row.state.resources[row.action.resource] || []).length) errors.push(`${row.id}: mining target absent from observation`);
    }
    if (row.action.action === 'craft') {
      const item = row.action.item, n = Object.fromEntries((row.state.inventory || []).map(i => [i.name, i.count]));
      const planks = count(row, CRAFT_ITEMS.filter(x => x === 'planks').length ? row.state.inventory.filter(i => /_planks$/.test(i.name)).map(i => i.name) : []);
      const logs = row.state.inventory.filter(i => /_log$/.test(i.name)).reduce((a, i) => a + i.count, 0);
      const haveTable = (n.crafting_table || 0) > 0 || row.state.stations.some(s => s.name === 'crafting_table');
      const table = (n.crafting_table || 0) > 0;
      if (item === 'planks' && logs * 4 < row.action.count) errors.push(`${row.id}: planks action exceeds available logs`);
      if (item === 'crafting_table' && (planks < 4 || table || row.state.stations.some(s => s.name === 'crafting_table'))) errors.push(`${row.id}: crafting_table prerequisites inconsistent`);
      if (item === 'wooden_pickaxe' && (!haveTable || planks < 3 || (n.stick || 0) < 2)) errors.push(`${row.id}: wooden_pickaxe prerequisites inconsistent`);
      if (item === 'stone_pickaxe' && (!haveTable || ((n.cobblestone || 0) + (n.cobbled_deepslate || 0) < 3) || (n.stick || 0) < 2)) errors.push(`${row.id}: stone_pickaxe prerequisites inconsistent`);
      if (item === 'iron_pickaxe' && (!haveTable || (n.iron_ingot || 0) < 3 || (n.stick || 0) < 2)) errors.push(`${row.id}: iron_pickaxe prerequisites inconsistent`);
    }
    if (row.action.action === 'smelt') {
      const input = row.action.item, fuel = (row.state.inventory || []).some(i => ['coal', 'charcoal'].includes(i.name) && i.count > 0);
      if (!row.state.inventory.some(i => i.name === input && i.count >= row.action.count)) errors.push(`${row.id}: smelt input insufficient`);
      if (!fuel || !row.state.inventory.some(i => i.name === 'furnace') && !row.state.stations.some(s => s.name === 'furnace')) errors.push(`${row.id}: smelt fuel/furnace missing`);
    }
    for (const hint of row.state.recipeHints || []) {
      if (!CRAFT_ITEMS.includes(hint.item)) errors.push(`${row.id}: invalid recipeHint action item ${hint.item}`);
      if (row.state.craftable.some(c => c.item === hint.item)) errors.push(`${row.id}: recipeHint item ${hint.item} is also marked craftable`);
      for (const m of hint.missing || []) {
        if (/planks$/.test(m.name)) {
          const familyCount = row.state.inventory.filter(i => /_planks$/.test(i.name)).reduce((a, i) => a + i.count, 0);
          if (familyCount >= m.count) errors.push(`${row.id}: recipeHint claims missing ${m.name} while plank-family stock suffices`);
        }
      }
    }
    for (const station of row.state.stations || []) for (const axis of ['x', 'y', 'z']) if (!Number.isInteger(station.position[axis])) errors.push(`${row.id}: non-integer station position`);
    for (const [kind, blocks] of Object.entries(row.state.resources || {})) for (const b of blocks || []) {
      const d = Math.round(Math.hypot(row.state.position.x - b.position.x, row.state.position.y - b.position.y, row.state.position.z - b.position.z) * 10) / 10;
      if (b.distance !== d || d > 40) errors.push(`${row.id}: ${kind} geometry/distance invalid`);
    }
    const tool = row.state.tools?.[0];
    if (tool && tool.maxDurability !== mcData.itemsByName[tool.name]?.maxDurability) errors.push(`${row.id}: tool durability does not match registry`);
  }
}

if (train.length !== 32 || dev.length !== 12 || replay.length !== 214) errors.push(`row counts wrong: ${train.length}/${dev.length}/${replay.length}`);
if (!replayBytes.subarray(0, originalBytes.length).equals(originalBytes)) errors.push('frozen 182-row replay byte prefix changed');
const promptKey = row => row.messages[1].content;
const keys = rows => new Set(rows.map(promptKey));
const overlap = (a, b) => [...keys(a)].filter(k => keys(b).has(k)).length;
const overlaps = { trainDev: overlap(train, dev), trainOldReplay: overlap(train, originalRows), devOldReplay: overlap(dev, originalRows) };
if (Object.values(overlaps).some(Boolean)) errors.push(`prompt overlap found ${JSON.stringify(overlaps)}`);
const hashes = {
  training: sha(fs.readFileSync(path.join(DATA, 'train-v5-candidates.jsonl'))),
  development: sha(fs.readFileSync(path.join(DATA, 'development-v5-candidates.jsonl'))),
  replay: sha(replayBytes),
  replayOriginalPrefixSha256: sha(replayBytes.subarray(0, originalBytes.length))
};
if (hashes.training !== manifest.trainingSha256 || hashes.development !== manifest.developmentSha256 || hashes.replay !== manifest.replaySha256) errors.push('manifest hash mismatch');

const report = { status: errors.length ? 'failed' : 'passed', trainingRows: train.length, developmentRows: dev.length, replayRows: replay.length, originalReplayPrefixByteIdentical: replayBytes.subarray(0, originalBytes.length).equals(originalBytes), overlaps, hashes, checked: { actionSchema: true, runtimeCompaction: true, sixRecentResults: true, foodLabels: true, miningTiersAndTargets: true, craftPrerequisites: true, smeltPrerequisites: true, recipeHintConsistency: true, geometry: true, registryDurability: true }, errors };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'v5-candidate-semantic-preflight.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
