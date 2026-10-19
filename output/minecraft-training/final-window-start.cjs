'use strict';
// Starts the selected local-model experiment; never selects a game skill.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { controlRequest } = require('../../src/minecraft/autonomy-loop');
(async () => {
  const selection = JSON.parse(fs.readFileSync(path.join(__dirname, 'final-window-selection.json'), 'utf8').replace(/^\uFEFF/, ''));
  const deadline = Date.parse('2026-10-12T23:17:01Z');
  if (Date.now() >= deadline) throw new Error('Five-hour authorization expired');
  const observation = await controlRequest('/observe');
  const health = await (await fetch('http://127.0.0.1:11435/health', { signal: AbortSignal.timeout(5000) })).json();
  const adapter = health.adapter_path || health.adapter;
  if (!health.adapter_loaded || !adapter || path.resolve(adapter) !== path.resolve(selection.adapter)) throw new Error('Unexpected loaded adapter');
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(selection.adapter, 'adapter_model.safetensors'))).digest('hex');
  if (sha256 !== selection.weightsSha256) throw new Error('Selected weight hash mismatch');
  if (!observation.connected || !observation.reactive?.enabled) throw new Error('Bot or safety unavailable');
  const response = await fetch('http://127.0.0.1:3000/api/minecraft/loop', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }), signal: AbortSignal.timeout(15000)
  });
  const loop = await response.json();
  if (!response.ok || !loop.enabled) throw new Error('Model loop did not start');
  const record = { at: new Date().toISOString(), trialStopAt: new Date(deadline).toISOString(), selection, historyResetByMainRestart: false, observation, health, loop };
  fs.writeFileSync(path.join(__dirname, 'final-window-start.json'), JSON.stringify(record, null, 2));
  console.log(JSON.stringify({ at: record.at, trialStopAt: record.trialStopAt, life: observation.reactive.lifecycleEpoch, health: observation.health, food: observation.food, inventory: observation.inventory, enabled: loop.enabled }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
