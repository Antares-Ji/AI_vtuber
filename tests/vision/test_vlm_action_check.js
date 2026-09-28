const assert = require('node:assert/strict');
const { checkTransition, pointToPixels } = require('../../src/vision/vlm-action-check');
const home = { scene: 'home' };
assert.equal(checkTransition({ before: home, after: home, expectedScene: 'settings', transportOk: true }).reason, 'scene_unchanged');
assert.equal(checkTransition({ before: home, after: { scene: 'settings' }, expectedScene: 'settings', transportOk: true }).ok, true);
assert.equal(checkTransition({ before: home, after: null, expectedScene: 'settings', transportOk: true }).ok, false);
assert.equal(checkTransition({ before: home, after: { scene: 'notice' }, expectedScene: 'settings', transportOk: true }).ok, false);
assert.equal(checkTransition({ before: {scene:'settings'}, after: {scene:'settings'}, expectedScene:'settings', transportOk:true }).ok, false);
assert.deepEqual(pointToPixels({ target_visible: true, target_point: [1000, 1000] }, 1602, 1056), {x:1601,y:1055});
for (const point of [[NaN, 1], [1, Infinity], [-1, 1], [1001, 1], ['35', 70], null]) {
  assert.equal(pointToPixels({ target_visible: true, target_point: point }, 1602, 1056), null);
}
assert.equal(pointToPixels({ target_visible: false, target_point: [35,70] }, 1602, 1056), null);
console.log('VLM action checks passed: unchanged scenes, missing evidence, invalid and edge coordinates.');
