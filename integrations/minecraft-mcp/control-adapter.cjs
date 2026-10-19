'use strict';
const path = require('node:path');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');
function createMcpControl() {
  let client, pending, observation;
  const tasks = new Map();
  async function connect() {
    if (client) return client;
    if (!pending) pending = (async () => {
      const next = new Client({ name: 'suige-local-qwen', version: '0.1.0' });
      next.onclose = () => { if (client === next) client = undefined; observation = undefined; };
      try { await next.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, 'server.cjs')], env: { ...process.env } })); }
      catch (error) { await next.close().catch(() => {}); throw error; }
      client = next; return next;
    })().finally(() => { pending = undefined; });
    return pending;
  }
  async function call(name, args, signal) {
    signal?.throwIfAborted();
    const current = await connect();
    const result = await current.callTool({ name, arguments: args }, undefined, { signal, timeout: 15000 });
    const text = result.content?.filter(c => c.type === 'text').map(c => c.text).join('\n');
    if (result.isError) throw new Error(text);
    return JSON.parse(text);
  }
  async function request(route, payload, signal) {
    if (route === '/observe') { observation = await call('minecraft_observe', {}, signal); return observation.state; }
    if (route === '/command' && payload.command === 'defend') return call('minecraft_defend', {}, signal);
    if (route === '/skill') {
      if (!observation) throw new Error('MCP observation required');
      const accepted = await call('minecraft_execute', { observationId: observation.observationId, action: payload.action }, signal);
      tasks.set(payload.taskId, accepted.taskId); observation = undefined;
      while (tasks.size > 100) tasks.delete(tasks.keys().next().value);
      return { ...accepted, taskId: payload.taskId, mcpTaskId: accepted.taskId };
    }
    const id = route === '/cancel-task' ? payload.taskId : new URL(route, 'http://localhost').searchParams.get('id');
    const mcpTaskId = tasks.get(id);
    if (!mcpTaskId) throw new Error('Unknown MCP task mapping');
    if (route === '/cancel-task') return call('minecraft_cancel', { taskId: mcpTaskId }, signal);
    if (route.startsWith('/task?')) return { ...await call('minecraft_task', { taskId: mcpTaskId }, signal), taskId: id, mcpTaskId };
    throw new Error('Unsupported MCP route');
  }
  return { request, close: async () => { if (pending) await pending.catch(() => {}); await client?.close(); client = undefined; } };
}
module.exports = { createMcpControl };
