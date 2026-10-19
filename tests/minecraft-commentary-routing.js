'use strict';
const assert = require('node:assert/strict');
const { generateCommentary } = require('../src/minecraft/visual-commentary');

const reply = (text, model) => Response.json({ model, choices: [{ message: { content: text }, finish_reason: 'stop' }] });
(async () => {
  const saved = { provider: process.env.MINECRAFT_CHAT_PROVIDER, key: process.env.OPENAI_API_KEY };
  try {
    process.env.MINECRAFT_CHAT_PROVIDER = 'cloud'; process.env.OPENAI_API_KEY = 'test-only';
    const calls = [];
    const input = { imageBase64: 'local-image-only', evidence: { goal: '制作一把铁镐', currentSubgoal: '寻找可达石头', action: { action: 'mine', resource: 'stone', count: 3 }, outcome: 'failed', inventory: [], health: 20, food: 20 }, persona: { name: '歌' }, lastSpeech: '前一句', signal: new AbortController().signal };
    const result = await generateCommentary({ ...input, fetchImpl: async (url, options) => { calls.push({ role: 'vision', body: JSON.parse(options.body), signal: options.signal }); return reply('前方可见树木和草地。', 'qwen3.5-4b'); }, cloudFetch: async (url, options) => { calls.push({ role: 'speech', body: JSON.parse(options.body), signal: options.signal }); return reply('这块石头还真不肯给我面子，我得按原计划继续找找。', 'deepseek-flash'); } });
    assert.equal(result.provider, 'cloud'); assert.equal(result.model, 'deepseek-flash'); assert.equal(result.visionModel, 'qwen3.5-4b');
    assert.equal(calls[0].body.max_tokens, 60); assert.equal(calls[0].body.task, 'minecraft-visual-observation'); assert.equal(calls[0].body.image_base64, input.imageBase64);
    assert.equal(calls[1].body.max_tokens, 90); assert.equal(calls[1].body.thinking.type, 'disabled'); assert.equal(calls[1].body.image_base64, undefined);
    const evidence = JSON.parse(calls[1].body.messages[1].content); assert.equal(evidence.outcome, 'failed'); assert.equal(evidence.currentSubgoal, '寻找可达石头'); assert.deepEqual(evidence.inventory, []); assert.equal(evidence.visualObservation, '前方可见树木和草地。');
    assert.ok(calls.every(call => call.signal === input.signal));
    let fallbackCalls = 0;
    await assert.rejects(generateCommentary({ ...input, fetchImpl: async () => { fallbackCalls++; return reply('树木。', 'qwen3.5-4b'); }, cloudFetch: async () => new Response('balance unavailable', { status: 402 }) }), /Cloud commentary HTTP 402/);
    assert.equal(fallbackCalls, 1, 'a cloud failure must not silently generate local success');
    const cancelled = new AbortController();
    await assert.rejects(generateCommentary({ ...input, signal: cancelled.signal, fetchImpl: async () => { cancelled.abort(); return reply('树木。', 'qwen3.5-4b'); }, cloudFetch: async () => { throw Error('cloud must not start after cancellation'); } }), /abort/i);
    process.env.MINECRAFT_CHAT_PROVIDER = 'local';
    const local = await generateCommentary({ ...input, fetchImpl: async (url, options) => { const body = JSON.parse(options.body); assert.equal(body.task, 'minecraft-commentary'); assert.equal(body.max_tokens, 120); return reply('我还在找能挖到的石头，树倒是比石头热情。', 'qwen3.5-4b'); }, cloudFetch: async () => { throw Error('cloud forbidden in local mode'); } });
    assert.equal(local.provider, 'local');
    console.log('minecraft-commentary-routing: vision/cloud separation, grounded plan, cancellation and explicit failure passed');
  } finally {
    for (const [name, value] of [['MINECRAFT_CHAT_PROVIDER', saved.provider], ['OPENAI_API_KEY', saved.key]]) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
