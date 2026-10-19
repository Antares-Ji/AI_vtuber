'use strict';
require('../src/config/env').loadEnv();
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { AutonomyLoop, controlRequest } = require('../src/minecraft/autonomy-loop');
const root = path.resolve(__dirname, '..');
const logDir = path.join(root, 'logs/minecraft-12h');
const stopFile = path.join(logDir, 'STOP');
const began = Date.now();
let loop, guard, checking = false;
const server = http.createServer(async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  if (req.method === 'GET' && req.url === '/status') return res.end(JSON.stringify(loop?.snapshot() || { starting: true }));
  if (req.method === 'POST' && req.url === '/suggest' && !req.headers.origin) {
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) throw new Error('Too large'); }
      loop.addAudienceSuggestion(JSON.parse(body).text);
      loop.prioritizeConversation(1);
      return res.end(JSON.stringify({ accepted: true }));
    } catch (error) { res.statusCode = 400; return res.end(JSON.stringify({ error: error.message })); }
  }
  if (req.method === 'POST' && req.url === '/stop' && !req.headers.origin) {
    await loop?.stop(); return res.end(JSON.stringify({ stopped: true }));
  }
  res.statusCode = 404; res.end('{}');
});
async function oldState() {
  const res = await fetch('http://127.0.0.1:3000/api/minecraft/loop', { signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error('Cannot verify original loop ownership');
  return res.json();
}
async function main() {
  // Exclusive local port prevents duplicate runners. Never stop the main service.
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(3003, '127.0.0.1', resolve); });
  const previous = await oldState();
  if (previous.enabled || previous.running) throw new Error('Original loop is active; refusing duplicate executor');
  if (fs.existsSync(stopFile)) throw new Error('STOP marker exists; operator action required');
  const observation = await controlRequest('/observe');
  if (!observation.connected) throw new Error('Minecraft is disconnected');
  fs.mkdirSync(logDir, { recursive: true });
  loop = new AutonomyLoop({ logDir });
  await loop.modelHealth(new AbortController().signal);
  if (process.argv.includes('--resume')) {
    const authorization = JSON.parse(fs.readFileSync(path.join(logDir, 'authorization.json')));
    if (Date.now() >= Date.parse(authorization.deadline)) throw new Error('Original authorization expired');
    const saved = JSON.parse(fs.readFileSync(path.join(logDir, 'minecraft-loop-state.json')));
    loop.state.deadline = authorization.deadline;
    loop.state.completionItem = saved.completionItem || 'crafting_table';
    loop.state.history = saved.history || [];
    loop.state.step = saved.step || 0;
    const feedbackPath = path.join(logDir, 'feedback.json');
    if (fs.existsSync(feedbackPath)) loop.addAudienceSuggestion(JSON.parse(fs.readFileSync(feedbackPath)).text);
    await loop.start({ goal: authorization.goal, continuous: true });
  } else {
    await loop.start({ goal: previous.goal, completionItem: previous.completionItem || 'crafting_table', durationMinutes: 720, continuous: true });
  }
  fs.writeFileSync(path.join(logDir, 'authorization.json'), JSON.stringify({ pid: process.pid, startedAt: new Date(began).toISOString(), deadline: loop.state.deadline, goal: loop.state.goal, executor: 'local-qwen', mode: 'game-practice-not-weight-training', statusUrl: 'http://127.0.0.1:3003/status' }, null, 2));
  console.log(JSON.stringify({ event: 'started', deadline: loop.state.deadline, pid: process.pid }));
  guard = setInterval(async () => {
    if (checking) return;
    checking = true;
    try {
      const original = await oldState();
      const log = path.join(root, 'logs/minecraft-autonomy.jsonl');
      let userStopped = false;
      if (fs.existsSync(log)) {
        const fd = fs.openSync(log, 'r');
        try { const size = fs.fstatSync(fd).size, n = Math.min(size, 65536), buf = Buffer.alloc(n); fs.readSync(fd, buf, 0, n, size - n);
          userStopped = buf.toString('utf8').split('\n').some(line => { try { const row = JSON.parse(line); return row.event === 'loop_stop_requested' && Date.parse(row.at) > began; } catch { return false; } });
        } finally { fs.closeSync(fd); }
      }
      if (original.enabled || original.running || userStopped || fs.existsSync(stopFile)) {
        loop.record('runner_stopped_by_operator_or_other_loop'); await loop.stop();
      }
    } catch (error) { loop.record('ownership_check_failed', { error: error.message }); await loop.stop(); }
    finally { checking = false; }
  }, 3000);
  await loop.pending;
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => { clearInterval(guard); server.close(); });
process.once('SIGINT', () => void loop?.stop());
process.once('SIGTERM', () => void loop?.stop());
