'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StreamerBrain } = require('../src/brain');

(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-chat-'));
  const brain = new StreamerBrain({ memoryOptions: { databasePath: path.join(dir, 'memory.db'), legacyPath: path.join(dir, 'missing.json') }, storyOptions: { filePath: path.join(dir, 'story.json') }, runtimeOptions: { filePath: null } });
  const savedFetch = global.fetch, savedProvider = process.env.MINECRAFT_CHAT_PROVIDER;
  let calls = 0;
  process.env.MINECRAFT_CHAT_PROVIDER = 'local';
  const response = '目标是制作铁镐，但目前血量很低，需要先解决生存问题。';
  brain.liveGameContextProvider = () => ({ capturedAt: Date.now(), goal: '制作铁镐', phase: '规划中', health: 1, food: 17, inventory: {} });
  global.fetch = async (_, options) => {
    calls++;
    assert(JSON.parse(options.body).messages.some(message => message.content.includes('制作铁镐')));
    return { ok: true, json: async () => ({ choices: [{ message: { content: response } }] }) };
  };
  try {
    for (let i = 0; i < 2; i++) {
      const result = await brain.reply({ user: '测试观众', text: '游戏目标是什么，现在卡在哪里？', type: 'chat' });
      assert.equal(result.text, response, 'Repeated factual game answers must not become generic fallback');
      assert.equal(result.llm.lastMode, 'local');
    }
    assert.equal(calls, 2);
    console.log('PASS repeated live game facts remain model answers; no unrelated anti-repetition fallback');
  } finally {
    global.fetch = savedFetch;
    if (savedProvider === undefined) delete process.env.MINECRAFT_CHAT_PROVIDER; else process.env.MINECRAFT_CHAT_PROVIDER = savedProvider;
    brain.memoryStore.db.close();
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
