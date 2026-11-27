'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { launch, configuredExecutable } = require('../src/genshin/launch');
const { createSkillHost } = require('../src/skills');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'genshin-launch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const executable = path.join(root, 'game with spaces', 'YuanShen.exe');
  fs.mkdirSync(path.dirname(executable)); fs.writeFileSync(executable, 'fixture, never executable');
  return { root, executable };
}
test('launch configuration requires a local game binary; explicit environment wins', t => {
  const { root, executable } = fixture(t);
  assert.throws(() => configuredExecutable({ dataRoot: root, env: {} }), /Configure/);
  for (const value of ['YuanShen.exe', 'https://example.com/YuanShen.exe'])
    assert.throws(() => configuredExecutable({ dataRoot: root, env: { GENSHIN_EXE: value } }));
  const bad = path.join(root, 'launcher.exe'); fs.writeFileSync(bad, 'test');
  assert.throws(() => configuredExecutable({ dataRoot: root, env: { GENSHIN_EXE: bad } }), /Only/);
  fs.mkdirSync(path.join(root, 'data'));
  fs.writeFileSync(path.join(root, 'data/genshin.local.json'), JSON.stringify({ executable }));
  assert.equal(configuredExecutable({ dataRoot: root, env: {} }), fs.realpathSync(executable));
  assert.throws(() => configuredExecutable({ dataRoot: root, env: { GENSHIN_EXE: bad } }), /Only/);
});
test('launch uses fixed helper arguments without shell or extra game arguments', async t => {
  const { root, executable } = fixture(t);
  const result = await launch({ root, env: { GENSHIN_EXE: executable }, signal: new AbortController().signal,
    runProcess: async (cmd, args) => {
      assert.equal(cmd, path.join(root, 'runtime/vlm-env/Scripts/python.exe'));
      assert.deepEqual(args.slice(0, 4), [path.join(root, 'scripts/genshin/launch.py'), '--exe', fs.realpathSync(executable), '--nonce']);
      assert.equal(args.length, 5);
      return JSON.stringify({ nonce: args[4], target: 'YuanShen.exe', pid: 123, started: true,
        inputSent: false, verified: false, windowFound: true, foreground: false });
    } });
  assert.equal(result.verified, false); assert.equal(result.inputSent, false);
});
test('launch does not retry permission errors or accept mismatched and late receipts', async t => {
  const { root, executable } = fixture(t); let calls = 0;
  const options = { root, env: { GENSHIN_EXE: executable }, signal: new AbortController().signal };
  await assert.rejects(launch({ ...options, runProcess: async () => { calls++; throw Error('WinError 740'); } }), /740/);
  assert.equal(calls, 1);
  await assert.rejects(launch({ ...options, runProcess: async () => '{}' }), /Invalid/);
  const c = new AbortController(); c.abort();
  await assert.rejects(launch({ ...options, signal: c.signal, runProcess: async () => { calls++; } }));
  assert.equal(calls, 1);
  const late = new AbortController();
  await assert.rejects(launch({ ...options, signal: late.signal, runProcess: async (cmd, args) => {
    late.abort();
    return JSON.stringify({ nonce: args[4], target: 'YuanShen.exe', pid: 123, started: true,
      inputSent: false, verified: false, windowFound: true, foreground: true });
  } }));
});
test('launch requires explicit live invocation and does not accept a caller executable', async t => {
  const { root } = fixture(t);
  const h = createSkillHost({ root, directory: null, env: {} });
  assert.throws(() => h.start({ skill: 'genshin:launch' }), /allowLive/);
  assert.throws(() => h.start({ skill: 'genshin:launch', allowLive: true, args: { executable: 'notepad.exe' } }), /Unknown/);
  const job = h.start({ skill: 'genshin:launch', allowLive: true });
  assert.equal((await h.wait(job.id)).state, 'FAILED');
});
