'use strict';
const assert = require('node:assert/strict');
const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { AutonomyLoop } = require('../src/minecraft/autonomy-loop');
async function main() {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-loop-test-'));
  const controller = new AbortController();
  const observed = { connected: true, health: 20, food: 20, busy: false, dimension: 'overworld', sessionId: 'same', reactive: { enabled: true, mode: 'idle' } };
  const calls = [];
  let changed = false, hold = false;
  const loop = new AutonomyLoop({ logDir, planner: async () => ({ action: 'gather_wood', count: 2 }), request: async (route, body) => {
    calls.push({ route, body });
    if (route === '/observe') return { ...observed, sessionId: changed ? 'different' : 'same' };
    if (route.startsWith('/task')) return { status: hold ? 'running' : 'completed', result: { verified: true, gained: 2 } };
    return { accepted: true };
  } });
  loop.modelHealth = async () => { loop.state.adapterLoaded = true; };
  const result = await loop.runOnce('采集', controller.signal);
  assert.equal(result.verified, true);
  assert.equal(result.decision.source, 'local-qwen');
  assert.equal(result.decision.adapterLoaded, false, 'health alone must not prove request used trained weights');
  assert.equal(calls.filter(c => c.route === '/skill').length, 1);
  assert.equal(loop.snapshot().history.length, 1);
  loop.planner = async () => { changed = true; return { action: 'eat' }; };
  await assert.rejects(loop.runOnce('进食', controller.signal), /状态已变化/);
  assert.equal(calls.filter(c => c.route === '/skill').length, 1, 'stale model result must not execute');
  changed = false; hold = true;
  loop.planner = async () => ({ action: 'gather_wood', count: 1 });
  const cancel = new AbortController();
  const pending = loop.runOnce('采集', cancel.signal);
  setTimeout(() => cancel.abort(), 30);
  await assert.rejects(pending);
  assert(calls.some(c => c.route === '/cancel-task' && typeof c.body.taskId === 'string'));
  assert.equal(loop.state.running, false);
  hold = false;
  loop.planner = async (_state, options) => { options.onMetadata({ task: 'minecraft-survival', used_adapter: true, adapter_path: 'test-only' }); return { action: 'observe' }; };
  const adapted = await loop.runOnce('观察', controller.signal);
  assert.equal(adapted.decision.adapterLoaded, true);
  assert.equal(loop.snapshot().lastDecisionMetadata.adapter_path, 'test-only');
  const stable = { ...observed, position: { x: 0, y: 64, z: 0 }, inventory: [{ name: 'stick', count: 2 }, { name: 'oak_log', count: 1 }], reactive: { enabled: true, mode: 'idle', lifecycleEpoch: 0 } };
  for (const [label, mutate] of [
    ['inventory', current => { current.inventory = []; }],
    ['position', current => { current.position.x = 4; }],
    ['health', current => { current.health = 18; }],
    ['life after full health recovery', current => { current.reactive.lifecycleEpoch = 1; }]
  ]) {
    let dispatched = 0, observations = 0;
    const stale = new AutonomyLoop({ logDir, planner: async () => ({ action: 'craft', item: 'stick', count: 1 }), request: async route => {
      if (route === '/observe') { const value = structuredClone(stable); if (++observations > 1) mutate(value); return value; }
      if (route === '/skill') dispatched++;
      return {};
    } });
    stale.modelHealth = async () => {};
    await assert.rejects(stale.runOnce(label, controller.signal), /状态已变化/, label);
    assert.equal(dispatched, 0, `${label} stale decision never dispatches a skill`);
  }
  let observations = 0, dispatched = 0;
  const reordered = new AutonomyLoop({ logDir, planner: async () => ({ action: 'observe' }), request: async route => {
    if (route === '/observe') {
      const value = structuredClone(stable);
      if (++observations > 1) { value.inventory = [{ name: 'oak_log', count: 1 }, { name: 'stick', count: 1 }, { name: 'stick', count: 1 }]; value.timeOfDay = 99; }
      return value;
    }
    if (route === '/skill') { dispatched++; return {}; }
    return { status: 'completed', result: { verified: true } };
  } });
  reordered.modelHealth = async () => {};
  await reordered.runOnce('inventory reordering', controller.signal);
  assert.equal(dispatched, 1, 'slot order and split stacks do not make a stale inventory');
  const logged = fs.readFileSync(path.join(logDir, 'minecraft-autonomy.jsonl'), 'utf8').trim().split('\n').map(JSON.parse).filter(e => e.event === 'model_action_result').at(-1);
  assert.equal(logged.before.timeOfDay, 99, 'audit before uses dispatch observation');
  assert.equal(logged.planningObservation.timeOfDay, undefined, 'planning snapshot retained separately');
  loop.state.history = [{ action: { count: 1, action: 'hunt' }, status: 'failed' }, { action: { action: 'hunt', count: 2 }, status: 'rejected' }, { action: { action: 'hunt', count: 3 }, status: 'failed' }];
  loop.updateRecovery(); assert.equal(loop.state.needsRecovery, true, 'count and field ordering do not disguise repeated failure');
  loop.state.history = Array.from({ length: 3 }, () => ({ action: null, status: 'rejected' }));
  loop.updateRecovery(); assert.equal(loop.state.needsRecovery, true, 'malformed planner output participates in backoff');
  loop.state.history[2] = { action: { action: 'explore', direction: 'north' }, status: 'completed' };
  loop.updateRecovery(); assert.equal(loop.state.needsRecovery, false, 'successful recovery clears backoff');
  loop.state.enabled = true;
  await assert.rejects(loop.runOnce('采集', controller.signal), /自主循环/);
  loop.state.enabled = false;
  loop.state.deadline = '2020-01-01T00:00:00Z';
  await assert.rejects(loop.start(), /授权窗口/);
  console.log('Minecraft loop checks passed: model-to-skill, stale session rejection, scoped cancellation, mutual exclusion, deadline.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
