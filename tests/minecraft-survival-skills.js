'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(registry);
const { observe, executeSkill, validateAction, SURVIVAL_ACTION_SCHEMA, setSafeMovements, validDig, portalLayout } = require('../src/minecraft/survival-skills');
const { compactObservation } = require('../src/minecraft/survival-planner');

function fakeBot() {
  const bot = new EventEmitter();
  const items = [];
  Object.assign(bot, { registry, game: { gameMode: 'survival', dimension: 'overworld' }, health: 20, food: 12, oxygenLevel: 20, time: { timeOfDay: 6000 },
    entity: { position: new Vec3(0, 64, 0), equipment: [] }, entities: {}, inventory: { items: () => items }, _items: items,
    heldItem: null, findBlocks: () => [], blockAt(p) { const b = Block.fromStateId(registry.blocksByName[p.y < 64 ? 'stone' : 'air'].minStateId, 0); b.position = p; return b; },
    pathfinder: { setMovements(m) { bot._movements = m; }, setGoal() { bot._stops = (bot._stops || 0) + 1; }, goto: async () => {} },
    clearControlStates() {}, stopDigging() {}, deactivateItem() {}, canDigBlock: () => true,
    equip: async item => { bot.heldItem = item; }, consume: async () => { items[0].count--; bot.food = 18; }
  });
  return bot;
}
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
(async () => {
  assert.equal(SURVIVAL_ACTION_SCHEMA.oneOf.length, 16);
  for (const action of [{ action: 'observe' }, { action: 'mine', resource: 'iron', count: 3 }, { action: 'explore', direction: 'northwest', distance: 48 }, { action: 'craft', item: 'diamond_pickaxe', count: 1 }]) assert.deepEqual(validateAction(action), action);
  for (const action of [null, [], { action: 'give' }, { action: 'eat', command: '/give @s diamond' }, { action: 'explore', direction: 'north', distance: 999 }, { action: 'mine', resource: 'diamond', count: 1.5 }, { action: 'craft', item: '__proto__', count: 1 }, { action: 'mine', resource: 'iron' }]) assert.throws(() => validateAction(action));
  const rejected = { action: 'craft', item: 'cherry_planks', count: 4 };
  assert.throws(() => validateAction(rejected), error => error.message.includes('"cherry_planks"') && error.message.includes('Allowed: planks,stick,crafting_table') && error.message.length <= 240);
  assert.equal(rejected.item, 'cherry_planks', 'feedback never normalizes or changes the rejected action');
  assert.throws(() => validateAction({ action: 'craft', item: 'x'.repeat(10000), count: 1 }), error => error.message.length <= 240 && error.message.includes('Allowed: planks'));
  assert.throws(() => validateAction({ action: 'explore', direction: 'north', distance: 999 }), /distance=999; integer range 8\.\.48/);
  const bot = fakeBot();
  const rabbit = fakeBot(); rabbit.health = 5; rabbit.food = 16;
  rabbit._items.push({ name: 'rabbit', count: 1, type: registry.itemsByName.rabbit.id });
  rabbit.consume = async () => { assert.equal(rabbit.heldItem.name, 'rabbit'); rabbit._items[0].count--; rabbit.food += 3; };
  const rabbitResult = await executeSkill(rabbit, { action: 'eat' });
  assert.equal(rabbitResult.item, 'rabbit'); assert.equal(rabbitResult.foodBefore, 16); assert.equal(rabbitResult.foodAfter, 19); assert.equal(rabbitResult.verified, true); assert.equal(rabbit._items[0].count, 0, 'legal model-selected eat consumes raw rabbit and confirms food/inventory change');
  const preferCooked = fakeBot(); preferCooked._items.push({ name: 'rabbit', count: 1, type: registry.itemsByName.rabbit.id }, { name: 'cooked_rabbit', count: 1, type: registry.itemsByName.cooked_rabbit.id });
  preferCooked.consume = async () => { assert.equal(preferCooked.heldItem.name, 'cooked_rabbit'); preferCooked._items[1].count--; preferCooked.food = 17; };
  assert.equal((await executeSkill(preferCooked, { action: 'eat' })).item, 'cooked_rabbit', 'cooked rabbit remains preferred');
  const state = observe(bot); assert.equal(state.health, 20); assert.equal(state.dimension, 'overworld'); assert.deepEqual(state.resources.iron, []);
  bot.entities[4] = { id: 4, name: 'creeper', position: new Vec3(2, 64, 0) };
  bot.entities[5] = { id: 5, name: 'player', position: new Vec3(1, 64, 0) };
  assert.equal(observe(bot).threats.length, 1);
  delete bot.entities[4];
  const threatBoundary = fakeBot();
  for (const [id, range] of [[1, 17], [2, 23.9], [3, 24], [4, 24.1]]) threatBoundary.entities[id] = { id, name: 'zombie', position: new Vec3(range, 64, 0) };
  threatBoundary.entities[5] = { id: 5, name: 'salmon', position: new Vec3(2, 64, 0) };
  threatBoundary.entities[6] = { id: 6, name: 'player', position: new Vec3(3, 64, 0) };
  const boundaryObservation = observe(threatBoundary);
  assert.deepEqual(boundaryObservation.threats.map(e => e.distance), [17, 23.9, 24], 'observation matches the inclusive emergency guard radius');
  assert.deepEqual(compactObservation(boundaryObservation).threats.map(e => e.distance), [17, 23.9, 24], 'model input retains the 16-to-24-block threats without duplicate reactive entities');
  threatBoundary.health = 5;
  await assert.rejects(executeSkill(threatBoundary, { action: 'hunt', count: 1 }), /hostile within 24/);
  await assert.rejects(executeSkill(threatBoundary, { action: 'explore', direction: 'east', distance: 8 }), /hostile within 24/);
  const movement = setSafeMovements(bot);
  assert.equal(movement.canDig, false); assert.equal(movement.maxDropDown, 2); assert.equal(movement.allowParkour, false); assert(movement.blocksToAvoid.has(registry.blocksByName.water.id));
  const below = bot.blockAt(new Vec3(0, 63, 0)); assert.equal(validDig(bot, below), false, 'never dig support beneath feet');
  const high = bot.blockAt(new Vec3(0, 66, 0)); high.diggable = true; assert.equal(validDig(bot, high), false, 'never dig straight overhead');
  const frame = portalLayout(new Vec3(0, 64, 0));
  assert.equal(frame.filter(b => b.name === 'obsidian').length, 10); assert.equal(frame.filter(b => b.name === 'cobblestone').length, 4); assert(!frame.some(b => b.position.x === 1 && b.position.y === 65));
  bot.game.gameMode = 'creative'; await assert.rejects(executeSkill(bot, { action: 'eat' }), /survival/); assert.equal((await executeSkill(bot, { action: 'observe' })).verified, true); bot.game.gameMode = 'survival';
  bot._items.push({ name: 'bread', count: 3, type: registry.itemsByName.bread.id });
  const ate = await executeSkill(bot, { action: 'eat' }); assert.equal(ate.verified, true); assert.equal(ate.foodBefore, 12); assert.equal(ate.foodAfter, 18);
  const cancelBot = fakeBot(); cancelBot._items.push({ name: 'bread', count: 3, type: registry.itemsByName.bread.id });
  let release, consumed = 0;
  cancelBot.equip = () => new Promise(resolve => { release = resolve; }); cancelBot.consume = async () => { consumed++; };
  const controller = new AbortController();
  const pending = executeSkill(cancelBot, { action: 'eat' }, { signal: controller.signal });
  await delay(5);
  await assert.rejects(executeSkill(cancelBot, { action: 'eat' }), /already running/);
  controller.abort(new Error('test cancellation'));
  await assert.rejects(pending, /test cancellation/); release(); await delay(5);
  assert.equal(consumed, 0, 'late equip completion cannot trigger eating after cancellation'); assert(cancelBot._stops > 0);
  const stuckBot = fakeBot(); stuckBot._items.push({ name: 'bread', count: 3, type: registry.itemsByName.bread.id }); stuckBot.equip = () => new Promise(() => {});
  await assert.rejects(executeSkill(stuckBot, { action: 'eat' }, { timeoutMs: 25 }), /deadline/);
  const fakeCraft = fakeBot();
  fakeCraft.recipesFor = () => [{ result: { id: registry.itemsByName.stick.id, count: 4 } }];
  fakeCraft.craft = async () => {};
  await assert.rejects(executeSkill(fakeCraft, { action: 'craft', item: 'stick', count: 4 }, { timeoutMs: 60 }), /deadline/, 'successful API return without inventory gain is not completion');
  const craftBot = fakeBot(); craftBot.recipesFor = fakeCraft.recipesFor;
  craftBot.craft = async (recipe, runs) => craftBot._items.push({ name: 'stick', count: recipe.result.count * runs });
  assert.equal((await executeSkill(craftBot, { action: 'craft', item: 'stick', count: 5 })).gained, 8, 'craft count is rounded to output batch');
  const dangerBot = fakeBot(); dangerBot.entities[2] = { id: 2, name: 'skeleton', position: new Vec3(3, 64, 0) };
  await assert.rejects(executeSkill(dangerBot, { action: 'explore', direction: 'north', distance: 16 }), /Unsafe/);
  await assert.rejects(executeSkill(fakeBot(), { action: 'explore', direction: 'north', distance: 16 }), /meaningful displacement/);
  const netherBot = fakeBot(); netherBot.game.dimension = 'the_nether';
  const blockedExplorer = fakeBot();
  let finishRoute;
  blockedExplorer.pathfinder.goto = () => new Promise(resolve => { finishRoute = resolve; });
  blockedExplorer.pathfinder.setGoal = () => finishRoute?.();
  const stalledAt = Date.now();
  await assert.rejects(executeSkill(blockedExplorer, { action: 'explore', direction: 'east', distance: 24 }), /no movement for 4 seconds/);
  assert(Date.now() - stalledAt < 6500, 'blocked exploration must not wait the old 35-second timeout');
  assert.equal((await executeSkill(netherBot, { action: 'enter_portal' })).alreadyThere, true);
  console.log('Survival skill checks passed: strict whitelist, observations, cautious movement, digging guards, frame geometry, survival gate, inventory verification, output batching, cancellation, deadline and mutual exclusion. These are simulated API tests, not live survival completion.');
})().catch(error => { console.error(error); process.exitCode = 1; });
