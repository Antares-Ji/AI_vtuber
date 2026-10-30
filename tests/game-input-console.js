const { test } = require('node:test');
const assert = require('node:assert/strict');
const { gesture, localRequest } = require('../src/api/game-input');
test('reject cross-origin and nonlocal input requests', () => {
  const request = { headers: { host: '127.0.0.1:3000', origin: 'http://127.0.0.1:3000' }, socket: { remoteAddress: '127.0.0.1' } };
  assert.equal(localRequest(request), true);
  assert.equal(localRequest({ ...request, headers: { ...request.headers, origin: 'https://outside.test' } }), false);
  assert.equal(localRequest({ ...request, socket: { remoteAddress: '192.168.1.4' } }), false);
});
test('reject invalid coordinates, scroll and non-game keys before spawning', () => {
  for (const body of [{ kind: 'click', to: [2, .5] }, { kind: 'drag', from: [.1, .2], to: [true, .5] }, { kind: 'scroll', steps: 0 }, { kind: 'scroll', steps: 11 }, { kind: 'key', key: 'WIN' }]) assert.throws(() => gesture(body));
  assert.equal(gesture({ kind: 'capture' }), null);
});
test('drag releases the same button after hover and motion', () => {
  const actions = gesture({ kind: 'drag', from: [.2, .9], to: [.7, .6] });
  const down = actions.findIndex(a => a.action === 'down'), up = actions.findIndex(a => a.action === 'up');
  assert.ok(down > 0 && up > down);
  assert.ok(actions.slice(down + 1, up).some(a => a.action === 'move' && a.to[0] === .7));
});
test('relative hover is a local option and leaves clicks and drags unchanged', () => {
  const body = { kind: 'hover', to: [.3, .8] };
  assert.equal(gesture(body)[0].pointer_mode, undefined);
  assert.equal(gesture(body, 'relative')[0].pointer_mode, 'relative');
  assert.deepEqual(gesture({ ...body, pointer_mode: 'relative' }), gesture(body));
  assert.throws(() => gesture(body, 'unrecognized'));
  for (const action of [{ kind: 'click', to: [.4, .5] }, { kind: 'drag', from: [.3, .8], to: [.6, .5] }]) {
    assert.deepEqual(gesture(action, 'relative'), gesture(action));
  }
});
