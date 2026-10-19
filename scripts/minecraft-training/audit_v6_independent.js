// CPU-only independent review; no model, endpoint or final holdout access.
const fs = require('node:fs'), path = require('node:path'), crypto = require('node:crypto');
const { validateAction, CRAFT_ITEMS, FOODS } = require('../../src/minecraft/survival-skills');
const { compactObservation } = require('../../src/minecraft/survival-planner');
const registry = require('prismarine-registry')('1.21.11');
const { Recipe } = require('prismarine-recipe')(registry);
const root = path.resolve(__dirname, '../..'), data = path.join(root, 'data/minecraft-training'), out = path.join(root, 'output/minecraft-training');
const read = file => fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const stable = v => Array.isArray(v) ? v.map(stable) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, stable(v[k])])) : v;
const key = v => JSON.stringify(stable(v));
const trainPath = path.join(data, 'train-v6r1-candidates.jsonl'), devPath = path.join(data, 'development-v6r1-candidates.jsonl'), replayPath = path.join(data, 'train-v6r1-weighted-replay-candidates.jsonl');
const train = read(trainPath), dev = read(devPath), replay = read(replayPath), priorPath = path.join(data, 'train-v5r2-replay-candidates.jsonl'), prior = read(priorPath);
const errors = [], checks = [], autonomy = read(path.join(root, 'logs/minecraft-autonomy.jsonl')), session = read(path.join(root, 'logs/minecraft-session-1791830191222.jsonl'));
function recipes(state, item, count = 1) {
  const inv = state.inventory, log = inv.find(i => /_log$/.test(i.name));
  const name = item === 'planks' ? log?.name.replace(/^stripped_/, '').replace(/_log$/, '_planks') || 'oak_planks' : item;
  const id = registry.itemsByName[name]?.id;
  return id == null ? [] : Recipe.find(id, null).filter(r => r.delta.every(d => inv.filter(i => i.name === registry.items[d.id]?.name).reduce((n, i) => n + i.count, 0) + d.count * Math.ceil(count / r.result.count) >= 0));
}
function feasible(row, action) {
  const s = row.state, inv = s.inventory, n = name => inv.filter(i => i.name === name).reduce((a, i) => a + i.count, 0);
  const prefix = `${row.id}:${JSON.stringify(action)}`;
  try { validateAction(action); } catch (e) { errors.push(`${prefix} schema: ${e.message}`); return; }
  if (action.action === 'craft') {
    const rs = recipes(s, action.item, action.count);
    if (!rs.length) errors.push(`${prefix} recipe affordability`);
    else if (rs.every(r => r.requiresTable) && !n('crafting_table') && !s.stations?.some(x => x.name === 'crafting_table')) errors.push(`${prefix} station absent`);
  }
  if (action.action === 'eat' && (s.food >= 20 || !inv.some(i => FOODS.includes(i.name) && i.count > 0))) errors.push(`${prefix} no useful edible food`);
  if (['mine', 'gather_wood'].includes(action.action)) {
    if (!s.resources[action.resource || 'wood']?.length) errors.push(`${prefix} no observed resource`);
    if (s.health <= 6) errors.push(`${prefix} critical-health prohibition`);
    if (action.action === 'mine') {
      const rank = Math.max(0, ...['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].map((name, i) => n(name) ? i + 1 : 0));
      if (rank < ({ stone: 1, coal: 1, iron: 2, diamond: 3, obsidian: 4, gravel: 0 }[action.resource])) errors.push(`${prefix} tool tier`);
    }
  }
  if (action.action === 'dig_staircase' && (s.health < 12 || s.food < 10 || !inv.some(i => /_pickaxe$/.test(i.name)) || s.position.y - action.steps < 50 && n('torch') < Math.ceil(action.steps / 4))) errors.push(`${prefix} staircase precondition`);
}
let acceptedVariants = 0;
for (const r of [...train, ...dev]) {
  feasible(r, r.action);
  if (r.messages.at(-1).content !== JSON.stringify(r.action)) errors.push(`${r.id} label/message`);
  const user = JSON.parse(r.messages[1].content);
  if (key(user.state) !== key(compactObservation(r.state))) errors.push(`${r.id} compact state`);
  if (r.sourceRef?.requestId) {
    const request = autonomy.find(x => x.event === 'model_request' && x.requestId === r.sourceRef.requestId);
    if (key(r.messages.slice(0, -1)) !== key(request?.request.messages)) errors.push(`${r.id} source messages altered`);
    if (r.sourceRef.taskId) {
      const result = autonomy.find(x => x.event === 'model_action_result' && x.requestId === r.sourceRef.requestId);
      const verified = session.find(x => x.event === 'skill_verified' && x.taskId === r.sourceRef.taskId);
      if (result?.taskId !== r.sourceRef.taskId || !verified?.verified || key(result.action) !== key(r.action) || key(verified.inventoryAfter) !== key(r.sourceRef.inventoryAfter)) errors.push(`${r.id} source task correlation`);
    }
  } else {
    const expected = CRAFT_ITEMS.flatMap(item => { const recipe = recipes(r.state, item)[0]; return recipe ? [{ item, outputPerCraft: recipe.result.count, requiresTable: !!recipe.requiresTable }] : []; });
    if (key(expected) !== key(r.state.craftable)) errors.push(`${r.id} craftable differs installed recipes`);
    const failed = user.recentResults.filter(x => x.status === 'failed').map(x => ({ action: x.action, error: x.error }));
    if (key(failed) !== key(r.state.recentFailures.map(x => ({ action: x.action, error: x.error })))) errors.push(`${r.id} failure history`);
    for (const blocks of Object.values(r.state.resources)) for (const b of blocks) if (Math.abs(Math.hypot(...['x', 'y', 'z'].map(k => b.position[k] - r.state.position[k])) - b.distance) > 0.06) errors.push(`${r.id} resource geometry`);
  }
  if (r.expectedActionSet) {
    let variants = [{}];
    for (const [name, value] of Object.entries(r.expectedActionSet)) {
      const values = Array.isArray(value) ? value : value && typeof value === 'object' ? Array.from({ length: value.max - value.min + 1 }, (_, i) => value.min + i) : [value];
      variants = variants.flatMap(v => values.map(x => ({ ...v, [name]: x })));
    }
    if (!variants.some(v => key(v) === key(r.action))) errors.push(`${r.id} reference excluded from allowed set`);
    for (const v of variants) feasible(r, v);
    acceptedVariants += variants.length;
  }
  checks.push({ id: r.id, action: r.action, sourceFaithful: !!r.sourceRef?.requestId });
}
function normalized(r) {
  const u = JSON.parse(r.messages[1].content), origin = u.state.position;
  function relative(v) {
    if (Array.isArray(v)) return v.map(relative);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).filter(([k]) => k !== 'timeOfDay').map(([k, x]) => [k, ['x', 'y', 'z'].includes(k) && typeof x === 'number' ? Math.round((x - origin[k]) * 10) / 10 : relative(x)]));
    return v;
  }
  return key(relative(u));
}
const refs = fs.readdirSync(data).filter(f => /^development-.*\.jsonl$/.test(f)).flatMap(f => read(path.join(data, f)));
for (const f of fs.readdirSync(out).filter(f => /^live-probe-.*\.json$/.test(f))) { const p = JSON.parse(fs.readFileSync(path.join(out, f))); if (p.messages?.length) refs.push({ id: f, messages: [...p.messages, { role: 'assistant', content: '' }] }); }
const overlap = { exact: [], normalized: [] };
for (const r of train) for (const ref of refs) {
  if (key(r.messages.slice(0, -1)) === key(ref.messages.slice(0, -1))) overlap.exact.push([r.id, ref.id]);
  if (normalized(r) === normalized(ref)) overlap.normalized.push([r.id, ref.id]);
}
if (overlap.exact.length || overlap.normalized.length) errors.push('Training/development or diagnostic input overlap');
const normGroups = new Map();
for (const r of train) normGroups.set(normalized(r), [...(normGroups.get(normalized(r)) || []), r.id]);
const trainingNormalizedDuplicates = [...normGroups.values()].filter(g => g.length > 1);
const prefix = fs.readFileSync(priorPath), replayBytes = fs.readFileSync(replayPath);
const prefixPreserved = replayBytes.subarray(0, prefix.length).equals(prefix);
if (!prefixPreserved || train.length !== 24 || dev.length !== 10 || replay.length !== 286) errors.push('Prefix/row counts');
const weights = train.map(r => ({ id: r.id, copies: replay.slice(214).filter(x => key(x.messages) === key(r.messages)).length }));
if (weights.some(w => w.copies !== 3)) errors.push('Explicit3x weighting differs');
for (const r of prior.filter(r => r.action.action === 'craft')) feasible(r, r.action);
const hashes = { train: sha(trainPath), development: sha(devPath), weightedReplay: sha(replayPath) };
const manifest = JSON.parse(fs.readFileSync(path.join(data, 'manifest-v6r1-candidates.json')));
if (hashes.train !== manifest.trainingSha256 || hashes.development !== manifest.developmentSha256 || hashes.weightedReplay !== manifest.weightedReplaySha256) errors.push('Manifest hashes');
const report = { generatedAt: new Date().toISOString(), status: errors.length ? 'NOT PASSED' : 'PASS for a candidate training experiment', hashes, errors, checks, acceptedVariants, referenceInputs: refs.length, overlap, trainingNormalizedDuplicates, prefixPreserved, weights, priorCraftsChecked: prior.filter(r => r.action.action === 'craft').length, weighting: { original: 214, newUnique: 24, newWeighted: 72, total: 286, newFraction: 72 / 286, realInputWeightedFraction: 6 / 286 }, limits: ['22 synthetic rows are not22 independent normalized scenarios; train02/train05 differ only by absolute coordinates and valid exploration direction label.', 'One real teacher correction is unexecuted; one positive demonstration has real task-correlated inventory evidence. Both exact inputs are now training evidence, not holdout.', 'Path geometry remains an executor check; shallow staircase y64->60 with healthy vitals/usable pickaxe is an allowed attempt, not guaranteed passage.', 'No original20 read and no model/endpoint/GPU operations.', 'Passing static conditions cannot establish learning, safe gameplay or broad generalization.'] };
fs.writeFileSync(path.join(out, 'independent-review/v6r1-candidate-audit.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ status: report.status, hashes, errors, acceptedVariants, overlap, trainingNormalizedDuplicates, prefixPreserved }, null, 2));
if (errors.length) process.exitCode = 1;
