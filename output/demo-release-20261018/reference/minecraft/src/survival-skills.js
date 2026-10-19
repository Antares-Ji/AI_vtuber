'use strict';

const { expanded } = require('./capability-policy');
const extendedActions = require('./extended-actions');
const { Vec3 } = require('vec3');
const { Movements, goals } = require('mineflayer-pathfinder');
const { HOSTILES, RANGED_THREATS, singleBlockDescents, entityView } = require('./reactive-agent');
const { inventoryDiagnostics, traceCraftInventory } = require('./inventory-diagnostics');
const confirmedCraft = require('./inventory-craft');
const resourceScan = require('./resource-scan');
// A proven wrong-block placement requires operator repair/reload before retry.
const placementFaults = new WeakMap();

const DIRECTIONS = { north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], northeast: [1, -1], northwest: [-1, -1], southeast: [1, 1], southwest: [-1, 1] };
const CRAFT_ITEMS = ['planks', 'stick', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'stone_axe', 'stone_sword', 'furnace', 'iron_pickaxe', 'iron_axe', 'iron_sword', 'iron_helmet', 'iron_chestplate', 'iron_leggings', 'iron_boots', 'shield', 'bucket', 'flint_and_steel', 'diamond_pickaxe', 'torch', 'bread', 'chest', 'bed', 'door'];
const RESOURCES = { stone: ['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate'], coal: ['coal_ore', 'deepslate_coal_ore'], iron: ['iron_ore', 'deepslate_iron_ore'], diamond: ['diamond_ore', 'deepslate_diamond_ore'], obsidian: ['obsidian'], gravel: ['gravel'] };
const HARVEST_ITEMS = { stone: ['cobblestone', 'cobbled_deepslate'], coal: ['coal'], iron: ['raw_iron', 'iron_ore'], diamond: ['diamond'], obsidian: ['obsidian'], gravel: ['gravel', 'flint'] };
const SMELT_OUTPUT = { raw_iron: 'iron_ingot', iron_ore: 'iron_ingot', deepslate_iron_ore: 'iron_ingot', raw_gold: 'gold_ingot', beef: 'cooked_beef', porkchop: 'cooked_porkchop', chicken: 'cooked_chicken', mutton: 'cooked_mutton', rabbit: 'cooked_rabbit', cod: 'cooked_cod', salmon: 'cooked_salmon', potato: 'baked_potato', charcoal: 'charcoal' };
// Normal choices avoid poison/hunger effects and scarce crafting ingredients.
// Rotten flesh is separately allowed only as a last-resort emergency food.
const FOODS = ['cooked_beef', 'cooked_porkchop', 'cooked_mutton', 'cooked_salmon', 'cooked_chicken', 'bread', 'baked_potato', 'cooked_rabbit', 'cooked_cod', 'apple', 'carrot', 'melon_slice', 'sweet_berries', 'beef', 'porkchop', 'mutton', 'cod', 'salmon', 'rabbit'];
const PREY = new Set(['cow', 'pig', 'sheep', 'chicken']);
const AIR = new Set(['air', 'cave_air', 'void_air']);
const DANGER = new Set(['lava', 'fire', 'soul_fire', 'magma_block', 'campfire', 'soul_campfire', 'cactus', 'powder_snow', 'sweet_berry_bush']);
const ADJACENT = [new Vec3(0, -1, 0), new Vec3(0, 1, 0), new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)];
const running = new WeakSet();
const memories = new WeakMap();
const LIFECYCLE_EPOCH = Symbol.for('ai-vtuber.minecraft.lifecycleEpoch');
// Bot-owned anchor survives idle skill-module reloads. It does not claim to
// survive a new bot process or reconnect to a different world.
const HOME_ANCHOR = Symbol.for('ai-vtuber.minecraft.homeAnchor');
const RESOURCE_MEMORY_TTL_MS = 60000;
const integer = (minimum, maximum) => ({ type: 'integer', minimum, maximum });
const variant = (action, fields = {}) => ({ type: 'object', additionalProperties: false, required: ['action', ...Object.keys(fields)], properties: { action: { const: action }, ...fields } });
const SURVIVAL_ACTION_SCHEMA = { oneOf: [
  ...extendedActions.schemas,
  ...['observe', 'eat', 'flee', 'build_portal', 'enter_portal', 'collect_water', 'place_water'].map(a => variant(a)),
  variant('dig_staircase', { direction: { enum: ['north', 'south', 'east', 'west'] }, steps: integer(1, 8) }),
  variant('explore', { direction: { enum: Object.keys(DIRECTIONS) }, distance: integer(8, 48) }),
  variant('gather_wood', { count: integer(1, 12) }),
  variant('craft', { item: { type: 'string', minLength: 1, maxLength: 128 }, count: integer(1, 16) }),
  variant('mine', { resource: { enum: Object.keys(RESOURCES) }, count: integer(1, 16) }),
  variant('smelt', { item: { enum: Object.keys(SMELT_OUTPUT) }, count: integer(1, 8) }),
  { ...variant('hunt', { count: integer(1, 3) }), properties: { ...variant('hunt', { count: integer(1, 3) }).properties, animal: { enum: ['cow', 'pig', 'sheep', 'chicken'] } } },
  variant('build_home', { count: integer(1, 8) }),
  variant('furnish_home', { item: { enum: ['bed', 'chest', 'torch', 'door', 'crafting_table', 'furnace'] } })
] };

