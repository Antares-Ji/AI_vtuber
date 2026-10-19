'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { controlRequest } = require('../../src/minecraft/autonomy-loop');
(async () => {
  if (Date.now() >= Date.parse('2026-10-12T23:17:01Z')) throw new Error('Authorization expired');
  const observation = await controlRequest('/observe');
  if (!observation.connected || !observation.reactive?.enabled) throw new Error('Safety unavailable');
  fs.writeFileSync(path.join(__dirname, `final-window-resume-observation-${Date.now()}.json`), JSON.stringify({ at: new Date().toISOString(), observation }, null, 2));
  const response = await fetch('http://127.0.0.1:3000/api/minecraft/loop', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }), signal: AbortSignal.timeout(15000)
  });
  const loop = await response.json();
  if (!response.ok || !loop.enabled) throw new Error('Resume failed');
  const record = { at: new Date().toISOString(), reason: 'Resume same v4 window after execution-layer maintenance; model and policy unchanged', life: observation.reactive.lifecycleEpoch, loop };
  fs.appendFileSync(path.join(__dirname, 'final-window-maintenance.jsonl'), JSON.stringify(record) + '\n');
  console.log(JSON.stringify({ at: record.at, enabled: loop.enabled, running: loop.running, life: record.life }));
})().catch(error => { console.error(error.message); process.exitCode = 1; });
