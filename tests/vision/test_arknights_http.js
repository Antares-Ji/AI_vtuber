const assert = require('node:assert/strict');
async function post(body) {
  const response = await fetch('http://127.0.0.1:3000/api/vision/arknights', {
    method: 'POST', headers: { 'content-type': 'image/png' }, body,
    signal: AbortSignal.timeout(25000)
  });
  const result = await response.json();
  assert.equal(typeof result.error, 'string');
  assert.doesNotMatch(result.error, /[A-Z]:\\|Traceback|at .+\.js/);
  return response.status;
}
(async () => {
  assert.equal(await post(Buffer.from('not an image at all')), 400);
  const fakePng = Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), Buffer.alloc(64)]);
  assert.equal(await post(fakePng), 422, 'decoder must reject invalid payload despite valid magic');
  assert.equal(await post(fakePng), 422, 'failure must release single-flight slot');
  assert.equal(await post(Buffer.alloc(0)), 400);
  console.log('Arknights live HTTP: invalid magic, invalid encoded image, recovery and sanitized errors passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
