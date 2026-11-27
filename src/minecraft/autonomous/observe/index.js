'use strict';
// Egocentric ASCII map + status observation (idea borrowed from Numen's spatial text grid,
// which is far cheaper for the LLM than dumping coordinates / screenshots).
// NOTE: bot.blockAt() requires a real Vec3; pass position.offset(dx,dy,dz), never {x,y,z} literals.
const mcdata = require('minecraft-data');
const cfg = require('../config');

// Remaining durability as 0..100. Items straight off the wire carry maxDurability, but a
// stack built locally does not, so fall back to minecraft-data for the cap.
// NOTE: prismarine-item has NO `durability` field on 1.21 - only `durabilityUsed`.
function wear(bot, it) {
  if (!it || !it.name) return null;
  let max = it.maxDurability;
  if (!max) {
    try { max = (mcdata(bot.version || cfg.mc.version).itemsByName[it.name] || {}).maxDurability; } catch {}
  }
  if (!max) return null;
  let used = 0;
  try { used = it.durabilityUsed || 0; } catch {}
  return Math.max(0, Math.min(100, Math.round(100 * (1 - used / max))));
}

function classify(name) {
  if (!name || name === 'air' || name === 'cave_air') return '.';
  if (name.includes('water')) return '~';
  if (name.includes('lava')) return '^';
  if (name.includes('log') || name.includes('leaves')) return 'T';
  if (/_ore$/.test(name)) return 'o';
  if (name.includes('grass') || name === 'dirt' || name.includes('sand') || name.includes('snow') || name.includes('gravel')) return ',';
  if (name.includes('bedrock')) return 'B';
  if (name.includes('portal') || name.includes('end_portal_frame')) return 'P';
  if (name.includes('fire')) return 'f';
  return '#';
}

// Sample a radius x radius map around the bot's feet. Uses position.offset -> real Vec3.
function grid(bot, r = 8) {
  const rows = [];
  for (let dz = -r; dz <= r; dz++) {
    let row = '';
    for (let dx = -r; dx <= r; dx++) {
      let ch = '?';
      for (let dy = 1; dy >= -1; dy--) {
        const b = bot.blockAt(bot.entity.position.offset(dx, dy, dz));
        if (!b) continue;
        const c = classify(b.name);
        ch = c;
        if (c !== '.') break;
      }
      row += ch;
    }
    rows.push(row);
  }
  rows[r] = rows[r].slice(0, r) + '@' + rows[r].slice(r + 1);
  return rows.join('\n');
}

function invSummary(bot) {
  const items = bot.inventory.items();
  const counts = {};
  for (const it of items) counts[it.name] = (counts[it.name] || 0) + it.count;
  const eq = bot.inventory.selectedItem ? bot.inventory.selectedItem.name : 'hand';
  return { count: items.length, slots: JSON.stringify(counts), held: eq };
}

function status(bot) {
  const pos = bot.entity ? bot.entity.position.floored() : { x: 0, y: 0, z: 0 };
  const near = bot.entities ? Object.values(bot.entities)
    .filter(e => e.name && e.name !== 'player' && e.position && bot.entity)
    .slice(0, 8).map(e => `${e.name}@${Math.round(e.position.distanceTo(bot.entity.position))}`) : [];
  return {
    health: Math.round(bot.health * 10) / 10,
    food: Math.round(bot.food * 10) / 10,
    xp: bot.experience ? bot.experience.level : 0,
    dimension: bot.game ? bot.game.dimension : 'overworld',
    position: `${pos.x},${pos.y},${pos.z}`,
    time: bot.time ? bot.time.day : null,
    nearbyEntities: near,
  };
}

// Tools/utensils with remaining durability, plus what is actually worn. The planner's
// biggest silent failures were "mining does nothing" (pickaxe at 0 uses) and "craft times
// out" (no free slot), so both need to be visible to the model without a extra round-trip.
function kit(bot) {
  const KEEP = /(pickaxe|axe|shovel|sword|shears|bucket|flint_and_steel|shield|bow|furnace|crafting_table)/;
  const tools = [];
  for (const it of bot.inventory.items()) {
    if (!KEEP.test(it.name)) continue;
    const w = wear(bot, it);
    tools.push(`${it.name}x${it.count}${w === null ? '' : ':' + w + '%'}`);
  }
  const worn = [];
  for (const slot of ['head', 'torso', 'legs', 'feet']) {
    const it = bot.inventory.slots[5 + ['head', 'torso', 'legs', 'feet'].indexOf(slot)];
    worn.push(slot + ':' + (it ? it.name : 'none'));
  }
  return { tools: tools.length ? tools.join(' ') : '(none)', armor: worn.join(' '), freeSlots: 36 - bot.inventory.items().length };
}

// Count exposed ore in a box around the bot. Cheap blockAt sweep, no chunk loading,
// so it can never trigger the findBlocks/useExtraChunks heap blow-up that killed the bot.
function census(bot, r = 14, dy = 8) {
  const feet = bot.entity.position.floored();
  const found = {};
  let obsidian = 0, water = 0, lava = 0;
  for (let dx = -r; dx <= r; dx += 2) {
    for (let dz = -r; dz <= r; dz += 2) {
      for (let y = feet.y - dy; y <= feet.y + dy; y += 2) {
        const b = bot.blockAt(feet.offset(dx, y - feet.y, dz));
        if (!b) continue;
        if (/_ore$/.test(b.name)) found[b.name] = (found[b.name] || 0) + 1;
        else if (b.name === 'obsidian') obsidian++;
        else if (b.name.includes('lava')) lava++;
        else if (b.name.includes('water')) water++;
      }
    }
  }
  const ores = Object.keys(found).map(k => `${k}x${found[k]}`).join(' ');
  return `ores=${ores || 'none visible'} obsidian=${obsidian} water=${water} lava=${lava}`;
}

module.exports = { grid, invSummary, status, classify, kit, census, wear };
