'use strict';
const https = require('node:https');

// Use Node HTTPS on this Windows installation: undici's TLS connection resets.
// No DNS overrides, redirects, automatic POST retries, or disabled TLS checks.
function createDeepseekFetch(requestImpl = https.request) {
  return async (input, options = {}) => {
    const url = new URL(input);
    if (url.origin !== 'https://api.deepseek.com' || url.username || url.password) throw Error('STS2 requires the official DeepSeek API origin');
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      let incoming;
      const headers = Object.fromEntries(new Headers(options.headers));
      headers['accept-encoding'] = 'identity';
      const req = requestImpl(url, { method: options.method || 'GET', headers, rejectUnauthorized: true }, res => {
        incoming = res;
        const chunks = []; let bytes = 0;
        res.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) req.destroy(Error('DeepSeek response too large')); else chunks.push(chunk); });
        res.on('error', fail);
        res.on('end', () => {
          cleanup();
          resolve(new Response(Buffer.concat(chunks), { status: res.statusCode, headers: res.headers }));
        });
      });
      function cleanup() { options.signal?.removeEventListener('abort', abort); }
      function fail(error) { cleanup(); reject(error); }
      function abort() { const error = options.signal.reason || Error('Aborted'); incoming?.destroy(error); req.destroy(error); fail(error); }
      req.on('error', fail); req.setTimeout(45000, () => req.destroy(Error('DeepSeek request timed out')));
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) return abort();
      req.end(options.body);
    });
  };
}
module.exports = { createDeepseekFetch, deepseekFetch: createDeepseekFetch() };
