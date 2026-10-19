'use strict';

// Build a candidate-only, independently authored dense-state training set.
// Never reads holdout or mutates the frozen v1-v4 corpora.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mcData = require('minecraft-data')('1.21.11');
const { decisionMessages, compactObservation, SURVIVAL_SYSTEM } = require('../../src/minecraft/survival-planner');
const { validateAction, SURVIVAL_ACTION_SCHEMA } = require('../../src/minecraft/survival-skills');

const ROOT = path.resolve(__dirname, '../..');
const DATA = path.join(ROOT, 'data/minecraft-training');
const OUT = path.join(ROOT, 'output/minecraft-training');
const GOAL = '在生存模式自主生存并进入下界';
const PROVENANCE = 'synthetic; independently authored dense-state counterfactual; no exact live probe copied';
const DIRECTIONS = ['north', 'south', 'east', 'west', 'northeast', 'northwest', 'southeast', 'southwest'];
const clone = x => JSON.parse(JSON.stringify(x));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const distance = (a, b) => Math.round(Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z) * 10) / 10;

const defaultHistory = [
  { action: { action: 'observe' }, status: 'completed', result: { verified: true, gained: 0 } },
  { action: { action: 'observe' }, status: 'completed', result: { verified: true, gained: 0 } },
  { action: { action: 'explore', direction: 'east', distance: 24 }, status: 'completed', result: { verified: true, complete: true, gained: 0 } },
  { action: { action: 'observe' }, status: 'completed', result: { verified: true, gained: 0 } },
  { action: { action: 'observe' }, status: 'completed', result: { verified: true, gained: 0 } },
  { action: { action: 'build_portal' }, status: 'failed', error: 'Need 10 obsidian for portal', result: { verified: false, gained: 0 } }
];
const fullFoodHistory = [
  ...defaultHistory.slice(0, 5),
  { action: { action: 'eat' }, status: 'completed', result: { alreadyFull: true, foodBefore: 20, foodAfter: 20, verified: true } }
];
const foodRecoveryHistory = (before, after) => [
  ...defaultHistory.slice(0, 3),
  { action: { action: 'eat' }, status: 'completed', result: { foodBefore: before, foodAfter: after, verified: true } },
  { action: { action: 'observe' }, status: 'completed', result: { verified: true, gained: 0 } },
  { action: { action: 'observe' }, status: 'completed', result: { verified: true, gained: 0 } }
];

function positions(base) {
  const [x, y, z] = [base.x, base.y, base.z];
  const blocks = (name, offsets) => offsets.map(([dx, dy, dz]) => ({ name, position: { x: x + dx, y: y + dy, z: z + dz } }));
  return {
    stone: blocks('stone', [[5, 0, 2], [8, 0, 3], [11, 0, 5], [14, 0, 2]]),
    coal: blocks('coal_ore', [[7, 1, 9], [12, 1, 11], [16, 0, 9]]),
    iron: blocks('iron_ore', [[18, -1, 8], [22, -2, 10], [25, -2, 7]]),
    diamond: blocks('diamond_ore', [[-17, -2, 4], [-20, -1, 7]]),
    obsidian: blocks('obsidian', [[-12, -1, 15], [-14, 0, 17]]),
    gravel: blocks('gravel', [[-7, 0, 10], [-10, 0, 13], [-13, 0, 9]]),
    wood: blocks('spruce_log', [[-8, 0, -7], [-11, 0, -8], [-13, 0, -11], [-16, 0, -9]])
  };
}

function inventoryMap(inv) { return Object.fromEntries(inv.map(i => [i.name, i.count])); }
function deriveCraftable(inv, table) {
  const n = inventoryMap(inv), logs = inv.filter(i => /_log$/.test(i.name)).reduce((a, i) => a + i.count, 0);
  const planks = inv.filter(i => /_planks$/.test(i.name)).reduce((a, i) => a + i.count, 0);
  const out = [];
  const add = (item, outputPerCraft, requiresTable = false) => out.push({ item, outputPerCraft, requiresTable });
  if (logs) add('planks', 4);
  if (planks >= 2) add('stick', 4);
  if (planks >= 4 && !table && !n.crafting_table) add('crafting_table', 1);
  if (planks >= 3 && n.stick >= 2 && !n.wooden_pickaxe && !n.stone_pickaxe) add('wooden_pickaxe', 1, true);
  if ((n.cobblestone || 0) + (n.cobbled_deepslate || 0) >= 3 && n.stick >= 2 && !n.stone_pickaxe) add('stone_pickaxe', 1, true);
  if ((n.cobblestone || 0) + (n.cobbled_deepslate || 0) >= 8 && !n.furnace) add('furnace', 1, true);
  if (n.iron_ingot >= 3 && n.stick >= 2 && !n.iron_pickaxe) add('iron_pickaxe', 1, true);
  if ((n.coal || 0) + (n.charcoal || 0) > 0 && n.stick > 0) add('torch', 4);
  return out;
}

