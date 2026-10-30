'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const { GenshinRuntime } = require('../src/genshin/runtime');
const { MockAdapter, BetterGiAdapter } = require('../src/genshin/adapters');
const { planGoal, validatePlan } = require('../src/genshin/planner');
const { createServer } = require('../src/genshin/server');
const { gameContextMessage } = require('../src/games/live-context');
const plan = steps => ({ goal: '测试任务', steps });

test('plan validation rejects arbitrary input and unsupported capabilities', async () => {
  for (const input of [null, {}, plan([]), plan([{ skill: 'shell' }]), plan([{ skill: '__proto__' }]),
    plan([{ skill: 'observe', command: 'anything' }]), plan([{ skill: 'observe', timeoutMs: -1 }]),
    plan(Array(7).fill({ skill: 'observe' }))]) assert.throws(() => validatePlan(input));
  await assert.rejects(planGoal('去购买道具'), /仅支持/);
  assert.deepEqual((await planGoal('观察并钓鱼')).steps.map(x => x.skill), ['observe', 'fish']);
});

test('LLM output is validated and malformed plans never execute', async () => {
  const env = { GENSHIN_LLM_API_KEY: 'test-only', GENSHIN_LLM_MODEL: 'test', GENSHIN_LLM_BASE_URL: 'https://example.invalid/v1' };
  let body;
  const fetchImpl = async (_url, options) => {
    body = JSON.parse(options.body);
    return { ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(plan([{ skill: 'observe' }])) } }] }) };
  };
  const result = await planGoal('观察', { mode: 'llm', env, fetchImpl });
  assert.equal(result.planner, 'llm');
  assert.equal(result.goal, '观察');
  assert.equal(body.messages.at(-1).content, '观察');
  await assert.rejects(planGoal('观察', { mode: 'llm', env,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: '{"steps":[{"skill":"shell"}]}' } }] }) }) }), /未知技能/);
  await assert.rejects(planGoal('观察', { mode: 'llm', env: {} }), /需要配置/);
});

test('simulation journals steps without claiming actual game observations', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genshin-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const logFile = path.join(dir, 'events.jsonl');
  const runtime = new GenshinRuntime({ adapter: new MockAdapter({ delayMs: 1 }), logFile });
  runtime.start(await planGoal('观察并钓鱼'));
  await runtime.done;
  assert.equal(runtime.status().job.state, 'simulated');
  assert.equal(runtime.status().job.completedSteps, 2);
  assert.equal(runtime.context().gameConnected, false);
  assert.equal(runtime.context().observation, null);
  assert.equal(runtime.context().lastResult.verified, false);
  const rows = fs.readFileSync(logFile, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(rows.filter(x => x.type === 'step.finished').length, 2);
  assert.equal(rows.at(-1).type, 'job.finished');
  assert.match(gameContextMessage(runtime.context()), /原神/);
  assert.match(gameContextMessage(runtime.context()), /没有实际操作游戏/);
  const snapshot = runtime.status(); snapshot.job.state = 'fake';
  assert.equal(runtime.status().job.state, 'simulated');
});

test('stop aborts current step, prevents subsequent steps, permits a later run', async () => {
  const runtime = new GenshinRuntime({ adapter: new MockAdapter({ delayMs: 1000 }) });
  runtime.start(plan([{ skill: 'observe' }, { skill: 'fight' }]));
  assert.throws(() => runtime.start(plan([{ skill: 'fish' }])), /占用/);
  runtime.stop(); await runtime.done;
  assert.equal(runtime.job.state, 'cancelled');
  assert.equal(runtime.job.completedSteps, 0);
  assert.equal(runtime.events.some(x => x.type === 'step.started' && x.skill === 'fight'), false);
  runtime.adapter.delayMs = 1;
  runtime.start(plan([{ skill: 'observe' }])); await runtime.done;
  assert.equal(runtime.job.state, 'simulated');
});

test('timeout does not falsely finish or release an unresponsive adapter', async () => {
  let finish;
  const adapter = { mode: 'simulation', status: () => ({ ready: true, gameConnected: false }),
    execute: () => new Promise(resolve => { finish = resolve; }) };
  const runtime = new GenshinRuntime({ adapter });
  runtime.start(plan([{ skill: 'observe', timeoutMs: 100 }]));
  await delay(150);
  assert.equal(runtime.status().busy, true);
  assert.equal(runtime.job.state, 'stopping');
  assert.throws(() => runtime.start(plan([{ skill: 'observe' }])), /占用/);
  finish({ verified: false }); await runtime.done;
  assert.equal(runtime.job.state, 'failed');
  assert.match(runtime.job.error, /超时/);
  assert.equal(runtime.job.completedSteps, 0);
});

test('adapter failure is recorded and real BetterGI remains unavailable', async () => {
  const adapter = { mode: 'simulation', status: () => ({ ready: true }), execute: async () => { throw Error('transport failed'); } };
  const runtime = new GenshinRuntime({ adapter });
  runtime.start(plan([{ skill: 'fish' }])); await runtime.done;
  assert.equal(runtime.job.state, 'failed');
  assert.equal(runtime.job.error, 'transport failed');
  const live = new GenshinRuntime({ adapter: new BetterGiAdapter() });
  assert.throws(() => live.start(plan([{ skill: 'fight' }])), /待验证/);
  assert.equal(live.status().busy, false);
});

test('HTTP API authenticates, plans, runs, stops, and exposes grounded context', async t => {
  const runtime = new GenshinRuntime({ adapter: new MockAdapter({ delayMs: 1000 }) });
  const token = 'test-token-long-enough-for-local-service';
  const server = createServer({ runtime, token });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(async () => { runtime.stop(); await runtime.done; server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = (route, body, extra = {}) => fetch(base + route, {
    method: body === undefined ? 'GET' : 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...extra },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  assert.equal((await fetch(base + '/state')).status, 401);
  assert.equal((await request('/state', undefined, { origin: 'https://untrusted.example' })).status, 403);
  assert.equal((await fetch(base + '/health')).status, 200);
  const proposed = await (await request('/plan', { goal: '观察并钓鱼' })).json();
  assert.equal(runtime.job, null, 'planning must not start gameplay');
  assert.equal((await request('/run', { plan: proposed })).status, 202);
  assert.equal((await request('/run', { plan: proposed })).status, 409);
  await request('/stop', {}); await runtime.done;
  const state = await (await request('/state')).json();
  assert.equal(state.job.state, 'cancelled');
  assert.equal((await (await request('/context')).json()).game, 'genshin');
  assert.equal((await request('/run', { plan: plan([{ skill: 'unknown' }]) })).status, 400);
});
