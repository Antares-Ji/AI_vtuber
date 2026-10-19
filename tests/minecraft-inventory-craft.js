'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const registry = require('prismarine-registry')('1.21.1');
const Item = require('prismarine-item')(registry), windows = require('prismarine-windows')('1.21.1');
const { Recipe } = require('prismarine-recipe')(registry);
const { craftInventoryBatch } = require('../src/minecraft/inventory-craft');
function fixture(name = 'spruce_planks', mode = 'normal') {
  const recipe = Recipe.find(registry.itemsByName[name].id, null)[0];
  const make = () => windows.createWindow(0, 'minecraft:inventory', 'Inventory');
  const server = make(), client = make(), transport = new EventEmitter(); let state = 0, lastFull;
  const ingredient = recipe.delta.find(d => d.count < 0);
  server.updateSlot(9, new Item(ingredient.id, 12));
  if (mode === 'conservation') server.updateSlot(10, new Item(registry.itemsByName.dirt.id, 3));
  const bot = { registry, inventory: client, currentWindow: null, supportFeature: f => f === 'stateIdUsed', _client: transport, packets: [] };
  const packet = () => ({ windowId: 0, stateId: ++state, items: server.slots.map(Item.toNotch), carriedItem: Item.toNotch(server.selectedItem) });
  transport.on('window_items', p => { if (p.windowId !== 0) return; p.items.forEach((n, i) => client.updateSlot(i, Item.fromNotch(n))); client.selectedItem = Item.fromNotch(p.carriedItem); });
  transport.write = (event, p) => {
    assert.equal(event, 'window_click'); bot.packets.push(p);
    if (p.mode === 5) {
      assert.equal(p.slot, -999); assert.equal(p.mouseButton, 2); assert.equal(p.stateId, -1);
      const before = JSON.stringify(server.slots.map(Item.toNotch)), cursor = JSON.stringify(Item.toNotch(server.selectedItem));
      // Vanilla quickcraft status0 + END2 is a no-op, including held cursor.
      assert.equal(JSON.stringify(server.slots.map(Item.toNotch)), before); assert.equal(JSON.stringify(Item.toNotch(server.selectedItem)), cursor);
      if (mode === 'timeout') return;
      const full = packet(), stale = lastFull; lastFull = full;
      queueMicrotask(() => { if (mode === 'wrong-window') transport.emit('window_items', { ...full, windowId: 7 }); else { if (mode === 'stale' && stale) transport.emit('window_items', stale); transport.emit('window_items', full); } });
      return;
    }
    assert.equal(p.mode, 0); assert(p.slot >= 0); assert([0, 1].includes(p.mouseButton));
    if (mode === 'rollback') return;
    server.acceptClick({ slot: p.slot, mouseButton: p.mouseButton, mode: 0, item: server.slots[p.slot] });
    if (mode === 'conservation' && p.slot >= 9 && !server.selectedItem && server.slots[p.slot]?.type === recipe.result.id) server.updateSlot(10, null);
    if (p.slot === 0) for (let i = 1; i <= 4; i++) server.updateSlot(i, null);
    const inGrid = server.slots.slice(1, 5).filter(Boolean), need = -ingredient.count;
    server.updateSlot(0, inGrid.reduce((n, i) => n + (i.type === ingredient.id ? i.count : 0), 0) === need && mode !== 'wrong-result' ? new Item(recipe.result.id, recipe.result.count) : null);
  };
  return { bot, recipe, server };
}
(async () => {
  for (const name of ['spruce_planks', 'stick', 'crafting_table']) {
    const { bot, recipe, server } = fixture(name), logs = [];
    const result = await craftInventoryBatch(bot, recipe, { log: e => logs.push(e) });
    assert.equal(result.inventoryConfirmation, 'server_full_window_per_click');
    assert.equal(server.count(recipe.result.id), recipe.result.count); assert.equal(server.selectedItem, null);
    assert.equal(bot.packets.filter(p => p.mode === 0 && p.slot === 0).length, 1, 'exactly one result click');
    assert(logs.every(e => e.stateId > 0));
  }
  const stale = fixture('spruce_planks', 'stale');
  await craftInventoryBatch(stale.bot, stale.recipe); assert.equal(stale.server.count(stale.recipe.result.id), 4, 'pre-click full snapshots cannot satisfy later postconditions');
  for (const mode of ['timeout', 'wrong-window', 'wrong-result', 'rollback']) {
    const { bot, recipe } = fixture('spruce_planks', mode);
    await assert.rejects(craftInventoryBatch(bot, recipe, { syncTimeoutMs: 20 }), mode === 'wrong-result' ? /result does not match/ : /reconciliation timed out/);
    assert.equal(bot.packets.filter(p => p.mode === 0 && p.slot === 0).length, 0, 'no unconfirmed output click or replay');
    assert.equal(bot._client.listenerCount('window_items'), 1, 'temporary listener removed');
  }
  const pending = fixture('spruce_planks', 'timeout'), pendingController = new AbortController(); let settled = false;
  const held = craftInventoryBatch(pending.bot, pending.recipe, { signal: pendingController.signal, syncTimeoutMs: 45 }).finally(() => { settled = true; });
  pendingController.abort(new Error('pending cancel'));
  await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(settled, false, 'pending packet retains native operation until bounded response timeout');
  await assert.rejects(held, /pending cancel/); assert.equal(pending.bot.packets.length, 1);
  const cancelled = fixture(), controller = new AbortController();
  await assert.rejects(craftInventoryBatch(cancelled.bot, cancelled.recipe, { signal: controller.signal, onConfirmedSnapshot: () => { if (cancelled.bot.inventory.selectedItem?.type === cancelled.recipe.result.id) controller.abort(new Error('cancel after result')); } }), /cancel after result/);
  assert.equal(cancelled.server.selectedItem.type, cancelled.recipe.result.id, 'cancel preserves actual cursor rather than dropping/replaying');
  const packets = cancelled.bot.packets.length; await new Promise(resolve => setTimeout(resolve, 10)); assert.equal(cancelled.bot.packets.length, packets);
  const occupied = fixture(); occupied.server.selectedItem = new Item(registry.itemsByName.dirt.id, 5);
  await assert.rejects(craftInventoryBatch(occupied.bot, occupied.recipe), /grid\/cursor not empty/);
  assert.equal(occupied.server.selectedItem.count, 5); assert.equal(occupied.bot.packets.filter(p => p.mode === 0).length, 0);
  const dirty = fixture(); dirty.server.updateSlot(1, new Item(registry.itemsByName.dirt.id, 1));
  await assert.rejects(craftInventoryBatch(dirty.bot, dirty.recipe), /grid\/cursor not empty/); assert.equal(dirty.bot.packets.filter(p => p.mode === 0).length, 0);
  const conservation = fixture('spruce_planks', 'conservation');
  await assert.rejects(craftInventoryBatch(conservation.bot, conservation.recipe), /conservation mismatch/, 'unrelated bag losses cannot be hidden by correct output');
  console.log('Inventory craft protocol passed: three 2x2 recipes, server full snapshots, held cursor no-op barrier, one result click, timeout/wrong-window/wrong-result fail closed, cancellation without further packets.');
})().catch(error => { console.error(error); process.exitCode = 1; });