function makeState(def) {
  const position = clone(def.position);
  const inventory = clone(def.inventory || []).filter(i => i.count > 0);
  const n = inventoryMap(inventory);
  const pickName = ['netherite_pickaxe', 'diamond_pickaxe', 'iron_pickaxe', 'stone_pickaxe', 'wooden_pickaxe'].find(k => n[k] > 0);
  const durability = pickName ? mcData.itemsByName[pickName]?.maxDurability : null;
  if (pickName && !Number.isInteger(durability)) throw new Error(`Missing registry durability for ${pickName}`);
  const resources = positions(position);
  for (const kind of Object.keys(resources)) if (def.emptyResources?.includes(kind)) resources[kind] = [];
  const locatedResources = Object.fromEntries(Object.entries(resources).map(([kind, list]) => [kind, list.map(b => ({ ...b, distance: distance(position, b.position) }))]));
  const station = { name: 'crafting_table', position: { x: position.x + 2, y: position.y, z: position.z + 1 } };
  const state = {
    connected: true, mode: 'survival', dimension: 'overworld', health: def.health ?? 20, food: def.food ?? 20, oxygen: 20,
    position, timeOfDay: 7000, isNight: false, inventory,
    tools: pickName ? [{ name: pickName, durabilityUsed: 0, maxDurability: durability, remaining: durability, durabilityStatus: 'known' }] : [],
    heldItem: pickName ? { name: pickName, durabilityUsed: 0 } : null,
    equipment: pickName ? [{ name: pickName, durabilityUsed: 0 }] : [], threats: [], hazards: [], animals: [],
    resources: locatedResources, stations: def.table === false || n.crafting_table ? [] : [station],
    fluids: { water: [], lava: [] }, craftable: deriveCraftable(inventory, def.table !== false || n.crafting_table),
    recipeHints: clone(def.recipeHints || []), recentExploration: clone(def.recentExploration || [{ from: { x: position.x - 24, y: position.y, z: position.z }, to: clone(position), direction: 'east', distance: 24 }]), recentFailures: clone(def.recentFailures || []),
    portalSite: null, landmarks: { evidenceOnly: true, villageConfirmed: false, entities: [], blocks: [] },
    reactive: { enabled: true, mode: 'idle', targetId: null }
  };
  return state;
}

function actionSet(action) {
  if (action.action === 'explore') return { action: 'explore', direction: DIRECTIONS, distance: { min: 8, max: 48 } };
  if (action.action === 'gather_wood') return { action: 'gather_wood', count: { min: 1, max: 8 } };
  if (action.action === 'mine') return { action: 'mine', resource: action.resource, count: { min: 1, max: 8 } };
  if (action.action === 'craft') return { action: 'craft', item: action.item, count: { min: 1, max: 8 } };
  return clone(action);
}

function makeRow(id, def, isDev) {
  const explicitFailure = def.recentFailures?.at(-1);
  const selectedHistory = def.history || (explicitFailure && def.scenario.includes('wood visible')
    ? [...defaultHistory.slice(0, 2), defaultHistory[3], defaultHistory[4], { action: clone(explicitFailure.action), status: 'failed', error: explicitFailure.error, result: { verified: false, gained: 0 } }, { action: { action: 'explore', direction: 'east', distance: 8 }, status: 'completed', result: { verified: true, complete: true, gained: 0 } }]
    : explicitFailure
    ? [...defaultHistory.slice(0, 5), { action: clone(explicitFailure.action), status: 'failed', error: explicitFailure.error, result: { verified: false, gained: 0 } }]
    : defaultHistory);
  const history = clone(selectedHistory);
  const failuresFromHistory = history.filter(h => h.status === 'failed').map(h => ({ action: clone(h.action), error: h.error || 'Action failed without verified world change' }));
  const state = makeState({ ...def, recentFailures: def.recentFailures || failuresFromHistory });
  const action = clone(def.action);
  validateAction(action);
  const messages = decisionMessages(state, { history, goal: GOAL });
  messages.push({ role: 'assistant', content: JSON.stringify(action) });
  const row = {
    id, scenario: def.scenario, provenance: PROVENANCE, rationale: def.rationale,
    state, action, messages,
    labelBasis: def.labelBasis,
    limitations: def.limitations || ['Action feasibility depends on current server checks for exposure, path, and danger; this is not a guaranteed execution outcome.']
  };
  if (isDev) {
    row.expectedActionSet = def.expectedActionSet || actionSet(action);
    row.selectionCriteria = def.selectionCriteria || 'Accept schema-valid, materially feasible, useful next actions from the stated action set; do not exact-match an arbitrary count or exploration direction.';
  }
  return row;
}

