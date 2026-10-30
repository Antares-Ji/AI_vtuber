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
    return { ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(plan([{ skill: 'observe' }])) } }] }) };
  };
  const result = await planGoal('观察', { mode: 'llm', env, fetchImpl });
  assert.equal(result.planner, 'llm');
  assert.equal(result.goal, '观察');
  assert.equal(body.messages.at(-1).content, '观察');
  await assert.rejects(planGoal('观察', { mode: 'llm', env,
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ finish_reason: 'stop', message: { content: '{"steps":[{"skill":"shell"}]}' } }] }) }) }), /未知技能/);
  await assert.rejects(planGoal('观察', { mode: 'llm', env: {} }), /需要配置/);
});

test('API planner uses saved DeepSeek game credentials and actual model planning', async t => {
  const { planWithApi } = require('../src/genshin/api-planner');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'genshin-api-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.mkdirSync(path.join(dir, 'data'));
  fs.writeFileSync(path.join(dir, 'data/minecraft-engine.local.json'), JSON.stringify({ deepseekApiKey: 'test-saved-key' }));
  let calls=0;
  const fetchImpl=async (url,options) => {
    calls++;
    assert.equal(url,'https://api.deepseek.com/chat/completions');
    assert.equal(options.headers.authorization,'Bearer test-saved-key');
    assert.equal(options.redirect,'error');
    const body=JSON.parse(options.body);
    assert.equal(body.thinking.type,'enabled');assert.equal(body.reasoning_effort,'high');
    assert.equal(body.model,'deepseek-flash');assert.equal(body.max_tokens,4096);
    return {ok:true,json:async()=>({model:'deepseek-flash',usage:{total_tokens:10},choices:[{finish_reason:'stop',message:{content:JSON.stringify(plan([{skill:'observe'}])),reasoning_content:'not persisted'}}]})};
  };
  const result=await planWithApi('观察当前场景',{dataRoot:dir,env:{GENSHIN_PLANNER:'rules'},fetchImpl});
  assert.equal(calls,1);assert.equal(result.planner,'llm');assert.equal(result.planning.reasoningReturned,true);
  assert.equal(JSON.stringify(result).includes('not persisted'),false);
  assert.equal(JSON.stringify(result).includes('test-saved-key'),false);
  for(const base of ['https://example.invalid','https://api.deepseek.com.evil.invalid','https://api.deepseek.com/?x=1'])
    await assert.rejects(planWithApi('观察',{dataRoot:dir,env:{GENSHIN_LLM_BASE_URL:base},fetchImpl}),/官方/);
  assert.equal(calls,1);
});

test('API planning rejects truncated, unobserved and cancelled results', async () => {
  const env={GENSHIN_LLM_API_KEY:'test',GENSHIN_LLM_MODEL:'test',GENSHIN_LLM_BASE_URL:'https://api.deepseek.com'};
  const response=(skill,finish='stop')=>({ok:true,json:async()=>({choices:[{finish_reason:finish,message:{content:JSON.stringify(plan([{skill}]))}}]})});
  await assert.rejects(planGoal('观察',{mode:'llm',env,fetchImpl:async()=>response('observe','length')}),/完整结束/);
  await assert.rejects(planGoal('钓鱼',{mode:'llm',env,fetchImpl:async()=>response('fish')}),/先观察/);
  const controller=new AbortController();
  await assert.rejects(planGoal('观察',{mode:'llm',env,signal:controller.signal,fetchImpl:async()=>{
    controller.abort(new Error('test cancellation'));return response('observe');
  }}),/test cancellation/);
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
  let modelCalls=0;
  const server = createServer({ runtime, token, planner: async (goal, options) => {
    assert.equal(options.mode,'llm');assert.ok(options.signal);
    modelCalls++;
    return planGoal(goal,{mode:'rules'}); // Isolated HTTP test double, no network.
  } });
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
  assert.equal(modelCalls,1);
  assert.equal(runtime.job, null, 'planning must not start gameplay');
  assert.equal((await request('/run', { plan: proposed })).status, 202);
  assert.equal((await request('/run', { plan: proposed })).status, 409);
  await request('/stop', {}); await runtime.done;
  const state = await (await request('/state')).json();
  assert.equal(state.job.state, 'cancelled');
  assert.equal((await (await request('/context')).json()).game, 'genshin');
  assert.equal((await request('/run', { plan: plan([{ skill: 'unknown' }]) })).status, 400);
});
