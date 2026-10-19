'use strict';

// Builds a small, review-only counterfactual candidate set. It never reads or
// writes the frozen v1/v2/v3r1 corpora or the final holdout.
const fs = require('fs');
const crypto = require('crypto');
const path = require('path');
const { decisionMessages, compactObservation, SURVIVAL_SYSTEM } = require('../../src/minecraft/survival-planner');
const { validateAction, SURVIVAL_ACTION_SCHEMA } = require('../../src/minecraft/survival-skills');

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'data/minecraft-training');
const CONTRACT = JSON.parse(fs.readFileSync(path.join(OUT, 'contract-v3r1.json'), 'utf8'));
if (CONTRACT.system !== SURVIVAL_SYSTEM || JSON.stringify(CONTRACT.schema) !== JSON.stringify(SURVIVAL_ACTION_SCHEMA)) {
  throw new Error('Frozen v3r1 contract no longer matches runtime system prompt/action schema; stop and review before building candidates.');
}
const GOAL = '在生存模式自主生存并进入下界';
const PROVENANCE = 'synthetic; independent v4 counterfactual inspired by live failure patterns; not copied from any exact live probe';
const DIRECTIONS = ['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'];

const clone = x => JSON.parse(JSON.stringify(x));
const hashFile = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const vecDistance = (a, b) => Math.round(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 10) / 10;

function makeState(spec) {
  const position = spec.position;
  const inventory = clone(spec.inventory || []).filter(i => !(spec.table && i.name === 'crafting_table'));
  const inv = Object.fromEntries(inventory.map(i => [i.name, (i.count || 0)]));
  const pick = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe']
    .find(name => inv[name] > 0);
  const tools = pick ? [{ name: pick, durabilityUsed: spec.durabilityUsed || 0, maxDurability: 59, remaining: 59 - (spec.durabilityUsed || 0), durabilityStatus: 'known' }] : [];
  const resources = { stone: [], coal: [], iron: [], diamond: [], obsidian: [], gravel: [], wood: [] };
  for (const [kind, blocks] of Object.entries(spec.resources || {})) {
    resources[kind] = blocks.map((block, i) => ({
      name: block.name,
      position: block.position,
      distance: vecDistance(position, block.position)
    }));
  }
  const stations = spec.table ? [{ name: 'crafting_table', position: { x: position.x + 1, y: position.y, z: position.z + 1 } }] : [];
  const planks = Object.entries(inv).filter(([n]) => n.endsWith('_planks')).reduce((n, [, c]) => n + c, 0);
  const logs = Object.entries(inv).filter(([n]) => n.endsWith('_log')).reduce((n, [, c]) => n + c, 0);
  const craftable = [];
  const addRecipe = (item, outputPerCraft, requiresTable = false) => craftable.push({ item, outputPerCraft, requiresTable });
  if (logs > 0) addRecipe('planks', 4);
  if (planks >= 2) addRecipe('stick', 4);
  if (planks >= 4 && !spec.table && !inv.crafting_table) addRecipe('crafting_table', 1);
  if (planks >= 3 && inv.stick >= 2 && !pick) addRecipe('wooden_pickaxe', 1, true);
  if ((inv.cobblestone || 0) + (inv.cobbled_deepslate || 0) >= 3 && inv.stick >= 2 && !inv.stone_pickaxe) addRecipe('stone_pickaxe', 1, true);
  if ((inv.charcoal || 0) + (inv.coal || 0) > 0 && inv.stick > 0) addRecipe('torch', 4);
  const recentFailures = clone(spec.recentFailures || []);
  const state = {
    connected: true,
    mode: 'survival',
    dimension: 'overworld',
    health: spec.health ?? 20,
    food: spec.food ?? 18,
    oxygen: 20,
    position,
    timeOfDay: spec.timeOfDay ?? 6000,
    isNight: spec.isNight ?? false,
    inventory,
    tools,
    heldItem: pick ? { name: pick, durabilityUsed: spec.durabilityUsed || 0 } : null,
    equipment: pick ? [{ name: pick, durabilityUsed: spec.durabilityUsed || 0 }] : [],
    threats: clone(spec.threats || []),
    hazards: clone(spec.hazards || []),
    animals: [],
    resources,
    stations,
    fluids: clone(spec.fluids || { water: [], lava: [] }),
    craftable,
    recipeHints: clone(spec.recipeHints || []),
    recentExploration: clone(spec.recentExploration || []),
    recentFailures,
    portalSite: null,
    landmarks: { evidenceOnly: true, villageConfirmed: false, entities: [], blocks: [] },
    ...(spec.reactive ? { reactive: { enabled: true, mode: 'idle', targetId: null } } : {})
  };
  return state;
}

