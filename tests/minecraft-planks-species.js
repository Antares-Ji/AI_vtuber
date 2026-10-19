'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const { resolveCraftName, executeSkill } = require('../src/minecraft/survival-skills');

function fixture(stock) {
  const items = stock.map(([name, count]) => ({ name, count }));
  const bot = new EventEmitter();
  Object.assign(bot, { registry, health: 20, food: 20, entities: {}, game: { gameMode: 'survival' },
    entity: { position: new Vec3(0, 64, 0) }, inventory: { items: () => items }, crafts: [],
    pathfinder: { setMovements() {}, setGoal() {} }, clearControlStates() {}, stopDigging() {},
    recipesFor(id, metadata, amount) {
      const name = registry.items[id]?.name;
      if (!name?.endsWith('_planks')) return [];
      const log = name.replace(/_planks$/, '_log');
      const logs = items.filter(i => i.name === log).reduce((n, i) => n + i.count, 0);
      return logs >= Math.ceil(amount / 4) ? [{ result: { id, count: 4 }, log }] : [];
    },
    async craft(recipe) {
      bot.crafts.push(recipe.log);
      items.find(i => i.name === recipe.log && i.count > 0).count--;
      const name = registry.items[recipe.result.id].name;
      const existing = items.find(i => i.name === name);
      if (existing) existing.count += 4; else items.push({ name, count: 4 });
    }
  });
  return bot;
}

(async () => {
  const mixed = fixture([['spruce_planks', 10], ['spruce_log', 1], ['oak_log', 6]]);
  assert.equal(resolveCraftName(mixed, 'planks', 8), 'oak_planks');
  const result = await executeSkill(mixed, { action: 'craft', item: 'planks', count: 8 });
  assert.equal(result.item, 'oak_planks'); assert.equal(result.gained, 8);
  assert.deepEqual(mixed.crafts, ['oak_log', 'oak_log']);
  assert.equal(mixed.inventory.items().find(i => i.name === 'spruce_log').count, 1);
  assert.equal(mixed.inventory.items().find(i => i.name === 'spruce_planks').count, 10);
  const insufficient = fixture([['spruce_log', 1], ['oak_log', 1], ['oak_planks', 64]]);
  assert.equal(resolveCraftName(insufficient, 'planks', 8), null, 'different species and existing boards cannot fund new eight-board output');
  await assert.rejects(executeSkill(insufficient, { action: 'craft', item: 'planks', count: 8 }), /Missing ingredients/);
  assert.equal(insufficient.crafts.length, 0);
  const normal = fixture([['spruce_log', 1], ['oak_log', 6]]);
  assert.equal(resolveCraftName(normal, 'planks'), 'spruce_planks');
  assert.equal((await executeSkill(normal, { action: 'craft', item: 'planks', count: 1 })).gained, 4);
  assert.equal(resolveCraftName(fixture([['spruce_log', 1], ['spruce_log', 1]]), 'planks', 8), 'spruce_planks', 'recipe affordability combines stacks of the same species');
  console.log('Plank species checks passed: requested output affordability, independent species, unchanged other inventory, insufficient refusal, normal batch and split stacks. Simulated only.');
})().catch(error => { console.error(error); process.exitCode = 1; });
