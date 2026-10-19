'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const { executeSkill, foodOptions, validateAction } = require('../src/minecraft/survival-skills');

function fixture({ health = 4, food = 17, names = ['rotten_flesh'] } = {}) {
  const bot = new EventEmitter();
  const items = names.map(name => ({ name, count: 4, type: registry.itemsByName[name].id }));
  Object.assign(bot, { registry, health, food, game: { gameMode: 'survival' }, entity: { position: new Vec3(0, 64, 0) },
    inventory: { items: () => items }, entities: {}, consumeCalls: 0,
    pathfinder: { setMovements() {}, setGoal() {} }, clearControlStates() {}, stopDigging() {}, deactivateItem() {},
    equip: async item => { bot.heldItem = item; }, consume: async () => { bot.consumeCalls++; bot.heldItem.count--; bot.food = Math.min(20, bot.food + 4); }
  });
  return bot;
}

(async () => {
  const depleted = fixture(), logs = [];
  assert.equal(foodOptions(depleted).canEat, true);
  const ate = await executeSkill(depleted, { action: 'eat' }, { log: event => logs.push(event) });
  assert.equal(ate.item, 'rotten_flesh'); assert.equal(ate.foodBefore, 17); assert.equal(ate.foodAfter, 20);
  assert.equal(ate.verified, true); assert.equal(ate.emergencyFallback, true); assert.equal(ate.risk, 'hunger_effect_possible');
  assert.equal(depleted.inventory.items()[0].count, 3);
  assert(logs.some(event => event.event === 'emergency_food_selected'));
  const normal = fixture({ names: ['rotten_flesh', 'bread'] });
  assert.equal((await executeSkill(normal, { action: 'eat' })).item, 'bread', 'normal food always takes precedence even at critical health');
  assert.equal(normal.inventory.items()[0].count, 4);
  const hungry = fixture({ health: 20, food: 6 });
  assert.equal((await executeSkill(hungry, { action: 'eat' })).item, 'rotten_flesh', 'starvation prevention also permits last-resort food');
  const healthy = fixture({ health: 20, food: 17 });
  await assert.rejects(executeSkill(healthy, { action: 'eat' }), /emergency fallback.*cannot be smelted/);
  assert.equal(healthy.consumeCalls, 0);
  const full = fixture({ food: 20 });
  assert.equal(foodOptions(full).canEat, false);
  assert.equal((await executeSkill(full, { action: 'eat' })).alreadyFull, true); assert.equal(full.consumeCalls, 0);
  const unavailable = fixture({ names: ['rotten_flesh'] }); unavailable.inventory.items()[0].count = 0;
  assert.equal(foodOptions(unavailable).canEat, false, 'zero-count slots cannot be selected');
  const unsupported = fixture({ names: ['chicken', 'spider_eye', 'poisonous_potato'] });
  await assert.rejects(executeSkill(unsupported, { action: 'eat' }), /No supported edible food/);
  assert.equal(unsupported.consumeCalls, 0, 'last-resort rotten flesh does not authorize other effect foods');
  assert.throws(() => validateAction({ action: 'smelt', item: 'rotten_flesh', count: 1 }), /Invalid item/);
  const noEvidence = fixture(); noEvidence.consume = async () => {};
  await assert.rejects(executeSkill(noEvidence, { action: 'eat' }, { timeoutMs: 80 }), /deadline/, 'successful native call alone is not proof of eating');
  console.log('Emergency food checks passed: low-health/starvation fallback, safe-food preference, fullness, inventory+food verification, and smelting/poison-food rejection. Simulated tests only.');
})().catch(error => { console.error(error); process.exitCode = 1; });