function actionSet(action) {
  switch (action.action) {
    case 'mine': return { action: 'mine', resource: action.resource, count: { min: 1, max: 8 } };
    case 'explore': return { action: 'explore', direction: [...DIRECTIONS], distance: { min: 8, max: 48 } };
    case 'gather_wood': return { action: 'gather_wood', count: { min: 1, max: 8 } };
    case 'craft': return { action: 'craft', item: action.item, count: { min: 1, max: 8 } };
    case 'dig_staircase': return { action: 'dig_staircase', direction: ['north', 'south', 'east', 'west'], steps: { min: 1, max: 8 } };
    case 'eat': return { action: 'eat' };
    default: return clone(action);
  }
}

function record(id, scenario, spec, action, { acceptedActions, rationale, history = [], train = true } = {}) {
  validateAction(action);
  const state = makeState(spec);
  const compact = compactObservation(state);
  const messages = decisionMessages(state, { goal: GOAL, history });
  messages.push({ role: 'assistant', content: JSON.stringify(action) });
  const row = {
    id,
    scenario,
    provenance: PROVENANCE,
    rationale,
    state,
    action,
    messages,
    sourceNote: 'Derived as an independent counterfactual from the observed post-pickaxe/material-repetition pattern; state, coordinates, inventory quantities, and history are varied.'
  };
  if (!train) {
    row.expectedActionSet = acceptedActions || actionSet(action);
    row.selectionCriteria = 'Score schema-valid, materially feasible, useful stage progress. Explore accepts any direction listed by the action set and distance 8–48; do not exact-match a single direction.';
  }
  return row;
}

const r = (name, x, y, z) => ({ name, position: { x, y, z } });
const hist = (...items) => items.map((x, i) => ({ action: x.action, status: x.status, ...(x.error ? { error: x.error } : {}), ...(x.result ? { result: x.result } : {}), at: `2026-10-01T00:00:0${i}Z` }));
const err = (action, error) => ({ action, status: 'failed', error });
const done = (action, gained = 1) => ({ action, status: 'completed', result: { verified: true, gained } });
const goodWoodInventory = (logs, planks, sticks, pick = 'wooden_pickaxe') => [
  { name: pick, count: 1 }, ...(logs ? [{ name: 'spruce_log', count: logs }] : []),
  ...(planks ? [{ name: 'spruce_planks', count: planks }] : []), ...(sticks ? [{ name: 'stick', count: sticks }] : [])
];

