'use strict';
// Joins independently authored semantic annotations to immutable prediction
// evidence. This reports judgments; it does not generate labels or train a model.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const args = process.argv.slice(2), option = key => { const index = args.indexOf(key); return index >= 0 ? args[index + 1] : undefined; };
const predictionFile = option('--predictions'), annotationFile = option('--annotations'), output = option('--output');
if (!predictionFile || !annotationFile || !output) throw new Error('Required: --predictions FILE --annotations FILE --output FILE');
const root = path.resolve(__dirname, '..');
const rubricFile = path.join(root, 'output/minecraft-training/independent-review/rubric-v1.json');
const holdoutFile = path.join(root, 'data/minecraft-training/holdout.jsonl');
const readJsonl = file => fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
const predictions = readJsonl(predictionFile), annotations = JSON.parse(fs.readFileSync(annotationFile, 'utf8'));
if (annotations.length !== predictions.length) throw new Error('Annotation count differs from prediction count');
const rows = predictions.map(p => {
  const annotation = annotations.find(a => a.id === p.id);
  if (!annotation || !['pass', 'fail', 'uncertain'].includes(annotation.verdict)) throw new Error(`Missing or invalid annotation ${p.id}`);
  if (annotation.verdict === 'pass' && !p.schema_valid) throw new Error(`Cannot pass invalid schema: ${p.id}`);
  return { ...annotation, predicted: p.predicted, schemaValid: p.schema_valid, exactMatch: p.exact_match, latencyMs: p.latency_ms };
});
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const totals = Object.fromEntries(['pass', 'fail', 'uncertain'].map(v => [v, rows.filter(r => r.verdict === v).length]));
const report = { generatedAt: new Date().toISOString(), rubric: JSON.parse(fs.readFileSync(rubricFile, 'utf8')).version,
  sources: { predictions: path.resolve(predictionFile), annotations: path.resolve(annotationFile), rubric: rubricFile, holdout: holdoutFile },
  sha256: { predictions: hash(predictionFile), annotations: hash(annotationFile), rubric: hash(rubricFile), holdout: hash(holdoutFile) },
  n: rows.length, totals, semanticPassRate: totals.pass / rows.length, semanticPassAmongDecidable: totals.pass / (totals.pass + totals.fail), strictSchemaRate: rows.filter(r => r.schemaValid).length / rows.length, exactMatchRate: rows.filter(r => r.exactMatch).length / rows.length,
  rows, limits: ['Independent manual semantic review of a small synthetic holdout; this is not live-world success.', 'Uncertain fixtures are retained and reported separately instead of silently repaired.', 'Training agents must not use per-holdout annotations for further tuning.'] };
fs.mkdirSync(path.dirname(path.resolve(output)), { recursive: true }); fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify({ output: path.resolve(output), n: report.n, totals, semanticPassRate: report.semanticPassRate, strictSchemaRate: report.strictSchemaRate, exactMatchRate: report.exactMatchRate }));
