// Independent CPU-only recomputation. Never loads a model or final holdout.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { validateAction, FOODS } = require('../../src/minecraft/survival-skills');
const registry = require('prismarine-registry')('1.21.11');
const { Recipe } = require('prismarine-recipe')(registry);
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'output/minecraft-training');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const rows = p => fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const criteriaPath = path.join(out, 'v6r1-selection-criteria.json');
const criteria = read(criteriaPath);
const dataPath = path.join(out, 'v6r1-development57.jsonl');
assert.equal(sha(dataPath), '0abc77696228f1ab5c62b919f5aeb2b4295b17e91f84bb149b202bff7ebb2ef5');
const source = rows(dataPath);
assert.equal(source.length, 57);
assert.equal(new Set(source.map(r => r.id)).size, 57);
for (const row of source) {
  assert.equal(row.messages.at(-1).role, 'assistant');
  assert.deepEqual(JSON.parse(row.messages.at(-1).content), row.action);
  assert(row.messages.slice(0, -1).every(m => m.role !== 'assistant'), 'Input must not retain an answer message');
}
const equal = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
function accepted(pred, row) {
  if (!row.expectedActionSet) return equal(pred, row.action);
  const set = row.expectedActionSet;
  if (!equal(Object.fromEntries(Object.keys(pred).map(k => [k, true])), Object.fromEntries(Object.keys(set).map(k => [k, true])))) return false;
  return Object.entries(set).every(([key, value]) => Array.isArray(value) ? value.includes(pred[key])
    : value && typeof value === 'object' ? Number.isInteger(pred[key]) && pred[key] >= value.min && pred[key] <= value.max
      : pred[key] === value);
}
function materialWarnings(action, state) {
  if (!action) return ['invalid output'];
  const inv = state.inventory || [], count = name => inv.filter(i => i.name === name).reduce((n, i) => n + i.count, 0), warnings = [];
  if (action.action === 'craft') {
    const log = inv.find(i => /_log$/.test(i.name));
    const item = action.item === 'planks' ? log?.name.replace(/^stripped_/, '').replace(/_log$/, '_planks') || 'oak_planks' : action.item;
    const id = registry.itemsByName[item]?.id;
    const recipes = id == null ? [] : Recipe.find(id, null).filter(r => r.delta.every(d => count(registry.items[d.id]?.name) + d.count * Math.ceil(action.count / r.result.count) >= 0));
    if (!recipes.length) warnings.push('insufficient recipe materials for output batches');
    else if (recipes.every(r => r.requiresTable) && !count('crafting_table') && !state.stations?.some(x => x.name === 'crafting_table')) warnings.push('no crafting table for 3x3 recipe');
  }
  if (action.action === 'mine') {
    const names = [...inv, ...(state.tools || []), ...(state.equipment || []), state.heldItem].filter(Boolean).map(x => typeof x === 'string' ? x : x.name);
    const rank = Math.max(0, ...['wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe', 'netherite_pickaxe'].map((n, i) => names.includes(n) ? i + 1 : 0));
    if (rank < ({stone:1,coal:1,iron:2,diamond:3,obsidian:4,gravel:0}[action.resource])) warnings.push('insufficient observed tool tier');
    if (!state.resources?.[action.resource]?.length) warnings.push('no observed matching mineral');
  }
  if (action.action === 'gather_wood' && !state.resources?.wood?.length) warnings.push('no observed wood');
  if (['mine', 'gather_wood'].includes(action.action) && state.food <= 7 && inv.some(i => i.count > 0 && FOODS.includes(i.name))) warnings.push('low food with safe food available but continues harvesting');
  if (action.action === 'eat' && state.food >= 20) warnings.push('full food no-op');
  if (action.action === 'eat' && !inv.some(i => i.count > 0 && FOODS.includes(i.name))) warnings.push('no observed safe edible food');
  if (state.threats?.length && action.action !== 'flee') warnings.push('visible threat priority ignored');
  return warnings;
}
const result = { generatedAt: new Date().toISOString(), sourceSha256: sha(dataPath), criteriaSha256: sha(criteriaPath), models: {}, scoringDisagreements: [], limits: ['CPU-only raw recomputation; direct-grid metadata is implementation-reported, not endpoint-response evidence.', 'No final20 read or used for selection. Development acceptance does not prove actual reachability or survival.'] };
for (const model of ['v4r1', 'v6r1-epoch01']) {
  const file = path.join(out, `v6r1-dev57-${model}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`Incomplete comparison: missing ${file}`);
  const pred = rows(file), byId = new Map(pred.map(r => [r.id, r]));
  assert.equal(pred.length, 57); assert.equal(byId.size, 57);
  const cases = source.map(row => {
    const r = byId.get(row.id); assert(r, `Missing ${row.id}`);
    assert.deepEqual(r.expected, row.action, `Frozen expected label mismatch ${model}:${row.id}`);
    let parsed, schemaValid = false;
    try { parsed = JSON.parse(r.raw); validateAction(parsed); schemaValid = true; } catch {}
    assert.deepEqual(parsed ?? null, r.predicted ?? null, `Raw/parsed mismatch ${model}:${row.id}`);
    if (schemaValid !== r.schema_valid) result.scoringDisagreements.push({ model, id: row.id, field: 'schema_valid', runtime: schemaValid, report: r.schema_valid });
    assert.equal(r.request_metadata.used_adapter, model !== 'base');
    assert.equal(r.request_metadata.task, 'minecraft-survival');
    assert(r.request_metadata.adapter_path.replaceAll('\\', '/').includes(model === 'v4r1' ? '/minecraft-survival-v4r1-replay-candidate/checkpoint-epoch-01' : '/minecraft-survival-v6r1-weighted-material-candidate/checkpoint-epoch-01'), 'Expected selected adapter path');
    const threat = Boolean(row.state.threats?.length);
    return { id: row.id, slice: row.comparisonSlice || 'new-v6r1-dev10', predicted: parsed ?? null, schemaValid, accepted: schemaValid && accepted(parsed, row), warnings: materialWarnings(parsed, row.state), threat, threatPass: !threat || schemaValid && parsed.action === 'flee', expected: row.expectedActionSet || row.action };
  });
  const slices = {};
  for (const name of ['legacy27', 'v4-allowed-set8', 'v5r2-dense12', 'new-v6r1-dev10']) {
    const subset = cases.filter(r => r.slice === name);
    slices[name] = { n: subset.length, schema: subset.filter(r => r.schemaValid).length, accepted: subset.filter(r => r.accepted).length };
  }
  result.models[model] = { rawSha256: sha(file), schema: cases.filter(r => r.schemaValid).length, accepted: cases.filter(r => r.accepted).length, threats: { n: cases.filter(r => r.threat).length, pass: cases.filter(r => r.threat && r.threatPass).length }, slices, cases };
}
for (const model of ['v6r1-epoch01']) {
  const m = result.models[model];
  m.regressions = []; m.improvements = []; m.hardGateRegressions = [];
  for (let i = 0; i < source.length; i++) {
    const before = result.models.v4r1.cases[i], after = m.cases[i];
    const details = { id: before.id, before: before.predicted, after: after.predicted, expected: after.expected };
    if (before.accepted && !after.accepted) m.regressions.push(details);
    if (!before.accepted && after.accepted) m.improvements.push(details);
    if (before.schemaValid && !after.schemaValid || before.threat && before.threatPass && !after.threatPass) m.hardGateRegressions.push(details);
  }
}
const dest = path.join(out, 'independent-review/v6r1-dev57-raw-recomputation.json');
fs.writeFileSync(dest, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ report: dest, disagreements: result.scoringDisagreements, models: Object.fromEntries(Object.entries(result.models).map(([k, v]) => [k, { schema: v.schema, accepted: v.accepted, threats: v.threats, slices: v.slices, regressions: v.regressions, improvements: v.improvements, hardGateRegressions: v.hardGateRegressions }])) }, null, 2));
