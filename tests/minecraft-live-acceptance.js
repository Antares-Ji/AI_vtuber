'use strict';
const assert = require('node:assert/strict');
const { report, corroborate } = require('../scripts/minecraft-live-acceptance');
const native = { status: 'completed', action: { action: 'craft', item: 'stick' }, result: { verified: true, item: 'stick', inventoryBefore: [], inventoryAfter: [{ name: 'stick', count: 4 }] }, before: { inventory: [{ name: 'stick', count: 20 }] }, after: { inventory: [] } };
assert.equal(corroborate(native).corroborated, true, 'native inventory snapshots take precedence over stale outer observation');
assert.equal(corroborate(native).inventorySource, 'executor-local');
assert.equal(corroborate({ ...native, result: { ...native.result, inventoryAfter: [] } }).corroborated, false, 'verified flag alone cannot establish an inventory gain');
assert.equal(corroborate({ status: 'completed', action: { action: 'observe' }, result: { verified: true } }).progress, false);
assert.equal(corroborate({ status: 'completed', action: { action: 'enter_portal' }, result: { verified: true, enteredNether: true }, before: { dimension: 'overworld' }, after: { dimension: 'overworld' } }).corroborated, false);
const observation = { inventory: [], position: { x: 0, y: 64, z: 0 } };
const failure = { event: 'model_action_result', status: 'failed', error: 'No nearby passive animals', before: observation, after: observation, modelMetadata: { used_adapter: true, adapter_path: 'v2-test' } };
const result = report([
  { event: 'model_decision', at: '2026-10-12T19:00:00Z', adapterLoaded: true },
  { ...failure, at: '2026-10-12T19:00:01Z', taskId: 'a', action: { action: 'hunt', count: 1 } },
  { ...failure, at: '2026-10-12T19:00:02Z', taskId: 'b', action: { count: 3, action: 'hunt' } },
  { ...failure, at: '2026-10-12T19:00:02Z', taskId: 'b', action: { count: 3, action: 'hunt' } },
  { ...failure, at: '2026-10-12T18:00:00Z', taskId: 'outside', action: { action: 'hunt' } }
], [{ at: '2026-10-12T18:00:00Z', event: 'death' }, { at: '2026-10-12T19:00:01Z', event: 'reactive_timing', tickMs: 1, sampleGapMs: 205, maxTickMs: 90, maxSampleGapMs: 800 }], { from: '2026-10-12T19:00:00Z', to: '2026-10-12T19:10:00Z' });
assert.equal(result.results, 2); assert.equal(result.repeatedUnchangedFailures, 1); assert.equal(result.cohorts.unknown.decisions, 1);
assert.equal(result.safety.deaths, 0); assert.equal(result.safety.escapeAcceptance, 'not-exercised');
assert.equal(result.safety.sampledTickMaxMs, 1); assert.equal(result.safety.observedCumulativeTickMaxMs, 90);
assert.throws(() => report([], [], {}), /Explicit valid/);
console.log('Live acceptance audit checks passed: native inventory, no flag-only progress, scoped window, deduplication, repeated failures, metadata provenance, timing limits.');
