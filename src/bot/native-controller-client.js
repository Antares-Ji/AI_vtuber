const fs = require('node:fs');
const path = require('node:path');

async function ensureNativeController(root, token) {
  const headers = { Authorization: `Bearer ${token}` };
  async function status() {
    let response;
    try {
      response = await fetch('http://127.0.0.1:17644/status', { headers, signal: AbortSignal.timeout(3000) });
    } catch (error) {
      if (error.cause?.code === 'ECONNREFUSED') return null;
      throw error;
    }
    const result = await response.json();
    if (!response.ok || !result.ok || !result.persistent) throw Error('Unexpected native controller status');
    return result;
  }
  const ready = await status();
  if (ready) return ready;
  const marker = path.join(root, 'runtime/vlm/controller/start-native-worker.request.json');
  fs.writeFileSync(marker + '.tmp', JSON.stringify({ port: 17644 }));
  fs.renameSync(marker + '.tmp', marker);
  const legacy = await fetch('http://127.0.0.1:17643/status', { headers, signal: AbortSignal.timeout(35000) });
  if (!legacy.ok || !(await legacy.json()).ok) throw Error('Existing authorized controller could not start native worker');
  const until = performance.now() + 10000;
  while (performance.now() < until) {
    const result = await status();
    if (result) return result;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  throw Error('Native controller did not become ready');
}
module.exports = { ensureNativeController };
