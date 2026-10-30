'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MinecraftEngine, parseProposal, PLANNER, CONTROLLER } = require('../src/minecraft/astra-jev');
const { AutonomyLoop } = require('../src/minecraft/autonomy-loop');

async function main() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-jev-'));
  const file = path.join(dir, 'engine.json');
  const requests = [], logs = [];
  let choice = 'a1', abortAfterPlanner = null, wrongProbe = false;
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body, signal: options.signal });
    assert.equal(options.headers.authorization, 'Bearer test-secret');
    let payload;
    if (url.endsWith('/chat/completions')) {
      assert.equal(body.model, PLANNER);
      assert.equal(body.temperature, undefined);
      const probe = body.messages[0].content.includes('这是模型连通性检查');
      payload = { model: PLANNER, choices: [{ message: { content: JSON.stringify({ objective: '核对周围和食物', candidates: probe && !wrongProbe ? [{ action: { action: 'observe' }, reason: '连接检查' }] : [
        { action: { action: 'gather_wood', count: 1 }, reason: '需要木头且安全时' },
        { action: { action: 'eat' }, reason: '需要补充食物时' }
      ] }) } }] };
      abortAfterPlanner?.abort();
    } else {
      assert.equal(url, 'https://openrouter.ai/api/alpha/decisions');
      assert.equal(body.model, CONTROLLER);
      assert.equal(body.questions.action.type, 'choice');
      payload = { model: CONTROLLER, answers: { action: { choice, confidence: 0.8 } } };
    }
    return { ok: true, json: async () => payload };
  };
  const engine = new MinecraftEngine({ file, env: {}, fetchImpl });
  assert.equal(engine.status().provider, 'deepseek');
  engine.save({ provider: 'astra-jev' });
  assert.throws(() => engine.assertReady(), /OpenRouter/);
  assert.throws(() => engine.save({ provider: 'unknown' }), /有效/);
  assert.throws(() => engine.save({ provider: 'astra-jev', apiKey: 'bad key' }), /格式/);
  engine.save({ provider: 'astra-jev', apiKey: 'test-secret' });
  assert(!JSON.stringify(engine.status()).includes('test-secret'));
  const restored = new MinecraftEngine({ file, env: {} });
  assert.equal(restored.status().keyConfigured, true);
  assert.equal(restored.status().verification, null, 'saved key must not imply successful inference');
  engine.save({ provider: 'astra-jev', apiKey: '' });
  assert.equal(engine.key(), 'test-secret', 'blank input preserves saved key');
  const observed = { connected: true, sessionId: 'same', dimension: 'overworld', health: 20, food: 15, inventory: [], reactive: { mode: 'idle', enabled: true } };
  const options = { goal: '生存', onRequest: row => logs.push(row), onCompletion: row => logs.push(row) };
  const action = await engine.plan(observed, options);
  assert.deepEqual(action, { action: 'eat' }, 'JEV choice must win over the first Astra candidate');
  assert.equal(engine.status().verification.ok, true);
  assert(!JSON.stringify(logs).includes('test-secret'), 'model callbacks must never include the key');
  assert(requests[1].body.questions.action.criteria.a2.includes('observe'));
  choice = 'a999';
  await assert.rejects(engine.plan(observed, options), /有效候选/);
  choice = '__proto__';
  await assert.rejects(engine.plan(observed, options), /有效候选/);
  assert.throws(() => parseProposal('invalid'), /JSON/);
  assert.throws(() => parseProposal(JSON.stringify({ objective: '非法', candidates: [{ action: { action: 'gather_wood', count: 99999 }, reason: '过量' }] })), /count/);
  assert.throws(() => parseProposal(JSON.stringify({ objective: '作弊', candidates: [{ action: { action: 'creative_clear_inventory' }, reason: '不允许' }] })), /创造/);
  const controller = new AbortController();
  abortAfterPlanner = controller;
  const count = requests.length;
  await assert.rejects(engine.plan(observed, { ...options, signal: controller.signal }), { name: 'AbortError' });
  assert.equal(requests.length, count + 1, 'cancelled Astra request must not proceed to JEV');
  abortAfterPlanner = null; choice = 'a0';
  await engine.test(new AbortController().signal);
  assert.equal(engine.status().verification.kind, 'model-probe');
  wrongProbe = true;
  await assert.rejects(engine.test(), /observe/);
  assert.equal(engine.status().verification.ok, false);
  wrongProbe = false;

  const gameCalls = [];
  let stale = false, waiting = false, observationCount = 0;
  const loop = new AutonomyLoop({ engine, logDir: dir, request: async (route, payload) => {
    gameCalls.push({ route, payload });
    if (route === '/observe') return { ...observed, sessionId: stale && ++observationCount > 1 ? 'changed' : 'same' };
    if (route.startsWith('/task')) return { status: waiting ? 'running' : 'completed', result: { verified: true } };
    return { accepted: true };
  } });
  choice = 'a1';
  const result = await loop.runOnce('吃东西', new AbortController().signal);
  assert.equal(result.decision.source, 'astra-jev');
  assert.deepEqual(gameCalls.find(row => row.route === '/skill').payload.action, { action: 'eat' });
  assert.equal(loop.snapshot().model, PLANNER);
  assert.equal(loop.snapshot().controllerModel, CONTROLLER);
  stale = true;
  await assert.rejects(loop.runOnce('生存', new AbortController().signal), /状态已变化/);
  assert.equal(gameCalls.filter(row => row.route === '/skill').length, 1, 'stale cloud decisions must not execute');
  stale = false; waiting = true;
  const cancel = new AbortController();
  const task = loop.runOnce('生存', cancel.signal);
  setTimeout(() => cancel.abort(), 25);
  await assert.rejects(task);
  assert(gameCalls.some(row => row.route === '/cancel-task'), 'stop must cancel cloud-selected game tasks');
  const errorEngine = new MinecraftEngine({ file, env: {}, fetchImpl: async () => ({ ok: false, status: 401, json: async () => ({ error: 'test-secret' }) }) });
  await assert.rejects(errorEngine.test(), error => /401/.test(error.message) && !error.message.includes('test-secret'));
  console.log('PASS Astra/JEV: persistence, secret redaction, selection, invalid actions, probe, cancellation, stale state, loop integration');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