const D = (x, z, spec) => ({ position: { x, y: 64, z }, ...spec });
const log = (name, count) => ({ name: `${name}_log`, count });
const plank = (name, count) => ({ name: `${name}_planks`, count });
const pick = (name = 'wooden_pickaxe') => ({ name, count: 1 });
const table = { name: 'crafting_table', count: 1 };
const sticks = (count = 4) => ({ name: 'stick', count });
const cobble = (count = 8) => ({ name: 'cobblestone', count });
const food = (name, count = 2) => ({ name, count });
const six = defaultHistory;
const progress = ['Schema-valid skill action; inventory and visible preconditions make it a useful next step.'];

// 32 training rows: balanced task pairs with varied coordinates/inventory/history.
const trainDefs = [
  D(101, 208, { scenario: 'full hunger and raw meat after alreadyFull no-op; use visible stone', inventory: [pick(), table, plank('spruce', 8), sticks(6), food('beef', 2), cobble(2)], history: fullFoodHistory, action: { action: 'mine', resource: 'stone', count: 4 }, rationale: '最近eat结果alreadyFull=true且food前后均20；库存肉仍在，改做有效采集。', labelBasis: progress }),
  D(-143, 57, { scenario: 'full hunger and raw pork after alreadyFull no-op; craft stone pickaxe', inventory: [pick(), table, plank('oak', 9), sticks(6), food('porkchop', 2), cobble(5)], history: fullFoodHistory, action: { action: 'craft', item: 'stone_pickaxe', count: 1 }, rationale: '满饥饿的eat无变化，肉类仍在；木棍圆石与工作台足以制作石镐。', labelBasis: progress }),
  D(226, -91, { scenario: 'full hunger with apple after alreadyFull no-op; mine coal', inventory: [pick(), table, food('apple', 3), log('birch', 2), plank('birch', 8), sticks(4)], history: fullFoodHistory, action: { action: 'mine', resource: 'coal', count: 3 }, rationale: 'alreadyFull的无操作结果没有消耗苹果；food=20时开采可见煤更有用。', labelBasis: progress }),
  D(-309, -77, { scenario: 'full hunger and cooked food; explore after tools are ready', inventory: [pick('stone_pickaxe'), table, food('cooked_beef', 3), cobble(10), plank('spruce', 12), sticks(8)], action: { action: 'explore', direction: 'west', distance: 24 }, rationale: '饱食且工具与木料充足；没有当前必需的进食，探索寻找后续矿物。', labelBasis: progress }),
  D(374, 125, { scenario: 'low hunger with safe cooked food; recent eat result confirms recovery', food: 14, inventory: [pick(), table, food('cooked_chicken', 2), plank('birch', 5), sticks(3)], history: foodRecoveryHistory(7, 15), action: { action: 'eat' }, rationale: '最近真实进食结果food从7升到15；当前仍低于20且还有熟食，继续恢复。', labelBasis: ['food<20 and safe edible inventory exists; eat is useful.'] }),
  D(-427, 164, { scenario: 'low hunger with bread and nearby resources after previous recovery', food: 14, inventory: [pick('stone_pickaxe'), table, food('bread', 2), cobble(5), plank('oak', 6)], history: foodRecoveryHistory(8, 16), action: { action: 'eat' }, rationale: '近期面包进食曾把food从8提升到16；当前food=14仍未满且库存有面包。', labelBasis: ['food<20 and safe edible inventory exists; eat is useful.'] }),
  D(518, -203, { scenario: 'full hunger with salmon and an iron tool stage', inventory: [pick('iron_pickaxe'), table, food('salmon', 2), { name: 'iron_ingot', count: 3 }, sticks(4)], action: { action: 'mine', resource: 'diamond', count: 2 }, rationale: '满饥饿不吃鱼；铁镐可采可见钻石，推进目标。', labelBasis: progress }),
  D(-581, -216, { scenario: 'low hunger raw mutton is allowed and recent recovery evidence is present', food: 13, inventory: [pick(), table, food('mutton', 1), plank('spruce', 4), sticks(2)], history: foodRecoveryHistory(6, 14), action: { action: 'eat' }, rationale: '近期进食food从6升到14；目前13且背包仍有白名单内羊肉，继续恢复。', labelBasis: ['food<20 and safe edible inventory exists; eat is useful.'] }),

  D(632, 279, { scenario: 'no pickaxe; materials and table support wooden pickaxe before visible stone', inventory: [table, plank('spruce', 8), sticks(4)], action: { action: 'craft', item: 'wooden_pickaxe', count: 1 }, rationale: '没有镐但木板、木棍和工作台齐全；先制作木镐再采石，不能裸挖石头。', labelBasis: ['mine stone requires an appropriate pickaxe; craft wooden_pickaxe is currently feasible.'] }),
  D(-706, 315, { scenario: 'no pickaxe, no sticks, reachable logs; gather prerequisite material', inventory: [table, plank('oak', 3)], action: { action: 'gather_wood', count: 4 }, rationale: '没有镐且木棍不足；可见原木可补充木材，避免直接采石。', labelBasis: ['no pickaxe; gather is useful when visible wood exists and materials are insufficient.'] }),
  D(778, -327, { scenario: 'no pickaxe and no visible wood; explore instead of mining', inventory: [food('apple', 1)], emptyResources: ['wood'], action: { action: 'explore', direction: 'south', distance: 20 }, rationale: '无镐、无可见木材，不应重复挖石或伪造补料；探索寻找资源。', labelBasis: ['no appropriate tool and no visible wood; explore for prerequisites.'] }),
  D(-842, -364, { scenario: 'stone pickaxe and enough sticks/cobble; mine iron with proper tier', inventory: [pick('stone_pickaxe'), table, sticks(6), cobble(9), plank('birch', 5)], action: { action: 'mine', resource: 'iron', count: 3 }, rationale: '石镐满足铁矿等级且铁矿可见，选择推进冶炼阶段。', labelBasis: progress }),
  D(914, 402, { scenario: 'wooden pickaxe cannot harvest iron; gather logs for tool progression', inventory: [pick(), table, sticks(2)], action: { action: 'gather_wood', count: 4 }, rationale: '木镐不足以采铁，当前木材可见；先补木料以继续工具/工作台配方链。', labelBasis: ['wood is visible; gathering is a feasible prerequisite step while iron mining is tier-blocked.'] }),
  D(-986, 447, { scenario: 'iron pickaxe can mine diamond; avoid repeated crafting of wooden items', inventory: [pick('iron_pickaxe'), table, plank('spruce', 24), sticks(12), { name: 'iron_ingot', count: 4 }], action: { action: 'mine', resource: 'diamond', count: 2 }, rationale: '铁镐满足钻石矿等级，基础木制装备已充足，不重复制作。', labelBasis: progress }),
  D(1058, -489, { scenario: 'no pickaxe, sufficient cobble and sticks but no table; create table first', table: false, inventory: [plank('oak', 4), sticks(4), cobble(4)], action: { action: 'craft', item: 'crafting_table', count: 1 }, rationale: '无镐且已有4木板、木棍、圆石，但没有工作台；先补齐制作站，再做石镐。', labelBasis: ['no table; craft crafting_table is feasible and unlocks stone_pickaxe.'] }),
  D(-1132, 527, { scenario: 'no pickaxe and enough cobble/sticks with existing table; make stone pickaxe', inventory: [table, plank('birch', 5), sticks(4), cobble(5)], action: { action: 'craft', item: 'stone_pickaxe', count: 1 }, rationale: '工作台、圆石与木棍已满足石镐配方；不直接挖铁或钻石。', labelBasis: ['craftable stone_pickaxe is a feasible tool-tier prerequisite.'] }),

  D(1204, 563, { scenario: 'wood exhausted after failed gather; explore rather than repeat gather', inventory: [pick(), table, plank('spruce', 3), sticks(2)], emptyResources: ['wood'], recentFailures: [{ action: { action: 'gather_wood', count: 4 }, error: 'No exposed reachable resource' }], action: { action: 'explore', direction: 'northwest', distance: 24 }, rationale: '当前木材列表为空且最近采木失败；换区域探索，避免重复空采。', labelBasis: ['no visible wood and recent gather failure; explore is the recovery action.'] }),
  D(-1278, -601, { scenario: 'wood visible and no logs after a prior empty gather', inventory: [pick(), table, plank('oak', 1), sticks(2)], recentFailures: [{ action: { action: 'gather_wood', count: 2 }, error: 'No exposed reachable resource' }], recentExploration: [{ from: { x: -1286, y: 64, z: -601 }, to: { x: -1278, y: 64, z: -601 }, direction: 'east', distance: 8 }], action: { action: 'gather_wood', count: 4 }, rationale: '新状态已有不同方向的可见木材，且原木为零；此次补采是合理重试，不是对旧失败原地重复。', labelBasis: ['visible wood exists at a new position; inventory lacks logs.'] }),
  D(1350, 638, { scenario: 'pickaxe and ample wood, no mineral observation; explore for progression', inventory: [pick(), table, log('spruce', 6), plank('spruce', 20), sticks(12), cobble(8)], action: { action: 'explore', direction: 'east', distance: 32 }, rationale: '木镐、木料和圆石均充足，当前无可见矿物；探索比再采木或重复制作有进度。', labelBasis: progress }),
  D(-1422, 674, { scenario: 'recent gather completed but no wood remains in current observation', inventory: [pick(), table, plank('birch', 3), sticks(3)], emptyResources: ['wood'], recentFailures: [{ action: { action: 'gather_wood', count: 4 }, error: 'No exposed reachable resource' }], action: { action: 'explore', direction: 'northeast', distance: 28 }, rationale: '采木资源已经耗尽且背包无原木，改变搜索方向而非重复gather。', labelBasis: ['empty wood observation after a gather failure; explore for a new resource patch.'] }),
  D(1496, -715, { scenario: 'wood present but inventory already contains logs and planks', inventory: [pick(), table, log('oak', 3), plank('oak', 12), sticks(8)], action: { action: 'explore', direction: 'south', distance: 24 }, rationale: '背包原木和木板都足够，附近虽有树但当前没有补料需求；转向搜矿。', labelBasis: ['wood exists but current stock is sufficient; explore advances resource search.'] }),
  D(-1560, -759, { scenario: 'wood depletion plus five prior outcomes; select another direction', inventory: [pick(), table, plank('spruce', 2), sticks(2)], emptyResources: ['wood'], recentFailures: [{ action: { action: 'gather_wood', count: 5 }, error: 'No exposed reachable resource' }], action: { action: 'explore', direction: 'southwest', distance: 20 }, rationale: '没有可见原木，过去的采集失败已经记录；不把一次失败无限重试。', labelBasis: ['no visible wood and repeated gathering failures; explore is actionable recovery.'] }),

  D(1628, 802, { scenario: 'spruce logs plus cherry recipe hint; craft generic planks item, not species action', table: false, inventory: [log('spruce', 3), food('apple', 1)], recipeHints: [{ item: 'crafting_table', missing: [{ name: 'cherry_planks', count: 4 }], oneRecipeExample: true }, { item: 'wooden_pickaxe', missing: [{ name: 'cherry_planks', count: 3 }, { name: 'stick', count: 2 }], oneRecipeExample: true }], action: { action: 'craft', item: 'planks', count: 8 }, rationale: '配方提示的cherry_planks是材料例子，不是合法动作enum；现有spruce原木可先转换为通用planks。', labelBasis: ['craft action item must use generic enum planks; available logs make planks feasible.'] }),
  D(-1694, 846, { scenario: 'birch logs and recipe hint show cherry ingredient; produce generic planks', table: false, inventory: [log('birch', 2), food('carrot', 2)], recipeHints: [{ item: 'crafting_table', missing: [{ name: 'cherry_planks', count: 4 }], oneRecipeExample: true }], action: { action: 'craft', item: 'planks', count: 4 }, rationale: '合法craft目标为planks；recipeHints中的cherry_planks表示示例材料名称，库存birch原木可制作木板。', labelBasis: ['generic planks action is valid despite species-specific hint wording.'] }),
  D(1762, -891, { scenario: 'oak planks enough for table; use the action enum crafting_table', table: false, inventory: [plank('oak', 8), sticks(2)], action: { action: 'craft', item: 'crafting_table', count: 1 }, rationale: '库存有足量oak_planks但合法action值为通用crafting_table；木材品种不应复制进item字段。', labelBasis: ['crafting_table is craftable from existing planks; species-specific item names are not action enums.'] }),
  D(-1830, -935, { scenario: 'many oak logs but no planks; convert logs before making tools', table: false, inventory: [log('oak', 5), food('bread', 1)], recipeHints: [{ item: 'crafting_table', missing: [{ name: 'spruce_planks', count: 4 }], oneRecipeExample: true }, { item: 'wooden_pickaxe', missing: [{ name: 'cherry_planks', count: 3 }], oneRecipeExample: true }], action: { action: 'craft', item: 'planks', count: 12 }, rationale: '已有原木可制作planks；recipe hint里的spruce/cherry是某个配方示例，不要求该具体木种。', labelBasis: ['logs make generic planks; do not copy species-specific ingredient into action item.'] }),
  D(1896, 978, { scenario: 'logs enough for planks but no crafting table; start legal action enum', table: false, inventory: [log('cherry', 2), sticks(1)], recipeHints: [{ item: 'crafting_table', missing: [{ name: 'oak_planks', count: 4 }], oneRecipeExample: true }], action: { action: 'craft', item: 'planks', count: 8 }, rationale: '动作enum使用通用planks；cherry原木可转木板，后续再制作工作台。', labelBasis: ['generic planks is feasible from available cherry logs; recipe ingredient name is not the action enum.'] }),
  D(2028, -1067, { scenario: 'recipe hint mentions acacia planks; available logs produce generic planks', table: false, inventory: [log('acacia', 2), food('apple', 1)], recipeHints: [{ item: 'crafting_table', missing: [{ name: 'acacia_planks', count: 4 }], oneRecipeExample: true }], action: { action: 'craft', item: 'planks', count: 8 }, rationale: 'recipeHints里的acacia_planks是缺料举例，动作只接受通用planks；当前acacia原木足以制作木板。', labelBasis: ['generic planks from available logs; species-specific name is ingredient data, not an action enum.'] }),

  D(-2094, -1110, { scenario: 'craftable stone pickaxe is the next stage before mining iron', inventory: [pick(), table, plank('spruce', 8), sticks(6), cobble(6)], action: { action: 'craft', item: 'stone_pickaxe', count: 1 }, rationale: '已有木镐、工作台、圆石和木棍，制作石镐可解锁铁矿开采。', labelBasis: progress }),
  D(2160, 1154, { scenario: 'stone pickaxe and fuel; collect visible iron and coal before smelting', inventory: [pick('stone_pickaxe'), table, cobble(8), sticks(6), plank('oak', 8)], action: { action: 'mine', resource: 'iron', count: 3 }, rationale: '石镐能采铁，当前可见铁矿，先取得冶炼原料。', labelBasis: progress }),
  D(-2226, 1198, { scenario: 'iron ingots and sticks allow iron pickaxe stage advancement', inventory: [pick('stone_pickaxe'), table, { name: 'iron_ingot', count: 4 }, sticks(4), { name: 'furnace', count: 1 }, { name: 'coal', count: 5 }], action: { action: 'craft', item: 'iron_pickaxe', count: 1 }, rationale: '有足量铁锭、木棍和工作台；制作铁镐推进钻石阶段。', labelBasis: progress }),
  D(2292, -1243, { scenario: 'raw iron and coal with furnace; smelt available ore', inventory: [pick('stone_pickaxe'), table, { name: 'raw_iron', count: 4 }, { name: 'coal', count: 5 }, { name: 'furnace', count: 1 }, sticks(4)], action: { action: 'smelt', item: 'raw_iron', count: 3 }, rationale: '现有熔炉、燃料和原铁足够，冶炼推进铁镐制作。', labelBasis: progress }),
];