function validateAction(action) {
  if (!action || typeof action !== 'object' || Array.isArray(action)) throw new Error('Action must be a JSON object');
  const schema = SURVIVAL_ACTION_SCHEMA.oneOf.find(s => s.properties.action.const === action.action);
  if (!schema || Object.keys(action).some(k => !schema.properties[k]) || schema.required.some(k => !(k in action))) throw new Error('Unknown action, extra fields, or missing required fields');
  for (const [key, rule] of Object.entries(schema.properties)) {
    if (!(key in action) && !schema.required.includes(key)) continue;
    const value = action[key];
    if (rule.type === 'string' && (typeof value !== 'string' || value.length < (rule.minLength || 0) || value.length > rule.maxLength)) throw new Error('Invalid string field ' + key);
    const display = (['string', 'number', 'boolean'].includes(typeof value) || value === null ? JSON.stringify(value) : `<${typeof value}>`).slice(0, 48);
    if (rule.enum && !rule.enum.includes(value)) {
      const prefix = `Invalid ${key}=${display}. Allowed: `;
      let allowed = rule.enum.join(',');
      if (prefix.length + allowed.length > 240) {
        const suffix = ',... (full enum in schema)';
        const visible = [];
        for (const entry of rule.enum) { if (prefix.length + [...visible, entry].join(',').length + suffix.length > 240) break; visible.push(entry); }
        allowed = visible.join(',') + suffix;
      }
      throw new Error(prefix + allowed);
    }
    if (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) throw new Error(`Invalid ${key}=${display}; integer range ${rule.minimum}..${rule.maximum}`);
  }
  return { ...action };
}
function inventory(bot) { return bot.inventory.items().map(({ name, count }) => ({ name, count })); }
function toolStatus(item) {
  let used = null, maximum = null;
  try { if (Number.isFinite(item.durabilityUsed)) used = item.durabilityUsed; } catch {}
  if (Number.isFinite(item.maxDurability) && item.maxDurability > 0) maximum = item.maxDurability;
  const known = used !== null && maximum !== null;
  return { name: item.name, durabilityUsed: used, maxDurability: maximum, remaining: known ? Math.max(0, maximum - used) : null, durabilityStatus: known ? 'known' : 'unknown' };
}
function count(bot, name) { return bot.inventory.items().filter(i => i.name === name).reduce((n, i) => n + i.count, 0); }
function foodOptions(bot) {
  const items = bot.inventory.items().filter(item => item.count > 0);
  const normal = FOODS.map(name => items.find(item => item.name === name)).find(Boolean) || (expanded && items.find(i => bot.registry.foodsByName?.[i.name]));
  const emergency = expanded || bot.health <= 6 || bot.food <= 6;
  const fallback = !normal && emergency && items.find(item => item.name === 'rotten_flesh');
  const selected = normal || fallback;
  const full = bot.food >= 20;
  return { canEat: !full && !!selected, selectedItem: selected?.name || null, emergencyFallback: !!fallback,
    risk: fallback ? 'hunger_effect_possible' : null,
    blockedReason: full ? 'already_full' : selected ? null : items.some(item => item.name === 'rotten_flesh') ? 'rotten_flesh_requires_health_at_most_6_or_food_at_most_6' : 'no_supported_food',
    rottenFlesh: { count: count(bot, 'rotten_flesh'), edibleInEmergency: emergency, smeltable: false } };
}
function position(p) { return p && { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, z: Math.round(p.z * 10) / 10 }; }
function resourceMemory(bot) {
  let memory = memories.get(bot);
  if (!memory) { memory = { visited: [], failures: [] }; memories.set(bot, memory); }
  const scope = `${bot.game?.dimension || ''}:${bot[LIFECYCLE_EPOCH] || 0}`;
  if (memory.resourceScope !== scope) { memory.resourceScope = scope; memory.resourceAttempts = new Map(); }
  return memory.resourceAttempts;
}
function resourceKey(block) { return `${block.name}:${block.position.x},${block.position.y},${block.position.z}`; }
function rememberResourceAttempt(bot, block, details) {
  const entries = resourceMemory(bot), key = resourceKey(block);
  const entry = { name: block.name, position: position(block.position), from: position(bot.entity.position), at: Date.now(), ...details };
  entries.delete(key); entries.set(key, entry);
  while (entries.size > 128) entries.delete(entries.keys().next().value);
}
function resourceReachability(bot, block, now = Date.now()) {
  const attempt = resourceMemory(bot).get(resourceKey(block));
  if (!attempt) return { status: 'unknown', reason: 'not_checked' };
  const ageMs = Math.max(0, now - attempt.at);
  const stale = ageMs > RESOURCE_MEMORY_TTL_MS || bot.entity.position.distanceTo(attempt.from) > 4;
  return { status: stale ? 'unknown' : attempt.status, reason: stale ? 'previous_check_stale' : attempt.reason,
    ...(stale ? { previousStatus: attempt.status } : {}), outcome: attempt.outcome, from: attempt.from, checkedAt: attempt.at, ageMs, stale };
}
function observedResource(bot, block) {
  return { name: block.name, position: position(block.position), distance: Math.round(distance(bot, block.position)), reachability: resourceReachability(bot, block) };
}
function scanResources(bot) {
  // Alternate/mock bot adapters without the native loaded-column interface
  // retain their supplied findBlocks implementation.
  if (typeof bot.world?.getColumn !== 'function') return null;
  const logs=Object.keys(bot.registry.blocksByName).filter(n=>/_log$/.test(n)&&!n.startsWith('stripped_'));
  return resourceScan.ensure(bot,[...new Set([...Object.values(RESOURCES).flat(),...logs])]);
}
function observedCandidates(bot, scan, names, limit) {
  return scan ? resourceScan.candidates(bot,scan,names,limit).filter(b=>exposed(bot,b)) : nearby(bot,names,40,limit,true);
}
async function harvestCandidates(ctx,names) {
  const {bot}=ctx;let scan=scanResources(bot);
  if(!scan)return nearby(bot,names,40,80,true);
  const stop=()=>resourceScan.cancel(bot);ctx.signal.addEventListener('abort',stop,{once:true});
  try {
    const until=Date.now()+10000;
    while(true){
      ctx.safe();scan=scanResources(bot);
      const found=observedCandidates(bot,scan,names,80);
      if(found.length)return found;
      if(scan.error)throw new Error(`Resource scan failed: ${scan.error}`);
      if(scan.complete){if(scan.unknownCells)throw new Error('No exposed candidates in scanned loaded cells; unloaded terrain remains unknown');return [];}
      if(Date.now()>=until)throw new Error('Resource scan still pending; empty result is not evidence of no resources');
      await ctx.sleep(50);
    }
  }finally{ctx.signal.removeEventListener('abort',stop);}
}
function distance(bot, p) { return bot.entity.position.distanceTo(p); }
function isAir(block) { return !!block && AIR.has(block.name); }
function solid(block) { return !!block && block.boundingBox === 'block' && !DANGER.has(block.name) && !['sand', 'gravel'].includes(block.name); }
function exposed(bot, block) { return ADJACENT.some(d => isAir(bot.blockAt(block.position.plus(d)))); }
function nearby(bot, names, maxDistance = 32, limit = 30, exposedOnly = false) {
  const ids = names.map(n => bot.registry.blocksByName[n]?.id).filter(Number.isInteger);
  if (!ids.length) return [];
  // Keep the numeric matcher for section-palette pruning. The installed
  // findBlocks applies useExtraInfo's predicate before its count truncation;
  // a position-dependent matching function would break palette pruning.
  const origin = bot.entity.position.floored();
  return bot.findBlocks({ matching: ids, maxDistance, count: limit,
    ...(exposedOnly ? { useExtraInfo: block => !!block?.position && block.position.distanceTo(origin) <= maxDistance && exposed(bot, block) } : {})
  }).map(p => bot.blockAt(p)).filter(b => b && (!exposedOnly || exposed(bot, b))).sort((a, b) => distance(bot, a.position) - distance(bot, b.position));
}
function threats(bot, range = 16) {
  return Object.values(bot.entities || {}).map(e => entityView(bot, e)).filter(e => e.position && HOSTILES.has(e.name) && distance(bot, e.position) <= range).map(e => ({ id: e.id, name: e.name, distance: Math.round(distance(bot, e.position) * 10) / 10, position: position(e.position) })).sort((a, b) => a.distance - b.distance);
}
function craftingOptions(bot) {
  if (!bot.recipesFor || !bot.recipesAll) return { craftable: [], recipeHints: [] };
  const craftable = [], recipeHints = [], alternateHints = [];
  for (const item of CRAFT_ITEMS) {
    const log = bot.inventory.items().find(i => /_log$/.test(i.name));
    const name = resolveCraftName(bot, item) || (item === 'planks' ? 'oak_planks' : item === 'bed' ? 'white_bed' : item === 'door' ? 'oak_door' : item);
    const id = bot.registry.itemsByName[name]?.id;
    if (id == null) continue;
    const usable = bot.recipesFor(id, null, 1, true);
    if (usable.length) { craftable.push({ item, outputPerCraft: usable[0].result.count, requiresTable: !!usable[0].requiresTable }); continue; }
    const ownsBed = bot.inventory.items().some(i => i.count > 0 && /_bed$/.test(i.name));
    const possibilities = bot.recipesAll(id, null, true).map(recipe => {
      const missing = (recipe.delta || []).filter(d => d.count < 0).map(d => {
        const ingredient = bot.registry.items[d.id]?.name;
        return { name: ingredient, count: Math.max(0, -d.count - count(bot, ingredient)) };
      }).filter(d => d.count > 0);
      const recolor = (recipe.delta || []).some(d => d.count < 0 && /_bed$/.test(bot.registry.items[d.id]?.name || ''));
      return { missing, recolor, total: missing.reduce((n, d) => n + d.count, 0) };
    }).filter(p => item !== 'bed' || ownsBed || !p.recolor).sort((a, b) => a.total - b.total);
    const seen = new Set(), distinct = possibilities.filter(p => {
      const key = p.missing.map(d => `${d.name}:${d.count}`).sort().join('|');
      if (seen.has(key)) return false;
      seen.add(key); return true;
    });
    if (distinct[0]) recipeHints.push({ item, missing: distinct[0].missing, oneRecipeExample: true });
    // Stone tools/furnaces also accept blackstone. Preserve the cheapest
    // example, but don't let registry tie order hide ordinary cobblestone
    // behind two less common variants. Only select an actual returned recipe.
    const ordinaryStoneAlternative = ['stone_pickaxe', 'furnace'].includes(item) &&
      !distinct[0]?.missing.some(d => d.name === 'cobblestone') ? distinct.slice(1).find(p => p.missing.some(d => d.name === 'cobblestone')) : null;
    const alternative = ordinaryStoneAlternative || distinct[1];
    if (alternative) alternateHints.push({ item, missing: alternative.missing, oneRecipeExample: true });
  }
  const coreHints = new Set(['stick', 'crafting_table', 'wooden_pickaxe', 'stone_pickaxe', 'furnace', 'iron_pickaxe', 'diamond_pickaxe', 'bucket', 'flint_and_steel', 'torch', 'bed', 'chest', 'door']);
  // Preserve one example for every core item before spending the remaining
  // bounded hint slots on a second, genuinely different recipe alternative.
  const ordinaryStoneHint = hint => ['stone_pickaxe', 'furnace'].includes(hint.item) && hint.missing.some(d => d.name === 'cobblestone');
  alternateHints.sort((a, b) => Number(ordinaryStoneHint(b)) - Number(ordinaryStoneHint(a)));
  return { craftable, recipeHints: [...recipeHints, ...alternateHints].filter(hint => coreHints.has(hint.item)).slice(0, 16) };
}
function localTerrainDiagnostics(bot) {
  if (!bot.entity?.position || !bot.blockAt) return null;
  const origin = bot.entity.position.floored(), blocks = [];
  // Fixed, loaded-local reads only. Omitted air cells are known air; unloaded
  // cells stay explicit. compactObservation deliberately excludes diagnostics.
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -4; dy <= 2; dy++) {
    const p = origin.offset(dx, dy, dz), block = bot.blockAt(p);
    if (block?.name === 'air' || block?.name === 'cave_air' || block?.name === 'void_air') continue;
    blocks.push({ ...position(p), name: block?.name || 'unloaded', boundingBox: block?.boundingBox || null, shapes: block?.shapes || null });
  }
  const movement = bot.pathfinder?.movements;
  return { origin: position(origin), bounds: { horizontalRadius: 2, minDy: -4, maxDy: 2 }, reads: 175, knownAirOmitted: true, onGround: bot.entity.onGround,
    movements: movement ? { canDig: movement.canDig, maxDropDown: movement.maxDropDown, allowParkour: movement.allowParkour, allowSprinting: movement.allowSprinting } : null, blocks };
}
function entityDiagnostics(bot) {
  if (!bot.entity?.position) return null;
  const entities = Object.values(bot.entities || {}).filter(e => e !== bot.entity && e.position && distance(bot, e.position) <= 48)
    .sort((a, b) => distance(bot, a.position) - distance(bot, b.position));
  return { radius: 48, loadedOnly: true, count: entities.length, truncated: entities.length > 128,
    entities: entities.slice(0, 128).map(e => ({ id: e.id, name: e.name ?? null, displayName: e.displayName ?? null, type: e.type ?? null, entityType: e.entityType ?? null,
      position: position(e.position), distance: Math.round(distance(bot, e.position) * 10) / 10,
      vehicle: e.vehicle ? { id: e.vehicle.id, name: e.vehicle.name, position: position(e.vehicle.position), loaded: bot.entities?.[e.vehicle.id] === e.vehicle } : null, passengers: (e.passengers || []).map(p => ({ id: p.id, name: p.name })),
      equipment: (e.equipment || []).map(item => item ? { name: item.name, count: item.count } : null) })) };
}
function observe(bot) {
  if (!bot.entity?.position) return { connected: false };
  const memory = memories.get(bot) || { visited: [], failures: [] };
  const resources = {};
  const scan=scanResources(bot);
  for (const [name, names] of Object.entries(RESOURCES)) resources[name] = observedCandidates(bot,scan,names,24).slice(0, 4).map(b => observedResource(bot, b));
  const logs = Object.keys(bot.registry.blocksByName).filter(n => /_log$/.test(n) && !n.startsWith('stripped_'));
  resources.wood = observedCandidates(bot,scan,logs,30).slice(0, 4).map(b => observedResource(bot, b));
  const hazards = nearby(bot, [...DANGER], 6, 12).map(b => ({ name: b.name, position: position(b.position) }));
  const entityList = Object.values(bot.entities || {}).filter(e => e !== bot.entity && e.position && distance(bot, e.position) <= 32);
  return { capabilityPolicy: 'expanded-survival', entities: Object.values(bot.entities || {}).filter(e=>e !== bot.entity && e.position).sort((a,b)=>distance(bot,a.position)-distance(bot,b.position)).slice(0,64).map(e=>({id:e.id,name:e.name,type:e.type,position:position(e.position),distance:distance(bot,e.position)})), connected: true, mode: bot.game?.gameMode, dimension: bot.game?.dimension, health: bot.health, food: bot.food, oxygen: bot.oxygenLevel, position: position(bot.entity.position), timeOfDay: bot.time?.timeOfDay, isNight: bot.time?.timeOfDay >= 12500 && bot.time?.timeOfDay <= 23500,
    resourceScan: scan ? resourceScan.status(scan) : null,
    inventory: inventory(bot), foodOptions: foodOptions(bot), inventoryDiagnostics: inventoryDiagnostics(bot), terrainDiagnostics: localTerrainDiagnostics(bot), entityDiagnostics: entityDiagnostics(bot), tools: bot.inventory.items().filter(i => /_(pickaxe|axe|shovel|hoe|sword)$/.test(i.name) || ['shears', 'flint_and_steel', 'bow', 'crossbow', 'fishing_rod'].includes(i.name)).map(toolStatus), heldItem: bot.heldItem ? { name: bot.heldItem.name, durabilityUsed: bot.heldItem.durabilityUsed } : null,
    // Include the same loaded-entity radius enforced by emergency hunt/explore.
    equipment: (bot.entity.equipment || []).filter(Boolean).map(i => ({ name: i.name, durabilityUsed: i.durabilityUsed })), threats: threats(bot, 24), hazards, resources,
    animals: entityList.filter(e => PREY.has(e.name)).sort((a,b) => distance(bot,a.position)-distance(bot,b.position)).slice(0, 8).map(e => {
      const dx=e.position.x-bot.entity.position.x, dz=e.position.z-bot.entity.position.z;
      const angle=(Math.atan2(dx,-dz)*180/Math.PI+360)%360;
      return { id:e.id, name:e.name, distance:Math.round(distance(bot,e.position)*10)/10, position:position(e.position),
        direction:['north','northeast','east','southeast','south','southwest','west','northwest'][Math.round(angle/45)%8],
        emergencyHuntCandidate:e.name!=='chicken' && distance(bot,e.position)<=16,
        reachability:{status:'unknown',reason:'hunt_route_not_checked'} };
    }),
    movementThreatPolicy: { observationRadius:24, meleeExclusionRadius:13, rangedExclusionRadius:25, nearbyMovementThreats:threats(bot,26), note:'An empty 24-block threats list does not imply no 25-block ranged movement exclusion. Already inside a forbidden radius: only supported adjacent steps strictly away from inside threats; the entire edge stays outside other hostile exclusion radii.' },
    emergencyHunt: { active:bot.health<=6, maxAnimalDistance:16, excludedAnimal:'chicken',
      hostilesWithin24:threats(bot,24).length, routeStatus:'not_checked',
      requirements:'Dry supported short route; no hostile within 24 blocks; stops on health loss. Candidate is not proof of reachability. Bare hands allowed; at most one animal.' },
    landmarks: { evidenceOnly: true, villageConfirmed: false,
      entities: entityList.filter(e => ['villager', 'iron_golem'].includes(e.name)).slice(0, 6).map(e => ({ name: e.name, position: position(e.position), distance: Math.round(distance(bot, e.position)) })),
      blocks: nearby(bot, ['bell', 'hay_block', ...Object.keys(bot.registry.blocksByName).filter(name => /_bed$/.test(name))], 32, 12).filter(b => exposed(bot, b)).slice(0, 8).map(b => ({ name: b.name, position: position(b.position), distance: Math.round(distance(bot, b.position)) })) },
    home: homeStatus(bot),
    stations: nearby(bot, ['crafting_table', 'furnace', 'nether_portal', 'chest', 'torch', ...Object.keys(bot.registry.blocksByName).filter(n => /_bed$/.test(n))], 32, 12).map(b => ({ name: b.name, position: position(b.position) })),
    fluids: { water: nearby(bot, ['water'], 24, 24).filter(isFluidSource).slice(0, 3).map(b => ({ position: position(b.position), distance: Math.round(distance(bot, b.position)) })), lava: nearby(bot, ['lava'], 24, 24).filter(isFluidSource).slice(0, 3).map(b => ({ position: position(b.position), distance: Math.round(distance(bot, b.position)) })) },
    ...craftingOptions(bot), recentExploration: memory.visited.slice(-8), recentFailures: memory.failures.slice(-5),
    recentResourceAttempts: [...resourceMemory(bot).values()].slice(-16).reverse().map(attempt => ({ ...attempt, reachability: resourceReachability(bot, attempt) })), portalSite: memory.portalSite || null };
}
function halt(bot) {
  try { bot.pathfinder.setGoal(null); } catch {}
  try { bot.clearControlStates(); } catch {}
  try { bot.stopDigging(); } catch {}
  try { bot.deactivateItem(); } catch {}
  try { if (bot.currentWindow) bot.closeWindow(bot.currentWindow); } catch {}
}
function setSafeMovements(bot) {
  const movement = new Movements(bot);
  // Keep native navigation capabilities enabled: dig obstructions, pillar and jump.
  // Retain the native inventory-backed scaffolding materials (dirt/cobblestone).
  movement.canDig = true; movement.allow1by1towers = true; movement.allowParkour = true;
  movement.allowSprinting = expanded || bot.food > 10; singleBlockDescents(movement, bot); movement.infiniteLiquidDropdownDistance = false;
  for (const name of [...DANGER, ...(expanded ? [] : ['water'])]) { const id = bot.registry.blocksByName[name]?.id; if (id != null) movement.blocksToAvoid.add(id); }
  if (expanded) { bot.pathfinder.setMovements(movement); return movement; }
  // Neighbor generation tests many step cells synchronously. Reuse one live
  // hostile sample for that node instead of scanning every loaded entity for
  // every cell. The next node samples again; there is no timer/stale cache.
  let neighborThreats = null, neighborOrigin = null;
  const movementThreats = () => Object.values(bot.entities || {}).map(e=>entityView(bot,e)).filter(e=>e.position && HOSTILES.has(e.name) && distance(bot,e.position)<=64);
  const radius = e => RANGED_THREATS.has(e.name) ? 25 : 13;
  const separation = (p,e) => Math.hypot(p.x-e.position.x,p.y-e.position.y,p.z-e.position.z);
  const edgeSeparation = (a,b,e) => {
    const dx=b.x-a.x,dy=b.y-a.y,dz=b.z-a.z, length2=dx*dx+dy*dy+dz*dz;
    const t=length2?Math.max(0,Math.min(1,((e.position.x-a.x)*dx+(e.position.y-a.y)*dy+(e.position.z-a.z)*dz)/length2)):0;
    return separation({x:a.x+t*dx,y:a.y+t*dy,z:a.z+t*dz},e);
  };
  const getNeighbors = movement.getNeighbors.bind(movement);
  movement.getNeighbors = node => {
    const previous = neighborThreats, previousOrigin = neighborOrigin;
    neighborThreats = movementThreats(); neighborOrigin = node;
    try {
      const inside = neighborThreats.filter(e=>separation(node,e)<radius(e));
      return getNeighbors(node).filter(next=>{
        if(!inside.length) return neighborThreats.every(e=>edgeSeparation(node,next,e)>=radius(e));
        // Recovery is one supported adjacent edge, never a gap/parkour jump
        // or a license to cross another hostile's exclusion boundary.
        if(!emergencyExploreEdge(bot,node,next)) return false;
        return neighborThreats.every(e=>{
          const before=separation(node,e), after=separation(next,e);
          return before<radius(e) ? after>before+0.01 : edgeSeparation(node,next,e)>=radius(e);
        });
      });
    } finally { neighborThreats=previous; neighborOrigin=previousOrigin; }
  };
  movement.exclusionAreasStep.push(block => !block?.position ? 100 : (neighborThreats || movementThreats()).some(e => {
    // Bodies/headroom aren't Move endpoints. For an already-enclosed origin,
    // defer this enemy's exclusion to the strict edge check above.
    if(neighborOrigin && separation(neighborOrigin,e)<radius(e)) return false;
    return separation(block.position,e)<radius(e);
  }) ? 100 : 0);
  bot.pathfinder.setMovements(movement);
  return movement;
}
function createContext(bot, action, { signal, log = () => {}, timeoutMs = 180000 } = {}) {
  const controller = new AbortController();
  const pending = new Set();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  const check = () => {
    combined.throwIfAborted();
    if (!bot.entity || (bot.health <= 0 && action.action !== 'respawn')) throw new Error('Bot died or disconnected');
    if (!extendedActions.names.has(action.action) && action.action !== 'observe' && bot.game?.gameMode !== 'survival') throw new Error('Survival skills require survival mode');
  };
  const abort = () => halt(bot);
  combined.addEventListener('abort', abort, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('Skill deadline exceeded')), Math.max(1, Math.min(timeoutMs, 240000)));
  const onDeath = () => controller.abort(new Error('Bot died'));
  const onEnd = () => controller.abort(new Error('Bot disconnected'));
  bot.once?.('death', onDeath); bot.once?.('end', onEnd);
  const step = async (name, fn, ms = 25000) => {
    check(); log({ event: 'skill_step', action: action.action, step: name });
    let timeout, onAbort;
    try {
      const operation = Promise.resolve().then(() => { check(); return fn(); });
      pending.add(operation);
      operation.then(() => pending.delete(operation), () => pending.delete(operation));
      const result = await Promise.race([
        operation,
        new Promise((_, reject) => {
          onAbort = () => reject(combined.reason || new Error('Cancelled'));
          combined.addEventListener('abort', onAbort, { once: true });
          timeout = setTimeout(() => controller.abort(new Error(`${name}: timeout`)), ms);
          if (combined.aborted) onAbort();
        })
      ]);
      check(); return result;
    } finally { clearTimeout(timeout); combined.removeEventListener('abort', onAbort); }
  };
  const sleep = ms => step('wait', () => new Promise(resolve => setTimeout(resolve, ms)), ms + 1000);
  const until = async (name, predicate, ms = 6000) => {
    const untilTime = Date.now() + ms;
    while (!predicate()) { check(); if (Date.now() >= untilTime) throw new Error(`${name}: server verification failed`); await sleep(150); }
  };
  const safe = () => {
    check();
    if (expanded) return;
    const danger = threats(bot, 10);
    if (danger.length) throw new Error(`Unsafe: ${danger[0].name} within ${danger[0].distance} blocks; flee first`);
    if (bot.health <= 6) throw new Error('Unsafe: critical health; eat or flee first');
  };
  const goto = async (goal, ms = expanded ? 60000 : 20000) => {
    check();
    const pathfinder = bot.pathfinder;
    const previousThink = pathfinder.thinkTimeout, previousTick = pathfinder.tickTimeout;
    if (expanded) {
      // Path search has its own budget, separate from the walking deadline.
      // Yield frequently so observation, cancellation and physics stay responsive.
      pathfinder.thinkTimeout = Math.min(15000, ms);
      pathfinder.tickTimeout = 5;
    }
    try { await step('navigate', () => pathfinder.goto(goal), ms); }
    finally { pathfinder.thinkTimeout = previousThink; pathfinder.tickTimeout = previousTick; }
  };
  return { bot, action, check, step, sleep, until, safe, goto, log, signal: combined,
    abort(reason) { if (!combined.aborted) controller.abort(reason); },
    drain() { return Promise.allSettled([...pending]); },
    hasPending() { return pending.size > 0; },
    dispose() { clearTimeout(timer); combined.removeEventListener('abort', abort); bot.removeListener?.('death', onDeath); bot.removeListener?.('end', onEnd); } };
}
function validDig(bot, block) {
  if (!block || !block.diggable || !bot.canDigBlock(block)) return false;
  if (expanded) return true;
  const feet = bot.entity.position.floored();
  if (block.position.x === feet.x && block.position.z === feet.z && block.position.y < feet.y) return false;
  // Never open an adjacent liquid, fire, falling column, or dig straight above the head.
  if (block.position.x === feet.x && block.position.z === feet.z && block.position.y >= feet.y + 2) return false;
  return !ADJACENT.some(d => { const b = bot.blockAt(block.position.plus(d)); return !b || ['water', 'lava'].includes(b.name) || DANGER.has(b.name) || (d.y === 1 && ['sand', 'gravel'].includes(b.name)); });
}
async function equipFor(ctx, block) {
  const { bot } = ctx;
  const candidates = bot.inventory.items().filter(i => /_(pickaxe|axe|shovel)$/.test(i.name));
  const suitable = candidates.filter(i => !block.harvestTools || block.harvestTools[i.type]);
  const ranked = suitable.sort((a, b) => block.digTime(a.type, false, false, false) - block.digTime(b.type, false, false, false));
  if (block.harvestTools && !ranked.length) throw new Error(`Missing correct tool for ${block.name}`);
  if (ranked[0]) await ctx.step('equip_tool', () => bot.equip(ranked[0], 'hand'));
  else if (bot.heldItem && /_pickaxe$/.test(bot.heldItem.name)) await ctx.step('unequip_tool', () => bot.unequip('hand'));
}
function directlyDiggable(bot, block) {
  if (!validDig(bot, block) || !bot.world?.raycast) return false;
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
  const ray = block.position.offset(0.5, 0.5, 0.5).minus(eye);
  if (ray.norm() < 0.01) return false;
  const hit = bot.world.raycast(eye, ray.unit(), ray.norm());
  return !!hit?.position?.equals(block.position);
}
async function settledHarvestBlock(ctx, block) {
  const { bot } = ctx;
  // Pathfinder may finish while a final jump is still airborne. Mineflayer
  // snapshots that state into a fivefold dig duration before looking at a block.
  if (bot.entity.onGround === false) {
    await ctx.until('harvest landing', () => { ctx.safe(); return bot.entity.onGround === true; }, 1500);
  }
  ctx.safe();
  const current = bot.blockAt(block.position);
  if (!current || current.name !== block.name || !directlyDiggable(bot, current)) throw new Error('Harvest target no longer safely diggable after landing');
  ctx.log({ event: 'harvest_dig_start', position: position(bot.entity.position), target: position(current.position),
    onGround: bot.entity.onGround, heldItem: bot.heldItem?.name || null,
    expectedDigMs: typeof bot.digTime === 'function' ? bot.digTime(current) : null });
  return current;
}
class HarvestGoal extends goals.Goal {
  constructor(block, bot) { super(); this.position = block.position.clone(); this.bot = bot; this.approaches = null; this.approachKeys = null; }
  prepare() {
    const endpoints = [];
    // Enumerate only the finite dig-reach volume, before searching the world.
    // Exposed logs in a canopy often have no supported line-of-sight endpoint.
    // Such a target must not consume a whole A* continuation budget.
    for (let dx = -4; dx <= 4; dx++) for (let dz = -4; dz <= 4; dz++) for (let dy = -5; dy <= 1; dy++) {
      const p = this.position.offset(dx, dy, dz);
      if (emergencyHuntStand(this.bot, p) && this.canReachFrom(p)) endpoints.push(p);
    }
    this.approaches = endpoints;
    this.approachKeys = new Set(endpoints.map(p => p.toString()));
    return endpoints;
  }
  heuristic(node) {
    if (!this.approaches) return Math.max(0, node.distanceTo(this.position) - 3);
    let best = Infinity;
    for (const p of this.approaches) best = Math.min(best, node.distanceTo(p));
    return best;
  }
  isEnd(node) {
    if (this.approachKeys && !this.approachKeys.has(new Vec3(node.x, node.y, node.z).toString())) return false;
    return this.canReachFrom(node);
  }
  canReachFrom(node) {
    const p = this.position;
    if (node.x === p.x && node.z === p.z && (p.y < node.y || p.y >= node.y + 2)) return false;
    const eye = new Vec3(node.x + 0.5, node.y + (this.bot.entity.eyeHeight || 1.62), node.z + 0.5);
    const ray = p.offset(0.5, 0.5, 0.5).minus(eye);
    if (ray.norm() < 0.01 || ray.norm() > 4.5 || !this.bot.world?.raycast) return false;
    const hit = this.bot.world.raycast(eye, ray.unit(), ray.norm());
    return !!hit?.position?.equals(p);
  }
}
async function harvestRoute(ctx, block, budget, options = {}) {
  const { bot } = ctx, goal = options.goal || (expanded ? new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2) : new HarvestGoal(block, bot));
  const totalBudgetMs = expanded ? 10000 : 800, wallBudgetMs = expanded ? 12000 : 3000;
  if (!bot.pathfinder.getPathFromTo) return { confirmed: false, reason: 'path preflight unavailable' };
  if (budget.cpuMs >= totalBudgetMs || budget.probes >= 12) return { confirmed: false, reason: 'search budget exhausted; reachability unconfirmed' };
  let generator, result, cpuMs = 0, candidateBudgetMs = expanded ? 2000 : 24, continued = false, slices = 0, maxSliceMs = 0;
  const wallStarted = performance.now();
  try {
    const started = performance.now();
    if (goal instanceof HarvestGoal) {
      const endpoints = goal.prepare();
      cpuMs += performance.now() - started;
      ctx.log({ event: 'harvest_approach_endpoints', position: position(block.position), count: endpoints.length, checks: 567, cpuMs: Math.round(cpuMs * 10) / 10 });
      if (!endpoints.length) return { confirmed: false, searched: true, status: 'unknown', reason: 'no loaded dry supported dig-reach endpoint with line of sight; reachability unconfirmed, exposed does not mean reachable' };
    }
    // Empty endpoint sets already return above and spend measured CPU, but
    // must not consume an A* probe: canopy-only targets otherwise exhaust all
    // twelve probes without allowing later supported candidates any search.
    if (totalBudgetMs - budget.cpuMs - cpuMs < 8) return { confirmed: false, searched: true, status: 'unknown', reason: 'search budget exhausted; reachability unconfirmed' };
    budget.probes++;
    const searchStarted = performance.now();
    // A* timeout includes time spent yielding, unlike our measured CPU budget.
    generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, bot.entity.position, goal, { timeout: wallBudgetMs, tickTimeout: 5, optimizePath: false });
    cpuMs += performance.now() - searchStarted;
    while (totalBudgetMs - budget.cpuMs - cpuMs >= 8 && performance.now() - wallStarted < wallBudgetMs) {
      if (candidateBudgetMs - cpuMs < 8) {
        // Preserve one frontier instead of throwing every partial search away.
        // Only one candidate per skill may borrow this continuation allowance.
        if (result?.status !== 'partial' || budget.continuationUsed) break;
        budget.continuationUsed = true; continued = true; candidateBudgetMs = expanded ? 5000 : 600;
      }
      ctx.safe();
      const sliceStart = performance.now();
      const next = generator.next();
      const sliceMs = performance.now() - sliceStart;
      cpuMs += sliceMs; slices++; maxSliceMs = Math.max(maxSliceMs, sliceMs);
      result = next.value?.result;
      // Yield between A* slices; neither preflight nor cleanup changes live goals.
      await ctx.sleep(0);
      ctx.safe();
      if (!result || result.status !== 'partial') break;
    }
  } finally {
    generator?.return?.(); budget.cpuMs += cpuMs;
    ctx.log({ event: 'candidate_path_preflight', purpose: options.purpose || 'harvest', position: position(block.position), status: result?.status || 'unconfirmed', cpuMs: Math.round(cpuMs * 10) / 10, totalCpuMs: Math.round(budget.cpuMs * 10) / 10, totalCpuBudgetMs: totalBudgetMs, candidateCpuBudgetMs: candidateBudgetMs, budgetOverrun: cpuMs > candidateBudgetMs || budget.cpuMs > totalBudgetMs, probes: budget.probes, continued, slices, maxSliceMs: Math.round(maxSliceMs * 10) / 10, wallMs: Math.round((performance.now() - wallStarted) * 10) / 10, visitedNodes: result?.visitedNodes });
  }
  if (result?.status !== 'success' || cpuMs > candidateBudgetMs || budget.cpuMs > totalBudgetMs || performance.now() - wallStarted > wallBudgetMs) return { confirmed: false, searched: slices > 0, status: result?.status === 'noPath' ? 'no_path_found' : 'unknown', reason: result?.status === 'noPath' ? 'no safe path found with current movement constraints' : 'search budget/timeout; reachability unconfirmed' };
  const path = result.path || [];
  let length = 0, previous = bot.entity.position;
  for (const node of path) {
    if (!expanded && options.naturalApproach) {
      const from = previous.floored(), dx = Math.abs(node.x - from.x), dz = Math.abs(node.z - from.z), dy = Math.abs(node.y - from.y);
      if (dx > 1 || dz > 1 || dy > 1 || (dy && !dx && !dz) || node.parkour) return { confirmed: false, searched: true, status: 'unknown', reason: 'high target requires contiguous natural steps, no towers or jumps' };
    }
    length += previous.distanceTo(node); previous = node;
    if (!expanded && (node.toBreak?.length || node.toPlace?.length)) return { confirmed: false, searched: true, status: 'unknown', reason: 'path requires forbidden digging/placing' };
    if (!expanded && options.dryPath && !emergencyHuntStand(bot, new Vec3(node.x, node.y, node.z))) return { confirmed: false, searched: true, status: 'unknown', reason: 'path lacks dry supported terrain' };
  }
  if (length > (options.pathLimit || (expanded ? 128 : 32)) || !goal.isEnd(path.at(-1) || bot.entity.position.floored())) return { confirmed: false, searched: true, status: 'unknown', reason: 'no verified endpoint within bounded route' };
  return { confirmed: true, searched: true, status: 'path_verified', goal, path: path.map(p => new Vec3(p.x, p.y, p.z)), pathLength: Math.round(length * 10) / 10 };
}
function matchingDrops(bot, names) {
  const drops = [];
  for (const entity of Object.values(bot.entities || {})) {
    if (!entity.position || typeof entity.getDroppedItem !== 'function') continue;
    try { const item = entity.getDroppedItem(); if (item && names.includes(item.name) && item.count > 0) drops.push({ entity, name: item.name, count: item.count }); } catch {}
  }
  return drops;
}
async function collectHarvestDrop(ctx, block, names, prior, beforeDrops, searchBudget, pickupBudget) {
  const { bot } = ctx, started = Date.now(), attempted = new Set();
  const gained = () => names.reduce((sum, name) => sum + count(bot, name), 0) > prior;
  const remaining = Math.min(10000, 18000 - pickupBudget.elapsedMs);
  if (gained() || remaining <= 0 || pickupBudget.attempts >= 6) return;
  let attempts = 0;
  try {
    while (!gained() && Date.now() - started < remaining) {
      ctx.safe();
      const candidates = matchingDrops(bot, names).filter(drop => {
        const p = drop.entity.position, old = beforeDrops.get(drop.entity.id);
        return (!old || (old.name === drop.name && drop.count > old.count)) && !attempted.has(drop.entity.id) && p.distanceTo(bot.entity.position) <= 10 && Math.hypot(p.x - block.position.x - 0.5, p.z - block.position.z - 0.5) <= 3.5 && p.y >= block.position.y - 12 && p.y <= block.position.y + 2;
      }).sort((a, b) => a.entity.position.distanceTo(bot.entity.position) - b.entity.position.distanceTo(bot.entity.position));
      const drop = candidates.find(d => emergencyHuntStand(bot, d.entity.position));
      if (!drop) {
        // Metadata and falling entities can arrive after the dig acknowledgement.
        if (Date.now() - started >= 1800) return;
        await ctx.sleep(150); continue;
      }
      if (attempts >= 2 || pickupBudget.attempts >= 6) return;
      attempted.add(drop.entity.id); attempts++; pickupBudget.attempts++;
      const observedPosition = drop.entity.position.clone(), destination = observedPosition.floored();
      const route = await harvestRoute(ctx, { position: destination }, searchBudget, { goal: new goals.GoalBlock(destination.x, destination.y, destination.z), purpose: 'pickup', pathLimit: 12, dryPath: true });
      ctx.safe();
      const live = bot.entities[drop.entity.id];
      if (!route.confirmed || !live || live.position.distanceTo(observedPosition) > 1 || !live.position.floored().equals(destination) || !emergencyHuntStand(bot, live.position)) {
        ctx.log({ event: 'harvest_drop_unconfirmed', entityId: drop.entity.id, item: drop.name, reason: route.reason || 'drop moved/disappeared or unsafe' }); continue;
      }
      const timeLeft = remaining - (Date.now() - started);
      if (timeLeft < 500) return;
      ctx.log({ event: 'harvest_drop_approach', entityId: drop.entity.id, item: drop.name, sourceBlock: position(block.position), destination: position(destination), evidence: beforeDrops.has(drop.entity.id) ? 'nearby matching stack increased after dig' : 'nearby matching entity appeared after dig' });
      const guard = setInterval(() => { try { ctx.safe(); if (!emergencyHuntStand(bot, destination) || route.path.some(p => !emergencyHuntStand(bot, p))) throw new Error('Pickup route became unsafe'); } catch (error) { ctx.abort(error); } }, 150);
      try { await ctx.goto(route.goal, Math.min(6000, timeLeft)); } finally { clearInterval(guard); }
      ctx.safe();
      // Entity disappearance is not pickup confirmation; only inventory counts.
      const pickupUntil = Math.min(started + remaining, Date.now() + 1000);
      while (!gained() && Date.now() < pickupUntil) { ctx.safe(); await ctx.sleep(150); }
      ctx.log({ event: gained() ? 'harvest_inventory_gain_after_pickup' : 'harvest_drop_unconfirmed', entityId: drop.entity.id, item: drop.name, inventoryGain: names.reduce((sum, name) => sum + count(bot, name), 0) - prior, attribution: 'inventory delta only; individual drop origin not proven' });
    }
  } finally { pickupBudget.elapsedMs += Date.now() - started; }
}
async function harvest(ctx, blocks, expectedNames, wanted) {
  const { bot } = ctx;
  if (!blocks.length) throw new Error('No exposed resource candidates in loaded search radius; reachability not tested');
  if (blocks.every(block => block.harvestTools && !bot.inventory.items().some(item => item.count > 0 && block.harvestTools[item.type]))) {
    throw new Error(`Missing correct tool for ${blocks[0].name}; no route attempted`);
  }
  const before = expectedNames.reduce((n, name) => n + count(bot, name), 0);
  let dug = 0;
  const failures = [];
  const searchBudget = { cpuMs: 0, probes: 0 };
  const pickupBudget = { elapsedMs: 0, attempts: 0 };
  const pickupSearchBudget = { cpuMs: 0, probes: 0 };
  // Spend the same bounded search budget on low targets first. A higher
  // target may be reachable by a natural slope, but requires a full proof.
  const initialY = bot.entity.position.y;
  const ordered = [...blocks.filter(b => b.position.y <= initialY + 4), ...blocks.filter(b => b.position.y > initialY + 4)];
  for (const candidate of ordered) {
    if (expectedNames.reduce((n, name) => n + count(bot, name), 0) - before >= wanted) break;
    ctx.safe();
    const block = bot.blockAt(candidate.position);
    if (!block || block.name !== candidate.name || !exposed(bot, block)) continue;
    const naturalApproach = !expanded && block.position.y > bot.entity.position.y + 4;
    try {
      const directDig = !naturalApproach && directlyDiggable(bot, block);
      ctx.log({ event: 'candidate_target', block: block.name, position: position(block.position), directDig, naturalApproachRequired: naturalApproach });
      if (!directDig) {
        const route = await harvestRoute(ctx, block, searchBudget, { naturalApproach, dryPath: naturalApproach });
        ctx.check();
        if (route.searched) rememberResourceAttempt(bot, block, { status: route.status, reason: route.reason || 'bounded safe preflight succeeded', outcome: route.confirmed ? 'route_verified' : 'route_unconfirmed' });
        if (!route.confirmed) { failures.push(route.reason); ctx.log({ event: 'candidate_rejected', block: block.name, position: position(block.position), reason: route.reason }); continue; }
        await ctx.goto(route.goal, expanded ? 60000 : 14000);
      }
      ctx.safe();
      if (naturalApproach && !emergencyHuntStand(bot, bot.entity.position)) throw new Error('High target arrival lacks dry supported terrain');
      const current = bot.blockAt(block.position);
      if (!current || current.name !== block.name || !directlyDiggable(bot, current)) { rememberResourceAttempt(bot, block, { status: 'unknown', reason: 'arrival not safely diggable', outcome: 'arrival_rejected' }); failures.push('arrival not safely diggable'); ctx.log({ event: 'candidate_rejected', block: block.name, position: position(block.position), reason: 'arrival not safely diggable' }); continue; }
      rememberResourceAttempt(bot, current, { status: 'directly_reachable', reason: 'dig reach and line of sight verified', outcome: 'dig_ready' });
      await equipFor(ctx, current);
      const held = bot.heldItem;
      if (current.harvestTools && (!held || !current.harvestTools[held.type])) throw new Error('Tool equip not confirmed');
      const prior = expectedNames.reduce((n, name) => n + count(bot, name), 0);
      const pickupNames = /_log$/.test(current.name) ? [current.name] : ['stone', 'cobblestone'].includes(current.name) ? ['cobblestone'] : ['deepslate', 'cobbled_deepslate'].includes(current.name) ? ['cobbled_deepslate'] : expectedNames;
      const pickupPrior = pickupNames.reduce((n, name) => n + count(bot, name), 0);
      const beforeDrops = new Map(matchingDrops(bot, pickupNames).map(d => [d.entity.id, { name: d.name, count: d.count }]));
      const settled = await settledHarvestBlock(ctx, current);
      await ctx.step('dig', () => bot.dig(settled), current.name === 'obsidian' ? 18000 : 15000);
      await ctx.until('block removal', () => bot.blockAt(current.position)?.name !== current.name);
      dug++;
      // Follow only matching post-dig drops to a verified dry landing site.
      await collectHarvestDrop(ctx, current, pickupNames, pickupPrior, beforeDrops, pickupSearchBudget, pickupBudget);
      await ctx.until('item pickup', () => expectedNames.reduce((n, name) => n + count(bot, name), 0) > prior, 4000);
      rememberResourceAttempt(bot, current, { status: 'directly_reachable', reason: 'block removed and inventory gain verified', outcome: 'harvested' });
    } catch (error) { ctx.check(); rememberResourceAttempt(bot, block, { status: 'unknown', reason: error.message.slice(0, 180), outcome: 'execution_failed' }); failures.push(error.message); ctx.log({ event: 'candidate_failed', block: block.name, position: position(block.position), error: error.message }); if (/Missing correct tool|Tool equip/.test(error.message)) throw error; }
  }
  const gained = expectedNames.reduce((n, name) => n + count(bot, name), 0) - before;
  if (gained <= 0) throw new Error(`No inventory gain (${dug} blocks removed): ${failures.slice(-2).join('; ') || 'exposed candidates changed before execution; reachability not confirmed'}`);
  return { gained, requested: wanted, complete: gained >= wanted, dug, items: expectedNames, gainAttribution: 'inventory delta; individual dropped-item origin not proven' };
}
async function placeAt(ctx, name, p) {
  const { bot } = ctx; ctx.safe();
  if (placementFaults.has(bot)) throw new Error(placementFaults.get(bot));
  if (bot.blockAt(p)?.name === name) return;
  if (!isAir(bot.blockAt(p))) throw new Error(`Placement blocked at ${p}`);
  const feet = bot.entity.position.floored();
  if (p.x === feet.x && p.z === feet.z && [feet.y, feet.y + 1].includes(p.y)) throw new Error('Placement would trap the bot');
  if (distance(bot, p.offset(0.5, 0.5, 0.5)) > 4.5) await ctx.goto(new goals.GoalNear(p.x, Math.min(p.y, feet.y), p.z, 3));
  const item = bot.inventory.items().find(i => i.name === name);
  if (!item) throw new Error(`Missing ${name}`);
  const support = ADJACENT.map(d => ({ block: bot.blockAt(p.plus(d)), face: d.scaled(-1) })).find(x => solid(x.block));
  if (!support) throw new Error('No safe block face for placement');
  const before = count(bot, name);
  await ctx.step('equip_placement', () => bot.equip(item, 'hand'));
  if (typeof bot._syncWindow === 'function' && (typeof bot.supportFeature !== 'function' || bot.supportFeature('stateIdUsed'))) {
    await ctx.step('sync_placement_inventory', () => bot._syncWindow(bot.inventory), 5000);
  }
  ctx.safe();
  const placementEvidence = () => ({ item: name, position: position(p), heldItem: bot.heldItem?.name || null,
    quickBarSlot: Number.isInteger(bot.quickBarSlot) ? bot.quickBarSlot : null,
    observedBlock: bot.blockAt(p)?.name || 'unloaded', inventoryCount: count(bot, name) });
  ctx.log({ event: 'placement_preflight', ...placementEvidence() });
  if (bot.heldItem?.name !== name || bot.heldItem.count <= 0) throw new Error(`Placement equip not confirmed for ${name}`);
  if (typeof bot._client?.write === 'function') {
    const slot = bot.quickBarSlot;
    if (!Number.isInteger(slot) || slot < 0 || slot > 8) throw new Error('Placement hotbar slot invalid');
    // Mineflayer setQuickBarSlot/equip short-circuit when the LOCAL selection
    // already matches. Reassert it on the server; inventory sync alone does
    // not synchronize the selected hotbar index.
    await ctx.step('select_placement_hotbar', () => bot._client.write('held_item_slot', { slotId: slot }));
    if (typeof bot._syncWindow === 'function' && (typeof bot.supportFeature !== 'function' || bot.supportFeature('stateIdUsed'))) {
      await ctx.step('confirm_placement_selection_barrier', () => bot._syncWindow(bot.inventory), 5000);
    }
    ctx.safe();
    if (bot.quickBarSlot !== slot || bot.heldItem?.name !== name || bot.heldItem.count <= 0) throw new Error('Placement selection changed during server barrier');
    ctx.log({ event:'placement_selection_sent', ...placementEvidence(), confirmation:'inventory_roundtrip_not_selected_slot_ack' });
  }
  try {
    await ctx.step('place_block', () => {
      if (bot.heldItem?.name !== name) throw new Error(`Placement held item changed before ${name}`);
      return bot.placeBlock(support.block, support.face);
    });
    await ctx.until('placed block', () => {
      const actual=bot.blockAt(p);
      if(actual && !isAir(actual) && actual.name!==name) {
        const error=`Placement inhibited: expected ${name}, observed ${actual.name}; repair selected-slot synchronization and reload skills before retry`;
        placementFaults.set(bot,error); throw new Error(error);
      }
      return actual?.name===name && count(bot,name)<before;
    });
  } finally { ctx.log({ event: 'placement_readback', ...placementEvidence() }); }
}
function removableStationCover(block) {
  if (!block) return false;
  if (['short_grass', 'grass', 'fern'].includes(block.name)) return block.boundingBox === 'empty';
  if (block.name !== 'snow') return false;
  const layers = Number(block.getProperties?.().layers);
  return (Number.isFinite(layers) ? layers <= 2 : block.boundingBox === 'empty') && (block.shapes || []).every(shape => shape[4] <= 0.25);
}
function stationSiteSafe(bot, p) {
  if (expanded) return true;
  return ADJACENT.every(d => { const b = bot.blockAt(p.plus(d)); return !!b && !DANGER.has(b.name) && b.name !== 'water'; });
}
function stationSites(bot) {
  const origin = bot.entity.position.floored(), sites = [];
  const offsets = expanded ? Array.from({length:49},(_,i)=>[i%7-3,Math.floor(i/7)-3]).filter(([x,z])=>x||z) : [[2, 0], [-2, 0], [0, 2], [0, -2], [2, 2], [-2, -2]];
  for (const [x, z] of offsets) for (const dy of [0, 1, -1]) {
    const p = origin.offset(x, dy, z), cover = bot.blockAt(p);
    if (!solid(bot.blockAt(p.offset(0, -1, 0))) || (!expanded && !isAir(bot.blockAt(p.offset(0, 1, 0))))) continue;
    if (!stationSiteSafe(bot, p) || (!isAir(cover) && !(expanded ? validDig(bot,cover) : removableStationCover(cover)))) continue;
    if (distance(bot, p.offset(0.5, 0.5, 0.5)) > 4.5) continue;
    if (!isAir(cover) && !validDig(bot, cover)) continue;
    sites.push({ position: p, needsClearing: !isAir(cover) });
  }
  // Prefer any already-clear site over modifying a surface cover.
  return sites.sort((a, b) => Number(a.needsClearing) - Number(b.needsClearing) || distance(bot,a.position)-distance(bot,b.position));
}
async function station(ctx, name) {
  const { bot } = ctx;
  const existing = nearby(bot, [name], 24, 6)[0];
  if (existing) { await ctx.goto(new goals.GoalGetToBlock(existing.position.x, existing.position.y, existing.position.z)); return bot.blockAt(existing.position); }
  if (!count(bot, name)) throw new Error(`Craft ${name} first`);
  for (const site of stationSites(bot)) {
    ctx.safe();
    const p = site.position, cover = bot.blockAt(p);
    if (!stationSiteSafe(bot, p)) continue;
    if (!solid(bot.blockAt(p.offset(0, -1, 0))) || (!expanded && !isAir(bot.blockAt(p.offset(0, 1, 0))))) continue;
    if (!isAir(cover)) {
      if ((!expanded && !removableStationCover(cover)) || !validDig(bot, cover)) continue;
      await ctx.step('clear_station_surface', () => bot.dig(cover));
      await ctx.until('station surface cleared', () => isAir(bot.blockAt(p)));
      ctx.safe();
      ctx.log({ event: 'station_surface_cleared', name: cover.name, position: position(p) });
    }
    if (!stationSiteSafe(bot, p) || !solid(bot.blockAt(p.offset(0, -1, 0))) || (!expanded && !isAir(bot.blockAt(p.offset(0, 1, 0))))) throw new Error('Station terrain changed before placement');
    await placeAt(ctx, name, p); return bot.blockAt(p);
  }
  throw new Error(`No safe nearby site for ${name}`);
}
function resolveCraftName(bot, item, requestedCount = 1) {
  const items = bot.inventory.items();
  if (item === 'planks') {
    const candidates = [...new Set(items.filter(i => i.count > 0 && /_log$/.test(i.name))
      .map(i => i.name.replace(/^stripped_/, '').replace(/_log$/, '_planks')))];
    // Select one affordable species for this output count, not merely the first
    // log stack. Recipe checks account for all stacks without combining species.
    return candidates.find(name => {
      const id = bot.registry.itemsByName[name]?.id;
      return id != null && bot.recipesFor(id, null, requestedCount, true).length;
    }) || null;
  }
  if (item === 'bed' || item === 'door') {
    const suffix = item === 'bed' ? /_bed$/ : /_door$/;
    return Object.keys(bot.registry.itemsByName).find(name => suffix.test(name) && name !== 'iron_door' && bot.recipesFor(bot.registry.itemsByName[name].id, null, 1, true).length) || null;
  }
  return item;
}
// A 5x5 outside shell, 3x3 interior, three-block wall and roof at y+3.
// Ground remains intact. The south doorway is kept open until furnishing.
function homeLayout(base) {
  const cells = [];
  for (let y = 0; y < 3; y++) for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) {
    if (x !== 0 && x !== 4 && z !== 0 && z !== 4) continue;
    if (x === 2 && z === 4 && y < 2) continue;
    cells.push(base.offset(x, y, z));
  }
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) cells.push(base.offset(x, 3, z));
  return cells;
}
function homeSiteClear(bot, base) {
  for (let x = -1; x <= 5; x++) for (let z = -1; z <= 5; z++) {
    if (!solid(bot.blockAt(base.offset(x, -1, z)))) return false;
    const height = x >= 0 && x <= 4 && z >= 0 && z <= 4 ? 4 : 2;
    for (let y = 0; y < height; y++) if (!isAir(bot.blockAt(base.offset(x, y, z)))) return false;
  }
  return true;
}
function homeStatus(bot) {
  const home = bot[HOME_ANCHOR] || memories.get(bot)?.home;
  if (!home) return null;
  const base = new Vec3(home.x, home.y, home.z);
  if (home.dimension !== bot.game?.dimension) return { position: position(base), accessible: false, reason: 'different_dimension' };
  const cells = homeLayout(base), blocks = cells.map(p => bot.blockAt(p));
  const loaded = blocks.every(Boolean);
  const built = blocks.filter(b => b?.name === home.material).length;
  const at = (x, y, z) => bot.blockAt(base.offset(x, y, z));
  const bedFoot = at(1, 0, 2), bedHead = at(1, 0, 1);
  const bed = !!bedFoot && /_bed$/.test(bedFoot.name) && bedFoot.name === bedHead?.name && bedFoot.getProperties?.().part === 'foot' && bedHead.getProperties?.().part === 'head';
  const door = at(2, 0, 4), upper = at(2, 1, 4);
  const furnishing = { bed, chest: at(3, 0, 1)?.name === 'chest', torch: at(2, 0, 1)?.name === 'torch',
    door: !!door && /_door$/.test(door.name) && door.name === upper?.name && door.getProperties?.().half === 'lower' && upper.getProperties?.().half === 'upper',
    crafting_table: at(3, 0, 3)?.name === 'crafting_table', furnace: at(3, 0, 2)?.name === 'furnace' };
  const floorVerified = Array.from({ length: 25 }, (_, i) => solid(at(i % 5, -1, Math.floor(i / 5)))).every(Boolean);
  return { position: position(base), dimension: home.dimension, material: home.material, accessible: loaded, built, total: cells.length,
    shellComplete: loaded && floorVerified && built === cells.length, floorVerified, furnishing,
    complete: loaded && floorVerified && built === cells.length && Object.values(furnishing).every(Boolean) };
}
async function buildHome(ctx) {
  const { bot, action } = ctx; ctx.safe();
  const memory = memories.get(bot);
  if (bot[HOME_ANCHOR]) memory.home = bot[HOME_ANCHOR];
  if (!memory.home) {
    const material = bot.inventory.items().filter(i => i.count > 0 && (/_planks$/.test(i.name) || i.name === 'cobblestone')).sort((a, b) => b.count - a.count)[0]?.name;
    if (!material) throw new Error('Home needs planks or cobblestone; craft or mine building blocks first');
    const origin = bot.entity.position.floored();
    let base;
    for (const [dx, dz] of [[-2, -2], [1, 1], [-5, 1], [1, -5], [-5, -5], [4, -2], [-8, -2], [-2, 4], [-2, -8]]) {
      const candidate = origin.offset(dx, 0, dz);
      if (homeSiteClear(bot, candidate)) { base = candidate; break; }
    }
    if (!base) throw new Error('No loaded clear flat 7x7 home site nearby; explore flat terrain, do not repeat unchanged');
    memory.home = { ...position(base), dimension: bot.game.dimension, material };
    bot[HOME_ANCHOR] = memory.home;
  }
  const home = memory.home;
  if (home.dimension !== bot.game.dimension) throw new Error('Home is in another dimension');
  const base = new Vec3(home.x, home.y, home.z);
  // Validate the whole blueprint before any mutation; never clear unknown or
  // player-built obstructions. Repeated calls resume from actual block state.
  for (const p of homeLayout(base)) {
    const b = bot.blockAt(p);
    if (!b || (!isAir(b) && b.name !== home.material)) throw new Error(`Home blueprint obstructed or unloaded at ${p}`);
  }
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) if (!solid(bot.blockAt(base.offset(x, -1, z)))) throw new Error('Home floor changed or unloaded');
  const missing = homeLayout(base).filter(p => bot.blockAt(p)?.name !== home.material);
  if (!missing.length) return { complete: true, placed: 0, home: homeStatus(bot) };
  if (!count(bot, home.material)) throw new Error(`Home needs more ${home.material}`);
  await ctx.goto(new goals.GoalBlock(base.x + 2, base.y, base.z + 2));
  let placed = 0;
  for (const p of missing.slice(0, Math.min(action.count, count(bot, home.material)))) {
    ctx.safe(); await placeAt(ctx, home.material, p); placed++;
    ctx.log({ event: 'home_block_verified', position: position(p), item: home.material });
  }
  const status = homeStatus(bot);
  return { placed, complete: status.shellComplete, home: status };
}
async function furnishHome(ctx) {
  const { bot, action } = ctx; ctx.safe();
  const status = homeStatus(bot);
  if (!status?.shellComplete) throw new Error('Complete build_home shell before furnishing');
  if (status.furnishing[action.item]) return { complete: true, alreadyPlaced: true, home: status };
  const base = new Vec3(status.position.x, status.position.y, status.position.z);
  const offsets = { bed: [1, 0, 2], chest: [3, 0, 1], torch: [2, 0, 1], door: [2, 0, 4], crafting_table: [3, 0, 3], furnace: [3, 0, 2] };
  const p = base.offset(...offsets[action.item]);
  const item = bot.inventory.items().find(i => i.count > 0 && (action.item === 'bed' ? /_bed$/.test(i.name) : action.item === 'door' ? /_door$/.test(i.name) && i.name !== 'iron_door' : i.name === action.item));
  if (!item) throw new Error(`Craft ${action.item} before furnishing`);
  const cells = action.item === 'bed' ? [p, p.offset(0, 0, -1)] : action.item === 'door' ? [p, p.offset(0, 1, 0)] : [p];
  if (cells.some(cell => !isAir(bot.blockAt(cell)))) throw new Error('Furnishing site occupied or unloaded');
  if (!solid(bot.blockAt(p.offset(0, -1, 0))) || (action.item === 'bed' && !solid(bot.blockAt(p.offset(0, -1, -1))))) throw new Error('Furnishing lacks a safe solid floor');
  await ctx.goto(new goals.GoalBlock(base.x + 2, base.y, base.z + 2));
  ctx.safe();
  if (cells.some(cell => !isAir(bot.blockAt(cell)))) throw new Error('Furnishing site changed during navigation');
  const before = count(bot, item.name);
  await ctx.step('equip_home_item', () => bot.equip(item, 'hand'));
  // Explicit north facing for the two-cell bed; use the installed Mineflayer
  // placement helper, which retains server acknowledgement verification.
  if (action.item === 'bed') {
    if (!bot._placeBlockWithOptions || !bot.lookAt) throw new Error('Bed placement requires orientation-capable Mineflayer');
    await ctx.step('orient_bed', () => bot.lookAt(bot.entity.position.offset(0, 1.62, -2), true));
    await ctx.step('place_bed', () => bot._placeBlockWithOptions(bot.blockAt(p.offset(0, -1, 0)), new Vec3(0, 1, 0), { forceLook: 'ignore', swingArm: 'right' }));
  } else await ctx.step('place_home_item', () => bot.placeBlock(bot.blockAt(p.offset(0, -1, 0)), new Vec3(0, 1, 0)));
  await ctx.until('home furnishing', () => count(bot, item.name) < before && homeStatus(bot)?.furnishing[action.item]);
  return { complete: true, item: item.name, home: homeStatus(bot) };
}
async function craft(ctx) {
  const { bot, action } = ctx; ctx.safe();
  const name = resolveCraftName(bot, action.item, action.count);
  if (!name) throw new Error(`Missing ingredients for ${action.item}`);
  const id = bot.registry.itemsByName[name]?.id;
  if (id == null) throw new Error(`Unavailable recipe item ${name}`);
  ctx.partialItems = [name];
  // Check affordability before moving or placing a table. A missing inventory
  // recipe can mean missing ingredients, not necessarily a missing 3x3 grid.
  if (!bot.recipesFor(id, null, action.count, true).length) throw new Error(`Missing ingredients for ${action.count} ${name}`);
  let table = null, recipes = bot.recipesFor(id, null, 1, null);
  if (!recipes.length) { table = await station(ctx, 'crafting_table'); recipes = bot.recipesFor(id, null, 1, table); }
  if (!recipes.length) throw new Error(`Missing ingredients for ${name}`);
  const recipe = recipes[0], output = recipe.result.count || 1;
  const runs = Math.ceil(action.count / output);
  const usable = bot.recipesFor(id, null, runs * output, table).find(r => r.result.id === recipe.result.id);
  if (!usable) throw new Error(`Not enough ingredients for ${action.count} ${name}`);
  const before = count(bot, name);
  const canSync = typeof bot._syncWindow === 'function' && (typeof bot.supportFeature !== 'function' || bot.supportFeature('stateIdUsed'));
  const modernInventory = !table && confirmedCraft.supported(bot, usable);
  const inventoryConfirmation = modernInventory ? 'server_full_window_per_click' : canSync ? (table ? 'native_crafting_table_sync' : 'server_window_sync') : 'inventory_delta_only';
  ctx.partialConfirmation = inventoryConfirmation;
  const stopTrace = traceCraftInventory(bot, ctx.log);
  try {
  // Gate each recipe batch separately: cancellation cannot start later batches.
  for (let i = 0; i < runs; i++) {
    if (modernInventory) await ctx.step('craft_confirmed_inventory', () => confirmedCraft.craftInventoryBatch(bot, usable, { signal: ctx.signal, check: ctx.safe, log: ctx.log, onConfirmedSnapshot: () => { ctx.craftObservedGain = count(bot, name) - before; } }));
    else await ctx.step('craft', () => bot.craft(usable, 1, table));
    // The installed native craft implementation syncs before closing a table,
    // but inventory-grid crafting otherwise returns with optimistic local slots.
    if (canSync && !table && !modernInventory) await ctx.step('sync_craft_inventory', () => bot._syncWindow(bot.inventory), 5000);
    ctx.craftObservedGain = count(bot, name) - before;
    await ctx.until('crafted batch inventory', () => count(bot, name) >= before + (i + 1) * output);
    ctx.log({ event: 'craft_batch_verified', item: name, batch: i + 1, gained: count(bot, name) - before, inventoryConfirmation });
  }
  return { item: name, gained: count(bot, name) - before, inventoryConfirmation, ...(canSync ? {} : { confirmationLimitation: 'No explicit server window synchronization available; inventory delta only' }) };
  } finally { stopTrace(); }
}
async function smelt(ctx) {
  const { bot, action } = ctx; ctx.safe();
  const block = await station(ctx, 'furnace');
  const furnace = await ctx.step('open_furnace', () => bot.openFurnace(block));
  try {
    const output = SMELT_OUTPUT[action.item], before = count(bot, output);
    const matchesInput = item => item && (action.item === 'charcoal' ? /_log$/.test(item.name) : item.name === action.item);
    if ((furnace.outputItem() && furnace.outputItem().name !== output) || (furnace.inputItem() && !matchesInput(furnace.inputItem()))) throw new Error('Furnace contains different recipe; refusing to mix inventory');
    // Recover an interrupted matching batch before adding a new one.
    const recovering = !!(furnace.inputItem() || furnace.outputItem());
    let expected = (furnace.inputItem()?.count || 0) + (furnace.outputItem()?.count || 0);
    if (!recovering) {
      const input = bot.inventory.items().find(matchesInput);
      if (!input || input.count < action.count) throw new Error(`Missing smelting input ${action.item}`);
      const fuel = bot.inventory.items().find(i => ['coal', 'charcoal'].includes(i.name)) || bot.inventory.items().find(i => /_planks$/.test(i.name));
      const fuelCount = fuel && Math.ceil(action.count / (/_planks$/.test(fuel.name) ? 1.5 : 8));
      if (!furnace.fuelItem() && (!fuel || fuel.count < fuelCount)) throw new Error('Need sufficient coal, charcoal, or planks fuel');
      await ctx.step('furnace_input', () => furnace.putInput(input.type, null, action.count));
      if (!furnace.fuelItem()) await ctx.step('furnace_fuel', () => furnace.putFuel(fuel.type, null, fuelCount));
      expected = action.count;
    }
    const deadline = Date.now() + expected * 11500 + 10000;
    while (count(bot, output) < before + expected) {
      ctx.safe();
      if (Date.now() > deadline) throw new Error('Smelting output timed out; items may remain in furnace');
      if (furnace.outputItem()?.name === output) await ctx.step('take_smelted', () => furnace.takeOutput());
      else await ctx.sleep(500);
    }
    return { item: output, gained: count(bot, output) - before, recovered: recovering, furnace: position(block.position) };
  } finally { try { furnace.close(); } catch {} }
}
async function eat(ctx) {
  const { bot } = ctx;
  if (bot.food >= 20) return { alreadyFull: true, food: bot.food };
  const options = foodOptions(bot);
  const item = bot.inventory.items().find(i => i.count > 0 && i.name === options.selectedItem);
  if (!item) throw new Error(options.rottenFlesh.count > 0 ? 'Rotten flesh is edible only as emergency fallback (health <= 6 or food <= 6); it cannot be smelted' : 'No supported edible food in inventory; raw beef, porkchop, mutton, rabbit, cod and salmon can be eaten without smelting');
  const beforeCount = count(bot, item.name), beforeFood = bot.food;
  if (options.emergencyFallback) ctx.log({ event: 'emergency_food_selected', item: item.name, health: bot.health, food: bot.food, risk: options.risk });
  await ctx.step('equip_food', () => bot.equip(item, 'hand'));
  await ctx.step('consume_food', () => bot.consume(), 10000);
  await ctx.until('food consumed', () => count(bot, item.name) < beforeCount && bot.food > beforeFood);
  return { item: item.name, foodBefore: beforeFood, foodAfter: bot.food, emergencyFallback: options.emergencyFallback, risk: options.risk };
}
async function explore(ctx, flee = false) {
  const { bot, action } = ctx;
  if (!expanded && !flee && bot.health <= 6) return emergencyExplore(ctx);
  if (!flee) ctx.safe();
  const start = bot.entity.position.clone();
  let direction = DIRECTIONS[action.direction] || [1, 0], length = action.distance || 24;
  const threat = threats(bot, 24)[0];
  if (flee && threat) { const dx = start.x - threat.position.x, dz = start.z - threat.position.z, norm = Math.hypot(dx, dz) || 1; direction = [dx / norm, dz / norm]; }
  const norm = Math.hypot(...direction);
  const x = Math.floor(start.x + direction[0] / norm * length), z = Math.floor(start.z + direction[1] / norm * length);
  let progressPosition = start.clone(), progressRadius = 0, progressAt = Date.now(), stalled = false;
  let navigationId = 0, lastPathUpdate = null;
  const onExplorePath = update => {
    lastPathUpdate = { observedAtMs: Date.now(), navigationId, status: String(update?.status || 'unknown').slice(0, 40),
      pathLength: Array.isArray(update?.path) ? update.path.length : 0,
      firstNodes: (Array.isArray(update?.path) ? update.path : []).slice(0, 6).map(p => ({
        ...position(p), parkour: !!p.parkour, toBreakCount: p.toBreak?.length || 0, toPlaceCount: p.toPlace?.length || 0
      })) };
  };
  bot.on('path_update', onExplorePath);
  const navigateExplore = async (goal, ms) => {
    navigationId++; lastPathUpdate = null;
    await ctx.goto(goal, ms);
    // Installed Mineflayer goto resolves any empty path before checking its
    // noPath/timeout status. Preserve failure semantics for bounded recovery.
    if (lastPathUpdate?.navigationId === navigationId && ['noPath','timeout'].includes(lastPathUpdate.status)) {
      throw new Error(`Exploration path ${lastPathUpdate.status}; goal completion unconfirmed`);
    }
    ctx.check();
    // Resolve alone is not arrival. Use the original goal's own block-coordinate
    // semantics (GoalNearXZ ignores height); never substitute the path endpoint.
    if (!goal.isEnd(bot.entity.position.floored())) {
      ctx.log({event:'explore_arrival_unconfirmed',navigationId,position:position(bot.entity.position),
        pathStatus:lastPathUpdate?.status || 'not_observed',pathLength:lastPathUpdate?.pathLength ?? null,
        goal:{type:goal.constructor.name,x:goal.x,y:goal.y,z:goal.z,rangeSq:goal.rangeSq}});
      throw new Error('Exploration resolved before original goal was reached');
    }
  };
  const progressMonitor = setInterval(() => {
    const current = bot.entity.position;
    const radius = Math.hypot(current.x - progressPosition.x, current.z - progressPosition.z);
    if (radius >= progressRadius + 0.75) {
      progressRadius = radius; progressAt = Date.now();
    } else if (!stalled && Date.now() - progressAt >= 4000) {
      const observedAtMs = Date.now();
      ctx.log({ event: 'explore_stalled', direction: action.direction, position: position(current), stalledMs: observedAtMs - progressAt,
        diagnostics: { observedAtMs, navigationId, onGround: typeof bot.entity.onGround === 'boolean' ? bot.entity.onGround : null,
          velocity: position(bot.entity.velocity) || null,
          controls: Object.fromEntries(['forward', 'back', 'left', 'right', 'jump', 'sprint', 'sneak'].map(key => [key, typeof bot.controlState?.[key] === 'boolean' ? bot.controlState[key] : null])),
          lastPathUpdate: lastPathUpdate ? { ...lastPathUpdate, ageMs: observedAtMs - lastPathUpdate.observedAtMs, evidence: 'last_path_update_not_current_remaining_path' } : null,
          terrain: localTerrainDiagnostics(bot) } });
      if (!stalled) {
        stalled = true;
        // Cancel this path only. Keep the skill signal alive for bounded local
        // recovery; external cancellation/death still aborts the whole skill.
        bot.pathfinder.setGoal(null);
        bot.clearControlStates();
      }
    }
  }, 200);
  let recovered = false;
  try {
    try { await navigateExplore(new goals.GoalNearXZ(x, z, 3), expanded ? 60000 : Math.min(25000, 5000 + length * 650)); }
    catch (error) {
      ctx.check();
      // Flee retains the dedicated safety behavior, never a generic detour.
      if (flee) throw error;
      ctx.safe();
      const budget = { cpuMs: 0, probes: 0 };
      const anchor = bot.entity.position.clone();
      const heading = Math.atan2(direction[1], direction[0]);
      for (const offset of [0, Math.PI / 4, -Math.PI / 4]) {
        ctx.safe();
        const target = new Vec3(Math.floor(anchor.x + Math.cos(heading + offset) * 7), Math.floor(anchor.y), Math.floor(anchor.z + Math.sin(heading + offset) * 7));
        const goal = new goals.GoalNearXZ(target.x, target.z, 1);
        const route = await harvestRoute(ctx, { position: target }, budget, { goal, purpose: 'explore_recovery', pathLimit: 18, dryPath: true });
        if (!route.confirmed) continue;
        progressPosition = bot.entity.position.clone(); progressRadius = 0; progressAt = Date.now(); stalled = false;
        ctx.log({ event: 'explore_recovery_attempt', direction: action.direction, target: position(target), pathLength: route.pathLength });
        try {
          await navigateExplore(goal, 10000);
          ctx.safe();
          if (bot.entity.position.distanceTo(anchor) >= 3) { recovered = true; break; }
        } catch (retryError) { ctx.check(); ctx.safe(); }
      }
      if (!recovered) throw new Error(`Exploration blocked; bounded safe detours exhausted: ${error.message}`);
    }
  }
  finally { clearInterval(progressMonitor); bot.removeListener('path_update', onExplorePath); }
  const moved = bot.entity.position.distanceTo(start);
  if (moved < 4) throw new Error('Exploration did not produce meaningful displacement');
  const memory = memories.get(bot); memory.visited.push({ from: position(start), to: position(bot.entity.position), direction: action.direction || 'away_from_threat', at: Date.now() });
  memory.visited = memory.visited.slice(-40);
  return { moved: Math.round(moved), ...(recovered ? { recovered: true, complete: Math.hypot(bot.entity.position.x - x, bot.entity.position.z - z) <= 3 } : {}), from: position(start), to: position(bot.entity.position), remainingThreats: threats(bot, 12) };
}
function emergencyExploreEdge(bot, from, to) {
  const dx=Math.abs(to.x-from.x), dz=Math.abs(to.z-from.z), dy=to.y-from.y;
  if(dx>1||dz>1||dx+dz===0||dy>1||dy< -1||to.parkour||to.toBreak?.length||to.toPlace?.length) return false;
  if(dy!==0 && dx+dz!==1) return false;
  const a=new Vec3(from.x,from.y,from.z), b=new Vec3(to.x,to.y,to.z);
  if(!emergencyHuntStand(bot,a)||!emergencyHuntStand(bot,b)) return false;
  // A single-block rise needs known empty takeoff headroom throughout the
  // jump, and a full solid landing directly beside the supported start.
  if(dy===1 && (!isAir(bot.blockAt(a.offset(0,2,0))) || !solid(bot.blockAt(b.offset(0,-1,0))))) return false;
  if(dx&&dz && (!emergencyHuntStand(bot,new Vec3(a.x,b.y,b.z))||!emergencyHuntStand(bot,new Vec3(b.x,b.y,a.z)))) return false;
  return true;
}
async function emergencyExplore(ctx) {
  const { bot, action } = ctx, origin = bot.entity.position.clone(), floorY = Math.floor(origin.y), startingHealth = bot.health, started = Date.now();
  const direction = DIRECTIONS[action.direction], norm = Math.hypot(...direction);
  const movement = setSafeMovements(bot); // Includes independently guarded single-block descents.
  movement.allowSprinting = false;
  // exclusionAreasStep also sees headroom blocks via safeOrBreak. Standing
  // checks must apply to Move feet, otherwise head air rejects every flat step.
  const terrainNeighbors = movement.getNeighbors.bind(movement);
  movement.getNeighbors = node => terrainNeighbors(node).filter(next => emergencyExploreEdge(bot, node, next));
  bot.pathfinder.setMovements(movement);
  let verifiedRoute = null;
  const safe = () => {
    ctx.check();
    if (bot.health < startingHealth) throw new Error('Emergency explore stopped: health decreased');
    if (threats(bot, 24).length) throw new Error('Emergency explore stopped: hostile within 24 blocks');
    if (Date.now() - started > 15000 || bot.entity.position.distanceTo(origin) > 8) throw new Error('Emergency explore stopped: time or eight-block range limit');
    if (!verifiedRoute) {
      if (!emergencyHuntStand(bot, bot.entity.position)) throw new Error('Emergency explore requires dry supported terrain');
    } else {
      if (verifiedRoute.some(p => !emergencyHuntStand(bot, p))) throw new Error('Emergency explore stopped: verified terrain changed');
      // During a one-block descent the feet briefly occupy air above the
      // already-verified landing. Permit only that bounded transition.
      const p = bot.entity.position;
      if (!verifiedRoute.some(node => Math.abs(p.x - node.x - 0.5) <= 0.85 && Math.abs(p.z - node.z - 0.5) <= 0.85 && p.y >= node.y - 0.1 && p.y <= node.y + (selected.nodes.some((next,i) => next.y === node.y + 1 && (i ? selected.nodes[i-1] : origin.floored()).equals(node)) ? 1.3 : 1.1))) throw new Error('Emergency explore stopped: left verified route');
    }
  };
  safe();
  if (!bot.pathfinder.getPathFromTo) throw new Error('Emergency explore infeasible: path verification unavailable');
  let selected;
  // Prefer progress in the model-selected direction; if the seven-block
  // endpoint is blocked, validate shorter endpoints rather than changing its
  // decision or declaring the entire direction impossible.
  for (let length = 7; length >= 1 && !selected; length--) {
    for (const drop of [0, -1, ...Array.from({length:Math.min(length,5)},(_,i)=>i+1)]) {
      if (selected) break;
      safe();
      const target = new Vec3(Math.floor(origin.x + direction[0] / norm * length), floorY - drop, Math.floor(origin.z + direction[1] / norm * length));
      if (!emergencyHuntStand(bot, target) || target.offset(0.5, 0, 0.5).distanceTo(origin) > 8) continue;
      const goal = new goals.GoalBlock(target.x, target.y, target.z);
      const generator = bot.pathfinder.getPathFromTo(movement, origin, goal, { timeout: 40, tickTimeout: 10, optimizePath: false });
      let route;
      for (let slices = 0; slices < 4; slices++) { route = generator.next().value?.result; if (route?.status !== 'partial') break; }
      if (route?.status !== 'success' || !route.path?.length || route.path.length > 8) continue;
      let previous = origin.floored(), pathDistance = 0, valid = true;
      const nodes = [];
      for (const node of route.path) {
        const p = new Vec3(node.x, node.y, node.z), dx = Math.abs(p.x - previous.x), dz = Math.abs(p.z - previous.z), dy = p.y - previous.y;
        pathDistance += previous.distanceTo(p);
        // Every edge is a supported adjacent step; a rise is exactly one block.
        // No gap jumping, shafts, diagonal elevation change, digging or placing.
        if (dx > 1 || dz > 1 || dx + dz === 0 || dy > 1 || dy < -1 || (dy !== 0 && dx + dz !== 1) || !emergencyExploreEdge(bot,previous,node) || node.toBreak?.length || node.toPlace?.length || !emergencyHuntStand(bot, p) || pathDistance > 8 || (p.x - origin.x + 0.5) * direction[0] + (p.z - origin.z + 0.5) * direction[1] < 0) { valid = false; break; }
        if (dx && dz && (!emergencyHuntStand(bot, new Vec3(previous.x, p.y, p.z)) || !emergencyHuntStand(bot, new Vec3(p.x, p.y, previous.z)))) { valid = false; break; }
        previous = p; nodes.push(p);
      }
      if (valid && previous.equals(target)) selected = { target, nodes };
    }
  }
  if (!selected) throw new Error('Emergency explore infeasible: no verified 1-7 block route in selected direction');
  verifiedRoute = [origin.floored(), ...selected.nodes];
  const routeKeys = new Set(verifiedRoute.map(p => p.toString()));
  const verifiedNeighbors = movement.getNeighbors.bind(movement);
  movement.getNeighbors = node => verifiedNeighbors(node).filter(next => routeKeys.has(new Vec3(next.x, next.y, next.z).floored().toString()));
  let monitor;
  try {
    monitor = setInterval(() => { try { safe(); } catch (error) { ctx.abort(error); } }, 150);
    // Navigate each checked landing separately, so successive one-block drops
    // cannot silently become a single multi-block fall through replanning.
    for (const node of selected.nodes) {
      safe(); await ctx.goto(new goals.GoalBlock(node.x, node.y, node.z), 12000); safe();
      // Mineflayer may emit goal_reached at floored()+1 while still descending.
      // Confirm the same physical landing; don't widen position tolerances or
      // reset the outer 15-second safety deadline while gravity settles.
      const landingStarted=Date.now(), landingDeadline=landingStarted+1200;
      const landed=()=>bot.entity.position.distanceTo(node.offset(0.5,0,0.5))<=0.8 && bot.entity.onGround!==false;
      while(!landed() && Date.now()<landingDeadline) { safe(); await ctx.sleep(50); }
      safe();
      ctx.log({event:'emergency_explore_landing', target:position(node), position:position(bot.entity.position), onGround:bot.entity.onGround ?? null, waitedMs:Date.now()-landingStarted, confirmed:landed()});
      if (!landed()) throw new Error('Emergency explore landing was not reached safely');
    }
    const moved = bot.entity.position.distanceTo(origin);
    if (moved < 0.5) throw new Error('Emergency explore destination was not reached');
    const memory = memories.get(bot); memory.visited.push({ from: position(origin), to: position(bot.entity.position), direction: action.direction, at: Date.now() }); memory.visited = memory.visited.slice(-40);
    return { moved: Math.round(moved * 10) / 10, from: position(origin), to: position(bot.entity.position), emergencyRecovery: true, distanceLimit: 8, requestedDistance: action.distance, complete: moved >= action.distance, verifiedSteps: selected.nodes.length, remainingThreats: threats(bot, 24) };
  } finally { clearInterval(monitor); }
}
function emergencyHuntStand(bot, position) {
  const p = position.floored();
  const body = block => !!block && !DANGER.has(block.name) && block.name !== 'water' && (block.boundingBox === 'empty' || (block.name === 'snow' && block.shapes?.every(shape => shape[4] <= 0.5)));
  if (!solid(bot.blockAt(p.offset(0, -1, 0))) || !body(bot.blockAt(p)) || !body(bot.blockAt(p.offset(0, 1, 0)))) return false;
  return [new Vec3(1, 0, 0), new Vec3(-1, 0, 0), new Vec3(0, 0, 1), new Vec3(0, 0, -1)].every(d => {
    const block = bot.blockAt(p.plus(d)); return !!block && !DANGER.has(block.name);
  });
}
async function hunt(ctx) {
  const { bot, action } = ctx, emergency = !expanded && bot.health <= 6;
  const origin = bot.entity.position.clone(), startingHealth = bot.health, started = Date.now();
  const safe = () => {
    if (!emergency) return ctx.safe();
    ctx.check();
    if (bot.health < startingHealth) throw new Error('Emergency hunt stopped: health decreased');
    if (threats(bot, 24).length) throw new Error('Emergency hunt stopped: hostile within 24 blocks');
    if (Date.now() - started > 35000 || bot.entity.position.distanceTo(origin) > 20) throw new Error('Emergency hunt stopped: time or distance limit');
    if (!emergencyHuntStand(bot, bot.entity.position)) throw new Error('Emergency hunt requires safe dry supported terrain');
  };
  safe();
  const navigate = async (goal, ms) => {
    safe();
    if (emergency) {
      if (!bot.pathfinder.getPathFromTo) throw new Error('Emergency hunt needs a verified safe route');
      const generator = bot.pathfinder.getPathFromTo(bot.pathfinder.movements, bot.entity.position, goal, { timeout: 40, tickTimeout: 10, optimizePath: false });
      let result;
      for (let slices = 0; slices < 4; slices++) { result = generator.next().value?.result; if (result?.status !== 'partial') break; }
      if (result?.status !== 'success' || !result.path || result.path.length > 24 || result.path.some(p => p.toBreak?.length || p.toPlace?.length || !emergencyHuntStand(bot, new Vec3(p.x, p.y, p.z)))) throw new Error('Emergency hunt has no verified safe short route');
    }
    await ctx.goto(goal, ms); safe();
  };
  // This exception belongs only to a model-selected hunt, not other work.
  // Passive raw chicken cannot be eaten safely without a cooking chain.
  let monitor;
  if (emergency) monitor = setInterval(() => { try { safe(); } catch (error) { ctx.abort(error); } }, 150);
  try {
  const foodNames = ['beef', 'porkchop', 'mutton', 'chicken'];
  const before = foodNames.reduce((n, name) => n + count(bot, name), 0);
  let killsObserved = 0;
  const animals = Object.values(bot.entities).filter(e => PREY.has(e.name) && (!action.animal || e.name === action.animal) && (!emergency || e.name !== 'chicken') && e.position && distance(bot, e.position) <= (emergency ? 16 : 32)).sort((a, b) => distance(bot, a.position) - distance(bot, b.position)).slice(0, emergency ? 1 : action.count);
  if (!animals.length) throw new Error('No nearby passive animals; explore');
  for (const animal of animals) {
    const weapon = ['diamond_sword', 'iron_sword', 'stone_sword', 'wooden_sword', 'iron_axe', 'stone_axe'].map(n => bot.inventory.items().find(i => i.name === n)).find(Boolean);
    if (weapon) await ctx.step('equip_hunting_weapon', () => bot.equip(weapon, 'hand'));
    let deathObserved = false;
    const died = e => { if (e.id === animal.id) deathObserved = true; };
    bot.on('entityDead', died);
    try {
      for (let hit = 0; hit < 16 && bot.entities[animal.id] && !deathObserved; hit++) {
        safe();
        await navigate(emergency ? new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 2) : new goals.GoalFollow(animal, 2), emergency ? 5000 : 10000);
        if (!bot.entities[animal.id] || !canSeePrey(bot, animal) || distance(bot, animal.position) > 3) continue;
        await ctx.step('look_at_prey', () => bot.lookAt(animal.position.offset(0, 0.6, 0), true));
        safe(); if (!bot.entities[animal.id]) break;
        bot.attack(animal); await ctx.sleep(1100);
      }
      if (deathObserved) killsObserved++;
      await navigate(new goals.GoalNear(animal.position.x, animal.position.y, animal.position.z, 1), emergency ? 5000 : 8000);
      await ctx.sleep(700);
    } finally { bot.removeListener('entityDead', died); }
  }
  const gained = foodNames.reduce((n, name) => n + count(bot, name), 0) - before;
  if (gained <= 0) throw new Error(`Hunting produced no verified food inventory gain; ${killsObserved} deaths observed`);
  return { gained, killsObserved, items: foodNames, ...(emergency ? { emergencyRecovery: true, preyLimit: 1 } : {}) };
  } finally { clearInterval(monitor); }
}
function canSeePrey(bot, entity) {
  if (!bot.world?.raycast) return false;
  const eye = bot.entity.position.offset(0, bot.entity.eyeHeight || 1.62, 0);
  const target = entity.position.offset(0, Math.min(entity.height || 1, 0.8), 0);
  const ray = target.minus(eye), range = ray.norm();
  if (range < 0.01) return true;
  const block = bot.world.raycast(eye, ray.scaled(1 / range), range);
  return !block || (block.intersect && eye.distanceTo(block.intersect) >= range - 0.1);
}
function portalLayout(base) {
  const frame = [];
  for (let y = 0; y <= 4; y++) for (let x = 0; x <= 3; x++) {
    if (x !== 0 && x !== 3 && y !== 0 && y !== 4) continue;
    const corner = (x === 0 || x === 3) && (y === 0 || y === 4);
    frame.push({ position: base.offset(x, y, 0), name: corner ? 'cobblestone' : 'obsidian' });
  }
  return frame;
}
const EXCAVATABLE = new Set(['stone', 'cobblestone', 'deepslate', 'cobbled_deepslate', 'dirt', 'grass_block', 'granite', 'diorite', 'andesite', 'tuff', 'calcite', 'dripstone_block', ...Object.values(RESOURCES).flat().filter(n => n !== 'obsidian' && n !== 'gravel')]);
function staircasePlan(bot, direction) {
  const offset = DIRECTIONS[direction];
  if (!offset || Math.abs(offset[0]) + Math.abs(offset[1]) !== 1) throw new Error('Staircase requires a cardinal direction');
  const feet = bot.entity.position.floored();
  const target = feet.offset(offset[0], -1, offset[1]);
  const blocks = [target.offset(0, 2, 0), target.offset(0, 1, 0), target].map(p => bot.blockAt(p));
  const floor = bot.blockAt(target.offset(0, -1, 0));
  if (!solid(floor)) throw new Error('Unsafe staircase: next step has unknown, falling, liquid, or absent support');
  for (const block of blocks) {
    if (!block || (!isAir(block) && !(expanded ? block.diggable : EXCAVATABLE.has(block.name)))) throw new Error(`Unsafe staircase: protected or unsupported material ${block?.name || 'unknown'}`);
    for (const d of expanded ? [] : ADJACENT) {
      const neighbor = bot.blockAt(block.position.plus(d));
      if (!neighbor || DANGER.has(neighbor.name) || neighbor.name === 'water' || (d.y === 1 && ['sand', 'gravel'].includes(neighbor.name))) throw new Error('Unsafe staircase: adjacent fluid, hazard, falling block, or unloaded terrain');
    }
  }
  return { from: feet, target, blocks };
}
async function digStaircase(ctx) {
  const { bot, action } = ctx; ctx.safe();
  if (!expanded && (bot.health < 12 || bot.food < 10)) throw new Error('Staircase requires health >= 12 and food >= 10');
  if (!bot.inventory.items().some(i => /^(wooden|stone|iron|diamond|netherite)_pickaxe$/.test(i.name))) throw new Error('Staircase requires a usable pickaxe');
  const underground = bot.entity.position.y - action.steps < 50;
  if (!expanded && underground && count(bot, 'torch') < Math.ceil(action.steps / 4)) throw new Error('Deep staircase requires torches (one per four steps)');
  const start = bot.entity.position.clone();
  let descended = 0, excavated = 0;
  for (let i = 0; i < action.steps; i++) {
    ctx.safe();
    const plan = staircasePlan(bot, action.direction);
    // Preflight every tool before altering this step, so a hidden harder ore
    // cannot leave a half-dug staircase merely due to an inadequate pickaxe.
    for (const block of plan.blocks.filter(b => !isAir(b))) {
      if (block.harvestTools && !bot.inventory.items().some(item => block.harvestTools[item.type])) throw new Error(`Missing correct tool for staircase ${block.name}`);
    }
    for (const block of plan.blocks) {
      ctx.safe(); if (isAir(bot.blockAt(block.position))) continue;
      const current = bot.blockAt(block.position);
      if (!validDig(bot, current)) throw new Error('Staircase dig safety check failed');
      await equipFor(ctx, current);
      await ctx.step('excavate_stair', () => bot.dig(current), 14000);
      await ctx.until('stair clearance', () => isAir(bot.blockAt(current.position)));
      excavated++;
    }
    if (!solid(bot.blockAt(plan.target.offset(0, -1, 0))) || !isAir(bot.blockAt(plan.target)) || !isAir(bot.blockAt(plan.target.offset(0, 1, 0)))) throw new Error('Staircase changed before descending');
    await ctx.goto(new goals.GoalBlock(plan.target.x, plan.target.y, plan.target.z), 10000);
    await ctx.until('stair descent', () => bot.entity.position.distanceTo(plan.target.offset(0.5, 0, 0.5)) < 0.85 && Math.abs(bot.entity.position.y - plan.target.y) < 0.3);
    descended++;
    if (underground && ((i + 1) % 4 === 0 || i === action.steps - 1)) await placeAt(ctx, 'torch', plan.from);
  }
  return { descended, excavated, from: position(start), to: position(bot.entity.position), verticalDrop: Math.round(start.y - bot.entity.position.y) };
}
function isFluidSource(block) { return !!block && ['water', 'lava'].includes(block.name) && Number(block.getProperties?.().level) === 0; }
function dryStanding(bot, p, wide = false) {
  for (let x = wide ? -1 : 0; x <= (wide ? 1 : 0); x++) for (let z = wide ? -1 : 0; z <= (wide ? 1 : 0); z++) {
    const q = p.offset(x, 0, z);
    if (!solid(bot.blockAt(q.offset(0, -1, 0))) || !isAir(bot.blockAt(q)) || !isAir(bot.blockAt(q.offset(0, 1, 0)))) return false;
  }
  return true;
}
async function bucketUse(ctx, itemName, target, expectedItem) {
  const { bot } = ctx;
  const item = bot.inventory.items().find(i => i.name === itemName);
  if (!item) throw new Error(`Missing ${itemName}`);
  if (distance(bot, target) > 4.4) throw new Error('Bucket target outside safe reach');
  const beforeInput = count(bot, itemName), beforeOutput = count(bot, expectedItem);
  await ctx.step('equip_bucket', () => bot.equip(item, 'hand'));
  await ctx.step('aim_bucket', () => bot.lookAt(target, true));
  ctx.safe(); bot.activateItem();
  await ctx.until('bucket inventory', () => count(bot, itemName) < beforeInput && count(bot, expectedItem) > beforeOutput, 4500);
}
async function collectWater(ctx) {
  const { bot } = ctx; ctx.safe();
  if (!count(bot, 'bucket')) throw new Error('Craft an empty bucket before collecting water');
  const sources = nearby(bot, ['water'], 24, 50).filter(isFluidSource);
  for (const source of sources) {
    // Approach a dry shore square; never path into the source or swim to it.
    const shore = [[1, 0], [-1, 0], [0, 1], [0, -1]].map(([x, z]) => source.position.offset(x, 1, z)).find(p => dryStanding(bot, p));
    if (!shore) continue;
    await ctx.goto(new goals.GoalBlock(shore.x, shore.y, shore.z));
    if (!dryStanding(bot, bot.entity.position.floored()) || !isFluidSource(bot.blockAt(source.position))) continue;
    await bucketUse(ctx, 'bucket', source.position.offset(0.5, 0.6, 0.5), 'water_bucket');
    return { item: 'water_bucket', gained: 1, source: position(source.position) };
  }
  throw new Error('No safely reachable water source with a dry bank');
}
function coolingSite(bot) {
  for (const lava of nearby(bot, ['lava'], 16, 40).filter(isFluidSource)) {
    for (const [x, z] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const bank = lava.position.offset(x, 0, z), water = bank.offset(0, 1, 0), stand = bank.offset(x * 2, 1, z * 2);
      if (!solid(bot.blockAt(bank)) || !isAir(bot.blockAt(water)) || !isAir(bot.blockAt(water.offset(0, 1, 0))) || !dryStanding(bot, stand, true)) continue;
      return { lava: lava.position, bank, water, stand };
    }
  }
  return null;
}
async function placeWater(ctx) {
  const { bot } = ctx; ctx.safe();
  if (String(bot.game.dimension).includes('nether')) throw new Error('Water evaporates in the Nether; placement refused');
  if (!count(bot, 'water_bucket')) throw new Error('Collect a water bucket first');
  const site = coolingSite(bot);
  if (!site) throw new Error('No visible lava source beside a safe flat dry bank');
  await ctx.goto(new goals.GoalBlock(site.stand.x, site.stand.y, site.stand.z));
  if (!dryStanding(bot, site.stand, true) || !isFluidSource(bot.blockAt(site.lava))) throw new Error('Cooling site changed');
  // Aim at the upper solid bank face: water flows over the adjacent source.
  await bucketUse(ctx, 'water_bucket', site.bank.offset(0.5, 0.999, 0.5), 'bucket');
  await ctx.until('placed water source', () => isFluidSource(bot.blockAt(site.water)) && bot.blockAt(site.water).name === 'water');
  await ctx.until('lava converted to obsidian', () => bot.blockAt(site.lava)?.name === 'obsidian', 6000);
  await bucketUse(ctx, 'bucket', site.water.offset(0.5, 0.6, 0.5), 'water_bucket');
  return { cooledObsidian: position(site.lava), obsidianWorldVerified: true, waterRecovered: true, waterSource: position(site.water) };
}
async function buildPortal(ctx) {
  const { bot } = ctx; ctx.safe();
  if (count(bot, 'obsidian') < 10 || count(bot, 'cobblestone') < 4 || !count(bot, 'flint_and_steel')) throw new Error('Portal requires 10 obsidian, 4 cobblestone corners, and flint_and_steel');
  const origin = bot.entity.position.floored();
  let base;
  for (const [dx, dz] of [[2, 2], [-5, 2], [2, -3], [-5, -3], [4, 0], [-7, 0]]) {
    const p = origin.offset(dx, 0, dz); let clear = true;
    for (let x = 0; x < 4; x++) {
      if (!solid(bot.blockAt(p.offset(x, -1, 0)))) clear = false;
      for (let y = 0; y <= 4; y++) if (!isAir(bot.blockAt(p.offset(x, y, 0)))) clear = false;
      for (const z of [-1, 1]) if (!solid(bot.blockAt(p.offset(x, -1, z))) || !isAir(bot.blockAt(p.offset(x, 0, z))) || !isAir(bot.blockAt(p.offset(x, 1, z)))) clear = false;
    }
    if (clear) { base = p; break; }
  }
  if (!base) throw new Error('No flat clear 4x5 portal site nearby; explore a flat area');
  memories.get(bot).portalSite = position(base);
  for (const part of portalLayout(base)) {
    await ctx.goto(new goals.GoalNear(part.position.x, base.y, base.z - 2, 1), 12000);
    await placeAt(ctx, part.name, part.position);
  }
  if (!portalLayout(base).every(p => bot.blockAt(p.position)?.name === p.name)) throw new Error('Portal frame not confirmed');
  await ctx.goto(new goals.GoalNear(base.x + 1, base.y, base.z - 2, 1));
  await ctx.step('equip_igniter', () => bot.equip(bot.inventory.items().find(i => i.name === 'flint_and_steel'), 'hand'));
  await ctx.step('ignite_portal', () => bot.activateBlock(bot.blockAt(base.offset(1, 0, 0)), new Vec3(0, 1, 0)));
  await ctx.until('portal ignition', () => bot.blockAt(base.offset(1, 1, 0))?.name === 'nether_portal', 5000);
  return { frameVerified: true, portalActive: true, position: position(base) };
}
async function enterPortal(ctx) {
  const { bot } = ctx;
  if (String(bot.game?.dimension).includes('nether')) return { dimension: bot.game.dimension, alreadyThere: true };
  ctx.safe();
  const portal = nearby(bot, ['nether_portal'], 48, 30).sort((a, b) => a.position.y - b.position.y)[0];
  if (!portal) throw new Error('No active nearby portal');
  const before = bot.game.dimension;
  await ctx.goto(new goals.GoalBlock(portal.position.x, portal.position.y, portal.position.z));
  await ctx.until('Nether dimension transition', () => String(bot.game?.dimension).includes('nether') && bot.game.dimension !== before, 15000);
  return { dimensionBefore: before, dimension: bot.game.dimension, enteredNether: true };
}
async function executeSkill(bot, input, options = {}) {
  const action = validateAction(input);
  options.signal?.throwIfAborted();
  if (action.action === 'observe') return { action, verified: true, state: observe(bot) };
  if (running.has(bot)) throw new Error('Another survival skill is already running');
  if (!bot.entity || (!extendedActions.names.has(action.action) && bot.game?.gameMode !== 'survival')) throw new Error('Connected bot required; survival recipes require survival mode');
  running.add(bot);
  if (!memories.has(bot)) memories.set(bot, { visited: [], failures: [] });
  const ctx = createContext(bot, action, options), before = inventory(bot);
  try {
    ctx.check(); setSafeMovements(bot);
    let result;
    switch (action.action) {
      case 'explore': result = await explore(ctx); break;
      case 'flee': result = await explore(ctx, true); break;
      case 'eat': result = await eat(ctx); break;
      case 'craft': result = await craft(ctx); break;
      case 'build_home': result = await buildHome(ctx); break;
      case 'furnish_home': result = await furnishHome(ctx); break;
      case 'smelt': result = await smelt(ctx); break;
      case 'hunt': result = await hunt(ctx); break;
      case 'dig_staircase': result = await digStaircase(ctx); break;
      case 'collect_water': result = await collectWater(ctx); break;
      case 'place_water': result = await placeWater(ctx); break;
      case 'build_portal': result = await buildPortal(ctx); break;
      case 'enter_portal': result = await enterPortal(ctx); break;
      case 'gather_wood': {
        const names = Object.keys(bot.registry.blocksByName).filter(n => /_log$/.test(n) && !n.startsWith('stripped_'));
        result = await harvest(ctx, await harvestCandidates(ctx,names), names, action.count); break;
      }
      case 'mine': {
        const expected = HARVEST_ITEMS[action.resource];
        result = await harvest(ctx, await harvestCandidates(ctx,RESOURCES[action.resource]), expected, action.count); break;
      }
      default: if (extendedActions.names.has(action.action)) result = await extendedActions.execute(ctx); else throw new Error('Unimplemented action');
    }
    ctx.check();
    const evidence = { action, verified: true, ...result, inventoryBefore: before, inventoryAfter: inventory(bot), position: position(bot.entity.position) };
    ctx.log({ event: 'skill_verified', ...evidence });
    return evidence;
  } catch (error) {
    ctx.abort(error);
    const after = inventory(bot);
    const items = action.action === 'mine' ? HARVEST_ITEMS[action.resource] : action.action === 'gather_wood' ? Object.keys(bot.registry.blocksByName).filter(n => /_log$/.test(n) && !n.startsWith('stripped_')) : action.action === 'craft' ? ctx.partialItems || [] : [];
    const total = snapshot => snapshot.filter(i => items.includes(i.name)).reduce((sum, i) => sum + i.count, 0);
    const delta = total(after) - total(before);
    const gained = action.action === 'craft' ? Math.min(delta, ctx.craftObservedGain || 0) : delta;
    // Keep failure/cancellation authoritative; only report inventory evidence.
    if (gained > 0) error.partialResult = { verifiedPartial: true, gained, items, inventoryBefore: before, inventoryAfter: after, complete: false, ...(ctx.partialConfirmation ? { inventoryConfirmation: ctx.partialConfirmation } : {}) };
    const memory = memories.get(bot); memory.failures.push({ action, error: error.message, position: position(bot.entity?.position), at: Date.now() }); memory.failures = memory.failures.slice(-20);
    ctx.log({ event: 'skill_failed', action, error: error.message, inventoryBefore: before, inventoryAfter: after, ...(error.partialResult ? { partialResult: error.partialResult } : {}) });
    throw error;
  } finally {
    halt(bot); ctx.dispose();
    // Native Mineflayer operations have no AbortSignal. Keep the per-bot lock
    // until in-flight calls settle, even after reporting cancellation promptly.
    // A permanently stuck native operation requires reconnecting the session.
    if (ctx.hasPending()) void ctx.drain().then(() => running.delete(bot));
    else running.delete(bot);
  }
}

module.exports = { harvestRoute, stationSites, observe, executeSkill, validateAction, toolStatus, craftingOptions, foodOptions, localTerrainDiagnostics, entityDiagnostics, staircasePlan, isFluidSource, coolingSite, HarvestGoal, homeLayout, homeStatus, homeSiteClear, resolveCraftName, isSkillBusy: bot => running.has(bot), SURVIVAL_ACTION_SCHEMA, CRAFT_ITEMS, RESOURCES, SMELT_OUTPUT, FOODS, DIRECTIONS, setSafeMovements, validDig, portalLayout };
