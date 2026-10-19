'use strict';
const path = require('node:path');
const { appendFileSync, mkdirSync } = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
const { planSurvival } = require('../../src/minecraft/survival-planner');

async function run({ steps = 1, goal = '安全观察周围环境', execute = false } = {}) {
  if (!Number.isInteger(steps) || steps < 1 || steps > 100) throw new Error('steps must be 1..100');
  const client = new Client({ name: 'local-qwen-minecraft-host', version: '0.1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, 'server.cjs')], env: { ...process.env } });
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  const history = [];
  let activeTask;
  const logDir = path.resolve(__dirname, '../../logs'); mkdirSync(logDir, { recursive: true });
  const log = value => appendFileSync(path.join(logDir, 'minecraft-mcp-qwen.jsonl'), JSON.stringify({ at: new Date().toISOString(), ...value }) + '\n');
  const call = async (name, args = {}) => {
    const result = await client.callTool({ name, arguments: args });
    const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
  };
  try {
    await client.connect(transport);
    for (let i = 0; i < steps; i++) {
      abort.signal.throwIfAborted();
      const observation = await call('minecraft_observe');
      if (!observation.state.connected) throw new Error('Minecraft bot is disconnected');
      if (observation.state.busy) throw new Error('Another game task is active');
      let metadata;
      const action = await planSurvival(observation.state, { goal, history, signal: abort.signal, onMetadata: value => { metadata = value; } });
      log({ event: 'local_model_decision', observationId: observation.observationId, action, metadata, execute });
      if (!execute) { console.log(JSON.stringify({ action, metadata, executed: false })); continue; }
      abort.signal.throwIfAborted();
      const accepted = await call('minecraft_execute', { observationId: observation.observationId, action });
      activeTask = accepted.taskId;
      const deadline = Date.now() + 130000;
      while (true) {
        abort.signal.throwIfAborted();
        const result = await call('minecraft_task', { taskId: activeTask });
        if (result.status !== 'running') {
          history.push({ action, ...result }); log({ event: 'game_result', ...result });
          console.log(JSON.stringify(result)); activeTask = undefined; break;
        }
        if (Date.now() >= deadline) throw new Error('Task deadline exceeded');
        await delay(500, undefined, { signal: abort.signal });
      }
    }
  } finally {
    if (activeTask) await call('minecraft_cancel', { taskId: activeTask }).catch(error => console.error(`Cancellation unconfirmed: ${error.message}`));
    await client.close(); process.removeListener('SIGINT', stop); process.removeListener('SIGTERM', stop);
  }
}
if (require.main === module) {
  const args = process.argv.slice(2);
  const option = (name, fallback) => { const i = args.indexOf(name); return i < 0 ? fallback : args[i + 1]; };
  run({ steps: Number(option('--steps', 1)), goal: option('--goal', '安全观察周围环境'), execute: args.includes('--execute') }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { run };