// 12 new dev-only cases, with varied coordinates and acceptable action sets.
const devDefs = [
  D(2556, 1419, { scenario: 'DEV full hunger, raw beef after alreadyFull no-op', inventory: [pick('iron_pickaxe'), table, food('beef', 2), { name: 'iron_ingot', count: 5 }, plank('oak', 10)], history: fullFoodHistory, action: { action: 'mine', resource: 'diamond', count: 2 }, rationale: 'food=20 and recent alreadyFull confirms no-op; iron tool supports visible diamond.', labelBasis: ['food=20 rejects eat; mine diamond is feasible and useful.'], expectedActionSet: { action: 'mine', resource: 'diamond', count: { min: 1, max: 8 } } }),
  D(-2622, -1463, { scenario: 'DEV low hunger, apple available, recent food recovery', food: 12, inventory: [pick(), table, food('apple', 2), plank('spruce', 6), sticks(4)], history: foodRecoveryHistory(5, 13), action: { action: 'eat' }, rationale: 'recent eat raised food from5 to13; current food=12 remains below full and apple is available.', labelBasis: ['food<20 and safe edible item is available.'] }),
  D(2688, 1507, { scenario: 'DEV full hunger, cooked mutton, stage-ready furnace materials', inventory: [pick('stone_pickaxe'), table, food('cooked_mutton', 2), { name: 'raw_iron', count: 3 }, { name: 'coal', count: 4 }, { name: 'furnace', count: 1 }], action: { action: 'smelt', item: 'raw_iron', count: 2 }, rationale: 'fullfood rejects eat; smelt available iron advances tool stage.', labelBasis: ['food=20; available furnace/fuel/ore make smelt useful.'] }),
  D(-2754, 1551, { scenario: 'DEV no tool with available logs; gather before stone mining', inventory: [table, plank('birch', 1), sticks(1)], action: { action: 'gather_wood', count: 3 }, rationale: 'no pick and insufficient sticks/planks; visible logs support prerequisite gathering.', labelBasis: ['no pickaxe, material shortage, visible wood.'] }),
  D(2820, -1595, { scenario: 'DEV stone pick already available; allow mining visible coal', inventory: [pick('stone_pickaxe'), table, cobble(6), sticks(4), plank('oak', 10)], action: { action: 'mine', resource: 'coal', count: 4 }, rationale: 'proper tool and visible coal; mine is a materially feasible choice.', labelBasis: ['coal mining with pickaxe is allowed; count variation accepted.'], expectedActionSet: { action: 'mine', resource: 'coal', count: { min: 1, max: 8 } } }),
  D(-2886, -1639, { scenario: 'DEV missing pickaxe and logs; explore to find prerequisites', inventory: [food('bread', 1)], emptyResources: ['wood'], action: { action: 'explore', direction: 'east', distance: 24 }, rationale: 'no tool or visible wood; explore for resources rather than issuing impossible mine.', labelBasis: ['no pickaxe and no visible wood.'], expectedActionSet: { action: 'explore', direction: DIRECTIONS, distance: { min: 8, max: 48 } } }),
  D(2952, 1683, { scenario: 'DEV empty wood after failure; explore any unsearched direction', inventory: [pick(), table, plank('oak', 2), sticks(3)], emptyResources: ['wood'], recentFailures: [{ action: { action: 'gather_wood', count: 4 }, error: 'No exposed reachable resource' }], action: { action: 'explore', direction: 'north', distance: 20 }, rationale: 'resource unavailable and prior gather failed; choose exploration recovery.', labelBasis: ['empty wood list and recent gather failure.'], expectedActionSet: { action: 'explore', direction: DIRECTIONS, distance: { min: 8, max: 48 } } }),
  D(-3018, 1727, { scenario: 'DEV wood becomes visible after exploration; gather now has a target', inventory: [pick(), table, plank('spruce', 2), sticks(2)], action: { action: 'gather_wood', count: 4 }, rationale: 'current observation has wood and inventory has no logs; gather can be retried based on new evidence.', labelBasis: ['visible wood at current observation; no logs in inventory.'], expectedActionSet: { action: 'gather_wood', count: { min: 1, max: 8 } } }),
  D(3084, -1771, { scenario: 'DEV species-specific cherry hint but oak logs make generic planks', table: false, inventory: [log('oak', 4), food('carrot', 1)], recipeHints: [{ item: 'crafting_table', missing: [{ name: 'cherry_planks', count: 4 }], oneRecipeExample: true }, { item: 'wooden_pickaxe', missing: [{ name: 'spruce_planks', count: 3 }, { name: 'stick', count: 2 }], oneRecipeExample: true }], action: { action: 'craft', item: 'planks', count: 12 }, rationale: 'action enum remains generic planks; existing logs can supply the example ingredient family.', labelBasis: ['generic planks from available logs; species name is not a craft enum.'] }),
  D(-3150, -1815, { scenario: 'DEV existing spruce planks support workbench; use generic craft enum', table: false, inventory: [plank('spruce', 8), sticks(4)], action: { action: 'craft', item: 'crafting_table', count: 1 }, rationale: '现有木板足够制作工作台；动作字段使用通用crafting_table，不输出具体木种名。', labelBasis: ['crafting_table from existing planks; no species-specific action enum.'] }),
  D(3216, 1859, { scenario: 'DEV stage progression from iron ingots to iron pickaxe', inventory: [pick('stone_pickaxe'), table, { name: 'iron_ingot', count: 5 }, sticks(4), cobble(4), food('apple', 2)], action: { action: 'craft', item: 'iron_pickaxe', count: 1 }, rationale: 'iron ingots and sticks are sufficient; advance tool stage.', labelBasis: ['iron_pickaxe recipe materials are present.'] }),
  D(-3282, -1903, { scenario: 'DEV food full with raw salmon; existing resources support mining stone', inventory: [pick(), table, food('salmon', 2), plank('birch', 6), sticks(4)], action: { action: 'mine', resource: 'stone', count: 3 }, rationale: 'full hunger means no need to eat; wooden pick can mine visible stone.', labelBasis: ['food=20 rejects eat; stone mining with wooden pick is feasible.'], expectedActionSet: { action: 'mine', resource: 'stone', count: { min: 1, max: 8 } } })
];