const train = [
  record('v4-train-01', 'wooden pickaxe with observed stone: advance to mining', { position: { x: -81.5, y: 68, z: 24.5 }, inventory: [...goodWoodInventory(0, 4, 2), { name: 'crafting_table', count: 1 }], table: true, resources: { stone: [r('stone', -77, 68, 24)] } }, { action: 'mine', resource: 'stone', count: 4 }, { rationale: '已有木镐，观测到附近石头；直接采石推进石镐阶段，不再制作木制耗材。' }),
  record('v4-train-02', 'wooden pickaxe with observed coal: mine feasible resource', { position: { x: 112.5, y: 72, z: -64.5 }, inventory: [...goodWoodInventory(1, 8, 6), { name: 'crafting_table', count: 1 }], table: true, resources: { coal: [r('coal_ore', 116, 72, -63)] } }, { action: 'mine', resource: 'coal', count: 3 }, { rationale: '木镐可采煤；煤矿已在观测范围内，行动应基于可见资源而非继续重复制作木板。' }),
  record('v4-train-03', 'stone pickaxe with observed iron', { position: { x: 28.5, y: 64, z: 134.5 }, inventory: [{ name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 4 }, { name: 'stick', count: 4 }, { name: 'spruce_planks', count: 3 }], table: true, resources: { iron: [r('iron_ore', 33, 64, 136)] } }, { action: 'mine', resource: 'iron', count: 2 }, { rationale: '石镐满足铁矿工具等级，附近存在观测到的铁矿；作为从石器转向冶炼的可行尝试。' }),
  record('v4-train-04', 'durable wooden pickaxe with stone and coal targets', { position: { x: -12.5, y: 70, z: -115.5 }, inventory: [...goodWoodInventory(2, 12, 4), { name: 'crafting_table', count: 1 }], durabilityUsed: 17, table: true, resources: { stone: [r('cobblestone', -9, 70, -115)], coal: [r('coal_ore', -15, 71, -115)] } }, { action: 'mine', resource: 'stone', count: 3 }, { rationale: '耐久仍充足，选择能升级石镐的可见石料；目标方向/暴露度仍由执行器复核。' }),
  record('v4-train-05', 'iron pickaxe with observed diamond', { position: { x: 203.5, y: 20, z: 47.5 }, inventory: [{ name: 'iron_pickaxe', count: 1 }, { name: 'stick', count: 8 }, { name: 'spruce_planks', count: 9 }, { name: 'crafting_table', count: 1 }], table: true, resources: { diamond: [r('diamond_ore', 210, 18, 49)] } }, { action: 'mine', resource: 'diamond', count: 2 }, { rationale: '铁镐满足钻石工具等级，目标在可观测距离内；只标注可行采掘尝试。' }),

  record('v4-train-06', 'pickaxe and surplus wood, no mineral target: explore', { position: { x: 66.5, y: 71, z: 188.5 }, inventory: [...goodWoodInventory(9, 28, 14), { name: 'crafting_table', count: 1 }], table: true, resources: {}, recentExploration: [{ from: { x: 52.5, y: 70, z: 186.5 }, to: { x: 58.5, y: 71, z: 188.5 }, direction: 'east' }], recentFailures: [err({ action: 'craft', item: 'crafting_table', count: 1 }, 'Missing ingredients for 1 crafting_table')] }, { action: 'explore', direction: 'north', distance: 24 }, { rationale: '木镐、工作台、木材均已充足且没有可见矿物；停止重复木材制作并换方向找资源。', history: hist(err({ action: 'craft', item: 'crafting_table', count: 1 }, 'Missing ingredients'), done({ action: 'gather_wood', count: 4 }, 4)) }),
  record('v4-train-07', 'large plank stock and completed wooden tools: explore', { position: { x: -191.5, y: 74, z: 39.5 }, inventory: [...goodWoodInventory(4, 36, 20), { name: 'crafting_table', count: 1 }], table: true, resources: {}, recentExploration: [{ from: { x: -184.5, y: 74, z: 44.5 }, to: { x: -189.5, y: 74, z: 42.5 }, direction: 'northwest' }] }, { action: 'explore', direction: 'south', distance: 32 }, { rationale: '已具备木制工具并有大量材料；最近完成工具制作后没有可见矿物，探索比继续囤木板更有进度价值。', history: hist(done({ action: 'craft', item: 'wooden_pickaxe', count: 1 }), done({ action: 'craft', item: 'crafting_table', count: 1 })) }),
  record('v4-train-08', 'workbench and tools exist, raw logs already exceed immediate need', { position: { x: 251.5, y: 66, z: -141.5 }, inventory: [...goodWoodInventory(6, 16, 12), { name: 'crafting_table', count: 1 }], table: true, resources: {}, recentExploration: [{ from: { x: 242.5, y: 66, z: -145.5 }, to: { x: 247.5, y: 66, z: -143.5 }, direction: 'east' }] }, { action: 'explore', direction: 'west', distance: 20 }, { rationale: '已有可用工具与足够原料，没有已知矿物可采；改变搜索方向寻找下一资源。' }),
  record('v4-train-09', 'previous plank batch succeeded but tool stage is ready', { position: { x: -322.5, y: 79, z: 217.5 }, inventory: [...goodWoodInventory(5, 24, 12), { name: 'crafting_table', count: 1 }], table: true, resources: {}, recentExploration: [{ from: { x: -318.5, y: 79, z: 216.5 }, to: { x: -320.5, y: 79, z: 221.5 }, direction: 'south' }] }, { action: 'explore', direction: 'northwest', distance: 28 }, { rationale: '前一步做木板已成功，背包足够且没有矿物观测；不应因成功本身继续重复同类制作。', history: hist(done({ action: 'craft', item: 'planks', count: 8 }, 8)) }),

  record('v4-train-10', 'pickaxe stage but no logs/planks and nearby reachable wood', { position: { x: 87.5, y: 69, z: 302.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'stick', count: 1 }, { name: 'crafting_table', count: 1 }], table: true, resources: { wood: [r('birch_log', 92, 69, 304)] }, recentFailures: [err({ action: 'craft', item: 'planks', count: 4 }, 'Gather wood before crafting planks')] }, { action: 'gather_wood', count: 4 }, { rationale: '补料在这里是合理的：库存没有原木/木板，附近看得到树，且最近一次木板制作因缺木失败。' }),
  record('v4-train-11', 'raw logs available but planks are genuinely missing for next recipe', { position: { x: -77.5, y: 67, z: 311.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'spruce_log', count: 2 }, { name: 'stick', count: 2 }, { name: 'cobblestone', count: 3 }, { name: 'crafting_table', count: 1 }], table: true, resources: {}, recentFailures: [] }, { action: 'craft', item: 'planks', count: 4 }, { rationale: '原木存在但木板不足；将原木转为木板支持已可制作的石镐，而不是无依据地再采树。' }),
  record('v4-train-12', 'planks and cobble available but sticks genuinely block stone pickaxe', { position: { x: 141.5, y: 73, z: 276.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'oak_planks', count: 8 }, { name: 'stick', count: 0 }, { name: 'cobblestone', count: 3 }, { name: 'crafting_table', count: 1 }], table: true, resources: {}, recentFailures: [] }, { action: 'craft', item: 'stick', count: 2 }, { rationale: '木板和圆石足够，但石镐缺木棍；补做木棍有明确的下一步用途。' }),

  record('v4-train-13', 'safe staircase attempt crossing below y=50 with one torch', { position: { x: -255.5, y: 53, z: -222.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'torch', count: 1 }, { name: 'bread', count: 4 }], health: 20, food: 16, resources: {}, hazards: [] }, { action: 'dig_staircase', direction: 'east', steps: 4 }, { rationale: '观测条件满足：木镐、血量与饥饿达标；53-4<50，需要ceil(4/4)=1火把。只表示可尝试，执行器仍需检查本地地形。' }),
  record('v4-train-14', 'safe deeper staircase attempt with torch reserve', { position: { x: 318.5, y: 48, z: 163.5 }, inventory: [{ name: 'stone_pickaxe', count: 1 }, { name: 'torch', count: 2 }, { name: 'cooked_beef', count: 3 }], health: 18, food: 14, resources: {}, hazards: [] }, { action: 'dig_staircase', direction: 'south', steps: 6 }, { rationale: '下探请求范围合法且有两支火把，48-6<50时需求ceil(6/4)=2；执行器需要逐步确认支撑和邻近危险。' }),
  record('v4-train-15', 'missing torch for planned descent but torch recipe is affordable', { position: { x: -48.5, y: 51, z: 405.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'charcoal', count: 1 }, { name: 'stick', count: 2 }, { name: 'cooked_beef', count: 2 }], table: true, resources: {}, hazards: [], recentFailures: [err({ action: 'dig_staircase', direction: 'west', steps: 4 }, 'Deep staircase requires torches (one per four steps)')] }, { action: 'craft', item: 'torch', count: 1 }, { rationale: '之前下探因无火把失败；目前木炭和木棍可制作火把，先补齐条件，不重复冒险下探。' }),
  record('v4-train-16', 'low food blocks staircase attempt; safe food is in inventory', { position: { x: 422.5, y: 57, z: -318.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'torch', count: 2 }, { name: 'cooked_mutton', count: 2 }], health: 15, food: 7, resources: {}, hazards: [] }, { action: 'eat' }, { rationale: '饥饿低于下探门槛，先吃已有安全食物恢复，不能把有镐和火把误当作足以开挖。' })
];

