'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const { executeSkill, validateAction, homeLayout, homeSiteClear, homeStatus, resolveCraftName } = require('../src/minecraft/survival-skills');
const { parseDecision, compactObservation } = require('../src/minecraft/survival-planner');
function fixture() {
  const bot = new EventEmitter(), cells = new Map();
  const items = ['oak_planks', 'red_bed', 'chest', 'torch', 'oak_door', 'crafting_table', 'furnace'].map(name => ({ name, count: name === 'oak_planks' ? 100 : 2, type: registry.itemsByName[name].id }));
  const block = (p, name, properties = {}) => ({ position: p, name, boundingBox: name === 'air' || name === 'torch' ? 'empty' : 'block', getProperties: () => properties });
  Object.assign(bot, { registry, health: 20, food: 20, game: { gameMode: 'survival', dimension: 'overworld' }, entity: { position: new Vec3(0, 64, 0) }, entities: {},
    inventory: { items: () => items.filter(i => i.count > 0) }, cells, placed: [],
    blockAt: p => cells.get(p.toString()) || block(p, p.y < 64 ? 'stone' : 'air'),
    pathfinder: { setMovements() {}, setGoal() {}, async goto(goal) { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); } },
    clearControlStates() {}, stopDigging() {}, deactivateItem() {}, equip: async item => { bot.heldItem = item; },
    lookAt: async p => { bot.lastLook = p; },
    placeBlock: async (support, face) => {
      const p = support.position.plus(face), name = bot.heldItem.name;
      cells.set(p.toString(), block(p, name, /_door$/.test(name) ? { half: 'lower' } : {}));
      if (/_door$/.test(name)) cells.set(p.offset(0, 1, 0).toString(), block(p.offset(0, 1, 0), name, { half: 'upper' }));
      bot.heldItem.count--; bot.placed.push(p);
    },
    _placeBlockWithOptions: async (support, face, options) => {
      assert.equal(options.forceLook, 'ignore');
      assert.equal(bot.lastLook.x, bot.entity.position.x); assert(bot.lastLook.z < bot.entity.position.z);
      const p = support.position.plus(face), name = bot.heldItem.name;
      cells.set(p.toString(), block(p, name, { part: 'foot' }));
      cells.set(p.offset(0, 0, -1).toString(), block(p.offset(0, 0, -1), name, { part: 'head' }));
      bot.heldItem.count--; bot.placed.push(p);
    }
  });
  return bot;
}
(async () => {
  assert.equal(homeLayout(new Vec3(0, 64, 0)).length, 71);
  assert.equal(new Set(homeLayout(new Vec3(0, 64, 0)).map(p => p.toString())).size, 71);
  assert.throws(() => validateAction({ action: 'build_home', count: 9 }), /Invalid count/);
  assert.throws(() => validateAction({ action: 'furnish_home', item: 'lava' }), /Invalid item/);
  assert.equal(parseDecision('{"action":"build_home","count":8}').action, 'build_home');
  assert.equal(validateAction({ action: 'hunt', count: 1, animal: 'sheep' }).animal, 'sheep');
  assert.throws(() => validateAction({ action: 'hunt', count: 1, animal: 'villager' }), /Invalid animal/);
  for (const item of ['bed', 'door', 'chest']) assert.equal(validateAction({ action: 'craft', item, count: 1 }).item, item);
  const unknown = fixture(); unknown.blockAt = () => null;
  assert.equal(homeSiteClear(unknown, new Vec3(0, 64, 0)), false);
  await assert.rejects(executeSkill(unknown, { action: 'build_home', count: 8 }), /No loaded clear/);
  assert.equal(unknown.placed.length, 0);
  const bot = fixture();
  const first = await executeSkill(bot, { action: 'build_home', count: 8 });
  assert.equal(first.placed, 8); assert.equal(first.complete, false);
  const initial = homeStatus(bot); assert.equal(initial.built, 8); assert.equal(initial.total, 71);
  while (!homeStatus(bot).shellComplete) await executeSkill(bot, { action: 'build_home', count: 8 });
  assert.equal(bot.placed.length, 71); assert.equal(bot.inventory.items().find(i => i.name === 'oak_planks').count, 29);
  const repeated = await executeSkill(bot, { action: 'build_home', count: 8 });
  assert.equal(repeated.placed, 0); assert.equal(bot.placed.length, 71);
  for (const item of ['bed', 'chest', 'torch', 'crafting_table', 'furnace', 'door']) {
    const placed = await executeSkill(bot, { action: 'furnish_home', item }); assert.equal(placed.complete, true);
    assert.equal(homeStatus(bot).furnishing[item], true);
    assert.equal((await executeSkill(bot, { action: 'furnish_home', item })).alreadyPlaced, true);
  }
  assert.equal(homeStatus(bot).complete, true);
  assert.deepEqual(compactObservation({ home: homeStatus(bot) }).home, homeStatus(bot));
  delete require.cache[require.resolve('../src/minecraft/survival-skills')];
  const reloaded = require('../src/minecraft/survival-skills');
  assert.equal(reloaded.homeStatus(bot).complete, true, 'home anchor survives idle module hot reload on the same bot');
  assert.equal((await reloaded.executeSkill(bot, { action: 'build_home', count: 1 })).placed, 0);
  const base = initial.position;
  bot.cells.delete(new Vec3(base.x + 1, base.y, base.z + 1).toString());
  const oldRead = bot.blockAt; bot.blockAt = p => p.y === 63 ? null : oldRead(p);
  assert.equal(homeStatus(bot).complete, false, 'unloaded or removed floor invalidates completed home');
  bot.blockAt = oldRead; bot.game.dimension = 'nether';
  await assert.rejects(executeSkill(bot, { action: 'build_home', count: 1 }), /another dimension/);
  const interrupted = fixture(), controller = new AbortController();
  const place = interrupted.placeBlock; interrupted.placeBlock = async (...args) => { await place(...args); controller.abort(new Error('user stop')); };
  await assert.rejects(executeSkill(interrupted, { action: 'build_home', count: 8 }, { signal: controller.signal }), /user stop/);
  assert.equal(interrupted.placed.length, 1, 'abort prevents all later placements');
  await new Promise(resolve => setImmediate(resolve));
  interrupted.placeBlock = place;
  assert.equal((await executeSkill(interrupted, { action: 'build_home', count: 1 })).placed, 1, 'resume reads actual world and does not duplicate first block');
  const noAck = fixture(); noAck.placeBlock = async () => {};
  await assert.rejects(executeSkill(noAck, { action: 'build_home', count: 1 }, { timeoutMs: 70 }), /deadline/);
  assert.equal(homeStatus(noAck).built, 0, 'native return alone is not verified construction');
  const recipeBot = fixture(); recipeBot.recipesFor = id => id === registry.itemsByName.red_bed.id || id === registry.itemsByName.spruce_door.id ? [{}] : [];
  assert.equal(resolveCraftName(recipeBot, 'bed'), 'red_bed'); assert.equal(resolveCraftName(recipeBot, 'door'), 'spruce_door');
  recipeBot.recipesFor = () => []; assert.equal(resolveCraftName(recipeBot, 'bed'), null);
  console.log('Home skill simulated checks passed: bounded/resumable shell, furnishing evidence, unknown floor/dimension refusal, cancellation, server-evidence timeout, recipe aliases. Live Minecraft not tested.');
})().catch(error => { console.error(error); process.exitCode = 1; });