if (trainDefs.length !== 32 || devDefs.length !== 12) throw new Error(`bad spec count ${trainDefs.length}/${devDefs.length}`);
const train = trainDefs.map((d, i) => makeRow(`v5-train-${String(i + 1).padStart(2, '0')}`, d, false));
const dev = devDefs.map((d, i) => makeRow(`v5-dev-${String(i + 1).padStart(2, '0')}`, d, true));
const jsonl = rows => rows.map(r => JSON.stringify(r)).join('\n') + '\n';
const trainPath = path.join(DATA, 'train-v5-candidates.jsonl');
const devPath = path.join(DATA, 'development-v5-candidates.jsonl');
const replayPath = path.join(DATA, 'train-v5-replay-candidates.jsonl');
const originalReplay = fs.readFileSync(path.join(DATA, 'train-v4r1-replay-candidates.jsonl'));
const trainBytes = Buffer.from(jsonl(train));
const devBytes = Buffer.from(jsonl(dev));
const replayBytes = Buffer.concat([originalReplay, trainBytes]);
fs.writeFileSync(trainPath, trainBytes);
fs.writeFileSync(devPath, devBytes);
fs.writeFileSync(replayPath, replayBytes);

const contract = {
  dataset: 'minecraft-survival-v5-candidates', status: 'candidate-only; awaiting independent semantic audit and root review; not used for training',
  contract: 'Current runtime SURVIVAL_ACTION_SCHEMA + compactObservation + decisionMessages; no system/schema change in this dataset builder.',
  provenance: PROVENANCE, trainingRows: train.length, developmentRows: dev.length, replayRows: 214,
  trainingSha256: sha(trainBytes), developmentSha256: sha(devBytes), replaySha256: sha(replayBytes),
  frozenReplayPrefix: { path: 'train-v4r1-replay-candidates.jsonl', sha256: sha(originalReplay), bytes: originalReplay.length, bytePrefixPreserved: replayBytes.subarray(0, originalReplay.length).equals(originalReplay) },
  scopeBalance: { trainFood: 8, trainToolPrerequisite: 8, trainResourceRecovery: 6, trainRecipeHintEnum: 6, trainStageProgress: 4, devRowsById: dev.map(r => r.id) },
  tokenTarget: 'Expected live-like dense state length ~1.8k-2.6k tokens; not yet tokenizer-verified. CPU tokenizer audit must set max_length only after exact lengths are known.',
  limits: ['Synthetic actions indicate a useful/materially feasible decision, not guaranteed path or block physics success.', 'Exact live probes remain development-only and are not copied here.', 'Recent result entries describe zero inventory delta unless explicitly reported; all six are matched to prior history and current state is not credited with unrecorded gains.', 'The fresh recentResults schema includes alreadyFull, foodBefore, and foodAfter from the current runtime planner.'],
  sourceHashes: { survivalPlanner: sha(fs.readFileSync(path.join(ROOT, 'src/minecraft/survival-planner.js'))), survivalSkills: sha(fs.readFileSync(path.join(ROOT, 'src/minecraft/survival-skills.js'))), priorReplay: sha(originalReplay) },
  validation: { schemaValidatedAtBuild: true, generatedFromRuntimeDecisionMessages: true, noHoldoutRead: true, semanticPreflightPending: true }
};
const manifestPath = path.join(DATA, 'manifest-v5-candidates.json');
fs.writeFileSync(manifestPath, JSON.stringify(contract, null, 2) + '\n');
const report = { train: trainPath, dev: devPath, replay: replayPath, manifest: manifestPath, trainSha256: contract.trainingSha256, developmentSha256: contract.developmentSha256, replaySha256: contract.replaySha256, rows: [train.length, dev.length, 214] };
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'v5-candidate-build.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
