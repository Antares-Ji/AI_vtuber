const assert = require("node:assert/strict");
const { publicAsrStatus } = require("../../src/api/public-state");
const { getAsrStatus } = require("../../src/asr/provider");
(async () => {
  const ready = { backendReady: true, baseUrl: "http://localhost:10095/private?token=fake", backend: { streaming: { ready: true } } };
  assert.equal(publicAsrStatus(ready).streaming.endpoint, "ws://localhost:10095/stream");
  for (const status of [{}, { ...ready, backendReady: false }, { ...ready, backend: {} }, { ...ready, baseUrl: "http://user:pass@localhost:10095" }, { ...ready, baseUrl: "file:///private" }]) {
    assert.equal(publicAsrStatus(status).streaming.ready, false);
    assert.equal(publicAsrStatus(status).streaming.endpoint, null);
  }
  const original = global.fetch;
  try {
    for (const health of [{ ready: false }, {}, { ready: true }]) {
      global.fetch = async () => new Response(JSON.stringify(health));
      assert.equal((await getAsrStatus()).backendReady, health.ready === true);
    }
  } finally { global.fetch = original; }
  console.log("ASR public status passed: explicit readiness and sanitized streaming endpoint.");
})().catch(error => { console.error(error); process.exitCode = 1; });
