'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { nativeMission, configuredClient } = require('../src/skills/mc-native-client');
const { createSkillHost } = require('../src/skills');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const worldId = 'a'.repeat(64);
function fixture() {
  const instanceId = randomUUID(), jobId = randomUUID(), controller = new AbortController();
  const args = { worldId, goal: 'Collect wood', durationMinutes: 1 };
  const status = { protocol: 1, instanceId, worldId, ready: true, active: false, hostFresh: true, controlRevision: 0 };
  const reply = (state, extra = {}) => ({ id: jobId, instanceId, worldId, state,
    releaseComplete: ['VERIFIED', 'UNVERIFIED', 'FAILED', 'INTERRUPTED', 'CANCELLED'].includes(state),
    missionId: 'native-mission', ...extra });
  return { instanceId, jobId, controller, args, status, reply, signal: controller.signal, pause: async () => {} };
}
test('native MC skill has explicit world selection and a shared desktop lease', async () => {
  const h = createSkillHost({ directory: null, env: {} });
  const entry = h.list().find(x => x.id === 'mcplayer:native-play');
  assert.deepEqual(entry.resources, ['desktop', 'minecraft']);
  assert.throws(() => h.start({ skill: entry.id, allowLive: true, args: { goal: 'test' } }), /worldId/);
  assert.throws(() => h.start({ skill: entry.id, allowLive: true, args: { goal: 'x'.repeat(1001), worldId } }), /goal/);
  assert.ok(h.list().some(x => x.id === 'mcplayer:native-status' && x.mode === 'read'));
});
test('successful native receipt preserves engine result without inventing independent verification', async () => {
  const f = fixture(), calls = [];
  const result = await nativeMission({ ...f, request: async (route, body) => {
    calls.push(route);
    if (route === '/status') return f.status;
    if (route === '/requests') { assert.equal(body.durationMs, 60000); return f.reply('QUEUED'); }
    return f.reply('VERIFIED');
  } });
  assert.equal(result.engine.state, 'VERIFIED'); assert.equal(result.verified, false);
  assert.deepEqual(calls, ['/status', '/requests', `/requests/${f.jobId}`]);
});
test('wrong world, active task, stale host and wrong protocol never send a start', async () => {
  for (const override of [{ worldId: 'other' }, { active: true }, { hostFresh: false }, { protocol: 2 }]) {
    const f = fixture(), calls = [];
    await assert.rejects(nativeMission({ ...f, request: async route => { calls.push(route); return { ...f.status, ...override }; } }), /ready/);
    assert.deepEqual(calls, ['/status']);
  }
});
test('uncertain start cancels its own request id without replaying the start', async () => {
  const f = fixture(), calls = [];
  await assert.rejects(nativeMission({ ...f, request: async (route, body) => {
    calls.push(route);
    if (route === '/status') return f.status;
    if (route === '/requests') throw Error('lost start response');
    assert.deepEqual(body, { instanceId: f.instanceId });
    return f.reply('CANCELLED', { worldId: '' });
  } }), /lost start/);
  assert.deepEqual(calls, ['/status', '/requests', `/requests/${f.jobId}/stop`]);
});
test('explicit start conflict does not send a stop', async () => {
  const f = fixture(), calls = [];
  await assert.rejects(nativeMission({ ...f, request: async route => {
    calls.push(route); if (route === '/status') return f.status;
    throw Object.assign(Error('conflict'), { status: 409 });
  } }), /conflict/);
  assert.deepEqual(calls, ['/status', '/requests']);
});
test('abort and offline cleanup retain control until the same instance confirms release', async () => {
  const f = fixture(); let stops = 0;
  await assert.rejects(nativeMission({ ...f, request: async route => {
    if (route === '/status') return f.status;
    if (route === '/requests') { f.controller.abort(Error('user stop')); return f.reply('RUNNING'); }
    stops++;
    if (stops === 1) throw Error('offline');
    if (stops === 2) return f.reply('INTERRUPTED', { instanceId: randomUUID() });
    if (stops === 3) return f.reply('STOPPING');
    return f.reply('INTERRUPTED');
  } }), /user stop/);
  assert.equal(stops, 4);
});
test('mismatched polling receipt cannot complete the task and triggers owned cleanup', async () => {
  const f = fixture(); let stopped = false;
  await assert.rejects(nativeMission({ ...f, request: async route => {
    if (route === '/status') return f.status;
    if (route === '/requests') return f.reply('RUNNING');
    if (route.endsWith('/stop')) { stopped = true; return f.reply('INTERRUPTED'); }
    return f.reply('VERIFIED', { id: randomUUID() });
  } }), /identity/);
  assert.equal(stopped, true);
});
test('local configuration refuses remote endpoint and malformed credentials', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-director-test-'));
  try {
    const file = path.join(dir, 'config.json'), tokenFile = path.join(dir, 'token.txt');
    const env = { MCPLAYER_DIRECTOR_CONFIG: file };
    fs.writeFileSync(tokenFile, 'a'.repeat(64));
    fs.writeFileSync(file, JSON.stringify({ endpoint: 'http://example.com', tokenFile }));
    assert.throws(() => configuredClient(dir, env), /loopback/);
    fs.writeFileSync(file, JSON.stringify({ endpoint: 'http://127.0.0.1:17650', tokenFile }));
    assert.equal(typeof configuredClient(dir, env), 'function');
    fs.writeFileSync(tokenFile, 'invalid');
    assert.throws(() => configuredClient(dir, env), /token/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
