'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const { executeSkill, isSkillBusy } = require('../src/minecraft/survival-skills');
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fakeBot() {
  const bot = new EventEmitter(), items = [{ name: 'oak_log', count: 4 }, { name: 'oak_planks', count: 0 }];
  Object.assign(bot, { registry, game: { gameMode: 'survival' }, health: 20, food: 20, entities: {}, entity: { position: new Vec3(0, 64, 0) }, inventory: { items: () => items }, _items: items, _calls: [],
    recipesFor: () => [{ result: { id: registry.itemsByName.oak_planks.id, count: 4 } }],
    async craft() { bot._calls.push('craft'); items[0].count--; items[1].count += 4; },
    async _syncWindow(window) { assert.equal(window, bot.inventory); bot._calls.push('sync'); },
    supportFeature: () => true, pathfinder: { setMovements() {}, setGoal() {} }, clearControlStates() {}, stopDigging() {}, deactivateItem() {}
  }); return bot;
}
async function rejected(promise) { try { await promise; assert.fail('Expected rejection'); } catch (error) { return error; } }
(async () => {
  const good = fakeBot();
  const result = await executeSkill(good, { action: 'craft', item: 'planks', count: 12 });
  assert.deepEqual(good._calls, ['craft', 'sync', 'craft', 'sync', 'craft', 'sync']);
  assert.equal(result.gained, 12); assert.equal(result.inventoryConfirmation, 'server_window_sync');
  const table = fakeBot(), tablePosition = new Vec3(2, 64, 0);
  table.findBlocks = () => [tablePosition]; table.blockAt = p => ({ name: 'crafting_table', position: p }); table.pathfinder.goto = async () => {};
  table.recipesFor = (id, metadata, count, station) => station ? [{ requiresTable: true, result: { id: registry.itemsByName.wooden_pickaxe.id, count: 1 } }] : [];
  table.craft = async () => { table._calls.push('native-table-craft-and-sync'); table._items.push({ name: 'wooden_pickaxe', count: 1 }); };
  const tableResult = await executeSkill(table, { action: 'craft', item: 'wooden_pickaxe', count: 1 });
  assert.equal(tableResult.inventoryConfirmation, 'native_crafting_table_sync'); assert.deepEqual(table._calls, ['native-table-craft-and-sync'], 'do not redundantly sync the closed table');
  const corrected = fakeBot(); let syncs = 0;
  corrected._syncWindow = async () => { corrected._calls.push('sync'); if (++syncs === 2) corrected._items[1].count = 4; };
  const failed = await rejected(executeSkill(corrected, { action: 'craft', item: 'planks', count: 12 }, { timeoutMs: 60 }));
  assert.match(failed.message, /deadline/); assert.deepEqual(corrected._calls, ['craft', 'sync', 'craft', 'sync'], 'do not start third batch when server corrected second output');
  assert.equal(failed.partialResult.gained, 4); assert.equal(failed.partialResult.verifiedPartial, true); assert.equal(failed.partialResult.complete, false); assert.equal(failed.partialResult.verified, undefined);
  assert.equal(failed.partialResult.inventoryConfirmation, 'server_window_sync');
  const cancelBot = fakeBot(), abort = new AbortController(); let release, entered, count = 0;
  const enteredSync = new Promise(resolve => { entered = resolve; });
  cancelBot._syncWindow = async () => { cancelBot._calls.push('sync'); if (++count === 2) { entered(); await new Promise(resolve => { release = resolve; }); } };
  const pending = executeSkill(cancelBot, { action: 'craft', item: 'planks', count: 12 }, { signal: abort.signal });
  await enteredSync; abort.abort(new Error('Cancel second sync'));
  const cancelled = await rejected(pending); assert.match(cancelled.message, /Cancel second sync/);
  assert.equal(cancelled.partialResult.gained, 4, 'unconfirmed optimistic second output is not credited');
  assert(isSkillBusy(cancelBot)); release(); await sleep(5);
  assert.equal(cancelBot._calls.filter(x => x === 'craft').length, 2); assert(!isSkillBusy(cancelBot));
  for (const unsupported of ['missing-api', 'old-protocol']) {
    const fallback = fakeBot(); if (unsupported === 'missing-api') delete fallback._syncWindow; else fallback.supportFeature = () => false;
    const observed = await executeSkill(fallback, { action: 'craft', item: 'planks', count: 4 });
    assert.equal(observed.inventoryConfirmation, 'inventory_delta_only'); assert.match(observed.confirmationLimitation, /No explicit server/); assert(!fallback._calls.includes('sync'));
  }
  console.log('Craft batch checks passed: server synchronization between batches; corrected output halts later batches; confirmed partial evidence; cancellation retains native lock; unsupported synchronization explicitly limited.');
})().catch(error => { console.error(error); process.exitCode = 1; });
