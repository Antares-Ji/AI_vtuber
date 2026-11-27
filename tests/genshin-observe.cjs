'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { observe, validateCapture, validateObservation } = require('../src/genshin/observe');
const { createSkillHost } = require('../src/skills');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aL1sAAAAASUVORK5CYII=', 'base64');
function capture(root, nonce, target = 'YuanShen.exe') {
  const image = path.join(root, 'runtime/genshin/observations', nonce, 'frame.png');
  fs.mkdirSync(path.dirname(image), { recursive: true }); fs.writeFileSync(image, PNG);
  return { nonce, image, target, capturedAt: Date.now(), pid: 123, source: 'project_native_capture',
    inputSent: false, sha256: createHash('sha256').update(PNG).digest('hex') };
}
function vision(image) {
  return { source_image: image, mode: 'genshin-scene', model: 'local-test-model', verification: 'unverified_local_model_output',
    parsed: { scene: 'unknown', summary: 'Test fixture, not game evidence', visible_text: [], uncertain: true } };
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genshin-observe-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true })); return root;
}
test('observation uses a fixed native script and local API, preserving uncertainty', async t => {
  const root = fixture(t), calls = [];
  const result = await observe({ root, signal: new AbortController().signal,
    runProcess: async (cmd, args, options) => {
      assert.equal(cmd, path.join(root, 'runtime/vlm-env/Scripts/python.exe'));
      assert.deepEqual(args.slice(0, 4), [path.join(root, 'scripts/genshin/observe.py'), '--exe', 'YuanShen.exe', '--nonce']);
      assert.equal(options.cwd, root); return JSON.stringify(capture(root, args[4]));
    }, fetchImpl: async (url, init) => {
      calls.push(url); assert.equal(init.redirect, 'error');
      const body = JSON.parse(init.body); assert.equal(body.mode, 'genshin-scene');
      return new Response(JSON.stringify(vision(body.image)));
    } });
  assert.deepEqual(calls, ['http://127.0.0.1:17646/read']);
  assert.equal(result.inputSent, false); assert.equal(result.verified, false); assert.equal(result.betterGiExecuted, false);
  assert.equal(result.observation.uncertain, true);
  assert.ok(fs.existsSync(path.join(path.dirname(result.capture.image), 'observation.json')));
});
test('receipt rejects stale, wrong request/target/path, bad hash and replaced frame', t => {
  const root = fixture(t), nonce = randomUUID(), receipt = capture(root, nonce);
  const options = { root, nonce, target: receipt.target, startedAt: receipt.capturedAt, now: receipt.capturedAt };
  for (const patch of [{ nonce: randomUUID() }, { target: 'SlayTheSpire2.exe' }, { image: root },
    { inputSent: true }, { capturedAt: receipt.capturedAt - 1 }, { sha256: '0'.repeat(64) }]) {
    assert.throws(() => validateCapture({ ...receipt, ...patch }, options));
  }
  assert.throws(() => validateCapture(receipt, { ...options, now: receipt.capturedAt + 30001 }));
  fs.writeFileSync(receipt.image, Buffer.alloc(24));
  assert.throws(() => validateCapture(receipt, options), /digest or format/);
});
test('model result cannot substitute another frame or add action fields', () => {
  const result = vision('frame.png');
  assert.deepEqual(validateObservation(result, 'frame.png'), result.parsed);
  for (const patch of [{ source_image: 'old.png' }, { mode: 'scene' }, { normalization_error: 'invalid' },
    { parsed: { ...result.parsed, target_point: [500, 500] } }, { parsed: { ...result.parsed, uncertain: false } },
    { parsed: { ...result.parsed, visible_text: ['x'.repeat(161)] } }]) {
    assert.throws(() => validateObservation({ ...result, ...patch }, 'frame.png'));
  }
});
test('capture failure never calls vision; pre-cancel never starts a process', async t => {
  const root = fixture(t); let processes = 0, requests = 0;
  const options = { root, runProcess: async () => { processes++; throw Error('Game absent'); }, fetchImpl: async () => { requests++; } };
  await assert.rejects(observe({ ...options, signal: new AbortController().signal }), /Game absent/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(observe({ ...options, signal: controller.signal }));
  assert.equal(processes, 1); assert.equal(requests, 0);
});
test('cancellation after capture prevents vision and after inference prevents publication', async t => {
  const root = fixture(t);
  for (const stage of ['capture', 'vision']) {
    const controller = new AbortController(); let receipt, called = false;
    await assert.rejects(observe({ root, signal: controller.signal, runProcess: async (cmd, args) => {
      receipt = capture(root, args[4]); if (stage === 'capture') controller.abort(); return JSON.stringify(receipt);
    }, fetchImpl: async () => { called = true; controller.abort(); return new Response(JSON.stringify(vision(receipt.image))); } }));
    assert.equal(called, stage === 'vision');
    assert.equal(fs.existsSync(path.join(path.dirname(receipt.image), 'observation.json')), false);
  }
});
test('oversized, busy and malformed vision responses fail without publishing', async t => {
  const root = fixture(t);
  for (const response of [() => new Response('busy', { status: 409 }), () => new Response('x'.repeat(1048577)), () => new Response('{}')]) {
    let receipt;
    await assert.rejects(observe({ root, signal: new AbortController().signal,
      runProcess: async (cmd, args) => JSON.stringify(receipt = capture(root, args[4])), fetchImpl: async () => response() }));
    assert.equal(fs.existsSync(path.join(path.dirname(receipt.image), 'observation.json')), false);
  }
});
test('observation shares desktop lease and rejects arbitrary executables and action arguments', async t => {
  const root = fixture(t); let release;
  const gate = new Promise(r => { release = r; });
  const h = createSkillHost({ root, directory: null, runProcess: async () => { await gate; throw Error('Fixture done'); } });
  assert.throws(() => h.start({ skill: 'genshin:observe', args: { target: 'notepad.exe' } }), /Unsupported/);
  assert.throws(() => h.start({ skill: 'genshin:observe', args: { actions: [] } }), /Unknown/);
  const j = h.start({ skill: 'genshin:observe' });
  assert.throws(() => h.start({ skill: 'sts2:native-play', allowLive: true }), /busy/);
  h.stop(j.id); release(); assert.equal((await h.wait(j.id)).state, 'INTERRUPTED');
});
