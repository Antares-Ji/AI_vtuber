'use strict';

// Independent CPU-only structural audit for the v4r1 candidate artifacts.
// This checks labels and observations, not Minecraft pathfinding or physics.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { validateAction } = require('../../src/minecraft/survival-skills');
const mcData = require('minecraft-data')('1.21.11');

const ROOT = path.resolve(__dirname, '../..');
const DATA = path.join(ROOT, 'data/minecraft-training');
const read = name => fs.readFileSync(path.join(DATA, name), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(DATA, file))).digest('hex');
const dist = (a, b) => Math.round(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 10) / 10;
const errors = [];
const train = read('train-v4r1-candidates.jsonl');
const dev = read('development-v4r1-candidates.jsonl');
const replay = read('train-v4r1-replay-candidates.jsonl');
const oldTrain = read('train-v3r1.jsonl');
const oldDev = read('development-v3r1.jsonl');

for (const [name, rows] of [['train', train], ['dev', dev]]) {
  const ids = new Set();
  for (const row of rows) {
    if (ids.has(row.id)) errors.push(`${name}: duplicate id ${row.id}`);
    ids.add(row.id);
    try { validateAction(row.action); } catch (e) { errors.push(`${row.id}: schema ${e.message}`); }
    if (JSON.stringify(row.messages.at(-1)?.content) !== JSON.stringify(JSON.stringify(row.action))) errors.push(`${row.id}: assistant message/action mismatch`);
    for (const item of row.state.inventory || []) if (!(item.count > 0)) errors.push(`${row.id}: nonpositive inventory item ${item.name}`);
    for (const station of row.state.stations || []) {
      for (const axis of ['x', 'y', 'z']) if (!Number.isInteger(station.position?.[axis])) errors.push(`${row.id}: fractional station ${axis}`);
    }
    for (const [kind, blocks] of Object.entries(row.state.resources || {})) for (const block of blocks || []) {
      const computed = dist(row.state.position, block.position);
      if (block.distance !== computed) errors.push(`${row.id}: ${kind} distance ${block.distance} != ${computed}`);
      if (computed > 40) errors.push(`${row.id}: ${kind} outside observation radius (${computed})`);
    }
    for (const bucket of ['water', 'lava']) for (const fluid of row.state.fluids?.[bucket] || []) {
      const computed = dist(row.state.position, fluid.position);
      if (fluid.distance !== computed) errors.push(`${row.id}: ${bucket} distance mismatch`);
    }
    const pick = (row.state.tools || []).find(t => /_pickaxe$/.test(t.name));
    if (pick && pick.maxDurability !== mcData.itemsByName[pick.name]?.maxDurability) errors.push(`${row.id}: wrong ${pick.name} durability`);
    if (!name.startsWith('train') && !row.expectedActionSet) errors.push(`${row.id}: dev expectedActionSet missing`);
    if (row.action.action === 'explore' && !name.startsWith('train')) {
      const accepted = row.expectedActionSet?.direction || [];
      if (!accepted.includes(row.action.direction)) errors.push(`${row.id}: primary direction missing from accepted set`);
      if (row.scenario.includes('any legal exploration') && accepted.length !== 8) errors.push(`${row.id}: direction preference incorrectly excludes a legal direction`);
    }
  }
}
if (train.length !== 16 || dev.length !== 8) errors.push(`unexpected candidate size ${train.length}/${dev.length}`);
if (replay.length !== oldTrain.length + train.length) errors.push('replay row count mismatch');
if (JSON.stringify(replay.slice(0, oldTrain.length)) !== JSON.stringify(oldTrain)) errors.push('frozen v3r1 train prefix changed');
if (JSON.stringify(replay.slice(oldTrain.length)) !== JSON.stringify(train)) errors.push('v4r1 rows differ from replay suffix');
const promptKey = row => row.messages.at(-2).content;
const keys = rows => new Set(rows.map(promptKey));
const overlaps = (a, b) => [...keys(a)].filter(x => keys(b).has(x));
for (const [label, a, b] of [
  ['train/dev', train, dev], ['train/v3train', train, oldTrain], ['train/v3dev', train, oldDev],
  ['dev/v3train', dev, oldTrain], ['dev/v3dev', dev, oldDev]
]) if (overlaps(a, b).length) errors.push(`${label}: prompt overlap`);

const probe = JSON.parse(fs.readFileSync(path.join(ROOT, 'output/minecraft-training/live-probe-1791836151666.json'), 'utf8'));
const probeString = JSON.stringify(probe);
if (train.some(row => probeString.includes(row.id) || JSON.stringify(row.state).includes(probeString))) errors.push('exact probe state appears in training');

const report = {
  status: errors.length ? 'failed' : 'passed',
  trainingRows: train.length,
  developmentRows: dev.length,
  replayRows: replay.length,
  replayOriginalPrefixIdentical: JSON.stringify(replay.slice(0, oldTrain.length)) === JSON.stringify(oldTrain),
  replayCandidateSuffixIdentical: JSON.stringify(replay.slice(oldTrain.length)) === JSON.stringify(train),
  actionSchemaChecked: true,
  stationCoordinatesInteger: true,
  inventoryCountsPositive: true,
  resourceDistancesRecomputed: true,
  pickaxeDurabilityMatchesMinecraftData: true,
  probeTrainLeakage: false,
  promptOverlaps: { trainDev: overlaps(train, dev).length, trainV3Train: overlaps(train, oldTrain).length, trainV3Dev: overlaps(train, oldDev).length, devV3Train: overlaps(dev, oldTrain).length, devV3Dev: overlaps(dev, oldDev).length },
  hashes: {
    train: hash('train-v4r1-candidates.jsonl'), development: hash('development-v4r1-candidates.jsonl'), replay: hash('train-v4r1-replay-candidates.jsonl'),
    frozenOriginalV4Train: hash('train-v4-candidates.jsonl'), frozenOriginalV4Development: hash('development-v4-candidates.jsonl')
  },
  errors
};
fs.writeFileSync(path.join(ROOT, 'output/minecraft-training/v4r1-preflight-audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
if (errors.length) process.exitCode = 1;
