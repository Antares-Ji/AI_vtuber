'use strict';
function itemSnapshot(item) {
  return item ? { name: item.name, type: item.type, count: item.count, metadata: item.metadata, slot: item.slot } : null;
}
function windowSnapshot(window) {
  if (!window) return null;
  return { id: window.id, type: window.type, inventoryStart: window.inventoryStart, inventoryEnd: window.inventoryEnd, craftingResultSlot: window.craftingResultSlot,
    slots: (window.slots || []).map(itemSnapshot), selectedItem: itemSnapshot(window.selectedItem) };
}
function inventoryDiagnostics(bot) {
  return { inventory: windowSnapshot(bot.inventory), currentWindow: windowSnapshot(bot.currentWindow), confirmation: 'local window model; includes optimistic updates until server reconciliation' };
}
function traceCraftInventory(bot, log) {
  let events = 0;
  const record = (event, packet = {}) => {
    if (events++ >= 160) { if (events === 161) log({ event: 'craft_inventory_trace_limit', limit: 160 }); return; }
    log({ event: 'craft_inventory_snapshot', phase: event, packet: { windowId: packet.windowId, stateId: packet.stateId, slot: packet.slot ?? packet.slotId }, ...inventoryDiagnostics(bot) });
  };
  const names = ['window_items', 'set_slot', 'set_player_inventory', 'set_cursor_item'];
  const listeners = names.map(name => { const listener = packet => record(name, packet); bot._client?.on?.(name, listener); return [name, listener]; });
  record('before');
  return () => { for (const [name, listener] of listeners) bot._client?.removeListener?.(name, listener); record('after'); };
}
module.exports = { inventoryDiagnostics, traceCraftInventory };