const dev = [
  record('v4-dev-01', 'different wooden-pickaxe state with visible stone', { position: { x: 601.5, y: 69, z: 107.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'spruce_planks', count: 11 }, { name: 'stick', count: 8 }, { name: 'crafting_table', count: 1 }], table: true, resources: { stone: [r('stone', 608, 69, 109)] } }, { action: 'mine', resource: 'stone', count: 3 }, { train: false, rationale: '独立验证已有木镐遇可见石料时是否从木材制作切到资源采集。' }),
  record('v4-dev-02', 'stone-pickaxe state with observed iron', { position: { x: -563.5, y: 62, z: -120.5 }, inventory: [{ name: 'stone_pickaxe', count: 1 }, { name: 'cobblestone', count: 7 }, { name: 'oak_planks', count: 5 }, { name: 'stick', count: 4 }, { name: 'crafting_table', count: 1 }], table: true, resources: { iron: [r('deepslate_iron_ore', -557, 61, -118)] } }, { action: 'mine', resource: 'iron', count: 2 }, { train: false, rationale: '独立检查铁矿工具级别和可见目标进度；环境结果仍可能失败。' }),
  record('v4-dev-03', 'surplus materials but no discovered mineral: allow any safe exploration direction', { position: { x: 714.5, y: 75, z: 221.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'birch_log', count: 7 }, { name: 'birch_planks', count: 31 }, { name: 'stick', count: 10 }, { name: 'crafting_table', count: 1 }], table: true, resources: {}, recentExploration: [{ from: { x: 707.5, y: 75, z: 220.5 }, to: { x: 711.5, y: 75, z: 222.5 }, direction: 'east' }] }, { action: 'explore', direction: 'north', distance: 24 }, { train: false, rationale: '多方向均可接受；不按单一exact方向评价。', acceptedActions: { action: 'explore', direction: DIRECTIONS.filter(d => d !== 'east'), distance: { min: 8, max: 48 } } }),
  record('v4-dev-04', 'repeat crafting already supplied but no visible ores', { position: { x: -744.5, y: 68, z: 332.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'jungle_log', count: 4 }, { name: 'jungle_planks', count: 18 }, { name: 'stick', count: 12 }, { name: 'crafting_table', count: 1 }], table: true, resources: {}, recentFailures: [err({ action: 'craft', item: 'crafting_table', count: 1 }, 'Missing ingredients for crafting_table')] }, { action: 'explore', direction: 'southwest', distance: 32 }, { train: false, rationale: '现有材料已足够，缺乏已观测矿物；可选安全探索方向集合，不固化某一方位。', acceptedActions: { action: 'explore', direction: [...DIRECTIONS], distance: { min: 8, max: 48 } } }),
  record('v4-dev-05', 'materials are short but visible wood can be gathered', { position: { x: 837.5, y: 71, z: -275.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'stick', count: 2 }], table: true, resources: { wood: [r('oak_log', 843, 71, -273)] }, recentFailures: [err({ action: 'craft', item: 'planks', count: 4 }, 'Gather wood before crafting planks')] }, { action: 'gather_wood', count: 3 }, { train: false, rationale: '保留需要实际补料的对照；方向、路径和目标可达性仍由执行器检查。' }),
  record('v4-dev-06', 'logs available for useful plank batch but no surplus planks', { position: { x: -882.5, y: 64, z: -318.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'oak_log', count: 2 }, { name: 'stick', count: 2 }, { name: 'cobblestone', count: 3 }, { name: 'crafting_table', count: 1 }], table: true, resources: {}, recentFailures: [] }, { action: 'craft', item: 'planks', count: 4 }, { train: false, rationale: '原木存在而木板不足以支持下一步升级，制作木板有材料依据。' }),
  record('v4-dev-07', 'underground descent only with adequate torches and vitals', { position: { x: 953.5, y: 50, z: 144.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'torch', count: 2 }, { name: 'bread', count: 3 }], health: 17, food: 13, resources: {}, hazards: [] }, { action: 'dig_staircase', direction: 'west', steps: 5 }, { train: false, rationale: '50-5<50且ceil(5/4)=2，两个火把、镐与生命/饥饿均达标；局部地形安全不由state保证。' }),
  record('v4-dev-08', 'staircase blocked by torch shortage; craft missing safety supply', { position: { x: -1004.5, y: 52, z: 287.5 }, inventory: [{ name: 'wooden_pickaxe', count: 1 }, { name: 'charcoal', count: 2 }, { name: 'stick', count: 4 }, { name: 'cooked_beef', count: 2 }], table: true, health: 18, food: 15, resources: {}, hazards: [], recentFailures: [err({ action: 'dig_staircase', direction: 'north', steps: 4 }, 'Deep staircase requires torches (one per four steps)')] }, { action: 'craft', item: 'torch', count: 1 }, { train: false, rationale: '下探需要至少一支火把而当前没有；配方原料现成，先补充安全用品。' })
];

