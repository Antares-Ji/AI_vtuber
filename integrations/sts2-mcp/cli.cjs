'use strict';
require('../../src/config/env').loadEnv();
const { Bridge, Agent, settings, completion, allowedTools, decisionMessages } = require('./agent.cjs');

async function doctor({ probe = false } = {}) {
  const config = settings();
  const bridge = new Bridge();
  try {
    await bridge.connect();
    const state = await bridge.observe();
    const result = { connected: true, model: config.model, keySource: config.keySource, mcpToolCount: bridge.tools.length, state };
    if (probe) {
      const decision = await completion(decisionMessages(state, [], '只检查连接，调用get_game_state读取状态，不操作游戏'), allowedTools(bridge.tools, state, true), config);
      result.probe = { tool: decision.name, model: decision.model, usage: decision.usage, result: await bridge.call(decision.name, decision.args) };
    }
    return result;
  } finally { await bridge.close(); }
}

async function main() {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  if (args[0] === 'doctor') console.log(JSON.stringify(await doctor({ probe: args.includes('--probe') }), null, 2));
  else if (args[0] === 'play') {
    const agent = new Agent();
    const stop = () => agent.stop();
    process.once('SIGINT', stop); process.once('SIGTERM', stop);
    try {
      await agent.run({ steps: Number(option('--steps', 100)), goal: option('--goal', '完成当前单人冒险，合理规划并争取胜利'), execute: !args.includes('--dry-run'),
        onEvent: event => console.log(JSON.stringify(event)) });
    } finally { process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop); }
  } else throw Error('Usage: node cli.cjs doctor [--probe] | play [--steps 100] [--dry-run] [--goal text]');
}
if (require.main === module) main().catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { doctor };
