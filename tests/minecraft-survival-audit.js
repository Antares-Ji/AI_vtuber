'use strict';
const assert = require('node:assert/strict');
const { summarize, inventoryDelta, failureClass } = require('../scripts/minecraft-audit');
assert.deepEqual(inventoryDelta([{ name: 'oak_log', count: 2 }], [{ name: 'oak_log', count: 1 }, { name: 'oak_planks', count: 4 }]), { oak_log: -1, oak_planks: 4 });
const report = summarize([
  { event: 'model_decision', adapterLoaded: true, modelMetadata: { used_adapter: true }, adapter: 'adapter-path', latencyMs: 1500 },
  { event: 'model_decision', adapterLoaded: false, modelMetadata: { used_adapter: false }, latencyMs: 500 },
  { event: 'model_decision', adapterLoaded: true, latencyMs: 800 },
  { event: 'model_action_result', taskId: 'a', action: { action: 'craft' }, status: 'completed', result: { verified: true }, before: { inventory: [] }, after: { inventory: [{ name: 'stick', count: 4 }] } },
  { event: 'model_action_result', taskId: 'b', action: { action: 'mine' }, status: 'failed', error: 'Missing correct tool' },
  { event: 'nether_dimension_observed', verified: true, dimension: 'overworld' },
  { event: 'model_action_result', taskId: 'c', action: { action: 'enter_portal' }, status: 'completed', result: { verified: false }, after: { dimension: 'overworld' } }
], [{ event: 'death' }]);
assert.equal(report.netherObserved, false); assert.equal(report.verifiedSkills, 1); assert.equal(report.sessionDeaths, 1); assert.equal(report.adapterDecisionCount, 1); assert.equal(report.modelLatencyMs.p95, 1500); assert.equal(report.failureAttribution.missing_prerequisite, 1);
assert.equal(report.unknownAdapterDecisionCount, 1, 'health-only adapterLoaded is not proof of adapter use in a completion');
assert.equal(failureClass('canSeeEntity is not a function'), 'runtime_or_transport');
console.log('Survival audit checks passed: inventory deltas, adapter/base counts, real dimension evidence, failed prerequisite attribution and no fabricated success.');
