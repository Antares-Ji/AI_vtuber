'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { SkillRegistry, SkillRuntime, createSkillHost } = require('../src/skills');
const { remoteRun, localClient } = require('../src/skills/local-client');
const tick = () => new Promise(resolve => setImmediate(resolve));
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const def = (execute, extra = {}) => ({ id: 'test:skill', version: '1', mode: 'live', resources: ['desktop'], validate: a => a, execute, ...extra });
function host(definition, options = {}) { return new SkillRuntime({ registry: new SkillRegistry().register(definition).seal(), ...options }); }

test('registries are isolated, sealed and enforce enabled skills', () => {
  const a = new SkillRegistry().register(def(async () => ({})));
  assert.throws(() => a.register(def(async () => ({}))), /Duplicate/);
  assert.throws(() => a.seal(['missing:skill']), /Unknown/);
  a.seal([]); assert.throws(() => a.get('test:skill'), /disabled/);
  assert.throws(() => a.register(def(async () => ({}))), /sealed/);
  assert.equal(new SkillRegistry().seal().list().length, 0);
});
test('live execution is explicit and copied arguments cannot change an active invocation', async () => {
  let seen;
  const h = host(def(async a => { seen = a; return { verified: true }; }));
  assert.throws(() => h.start({ skill: 'test:skill' }), /allowLive/);
  const args = { steps: 1 }, j = h.start({ skill: 'test:skill', args, allowLive: true }); args.steps = 999;
  const result = await h.wait(j.id);
  assert.equal(seen.steps, 1); assert.equal(result.state, 'UNVERIFIED');
});
test('stop retains execution ownership through delayed cleanup and rejects late success', async () => {
  const running = deferred(), cleanup = deferred();
  const h = host(def(async (a, { signal }) => {
    running.resolve(); await new Promise(r => signal.addEventListener('abort', r, { once: true }));
    await cleanup.promise; return { verified: true };
  }, { verify: () => true }));
  const j = h.start({ skill: 'test:skill', allowLive: true }); await running.promise;
  assert.equal(h.stop(j.id).state, 'STOPPING');
  assert.throws(() => h.start({ skill: 'test:skill', allowLive: true }), /busy/);
  cleanup.resolve(); assert.equal((await h.wait(j.id)).state, 'INTERRUPTED');
  assert.equal(h.owners.size, 0);
});
test('monotonic budget rejects a completed receipt even before timer callback', async () => {
  let now = 0;
  const h = host(def(async () => { now = 11; return { verified: true }; }, { verify: () => true }), { clock: () => now });
  const j = h.start({ skill: 'test:skill', allowLive: true, timeoutMs: 10 });
  assert.equal((await h.wait(j.id)).state, 'INTERRUPTED');
  assert.equal(h.status(j.id).reason, 'BUDGET_EXHAUSTED');
});
test('only a verifier can accept evidence, and simulated receipts remain simulated', async () => {
  for (const [simulated, expected] of [[false, 'VERIFIED'], [true, 'SIMULATED']]) {
    const h = host(def(async () => ({ simulated, evidence: { observed: 2 } }), { verify: r => r.evidence.observed === 2 }));
    const j = h.start({ skill: 'test:skill', allowLive: true }); assert.equal((await h.wait(j.id)).state, expected);
  }
});
test('timeline stores invocation metadata, not arbitrary arguments, output or prompts', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-test-'));
  try {
    const h = host(def(async () => ({ private: 'PRIVATE_PAYLOAD' }), { mode: 'read' }), { directory: dir });
    const j = h.start({ skill: 'test:skill', args: { prompt: 'PRIVATE_PAYLOAD' } }); await h.wait(j.id);
    const log = fs.readFileSync(path.join(dir, j.id + '.jsonl'), 'utf8');
    assert.doesNotMatch(log, /PRIVATE_PAYLOAD/); assert.match(log, /profileHash/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('adapter stop waits for native input release even when autonomy has ended', async () => {
  const controller = new AbortController(); let calls = [], stateCount = 0;
  const request = async route => {
    calls.push(route);
    if (route === '/start') { controller.abort(); return {}; }
    if (route === '/state') return { busy: stateCount++ === 1 };
    return {};
  };
  await assert.rejects(remoteRun({ request, routes: { state: '/state', start: '/start', stop: '/stop' },
    start: {}, busy: s => s.busy, signal: controller.signal, pause: async () => {} }));
  assert.deepEqual(calls, ['/state', '/start', '/stop', '/state', '/stop', '/state']);
});
test('remote start is never retried, and explicit conflicts never stop the other owner', async () => {
  for (const status of [409, undefined]) {
    const calls = [];
    const request = async route => { calls.push(route); if (route === '/start') throw Object.assign(Error('start failed'), { status }); return { running: false }; };
    await assert.rejects(remoteRun({ request, routes: { state: '/state', start: '/start', stop: '/stop' },
      busy: s => s.running, signal: new AbortController().signal, pause: async () => {} }));
    assert.equal(calls.filter(x => x === '/start').length, 1);
    assert.equal(calls.includes('/stop'), status !== 409);
  }
});
test('cleanup network loss keeps lease until an idle receipt returns', async () => {
  const gate = deferred(), controller = new AbortController(); let retries = 0, polls = 0;
  const h = host(def((a, { signal }) => remoteRun({ signal, routes: { state: '/state', start: '/start', stop: '/stop' },
    request: async route => {
      if (route === '/start') throw Error('uncertain response');
      if (route === '/stop' && retries++ === 0) throw Error('offline');
      if (route === '/state') polls++;
      return { running: false };
    }, busy: s => s.running, pause: () => gate.promise })));
  const j = h.start({ skill: 'test:skill', allowLive: true }); await tick();
  h.stop(j.id); assert.equal(h.status(j.id).state, 'STOPPING');
  assert.throws(() => h.start({ skill: 'test:skill', allowLive: true }), /busy/);
  gate.resolve(); assert.equal((await h.wait(j.id)).state, 'INTERRUPTED'); assert.equal(polls, 2);
});
test('engine HTTP client refuses remote URLs and redirects', async () => {
  assert.throws(() => localClient('https://example.com'), /local/);
  let init;
  const request = localClient('http://127.0.0.1:1', { fetchImpl: async (url, options) => { init = options; return { ok: true, json: async () => ({}) }; } });
  await request('/state'); assert.equal(init.redirect, 'error');
});
test('built-in Genshin path runs a simulation and BetterGI cannot fabricate a live result', async () => {
  const h = createSkillHost({ directory: null, env: {} });
  const j = h.start({ skill: 'genshin:demo', args: { goal: '观察当前场景' } });
  assert.equal((await h.wait(j.id)).state, 'SIMULATED');
  const b = h.start({ skill: 'genshin:bettergi', allowLive: true });
  assert.equal((await h.wait(b.id)).state, 'FAILED'); assert.match(h.status(b.id).error, /BetterGI/);
  assert.throws(() => h.start({ skill: 'sts2:native-play', allowLive: true, args: { maxSteps: 1001 } }), /maxSteps/);
});
test('native and MCP routes share a desktop lease', async () => {
  const gate = deferred();
  const h = createSkillHost({ directory: null, clients: { main: async () => { await gate.promise; return { busy: true }; } } });
  const j = h.start({ skill: 'sts2:native-play', allowLive: true });
  assert.throws(() => h.start({ skill: 'sts2:play', allowLive: true }), /busy/);
  h.stop(j.id); gate.resolve(); await h.wait(j.id);
});
test('third-party provider registers through public API without changing core files', async () => {
  const h = createSkillHost({ directory: null, providers: [{ register(registry) {
    registry.register(def(async a => ({ value: a.value }), { id: 'example:review', mode: 'read', resources: [] }));
  } }], enabled: ['example:review'] });
  const j = h.start({ skill: 'example:review', args: { value: 7 } });
  assert.equal((await h.wait(j.id)).result.value, 7);
  assert.throws(() => h.start({ skill: 'genshin:demo' }), /disabled/);
});
test('shutdown prevents new tasks while existing cleanup is still pending', async () => {
  const gate = deferred();
  const h = host(def(async () => { await gate.promise; return {}; }));
  const j = h.start({ skill: 'test:skill', allowLive: true }); await tick();
  const closing = h.close();
  assert.throws(() => h.start({ skill: 'test:skill', allowLive: true }), /shutting down/);
  assert.equal(h.status(j.id).state, 'STOPPING'); gate.resolve(); await closing;
  assert.equal(h.status(j.id).state, 'INTERRUPTED');
});
