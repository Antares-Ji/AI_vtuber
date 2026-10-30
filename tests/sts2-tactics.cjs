'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateSummary, signature, visionEvidence, combatBudget, summarize } = require('../scripts/sts2/summarize.cjs');

test('a model recommendation of lethal is rejected when the actual hand only deals twelve', async () => {
  const state = { player: { hand: ['ANGER', 'STRIKE_IRONCLAD'].map(id => ({ id, name: id, can_play: true, type: 'Attack', description: '造成6点伤害。' })) }, battle: { enemies: [{ hp: 17 }] } };
  await assert.rejects(summarize(state, {}, null, async (_url, options) => {
    assert.equal(JSON.parse(options.body).messages[1].role, 'user');
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ situation: '局面', plan: '愤怒加打击可以击杀17血目标', reason: '错误算术', risk: '风险', lesson: '待验证' }) } }] }) };
  }, { url: 'https://api.deepseek.com/chat/completions', key: 'test-only', model: 'fixture' }), /without sufficient/);
});

test('two six-damage attacks cannot kill a seventeen-HP enemy', () => {
  const state = { player: { hand: ['ANGER', 'STRIKE_IRONCLAD'].map(id => ({ id, name: id, can_play: true, type: 'Attack', description: '造成6点伤害。' })) }, battle: { enemies: [{ hp: 17 }] } };
  assert.equal(combatBudget(state).knownDamageUpperBound, 12); assert.equal(combatBudget(state).noLethal, true);
});

test('incomplete summaries are rejected rather than published as a successful lesson', () => {
  assert.throws(() => validateSummary({ situation: '当前局面' }), /plan/);
  const valid = { situation: '局面', plan: '计划', reason: '依据', risk: '未知', lesson: '条件化推断' };
  assert.deepEqual(validateSummary(valid), valid);
});
test('a change to hand, enemy HP or energy invalidates the old snapshot', () => {
  const state = { player: { energy: 3, hand: [{ id: 'A' }] }, battle: { enemies: [{ hp: 10 }] } };
  const original = signature(state);
  for (const modify of [s => s.player.energy--, s => s.player.hand.pop(), s => s.battle.enemies[0].hp--]) {
    const next = structuredClone(state); modify(next); assert.notEqual(signature(next), original);
  }
});
test('visual data can be unavailable and cannot load paths outside STS2 records', () => {
  assert.equal(visionEvidence(null).available, false);
  assert.throws(() => visionEvidence({ last_result: { record: 'C:/not-a-vision-record.json' } }), /Unexpected/);
});
