'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AutonomyLoop } = require('../src/minecraft/autonomy-loop');
(async () => {
  let epoch = 1, sessionId = 'first';
  const histories = [], logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-life-'));
  const loop = new AutonomyLoop({ logDir, planner: async (_, options) => {
    histories.push(options.history.slice()); return { action: 'observe' };
  }, request: async route => route === '/observe' ? {
    connected: true, sessionId, dimension: 'overworld', health: 20, food: 20,
    inventory: [], reactive: { lifecycleEpoch: epoch, enabled: true, mode: 'idle' }
  } : route.startsWith('/task') ? { status: 'completed', result: { verified: true } } : {} });
  loop.modelHealth = async () => {};
  const run = () => loop.runOnce('生存', new AbortController().signal);
  await run(); await run(); assert.equal(histories[1].length, 1, 'same-life feedback retained');
  epoch++; await run(); assert.equal(histories[2].length, 0, 'respawn does not reuse old-life inventory/task history');
  await run(); assert.equal(histories[3].length, 1);
  sessionId = 'reconnected'; await run(); assert.equal(histories[4].length, 0, 'new connection isolates previous task history');
  const events = fs.readFileSync(path.join(logDir, 'minecraft-autonomy.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(events.filter(e => e.event === 'model_history_boundary').length, 2);
  assert.equal(events.filter(e => e.event === 'model_action_result').length, 5, 'audit history remains intact');
  console.log('Life memory checks passed: same-life results retained, respawn/session boundaries isolate prompts, audit evidence preserved.');
})().catch(error => { console.error(error); process.exitCode = 1; });