function writeJsonl(file, records) {
  fs.writeFileSync(path.join(OUT, file), records.map(r => JSON.stringify(r)).join('\n') + '\n');
}
function readJsonl(file) {
  return fs.readFileSync(path.join(OUT, file), 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}
function promptKeys(records) { return new Set(records.map(r => r.messages[r.messages.length - 2].content)); }
writeJsonl('train-v4-candidates.jsonl', train);
writeJsonl('development-v4-candidates.jsonl', dev);
const v3Train = path.join(OUT, 'train-v3r1.jsonl');
const v3Dev = path.join(OUT, 'development-v3r1.jsonl');
const replayPath = path.join(OUT, 'train-v4-replay-candidates.jsonl');
const replay = fs.readFileSync(v3Train, 'utf8').trimEnd() + '\n' + fs.readFileSync(path.join(OUT, 'train-v4-candidates.jsonl'), 'utf8');
fs.writeFileSync(replayPath, replay);
const oldTrainRecords = readJsonl('train-v3r1.jsonl');
const oldDevRecords = readJsonl('development-v3r1.jsonl');
const candidateTrainKeys = promptKeys(train), candidateDevKeys = promptKeys(dev);
const oldTrainKeys = promptKeys(oldTrainRecords), oldDevKeys = promptKeys(oldDevRecords);
const overlapCount = (a, b) => [...a].filter(x => b.has(x)).length;
const manifest = {
  dataset: 'minecraft-survival-v4-candidates',
  status: 'candidate-only; awaiting independent Astra audit and root review; not used for training',
  contract: 'Frozen current SURVIVAL_ACTION_SCHEMA and survival-planner decisionMessages; no schema or system prompt change',
  provenance: PROVENANCE,
  trainingRows: train.length,
  developmentRows: dev.length,
  trainSha256: hashFile(path.join(OUT, 'train-v4-candidates.jsonl')),
  developmentSha256: hashFile(path.join(OUT, 'development-v4-candidates.jsonl')),
  replayRows: 182,
  replaySha256: hashFile(replayPath),
  frozenInputReferences: {
    v3r1TrainSha256: hashFile(v3Train),
    v3r1DevelopmentSha256: hashFile(v3Dev),
    liveTrialR2Sha256: hashFile(path.join(OUT, 'live-trial-v3r1-20261012-candidates-r2.json')),
    exactSameStateProbe: 'output/minecraft-training/live-probe-1791836151666.json (development only; never a train row)'
  },
  promptOverlap: {
    candidateTrainWithinSet: train.length - candidateTrainKeys.size,
    candidateDevWithinSet: dev.length - candidateDevKeys.size,
    candidateTrainVsDev: overlapCount(candidateTrainKeys, candidateDevKeys),
    candidateTrainVsFrozenV3r1Train: overlapCount(candidateTrainKeys, oldTrainKeys),
    candidateTrainVsFrozenV3r1Development: overlapCount(candidateTrainKeys, oldDevKeys),
    candidateDevVsFrozenV3r1Train: overlapCount(candidateDevKeys, oldTrainKeys),
    candidateDevVsFrozenV3r1Development: overlapCount(candidateDevKeys, oldDevKeys)
  },
  runtimeSourceHashes: {
    survivalPlanner: hashFile(path.join(ROOT, 'src/minecraft/survival-planner.js')),
    survivalSkills: hashFile(path.join(ROOT, 'src/minecraft/survival-skills.js'))
  },
  frozenContractHashes: {
    contractVersion: CONTRACT.version,
    systemPromptSha256: crypto.createHash('sha256').update(CONTRACT.system).digest('hex'),
    actionSchemaSha256: crypto.createHash('sha256').update(JSON.stringify(CONTRACT.schema)).digest('hex'),
    runtimePromptMatchesFrozen: CONTRACT.system === SURVIVAL_SYSTEM,
    runtimeSchemaMatchesFrozen: JSON.stringify(CONTRACT.schema) === JSON.stringify(SURVIVAL_ACTION_SCHEMA)
  },
  proposal: 'If approved after independent audit: replay unchanged train-v3r1 (166 rows) plus these 16 candidates via train-v4-replay-candidates.jsonl; resume from v3r1 epoch-02 at learning rate 1e-5 for one epoch, save into a new output directory. No GPU work was started.',
  suggestedCommand: 'runtime/minecraft-training/.venv/Scripts/python.exe scripts/minecraft-training/train_lora.py --allow-gpu-training --min-free-gib 6.0 --data data/minecraft-training/train-v4-replay-candidates.jsonl --output runtime/minecraft-training/adapters/minecraft-survival-v4-replay-candidate --resume-adapter runtime/minecraft-training/adapters/minecraft-survival-v3r1-fresh-base/checkpoint-epoch-02 --epochs 1 --max-length 1536 --rank 4 --learning-rate 1e-5 --experiment minecraft-survival-v4-replay-candidate --log-every-steps 4 (proposal only; do not run before audit/root approval)',
  validation: { schemaValid: true, messagesBuiltWithRuntimePlanner: true, distancesDerivedFromPositions: true, trainDevInputOverlap: overlapCount(candidateTrainKeys, candidateDevKeys) },
  notes: [
    'Train actions are strict single labels. Dev rows carry expectedActionSet for accepted direction/resource/count classes; custom semantic scoring is required, since the generic evaluator exact-matches one action.',
    'Mine targets are synthetic observation fixtures with positions inside the perception radius. Visibility, exposure, path reachability, and world physics remain runtime checks.',
    'Staircase gold means permitted attempt only. Hidden adjacent block geometry cannot be inferred from observations and must not be scored as model guarantee.',
    'No exact live probe state or response was copied into train data; dev coordinates/inventory/history differ from training.'
  ]
};
fs.writeFileSync(path.join(OUT, 'manifest-v4-candidates.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(JSON.stringify({ train: train.length, dev: dev.length, replay: manifest.replayRows, trainSha256: manifest.trainSha256, developmentSha256: manifest.developmentSha256, replaySha256: manifest.replaySha256, invalidActions: 0, files: ['train-v4-candidates.jsonl', 'development-v4-candidates.jsonl', 'train-v4-replay-candidates.jsonl', 'manifest-v4-candidates.json'] }, null, 2));
