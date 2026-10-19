'use strict';
// Experiment supervisor only. Never chooses or issues a Minecraft skill.
const fs = require('node:fs');
const path = require('node:path');
const { setTimeout: sleep } = require('node:timers/promises');
const { controlRequest } = require('../../src/minecraft/autonomy-loop');
const start = JSON.parse(fs.readFileSync(path.join(__dirname, 'final-window3-start.json'), 'utf8'));
const endAt = Date.parse(start.trialStopAt);
const baselineEpoch = start.observation.reactive.lifecycleEpoch;
const audit = path.join(__dirname, 'final-window3-watchdog.jsonl');
const record = row => fs.appendFileSync(audit, JSON.stringify({ at: new Date().toISOString(), ...row }) + '\n');
async function stop(reason, observation) {
  const response = await fetch('http://127.0.0.1:3000/api/minecraft/loop', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ enabled: false }), signal: AbortSignal.timeout(15000)
  });
  const loop = await response.json();
  if (!response.ok) throw new Error(`Stop HTTP ${response.status}`);
  record({ event: 'stop_requested', reason, observation, loop });
}
(async () => {
  if (!Number.isFinite(endAt) || !Number.isInteger(baselineEpoch)) throw new Error('Invalid experiment start artifact');
  record({ event: 'watch_started', baselineEpoch, endAt: new Date(endAt).toISOString(), pid: process.pid });
  while (true) {
    try {
      // The supervisor only needs life/health; avoid synchronous world scans.
      const observation = await controlRequest('/status');
      const reason = observation.health <= 0 || observation.reactive?.lifecycleEpoch !== baselineEpoch
        ? 'death_or_lifecycle_change' : Date.now() >= endAt ? 'five_hour_authorization_deadline' : null;
      if (reason) { await stop(reason, observation); return; }
      const response = await fetch('http://127.0.0.1:3000/api/minecraft/loop', { signal: AbortSignal.timeout(5000) });
      if (response.ok) {
        const loop = await response.json();
        if (!loop.enabled && !loop.running) { record({ event: 'loop_already_stopped' }); return; }
      }
    } catch (error) {
      record({ event: 'observation_or_stop_error', errorName: error.name });
      if (Date.now() >= endAt) {
        // One independent stop attempt even when the Minecraft observation failed.
        try { await stop('trial_deadline_observation_unavailable', null); return; } catch {}
      }
    }
    await sleep(2000);
  }
})().catch(error => { record({ event: 'watch_failed', errorName: error.name }); process.exitCode = 1; });
