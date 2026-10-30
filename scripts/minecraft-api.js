'use strict';
require('../src/config/env').loadEnv();

// Use the same selected API engine and task ownership as the browser console.
const controller = new AbortController();
const stop = () => controller.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
(async () => {
  const response = await fetch(`http://127.0.0.1:${Number(process.env.PORT || 3000)}/api/minecraft/command`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ text: process.argv.slice(2).join(' ') }),
    signal: AbortSignal.any([controller.signal, AbortSignal.timeout(190000)])
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || `Minecraft HTTP ${response.status}`);
  console.log(JSON.stringify(result, null, 2));
})().catch(error => { console.error(error.message); process.exitCode = 1; })
  .finally(() => { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); });
