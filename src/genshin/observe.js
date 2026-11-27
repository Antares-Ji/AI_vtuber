'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { processRun } = require('../skills/process');
const TARGETS = ['YuanShen.exe', 'GenshinImpact.exe'];

function validateCapture(receipt, { root, nonce, target, startedAt, now = Date.now() }) {
  const image = path.join(root, 'runtime/genshin/observations', nonce, 'frame.png');
  if (!receipt || receipt.nonce !== nonce || receipt.target !== target || receipt.inputSent !== false ||
      receipt.source !== 'project_native_capture' || !Number.isInteger(receipt.pid) || receipt.pid < 1 ||
      !Number.isSafeInteger(receipt.capturedAt) || receipt.capturedAt < startedAt || receipt.capturedAt > now ||
      now - receipt.capturedAt > 30000 || receipt.image !== image || !/^[a-f0-9]{64}$/.test(receipt.sha256)) {
    throw Error('Genshin capture receipt does not match this request');
  }
  const base = fs.realpathSync(path.join(root, 'runtime/genshin/observations'));
  if (fs.realpathSync(image) !== path.join(base, nonce, 'frame.png')) throw Error('Genshin frame escaped evidence directory');
  const stat = fs.statSync(image);
  if (!stat.isFile() || stat.size < 24 || stat.size > 20 * 1024 * 1024) throw Error('Invalid Genshin frame size');
  const bytes = fs.readFileSync(image);
  if (!bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      createHash('sha256').update(bytes).digest('hex') !== receipt.sha256) throw Error('Genshin frame digest or format mismatch');
  return image;
}

function validateObservation(result, image) {
  const observation = result?.parsed;
  if (result?.source_image !== image || result?.mode !== 'genshin-scene' || result?.normalization_error ||
      result?.verification !== 'unverified_local_model_output' || typeof result?.model !== 'string' || !result.model ||
      !observation || Object.keys(observation).sort().join(',') !== 'scene,summary,uncertain,visible_text' ||
      !['login', 'loading', 'world', 'menu', 'dialog', 'map', 'combat', 'unknown'].includes(observation.scene) ||
      typeof observation.uncertain !== 'boolean' || (observation.scene === 'unknown' && !observation.uncertain) ||
      typeof observation.summary !== 'string' || observation.summary.length > 240 ||
      !Array.isArray(observation.visible_text) || observation.visible_text.length > 12 ||
      observation.visible_text.some(s => typeof s !== 'string' || !s.trim() || s.length > 160)) {
    throw Error('Local Genshin vision did not return a valid observation for this frame');
  }
  return observation;
}

async function boundedJson(response) {
  if (!response.ok) throw Error(`Local Genshin vision returned HTTP ${response.status}`);
  let size = 0; const chunks = [];
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > 1024 * 1024) throw Error('Local Genshin vision response exceeds limit');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

async function observe({ root, target = 'YuanShen.exe', signal, runProcess = processRun, fetchImpl = fetch }) {
  if (!TARGETS.includes(target)) throw Error('Unsupported Genshin executable');
  signal.throwIfAborted();
  const nonce = randomUUID(), startedAt = Date.now();
  const output = await runProcess(path.join(root, 'runtime/vlm-env/Scripts/python.exe'),
    [path.join(root, 'scripts/genshin/observe.py'), '--exe', target, '--nonce', nonce],
    { cwd: root, signal });
  signal.throwIfAborted();
  const receipt = JSON.parse(output.trim());
  const image = validateCapture(receipt, { root, nonce, target, startedAt });
  const response = await fetchImpl('http://127.0.0.1:17646/read', { method: 'POST', redirect: 'error',
    headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode: 'genshin-scene', image }),
    signal: AbortSignal.any([signal, AbortSignal.timeout(90000)]) });
  const vision = await boundedJson(response);
  signal.throwIfAborted();
  // Recheck file identity after inference; an old or replaced frame cannot become
  // evidence for the current request. Inference duration is not capture freshness.
  validateCapture(receipt, { root, nonce, target, startedAt, now: receipt.capturedAt });
  const observation = validateObservation(vision, image);
  const result = { capture: receipt, observation, model: vision.model, visionRecord: vision.record,
    source: 'native_capture_and_local_vision_api', inputSent: false, verified: false,
    verification: 'unverified_local_model_output', betterGiExecuted: false };
  fs.writeFileSync(path.join(path.dirname(image), 'observation.json'), JSON.stringify(result, null, 2));
  return result;
}
module.exports = { observe, validateCapture, validateObservation, TARGETS };
