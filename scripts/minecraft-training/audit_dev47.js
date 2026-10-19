// Independent CPU-only recomputation. Never loads a model or final holdout.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { validateAction } = require('../../src/minecraft/survival-skills');
const root = path.resolve(__dirname, '../..');
const out = path.join(root, 'output/minecraft-training');
const read = p => JSON.parse(fs.readFileSync(p, 'utf8'));
const rows = p => fs.readFileSync(p, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const sha = p => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const criteriaPath = path.join(out, 'v5r2-selection-criteria.json');
const criteria = read(criteriaPath);
const dataPath = path.join(out, 'v5r2-development47.jsonl');
assert.equal(sha(dataPath), criteria.selectionDataSha256);
const source = rows(dataPath);
assert.equal(source.length, 47);
assert.equal(new Set(source.map(r => r.id)).size, 47);
const equal = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
function accepted(pred, row) {
  if (!row.expectedActionSet) return equal(pred, row.action);
  const set = row.expectedActionSet;
  if (!equal(Object.fromEntries(Object.keys(pred).map(k => [k, true])), Object.fromEntries(Object.keys(set).map(k => [k, true])))) return false;
  return Object.entries(set).every(([key, value]) => Array.isArray(value) ? value.includes(pred[key])
    : value && typeof value === 'object' ? Number.isInteger(pred[key]) && pred[key] >= value.min && pred[key] <= value.max
      : pred[key] === value);
}
const result = { generatedAt: new Date().toISOString(), sourceSha256: sha(dataPath), criteriaSha256: sha(criteriaPath), models: {}, scoringDisagreements: [], limits: ['CPU-only raw recomputation; direct-grid metadata is implementation-reported, not endpoint-response evidence.', 'No final20 read or used for selection. Development acceptance does not prove actual reachability or survival.'] };
for (const model of ['base', 'v4r1', 'epoch-01', 'epoch-02']) {
  const file = path.join(out, `v5r2-dev47-${model}.jsonl`);
  if (!fs.existsSync(file)) throw new Error(`Incomplete comparison: missing ${file}`);
  const pred = rows(file), byId = new Map(pred.map(r => [r.id, r]));
  assert.equal(pred.length, 47); assert.equal(byId.size, 47);
  const cases = source.map(row => {
    const r = byId.get(row.id); assert(r, `Missing ${row.id}`);
    let parsed, schemaValid = false;
    try { parsed = JSON.parse(r.raw); validateAction(parsed); schemaValid = true; } catch {}
    assert.deepEqual(parsed ?? null, r.predicted ?? null, `Raw/parsed mismatch ${model}:${row.id}`);
    if (schemaValid !== r.schema_valid) result.scoringDisagreements.push({ model, id: row.id, field: 'schema_valid', runtime: schemaValid, report: r.schema_valid });
    assert.equal(r.request_metadata.used_adapter, model !== 'base');
    const threat = Boolean(row.state.threats?.length);
    return { id: row.id, slice: row.comparisonSlice, predicted: parsed ?? null, schemaValid, accepted: schemaValid && accepted(parsed, row), threat, threatPass: !threat || schemaValid && parsed.action === 'flee', expected: row.expectedActionSet || row.action };
  });
  const slices = {};
  for (const name of ['legacy27', 'v4-allowed-set8', 'v5r2-dense12']) {
    const subset = cases.filter(r => r.slice === name);
    slices[name] = { n: subset.length, schema: subset.filter(r => r.schemaValid).length, accepted: subset.filter(r => r.accepted).length };
  }
  result.models[model] = { rawSha256: sha(file), schema: cases.filter(r => r.schemaValid).length, accepted: cases.filter(r => r.accepted).length, threats: { n: cases.filter(r => r.threat).length, pass: cases.filter(r => r.threat && r.threatPass).length }, slices, cases };
}
for (const model of ['epoch-01', 'epoch-02']) {
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
const dest = path.join(out, 'independent-review/v5r2-dev47-raw-recomputation.json');
fs.writeFileSync(dest, JSON.stringify(result, null, 2) + '\n');
console.log(JSON.stringify({ report: dest, disagreements: result.scoringDisagreements, models: Object.fromEntries(Object.entries(result.models).map(([k, v]) => [k, { schema: v.schema, accepted: v.accepted, threats: v.threats, slices: v.slices, regressions: v.regressions, improvements: v.improvements, hardGateRegressions: v.hardGateRegressions }])) }, null, 2));
