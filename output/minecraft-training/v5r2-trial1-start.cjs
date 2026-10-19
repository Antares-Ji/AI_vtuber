'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { controlRequest } = require('../../src/minecraft/autonomy-loop');
(async () => {
  const selection = JSON.parse(fs.readFileSync(path.join(__dirname, 'v5r2-experimental-selection.json'), 'utf8').replace(/^\uFEFF/, ''));
  const observation = await controlRequest('/observe');
  const health = await (await fetch('http://127.0.0.1:11435/health')).json();
  if (!health.adapter_loaded || path.resolve(health.adapter) !== path.resolve(selection.adapter)) throw new Error('Unexpected model');
  const response = await fetch('http://127.0.0.1:3000/api/minecraft/loop', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true })
  });
  const loop = await response.json();
  if (!response.ok) throw new Error('Loop start failed');
  const row = { at: new Date().toISOString(), trialStopAt: new Date(Date.now() + 20 * 60000).toISOString(),
    selection: 'v5r2-experimental-selection.json', historyResetByMainRestart: true, observation, health, loop };
  fs.writeFileSync(path.join(__dirname, 'v5r2-live-trial1-start.json'), JSON.stringify(row, null, 2));
  console.log(JSON.stringify({ at: row.at, trialStopAt: row.trialStopAt, epoch: observation.reactive?.lifecycleEpoch,
    health: observation.health, food: observation.food, inventory: observation.inventory, enabled: loop.enabled }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
