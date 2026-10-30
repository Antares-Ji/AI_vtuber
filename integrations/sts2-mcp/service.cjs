'use strict';
require('../../src/config/env').loadEnv();
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { Agent, Bridge, settings } = require('./agent.cjs');
const { doctor } = require('./cli.cjs');
const { StreamerSync, liveContext } = require('./streamer.cjs');

function createService({ agent = new Agent(), env = process.env } = {}) {
  let task = null;
  const streamer = new StreamerSync();
  const learning = require('../../src/sts2/learning-commentary').createLearningCommentary(streamer, settings, env);
  const send = (res, code, body) => {
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  const server = http.createServer(async (req, res) => {
    try {
      // Local control only; reject cross-site requests and DNS rebinding.
      const port = server.address()?.port;
      const hosts = [`127.0.0.1:${port}`, `localhost:${port}`];
      if (!hosts.includes(req.headers.host) || (req.headers.origin && !hosts.some(h => req.headers.origin === `http://${h}`))) return send(res, 403, { error: 'Local requests only' });
      const url = new URL(req.url, 'http://127.0.0.1');
      if (req.method === 'GET' && url.pathname === '/') {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self'" });
        return res.end(fs.readFileSync(path.join(__dirname, 'panel.html')));
      }
      if (req.method === 'GET' && url.pathname === '/api/status') {
        let config; try { const c = settings(env); config = { model: c.model, keyConfigured: true, keySource: c.keySource }; } catch (error) { config = { keyConfigured: false, error: error.message }; }
        return send(res, 200, { ...agent.snapshot(), ...config, streamer: streamer.snapshot(), learning: learning.snapshot() });
      }
      if (req.method === 'GET' && url.pathname === '/api/streamer/status') return send(res, 200, streamer.snapshot());
      if (req.method === 'GET' && url.pathname === '/api/streamer/context') {
        const response = await fetch(`http://127.0.0.1:${Number(env.STS2_GAME_PORT || 15526)}/api/v1/singleplayer`, { signal: AbortSignal.timeout(4000) });
        if (!response.ok) throw Error('Game state unavailable');
        return send(res, 200, liveContext(await response.json(), agent.snapshot(), Date.now(), streamer.snapshot()));
      }
      if (req.method === 'GET' && url.pathname === '/api/state') {
        const bridge = new Bridge(env);
        try { await bridge.connect(); return send(res, 200, await bridge.observe()); }
        finally { await bridge.close(); }
      }
      if (req.method === 'POST') {
        if (!(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'application/json required' });
        let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 8192) return send(res, 413, { error: 'Request too large' }); }
        const data = JSON.parse(body || '{}');
        if (url.pathname === '/api/stop') { agent.stop(); streamer.cancel(); return send(res, 200, { stopping: true }); }
        if (url.pathname === '/api/streamer/config') {
          if (typeof data.enabled !== 'boolean') return send(res, 400, { error: 'enabled must be boolean' });
          return send(res, 200, streamer.configure(data.enabled));
        }
        if (url.pathname === '/api/streamer/learning') {
          if (typeof data.enabled !== 'boolean') return send(res, 400, { error: 'enabled must be boolean' });
          return send(res, 200, learning.configure(data.enabled));
        }
        if (url.pathname === '/api/streamer/next') return send(res, 200, { entry: streamer.take() });
        if (url.pathname === '/api/streamer/receipt') return send(res, 200, { accepted: streamer.receipt(data.id, data.phase) });
        if (url.pathname === '/api/probe') return send(res, 200, await doctor({ probe: true }));
        if (url.pathname === '/api/start') {
          if (agent.snapshot().running || task) return send(res, 409, { error: 'Agent already running' });
          if (data.steps !== undefined && (!Number.isInteger(data.steps) || data.steps < 1 || data.steps > 500)) return send(res, 400, { error: 'steps must be 1..500' });
          if (data.goal !== undefined && (typeof data.goal !== 'string' || data.goal.length > 1000)) return send(res, 400, { error: 'Invalid goal' });
          task = agent.run({ steps: data.steps ?? 100, goal: data.goal, execute: data.execute !== false,
            narrate: streamer.enabled, beforeAction: (decision, state, signal) => streamer.beforeAction(decision, state, signal) })
            .catch(error => console.error(`STS2: ${error.message}`)).finally(() => { streamer.cancel(); task = null; });
          return send(res, 202, agent.snapshot());
        }
      }
      send(res, 404, { error: 'Not found' });
    } catch (error) { send(res, 502, { error: error.message }); }
  });
  return { server, agent, async close() { learning.close(); agent.stop(); await task; await new Promise(resolve => server.close(resolve)); } };
}
if (require.main === module) {
  const service = createService();
  const port = Number(process.env.STS2_CONTROL_PORT || 15527);
  service.server.listen(port, '127.0.0.1', () => console.log(`STS2 DeepSeek panel: http://127.0.0.1:${port}`));
  service.server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  const shutdown = () => service.close().then(() => process.exit(0));
  process.once('SIGINT', shutdown); process.once('SIGTERM', shutdown);
}
module.exports = { createService };
