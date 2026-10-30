'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { plannerHistory, actionFor } = require('../src/sts2/native-autonomy');
test('model predictions and old narration cannot return as observation history', () => {
  const before = { frameId: 'old', scene: 'battle', energy: 3, targets: [
    { id: 'card1', kind: 'card', label: '愤怒', point: [500, 800], card: { name: '愤怒', cost: 0, type: null, description: null } }
  ] };
  const result = plannerHistory([{ before, decision: { kind: 'hover', targetId: 'card1', reason: 'FAKE_6_DAMAGE',
    previousOutcome: 'FAKE_6_DAMAGE', expected: 'FAKE_6_DAMAGE', line: 'FAKE_6_DAMAGE', usage: { total_tokens: 123 } },
    result: { id: 'input1', status: 'awaiting_visual_review', game_verified: true, arbitrary: 'FAKE_6_DAMAGE' },
    verification: 'await_next_observation' }]);
  assert.doesNotMatch(JSON.stringify(result), /FAKE_6_DAMAGE|point|game_verified|total_tokens/);
  assert.deepEqual(result[0].decision, { kind: 'hover', targetId: 'card1' });
  assert.equal(result[0].before.targets[0].card.description, null);
  assert.equal(result[0].result.status, 'awaiting_visual_review');
  assert.throws(() => actionFor({ kind: 'drag', fromId: 'card1', targetId: 'enemy1' }, before), /读清/);
});
test('history retains program rejection and a bounded set of state transitions', () => {
  const history = Array.from({ length: 6 }, (_, i) => ({ decision: { kind: 'hover', targetId: 't'+i } }));
  history[5] = { decision: { kind: 'drag', fromId: 't5', reason: 'unsupported story' }, rejected: true, error: 'Current card unreadable' };
  const result = plannerHistory(history);
  assert.equal(result.length, 4); assert.equal(result[0].decision.targetId, 't2');
  assert.equal(result.at(-1).rejected, true); assert.equal(result.at(-1).error, 'Current card unreadable');
  assert.equal(result.at(-1).verification, 'not_game_verified');
  assert.equal(Object.hasOwn(result.at(-1), 'before'), false);
});
