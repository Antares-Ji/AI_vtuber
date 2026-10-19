'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { MinecraftEngine } = require('../src/minecraft/astra-jev');
const { parseDecision } = require('../src/minecraft/astra-direct');
const { AutonomyLoop } = require('../src/minecraft/autonomy-loop');
const { AudienceSuggestions } = require('../src/minecraft/audience-suggestions');
const { liveGameContext } = require('../src/minecraft/live-context');
const { generateCommentary } = require('../src/minecraft/visual-commentary');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'astra-streamer-'));
const conditions = { minHealth: 12, minFood: 10, items: [] };
const proposal = { subgoal: '采木并制作木板', reason: '先获取材料', steps: [
  { action: { action: 'gather_wood', count: 1 }, preconditions: conditions },
  { action: { action: 'craft', item: 'oak_planks', count: 4 }, preconditions: { ...conditions, items: [{ name: 'oak_log', count: 1 }] } }
] };
const response = value => Response.json({ status: 'completed', model: 'gpt-6-astra', output: [{ type: 'reasoning', summary: [] }, { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: JSON.stringify(value) }] }] });
(async () => {
  let modelCalls = 0;
  const requests = [];
  const engine = new MinecraftEngine({ file: path.join(dir, 'engine.json'), env: { ASTRA_API_KEY: 'test-astra', OPENAI_API_KEY: 'wrong-service', OPENROUTER_API_KEY: 'wrong-router' }, fetchImpl: async (url, options) => {
    modelCalls++; requests.push(JSON.parse(options.body));
    assert.equal(url, 'https://api.openai.com/v1/responses'); assert.equal(options.headers.authorization, 'Bearer test-astra');
    assert.equal(requests.at(-1).model, 'gpt-6-astra'); assert.equal(requests.at(-1).store, false);
    assert(!('temperature' in requests.at(-1)));
    return response(proposal);
  } });
  engine.save({ provider: 'astra' });
  assert(!JSON.stringify(engine.status()).includes('test-astra'));
  const observed = { connected: true, busy: false, health: 20, food: 20, inventory: [], sessionId: 'world', dimension: 'overworld', reactive: { lifecycleEpoch: 1, mode: 'idle' }, threats: [], hazards: [] };
  const executed = [];
  let taskStatus = 'completed';
  const loop = new AutonomyLoop({ engine, logDir: dir, request: async (route, body) => {
    if (route === '/observe') return structuredClone(observed);
    if (route === '/skill') { executed.push(body.action); observed.inventory = body.action.action === 'gather_wood' ? [{ name: 'oak_log', count: 1 }] : [{ name: 'oak_planks', count: 4 }]; return {}; }
    if (route.startsWith('/task')) return { status: taskStatus, result: { verified: taskStatus === 'completed', complete: taskStatus === 'completed', gained: taskStatus === 'completed' ? 1 : 0 } };
    return {};
  } });
  const signal = new AbortController().signal;
  await loop.runOnce('制作木板', signal); await loop.runOnce('制作木板', signal);
  assert.equal(modelCalls, 1, 'two verified stage steps reuse one API request');
  assert.deepEqual(executed.map(action => action.action), ['gather_wood', 'craft']);
  await loop.runOnce('制作木板', signal); observed.inventory = [];
  await loop.runOnce('制作木板', signal);
  assert.equal(modelCalls, 3, 'unexpected inventory invalidates remaining stage');
  taskStatus = 'failed'; await loop.runOnce('制作木板', signal);
  taskStatus = 'completed'; await loop.runOnce('制作木板', signal);
  assert.equal(modelCalls, 4, 'failed action invalidates stage');
  loop.addAudienceSuggestion('确认后优先找食物'); await loop.runOnce('制作木板', signal);
  assert.equal(modelCalls, 5, 'operator suggestion triggers replan');
  assert(requests.at(-1).input[1].content.includes('确认后优先找食物'));
  assert.equal(loop.state.audienceSuggestions[0].status, 'considered');
  const noKey = new MinecraftEngine({ file: path.join(dir, 'empty.json'), env: { OPENAI_API_KEY: 'wrong-service', OPENROUTER_API_KEY: 'wrong-router' } });
  noKey.save({ provider: 'astra' }); assert.throws(() => noKey.assertReady(), /OpenAI API Key/);
  assert.throws(() => parseDecision(JSON.stringify({ ...proposal, steps: [] })), /1到6步/);
  assert.throws(() => parseDecision(JSON.stringify(proposal), true), /observe/);
  const failed = new MinecraftEngine({ file: path.join(dir, 'failed.json'), env: { ASTRA_API_KEY: 'secret' }, fetchImpl: async () => new Response('secret', { status: 401 }) });
  failed.save({ provider: 'astra' }); await assert.rejects(failed.plan(observed), error => error.message.includes('401') && !error.message.includes('secret'));
  const truncated = new MinecraftEngine({ file: path.join(dir, 'truncated.json'), env: { ASTRA_API_KEY: 'test' }, fetchImpl: async () => Response.json({ status: 'incomplete' }) });
  truncated.save({ provider: 'astra' }); await assert.rejects(truncated.plan(observed), /未完成/);
  const cancelled = new AbortController(); cancelled.abort(); const beforeCalls = modelCalls;
  await assert.rejects(engine.plan(observed, { signal: cancelled.signal })); assert.equal(modelCalls, beforeCalls);

  const summaries = new AudienceSuggestions({ fetchImpl: async url => {
    assert(url.startsWith('http://127.0.0.1:11435/'));
    return Response.json({ choices: [{ message: { content: JSON.stringify({ isGameSuggestion: true, summary: '优先找食物，保留原目标' }) } }] });
  } });
  const submitted = summaries.submit('先吃饭再挖矿', { goal: '制作木板' });
  let approvals = 0;
  assert.throws(() => summaries.confirm(submitted.id, undefined, () => approvals++));
  await summaries.pending; assert.equal(approvals, 0, 'summarization cannot submit a game command');
  summaries.confirm(submitted.id, '先检查食物', text => { approvals++; assert.equal(text, '先检查食物'); });
  assert.equal(approvals, 1); assert.throws(() => summaries.confirm(submitted.id, undefined, () => approvals++));
  const dismissed = summaries.submit('不要采矿', {}); summaries.dismiss(dismissed.id); await summaries.pending;
  assert.equal(summaries.list().find(entry => entry.id === dismissed.id).status, 'dismissed');

  const state = { ...observed, controlToken: 'never-forward' };
  const snapshot = loop.snapshot();
  const current = liveGameContext(state, snapshot);
  assert.equal(current.localOnly, true); assert.equal(current.result.verified, true);
  assert(!JSON.stringify(current).includes('never-forward'));
  const expired = liveGameContext(state, snapshot, Date.now() - 7000);
  assert.equal(expired.inventory, null); assert.equal(expired.result, null);
  const respawn = liveGameContext({ ...state, reactive: { lifecycleEpoch: 2 } }, snapshot);
  assert.equal(respawn.result, null); assert.equal(respawn.execution, null);
  const partial = liveGameContext(state, { ...snapshot, lastResult: { ...snapshot.lastResult, result: { verified: true, complete: false, gained: 1 } } });
  assert.equal(partial.result.verified, false); assert.equal(partial.result.partial, true);
  const oldCloud = process.env.MINECRAFT_CHAT_PROVIDER; process.env.MINECRAFT_CHAT_PROVIDER = 'cloud';
  try {
    const commentary = await generateCommentary({ stateOnly: true, gameContext: partial, persona: {}, fetchImpl: async (url, options) => {
      assert(url.startsWith('http://127.0.0.1:11435/')); const body = JSON.parse(options.body);
      assert(!body.image_base64); assert(body.messages[0].content.includes('partial=true')); assert(body.messages[0].content.includes('不能调用游戏动作'));
      return Response.json({ choices: [{ message: { content: '{"reaction":1}' } }], model: 'qwen3.5-4b' });
    }, cloudFetch: () => { throw Error('cloud speech forbidden'); } });
    assert.equal(commentary.provider, 'local'); assert(commentary.speech.startsWith('刚才采集木头只完成了一部分，目标尚未完成。'));
    const invalid = await generateCommentary({ stateOnly: true, gameContext: partial, persona: {}, fetchImpl: async () => Response.json({ choices: [{ message: { content: '已经获得四根木头' } }] }) });
    assert(!invalid.speech.includes('四根')); assert.equal(invalid.provider, 'program-facts');
  } finally { if (oldCloud === undefined) delete process.env.MINECRAFT_CHAT_PROVIDER; else process.env.MINECRAFT_CHAT_PROVIDER = oldCloud; }
  console.log('PASS direct Astra stage reuse/replan, isolated credentials, invalid responses, local-only narration, confirmation boundary, partial/stale/life evidence');
})().catch(error => { console.error(error); process.exitCode = 1; });
