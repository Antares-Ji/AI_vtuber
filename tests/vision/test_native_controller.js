// Read-only integration checks against the running local native controller.
// Every POST deliberately fails validation before focus/input/capture occurs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '../..');
const token = fs.readFileSync(path.join(root, 'runtime/vlm/controller/token.txt'), 'utf8').trim();
const origin = 'http://127.0.0.1:17644';
async function post(route, body) {
  const response = await fetch(origin + route, {
    method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body), signal: AbortSignal.timeout(5000),
  });
  assert.equal(response.status, 400);
  assert.equal((await response.json()).ok, false);
}
(async () => {
  assert.equal((await fetch(origin + '/status')).status, 403);
  const frame = path.join(root, 'runtime/vlm/controller/native-live.png');
  const modified = fs.statSync(frame).mtimeMs;
  await post('/click', { xRatio: 2, yRatio: .5 });
  await post('/click', { xRatio: null, yRatio: .5 });
  await post('/drag', { startXRatio: .5, startYRatio: .5, endXRatio: .7, endYRatio: -.1 });
  await post('/capture', { profile: 'unsupported' });
  await post('/deploy-local', { stage: 'unreviewed-stage' });
  assert.equal(fs.statSync(frame).mtimeMs, modified);
  console.log('6 native-controller auth/validation checks passed; no input or capture emitted.');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
