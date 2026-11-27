const { test } = require('node:test');
const assert = require('node:assert/strict');
const { inspect, summarize } = require('../scripts/genshin/audit-quest-map.cjs');
const text = (text, box) => ({ text, box });

test('a saved world label does not turn a grounded map overview into a world target', () => {
  const row = inspect({ observation: { scene: 'world' }, request: { texts: [
    text('53/200', [1512, 30, 99, 31]),
    text('苍风高地', [1682, 985, 111, 36]),
    text('探索度23%', [1670, 1020, 123, 29]),
  ] } }, 'fixture');
  assert.equal(row.groundedScene, 'map');
  assert.equal(row.map.kind, 'overview');
  assert.equal(row.questCenterProven, false);
  assert.equal(summarize([row]).savedSceneDisagreements, 1);
});

test('teleport detail and its title are not evidence of a centered quest', () => {
  const row = inspect({ request: { texts: [
    text('X', [1850, 8, 55, 55]),
    text('冒险家协会', [1490, 18, 147, 35]),
    text('他们称自己上至星天下达九渊', [1452, 155, 431, 29]),
    text('找猫咪和探索秘境都在工作范围内', [1452, 191, 427, 26]),
    text('传送至蒙德城', [1604, 989, 175, 34]),
  ] } }, 'fixture');
  assert.equal(row.map.kind, 'detail');
  const summary = summarize([row]);
  assert.equal(summary.mapTeleportDetails, 1);
  assert.equal(summary.questCenterProven, 0);
  assert.equal(summary.fallbackReady, false);
});

test('unrecognized or missing observations cannot be counted as successful centering', () => {
  assert.equal(inspect({}, 'empty'), null);
  assert.equal(inspect({ request: { texts: [text('追踪目标', [1612, 1001, 121, 36])] } }, 'isolated'), null);
  assert.equal(summarize([]).fallbackReady, false);
});
