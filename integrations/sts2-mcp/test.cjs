'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const Ajv = require('ajv');
const { Agent, settings, completion, allowedTools, validateDecision, toolText } = require('./agent.cjs');
const { createService } = require('./service.cjs');
const { StreamerSync, liveContext } = require('./streamer.cjs');
const env = { STS2_DEEPSEEK_API_KEY: 'test-only', STS2_MODEL: 'deepseek-flash' };
const tools = [
  { name: 'get_game_state', inputSchema: { type: 'object', properties: { format: { type: 'string' } }, additionalProperties: false } },
  { name: 'menu_select', inputSchema: { type: 'object', properties: { option: { type: 'string' } }, required: ['option'], additionalProperties: false } },
  { name: 'map_choose_node', inputSchema: { type: 'object', properties: { node_index: { type: 'integer', minimum: 0 } }, required: ['node_index'], additionalProperties: false } },
  { name: 'combat_play_card', inputSchema: { type: 'object' } },
  { name: 'delete_profile', inputSchema: { type: 'object' } },
  { name: 'mp_combat_end_turn', inputSchema: { type: 'object' } }
];
const validators = new Map(tools.map(t => [t.name, new Ajv().compile(t.inputSchema)]));
function reply(name = 'map_choose_node', args = { node_index: 0 }) {
  return { choices: [{ finish_reason: 'tool_calls', message: { role: 'assistant', content: '按当前可用路线行动', tool_calls: [{ id: 'call_test', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }], usage: { total_tokens: 12 } };
}
const response = body => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function fakeBridge(observations = [{ state_type: 'map' }]) {
  const calls = []; let cursor = 0;
  return { tools, validators, calls, async connect() {}, async close() {},
    async observe() { return observations[Math.min(cursor++, observations.length - 1)]; },
    async call(name, args) { calls.push({ name, args }); return { status: 'ok' }; } };
}

test('credentials stay on official DeepSeek origin and support an existing saved key', () => {
  assert.equal(settings({}, 'saved-only').keySource, 'existing-local-game-settings');
  assert.equal(settings(env, 'saved-only').key, 'test-only');
  assert.throws(() => settings({ ...env, STS2_DEEPSEEK_BASE_URL: 'https://example.com' }, ''), /official/);
  assert.throws(() => settings({}, ''), /not configured/);
});
test('tools are restricted to the scene and do not expose destructive or multiplayer operations', () => {
  assert.deepEqual(allowedTools(tools, { state_type: 'map' }).map(t => t.name), ['get_game_state', 'map_choose_node']);
  assert.deepEqual(allowedTools(tools, { state_type: 'map' }, true).map(t => t.name), ['get_game_state']);
});
test('menu validation handles upstream string and object formats and rejects invalid selection', () => {
  const available = allowedTools(tools, { state_type: 'menu' });
  for (const options of [['singleplayer'], [{ name: 'singleplayer', enabled: true }]]) {
    validateDecision({ name: 'menu_select', args: { option: 'singleplayer' } }, available, { validators }, { options });
  }
  for (const option of ['abandon', 'multiplayer', 'delete_profile', 'settings']) {
    assert.throws(() => validateDecision({ name: 'menu_select', args: { option } }, available, { validators }, { options: [option] }), /outside/);
  }
  assert.throws(() => validateDecision({ name: 'menu_select', args: { option: 'confirm' } }, available, { validators }, { options: [{ name: 'confirm', enabled: false }] }));
});
test('completion preserves tool call data and refuses truncation, multiple calls and unknown tools', async () => {
  const config = settings(env, '');
  let request;
  const result = await completion([], tools, config, null, async (url, options) => { request = JSON.parse(options.body); return response(reply()); });
  assert.equal(result.name, 'map_choose_node');
  assert.equal(request.parallel_tool_calls, false);
  assert.equal(request.thinking.type, 'disabled');
  const truncated = reply(); truncated.choices[0].finish_reason = 'length';
  const multiple = reply(); multiple.choices[0].message.tool_calls.push(multiple.choices[0].message.tool_calls[0]);
  for (const body of [truncated, multiple, reply('unlisted')]) await assert.rejects(completion([], tools, config, null, async () => response(body)));
});
test('tool-level errors returned as text are treated as failures', () => {
  assert.throws(() => toolText({ content: [{ type: 'text', text: 'Error: Cannot connect' }] }), /Cannot connect/);
});
test('stale state is reobserved and replanned before mutation', async () => {
  const bridge = fakeBridge([{ state_type: 'map', floor: 1 }, { state_type: 'map', floor: 2 }]);
  let requests = 0;
  const agent = new Agent({ env, bridgeFactory: () => bridge, fetchImpl: async () => { requests++; return response(reply()); } });
  const status = await agent.run({ steps: 1 });
  assert.equal(requests, 2); assert.equal(bridge.calls.length, 1); assert.equal(status.running, false);
});
test('dry run does not execute the model-proposed action', async () => {
  const bridge = fakeBridge();
  const agent = new Agent({ env, bridgeFactory: () => bridge, fetchImpl: async () => response(reply()) });
  await agent.run({ steps: 1, execute: false });
  assert.equal(bridge.calls.length, 0);
});
test('stop during model inference prevents a later game action', async () => {
  const bridge = fakeBridge(); let release;
  const waiting = new Promise(resolve => { release = resolve; });
  const agent = new Agent({ env, bridgeFactory: () => bridge, fetchImpl: async () => { await waiting; return response(reply()); } });
  const running = agent.run({ steps: 1 });
  await new Promise(resolve => setImmediate(resolve)); agent.stop(); release(); await running;
  assert.equal(bridge.calls.length, 0); assert.equal(agent.snapshot().running, false);
});
test('game-over stops without another model request or action', async () => {
  const bridge = fakeBridge([{ state_type: 'game_over' }]);
  const agent = new Agent({ env, bridgeFactory: () => bridge, fetchImpl: async () => { throw Error('must not call'); } });
  await agent.run({ steps: 1 }); assert.equal(bridge.calls.length, 0);
});
test('control service rejects cross-origin mutations and invalid step budgets', async () => {
  const service = createService({ env });
  await new Promise(resolve => service.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${service.server.address().port}`;
  try {
    const bad = await fetch(base + '/api/start', { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://example.com' }, body: '{}' });
    assert.equal(bad.status, 403);
    const invalid = await fetch(base + '/api/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"steps":0}' });
    assert.equal(invalid.status, 400);
    const status = await (await fetch(base + '/api/status')).json();
    assert.equal(status.keyConfigured, true); assert.equal(JSON.stringify(status).includes('test-only'), false);
  } finally { await service.close(); }
});

test('streamer narration is removed from arguments before the real game tool executes', async () => {
  const body = reply('map_choose_node', { node_index: 0, streamer_line: '我先走这条路线，看看前面的敌人。', streamer_emotion: 'focused' });
  const decision = await completion([], tools, { ...settings(env, ''), narrate: true }, null, async () => response(body));
  assert.deepEqual(decision.args, { node_index: 0 });
  assert.match(decision.streamerLine, /路线/);
  validateDecision(decision, allowedTools(tools, { state_type: 'map' }), { validators }, { state_type: 'map' });
});
test('game action waits for the actual speech-start receipt and speech is delivered only once', async () => {
  const sync = new StreamerSync({ startTimeout: 500 }); sync.configure(true);
  let ready = false;
  const waiting = sync.beforeAction({ name: 'map_choose_node', args: { node_index: 0 }, streamerLine: '我先走这里。' }, { state_type: 'map' }, new AbortController().signal).then(() => { ready = true; });
  const entry = sync.take(); assert.ok(entry); assert.equal(sync.take(), null);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(ready, false);
  assert.equal(sync.receipt('wrong-id', 'started'), false);
  sync.receipt(entry.id, 'started'); await waiting; assert.equal(ready, true);
  sync.receipt(entry.id, 'ended'); assert.equal(sync.snapshot().pending, null);
});
test('stop cancels an undelivered streamer line and does not leave stale speech queued', async () => {
  const sync = new StreamerSync(); sync.configure(true); const controller = new AbortController();
  const waiting = sync.beforeAction({ name: 'map_choose_node', streamerLine: '我先看一下。' }, { state_type: 'map' }, controller.signal);
  controller.abort(); await assert.rejects(waiting); assert.equal(sync.take(), null);
});
test('unavailable audio pauses gameplay instead of executing an unheard narrated action', async () => {
  const sync = new StreamerSync({ startTimeout: 1 }); sync.configure(true);
  await assert.rejects(sync.beforeAction({ name: 'map_choose_node', streamerLine: '先走这里。' }, { state_type: 'map' }, new AbortController().signal), /语音尚未就绪/);
  assert.equal(sync.take(), null);
});
test('a failed speech receipt does not release the corresponding game action', async () => {
  const sync = new StreamerSync(); sync.configure(true);
  const waiting = sync.beforeAction({ name: 'map_choose_node', streamerLine: '先走这里。' }, { state_type: 'map' }, new AbortController().signal);
  const entry = sync.take(); sync.receipt(entry.id, 'failed');
  await assert.rejects(waiting, /语音播放失败/);
});
test('Spire dialogue context carries the real game without changing Minecraft context formatting', () => {
  const { gameContextMessage } = require('../../src/games/live-context');
  const state = { state_type: 'monster', player: { hp: 55, max_hp: 80, hand: [] }, battle: { is_play_phase: true }, run: { act: 1, floor: 2 } };
  const context = liveContext(state, { running: true, steps: 2 });
  assert.equal(context.game, 'sts2'); assert.equal(context.player.hp, 55);
  assert.match(gameContextMessage(context), /杀戮尖塔2/);
  const mc = { goal: '采木头' };
  assert.equal(gameContextMessage(mc), require('../../src/minecraft/live-context').gameContextMessage(mc));
});
