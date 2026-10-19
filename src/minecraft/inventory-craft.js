'use strict';

// Modern player-inventory crafting only. Table recipes retain Mineflayer's
// native implementation. Every click is sent once; reconciliation failure
// stops the batch with the server cursor/grid preserved for diagnostics.
function supported(bot, recipe) {
  return !recipe.requiresTable && !recipe.outShape && bot.supportFeature?.('stateIdUsed') && !!bot._client?.write && typeof bot.inventory?.acceptClick === 'function';
}
const signature = item => item ? `${item.type}:${item.metadata ?? 0}:${item.count}` : null;
async function craftInventoryBatch(bot, recipe, { signal, check = () => {}, log = () => {}, onConfirmedSnapshot = () => {}, syncTimeoutMs = 3500 } = {}) {
  if (!supported(bot, recipe)) throw new Error('Confirmed inventory crafting unavailable');
  const Item = require('prismarine-item')(bot.registry), window = bot.inventory;
  let stateId = null, sequence = 0;
  const safe = () => { signal?.throwIfAborted(); check(); if (bot.currentWindow || bot.inventory !== window) throw new Error('Craft window changed'); };
  const sync = (predicate = () => true, phase = 'initial') => new Promise((resolve, reject) => {
    let timer, cancelledWhilePending = false;
    const cleanup = () => { clearTimeout(timer); bot._client.removeListener('window_items', response); signal?.removeEventListener('abort', cancelled); };
    const fail = error => { cleanup(); reject(error); };
    // Do not release the native operation while its already-sent packets are
    // still outstanding. The outer skill aborts immediately, but its mutex is
    // retained until this full response or the bounded reconciliation timeout.
    const cancelled = () => { cancelledWhilePending = true; };
    const response = packet => {
      if (packet.windowId !== window.id || !Number.isInteger(packet.stateId) || packet.carriedItem === undefined || packet.items?.length !== window.slots.length) return;
      try {
        safe();
        // Mineflayer's earlier packet listener already applied this full state.
        // A stale pre-click snapshot cannot satisfy the click's slot/cursor
        // postcondition; wait for the following ordered full reconciliation.
        if (!predicate()) return;
        stateId = packet.stateId;
        onConfirmedSnapshot();
        log({ event: 'craft_window_reconciled', phase, sequence, windowId: window.id, stateId, correlation: 'ordered full snapshot with slot/cursor postcondition; protocol has no request nonce' });
        cleanup(); resolve();
      } catch (error) { fail(error); }
    };
    bot._client.on('window_items', response); signal?.addEventListener('abort', cancelled, { once: true });
    timer = setTimeout(() => fail(cancelledWhilePending ? signal.reason || new Error('Craft cancelled') : new Error(`Craft reconciliation timed out: ${phase}`)), syncTimeoutMs);
    try {
      safe(); sequence++;
      // Same no-op as installed Mineflayer _syncWindow: END a drag which
      // this controller never starts. mode5/button2 is not a throw/drop click.
      // Verified against the local 26.1.2 AbstractContainerMenu bytecode:
      // quickcraftStatus 0 -> header2 resets drag state without touching items.
      bot._client.write('window_click', { windowId: window.id, stateId: -1, slot: -999, mouseButton: 2, mode: 5, changedSlots: [], cursorItem: Item.toNotch(window.selectedItem) });
    } catch (error) { fail(error); }
  });
  const click = async (slot, button) => {
    safe();
    if (!Number.isInteger(slot) || slot < 0 || slot >= window.slots.length || ![0, 1].includes(button)) throw new Error('Invalid crafting click');
    const changed = window.acceptClick({ slot, mouseButton: button, mode: 0, item: window.slots[slot] });
    const expectedSlot = signature(window.slots[slot]), expectedCursor = signature(window.selectedItem);
    safe();
    bot._client.write('window_click', { windowId: window.id, stateId, slot, mouseButton: button, mode: 0, changedSlots: changed.map(location => ({ location, item: Item.toNotch(window.slots[location]) })), cursorItem: Item.toNotch(window.selectedItem) });
    await sync(() => signature(window.slots[slot]) === expectedSlot && signature(window.selectedItem) === expectedCursor, `click:${slot}:${button}`);
  };
  const storeCursor = async preferred => {
    for (let attempt = 0; window.selectedItem && attempt < 4; attempt++) {
      safe(); const item = window.selectedItem;
      const slot = preferred != null && !window.slots[preferred] ? preferred : window.findItemRange(window.inventoryStart, window.inventoryEnd, item.type, item.metadata, true, item.nbt)?.slot ?? window.firstEmptySlotRange(window.inventoryStart, window.inventoryEnd);
      if (slot == null) throw new Error('No inventory space; cursor retained');
      await click(slot, 0);
    }
    if (window.selectedItem) throw new Error('Cursor could not be stored without dropping');
  };
  await sync(); safe();
  if (window.selectedItem || window.slots.slice(0, 5).some(Boolean)) throw new Error('Craft grid/cursor not empty after server reconciliation; recovery required');
  const bagCounts = () => { const counts = new Map(); for (const item of window.items()) counts.set(item.type, (counts.get(item.type) || 0) + item.count); return counts; };
  const before = bagCounts(), placements = [];
  if (recipe.inShape) {
    if (recipe.inShape.length > 2 || recipe.inShape.some(row => row.length > 2)) throw new Error('Recipe does not fit inventory grid');
    recipe.inShape.forEach((row, y) => row.forEach((ingredient, x) => { if (ingredient.id !== -1) placements.push({ ingredient, slot: 1 + x + 2 * y }); }));
  } else (recipe.ingredients || []).forEach((ingredient, i) => placements.push({ ingredient, slot: i + 1 }));
  if (!placements.length || placements.length > 4) throw new Error('Unsupported inventory recipe');
  for (const { ingredient, slot } of placements) {
    safe(); const source = window.findInventoryItem(ingredient.id, ingredient.metadata);
    if (!source) throw new Error('Missing confirmed recipe ingredient');
    const sourceSlot = source.slot;
    await click(sourceSlot, 0); await click(slot, 1); await storeCursor(sourceSlot);
  }
  const result = window.slots[0];
  if (!result || result.type !== recipe.result.id || result.count !== recipe.result.count) throw new Error('Server crafting result does not match requested recipe');
  await click(0, 0); await storeCursor(); safe();
  if (window.selectedItem || window.slots.slice(0, 5).some(Boolean)) throw new Error('Server craft grid/cursor not cleared');
  const after = bagCounts(), expected = new Map();
  for (const delta of recipe.delta) expected.set(delta.id, (expected.get(delta.id) || 0) + delta.count);
  for (const id of new Set([...before.keys(), ...after.keys(), ...expected.keys()])) if ((after.get(id) || 0) - (before.get(id) || 0) !== (expected.get(id) || 0)) throw new Error('Server-confirmed recipe inventory conservation mismatch');
  return { inventoryConfirmation: 'server_full_window_per_click', confirmationLimitation: 'Protocol has no request nonce; ordered full snapshots validated by each click postcondition and whole recipe conservation.' };
}
module.exports = { supported, craftInventoryBatch };
