'use strict';
const assert = require('node:assert/strict');
const { parseDecision, planSurvival, decisionMessages, compactObservation } = require('../src/minecraft/survival-planner');
(async () => {
  assert.deepEqual(parseDecision('{"action":"mine","resource":"iron","count":3}'), { action: 'mine', resource: 'iron', count: 3 });
  for (const text of ['```json\n{"action":"eat"}\n```', '<think>eat</think>{"action":"eat"}', '{"action":"give"}', '{"action":"eat","reason":"hungry"}', 'null']) assert.throws(() => parseDecision(text));
  const state = { food: 8, inventory: [{ name: 'bread', count: 3 }], threats: [] };
  assert.equal(decisionMessages(state)[1].role, 'user');
  const failedHistory = JSON.parse(decisionMessages(state, { history: [{ action: { action: 'mine', resource: 'stone', count: 4 }, status: 'failed', error: 'navigate: timeout', result: { verifiedPartial: true, gained: 1, complete: false, inventoryAfter: [{ name: 'cobblestone', count: 1 }] } }] })[1].content).recentResults[0];
  assert.equal(failedHistory.status, 'failed'); assert.equal(failedHistory.result.verifiedPartial, true); assert.equal(failedHistory.result.gained, 1); assert.equal(failedHistory.result.complete, false);
  assert(!('verified' in failedHistory.result)); assert(!('inventoryAfter' in failedHistory.result));
  const eatingHistory = JSON.parse(decisionMessages({ food: 20 }, { history: [
    { action: { action: 'eat' }, status: 'completed', result: { alreadyFull: true, verified: true } },
    { action: { action: 'eat' }, status: 'completed', result: { foodBefore: 16, foodAfter: 20, verified: true } }
  ] })[1].content).recentResults;
  assert.equal(eatingHistory[0].result.alreadyFull, true, 'a successful no-op must remain distinguishable from actual recovery in the next model request');
  assert.equal(eatingHistory[1].result.foodBefore, 16); assert.equal(eatingHistory[1].result.foodAfter, 20);
  const compact = compactObservation({ ...state, sessionId: 'private-path', logPath: 'private-log', activeTaskId: 'private-task', position: { x: 1.1234567, y: 63, z: -2.789 }, animals: [{ id: 9, name: 'cow', distance: 4.6789 }], reactive: { enabled: true, mode: 'idle', targetId: null, entities: Array(30).fill({ name: 'salmon', position: { x: 3.333333333, y: 1, z: 6 } }) } });
  assert.equal(compact.position.x, 1.1); assert.equal(compact.position.z, -2.8); assert.equal(compact.animals[0].distance, 4.7);
  assert(!JSON.stringify(compact).includes('salmon')); assert(!('sessionId' in compact)); assert(!('logPath' in compact)); assert(!('activeTaskId' in compact)); assert.deepEqual(compact.inventory, state.inventory);
  let sent, metadata, auditedRequest, auditedCompletion;
  const fetchImpl = async (url, options) => { sent = JSON.parse(options.body); return { ok: true, json: async () => ({ metadata: { used_adapter: true, adapter_path: 'test-adapter' }, choices: [{ message: { content: '{"action":"eat"}' } }] }) }; };
  assert.deepEqual(await planSurvival(state, { fetchImpl, onMetadata: value => { metadata = value; }, onRequest: value => { auditedRequest = value; }, onCompletion: value => { auditedCompletion = value; } }), { action: 'eat' });
  assert.deepEqual(auditedRequest, sent, 'audit captures the exact serialized request, without changing generation');
  assert.equal(auditedCompletion.content, '{"action":"eat"}');
  assert.equal(auditedCompletion.metadata.used_adapter, true);
  assert.equal(sent.task, 'minecraft-survival'); assert.equal(metadata.used_adapter, true); assert.equal(metadata.adapter_path, 'test-adapter');
  assert(sent.messages[0].content.includes('build_portal')); assert.equal(sent.temperature, 0); assert.equal(sent.chat_template_kwargs.enable_thinking, false);
  // The model decides even if the state would invite a deterministic rule.
  const chooseObserve = async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"action":"observe"}' } }] }) });
  assert.deepEqual(await planSurvival({ food: 1, threats: [{ name: 'creeper', distance: 2 }] }, { fetchImpl: chooseObserve }), { action: 'observe' });
  await assert.rejects(planSurvival(state, { fetchImpl: async () => ({ ok: false, status: 503 }) }), /503/);
  const controller = new AbortController(); controller.abort(new Error('cancel planner')); await assert.rejects(planSurvival(state, { signal: controller.signal, fetchImpl }), /cancel planner/);
  console.log('Survival planner checks passed: strict model JSON, action schema, local inference payload, no rule-based progression fallback, transport errors and cancellation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
