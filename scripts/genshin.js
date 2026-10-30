'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { GenshinRuntime } = require('../src/genshin/runtime');
const { MockAdapter, BetterGiAdapter } = require('../src/genshin/adapters');
const { planGoal } = require('../src/genshin/planner');
const { createServer } = require('../src/genshin/server');

async function main() {
  const command = process.argv[2] || 'serve';
  const root = path.resolve(__dirname, '../runtime/genshin');
  if (!['serve', 'demo', 'doctor'].includes(command)) throw new Error('用法：node scripts/genshin.js serve|demo|doctor');
  if (command === 'doctor') {
    console.log(JSON.stringify({ node: process.version, bettergi: new BetterGiAdapter().status(),
      phase: 'framework-only', liveEnabled: false }, null, 2)); return;
  }
  fs.mkdirSync(root, { recursive: true });
  const mode = process.env.GENSHIN_ADAPTER || 'mock';
  if (!['mock', 'bettergi'].includes(mode)) throw new Error('GENSHIN_ADAPTER 只能是 mock 或 bettergi');
  const runtime = new GenshinRuntime({ adapter: mode === 'mock' ? new MockAdapter() : new BetterGiAdapter(),
    logFile: path.join(root, 'events.jsonl') });
  if (command === 'demo') {
    const plan = await planGoal('观察当前场景并钓鱼', { mode: 'rules' });
    runtime.start(plan);
    await runtime.done;
    console.log(JSON.stringify({ state: runtime.status(), streamerContext: runtime.context() }, null, 2));
    if (runtime.job.state !== 'simulated') process.exitCode = 1;
    return;
  }
  const plannerMode = process.env.GENSHIN_PLANNER || 'llm';
  if (!['rules', 'llm'].includes(plannerMode)) throw new Error('GENSHIN_PLANNER 只能是 rules 或 llm');
  const tokenPath = path.join(root, 'service-token.txt');
  const token = randomBytes(32).toString('hex');
  const port = Number(process.env.GENSHIN_PORT || 17650);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('端口无效');
  const server = createServer({ runtime, token, plannerMode });
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    fs.writeFileSync(tokenPath, token, { mode: 0o600 });
    console.log(`原神框架：http://127.0.0.1:${port} | ${mode} | planner=${plannerMode}\n令牌文件：${tokenPath}\n当前版本不执行真实游戏操作。`);
  });
  const shutdown = () => { runtime.stop(); server.close(); server.closeIdleConnections(); };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
