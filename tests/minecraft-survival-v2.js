'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(registry);
const { executeSkill, staircasePlan, coolingSite, craftingOptions, toolStatus, validateAction, isSkillBusy } = require('../src/minecraft/survival-skills');
const { decisionMessages } = require('../src/minecraft/survival-planner');
function fakeBot() {
  const bot = new EventEmitter(), overrides = new Map(), items = [];
  Object.assign(bot, { registry, game: { gameMode: 'survival', dimension: 'overworld' }, health: 20, food: 20,
    entity: { position: new Vec3(0.5, 64, 0.5), equipment: [] }, entities: {}, inventory: { items: () => items }, _items: items,
    heldItem: null, findBlocks: () => [], blockAt(p) { const name = overrides.get(p.toString()) || (p.y < 64 ? 'stone' : 'air'); if (name === 'unknown') return null; const b = Block.fromStateId(registry.blocksByName[name].minStateId, 0); b.position = p; return b; },
    setBlock(p, name) { overrides.set(p.toString(), name); },
    pathfinder: { setMovements() {}, setGoal() {}, goto: async goal => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); } },
    clearControlStates() {}, stopDigging() {}, deactivateItem() {}, canDigBlock: () => true,
    equip: async item => { bot.heldItem = item; }, lookAt: async () => {}, dig: async block => { bot.setBlock(block.position, 'air'); },
    add(name, count = 1) { items.push({ name, count, type: registry.itemsByName[name].id }); }
  });
  return bot;
}
(async () => {
  assert.deepEqual(validateAction({ action: 'dig_staircase', direction: 'east', steps: 8 }), { action: 'dig_staircase', direction: 'east', steps: 8 });
  assert.throws(() => validateAction({ action: 'dig_staircase', direction: 'northeast', steps: 8 }));
  assert.throws(() => validateAction({ action: 'dig_staircase', direction: 'east', steps: 9 }));
  const bot = fakeBot(); bot.add('wooden_pickaxe');
  const plan = staircasePlan(bot, 'east'); assert.equal(plan.target.y, 63); assert.equal(plan.target.x, 1);
  assert(plan.blocks.every(b => b.position.x !== Math.floor(bot.entity.position.x)), 'every excavation is ahead, never under current feet');
  const stairs = await executeSkill(bot, { action: 'dig_staircase', direction: 'east', steps: 2 });
  assert.equal(stairs.descended, 2); assert.equal(stairs.verticalDrop, 2); assert.equal(bot.entity.position.y, 62);
  const flooded = fakeBot(); flooded.setBlock(new Vec3(2, 63, 0), 'water'); assert.throws(() => staircasePlan(flooded, 'east'), /adjacent fluid/);
  const falling = fakeBot(); falling.setBlock(new Vec3(1, 66, 0), 'sand'); assert.throws(() => staircasePlan(falling, 'east'), /falling block/);
  const unsupported = fakeBot(); unsupported.setBlock(new Vec3(1, 62, 0), 'air'); assert.throws(() => staircasePlan(unsupported, 'east'), /support/);
  const unknown = fakeBot(); unknown.setBlock(new Vec3(2, 63, 0), 'unknown'); assert.throws(() => staircasePlan(unknown, 'east'), /unloaded/);
  const deep = fakeBot(); deep.entity.position.y = 49; deep.add('stone_pickaxe'); await assert.rejects(executeSkill(deep, { action: 'dig_staircase', direction: 'east', steps: 2 }), /torches/);
  const hungry = fakeBot(); hungry.add('stone_pickaxe'); hungry.food = 9; await assert.rejects(executeSkill(hungry, { action: 'dig_staircase', direction: 'east', steps: 1 }), /food >= 10/);
  const interrupted = fakeBot(); interrupted.add('stone_pickaxe'); let release;
  interrupted.dig = () => new Promise(resolve => { release = resolve; }); const cancel = new AbortController();
  const pending = executeSkill(interrupted, { action: 'dig_staircase', direction: 'east', steps: 2 }, { signal: cancel.signal });
  await new Promise(resolve => setTimeout(resolve, 5)); cancel.abort(new Error('cancel excavation')); await assert.rejects(pending, /cancel excavation/);
  assert.equal(isSkillBusy(interrupted), true, 'pending native dig retains lock after cancellation'); release(); await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(isSkillBusy(interrupted), false); assert.equal(interrupted.entity.position.y, 64, 'late dig does not trigger a descent');
  const water = fakeBot(); water.add('bucket'); water.setBlock(new Vec3(0, 63, 0), 'water'); water.findBlocks = ({ matching }) => matching.includes(registry.blocksByName.water.id) ? [new Vec3(0, 63, 0)] : [];
  water.activateItem = () => { water._items[0] = { name: 'water_bucket', count: 1, type: registry.itemsByName.water_bucket.id }; };
  assert.equal((await executeSkill(water, { action: 'collect_water' })).gained, 1);
  const lava = fakeBot(); lava.add('water_bucket'); lava.setBlock(new Vec3(0, 63, 0), 'lava'); lava.findBlocks = ({ matching }) => matching.includes(registry.blocksByName.lava.id) ? [new Vec3(0, 63, 0)] : [];
  const site = coolingSite(lava); assert(site); assert(site.stand.distanceTo(site.lava) >= 3);
  let used = 0;
  lava.activateItem = () => {
    if (used++ === 0) { lava._items[0] = { name: 'bucket', count: 1, type: registry.itemsByName.bucket.id }; lava.setBlock(site.water, 'water'); lava.setBlock(site.lava, 'obsidian'); }
    else { lava._items[0] = { name: 'water_bucket', count: 1, type: registry.itemsByName.water_bucket.id }; lava.setBlock(site.water, 'air'); }
  };
  const cooled = await executeSkill(lava, { action: 'place_water' }); assert.equal(cooled.obsidianWorldVerified, true); assert.equal(cooled.waterRecovered, true); assert.equal(used, 2);
  lava.game.dimension = 'the_nether'; await assert.rejects(executeSkill(lava, { action: 'place_water' }), /evaporates/);
  const noMaterials = fakeBot(); noMaterials.add('crafting_table'); noMaterials.recipesFor = () => [];
  let placements = 0; noMaterials.placeBlock = async () => { placements++; };
  await assert.rejects(executeSkill(noMaterials, { action: 'craft', item: 'stick', count: 4 }), /Missing ingredients/); assert.equal(placements, 0);
  const message = JSON.parse(decisionMessages({}, { history: [{ action: { action: 'craft' }, result: { gained: 4, inventoryBefore: Array(50).fill({ name: 'large', count: 64 }) } }] })[1].content);
  assert.equal(message.recentResults[0].result.gained, 4); assert(!('inventoryBefore' in message.recentResults[0].result));
  assert.deepEqual(craftingOptions(fakeBot()), { craftable: [], recipeHints: [] });
  assert.deepEqual(toolStatus({ name: 'stone_pickaxe', durabilityUsed: 31, maxDurability: 131 }), { name: 'stone_pickaxe', durabilityUsed: 31, maxDurability: 131, remaining: 100, durabilityStatus: 'known' });
  assert.equal(toolStatus({ name: 'stone_pickaxe' }).durabilityStatus, 'unknown'); assert.equal(toolStatus({ name: 'stone_pickaxe' }).remaining, null);
  console.log('Survival v2 simulated checks passed: stair geometry/descent, no digging under feet, liquids/gravity/unloaded/support guards, torch/food prerequisites, cancellation native lock, bucket/obsidian verification, Nether refusal, preflight crafting and compact history. Water and staircase still require live validation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
