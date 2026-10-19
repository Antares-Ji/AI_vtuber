'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { McpServer } = require('@modelcontextprotocol/server');
const { StdioServerTransport } = require('@modelcontextprotocol/server/stdio');
const { z } = require('zod');
const { expanded } = require('../../src/minecraft/capability-policy');
const { SURVIVAL_ACTION_SCHEMA, validateAction } = require('../../src/minecraft/survival-skills');

function createServer() {
  const server = new McpServer({ name: 'suige-minecraft', version: '0.1.0' });
  const observations = new Map();
  const tasks = new Map();
  async function control(route, body, signal, expectedSession) {
    const config = JSON.parse(fs.readFileSync(process.env.MC_CONTROL_FILE || path.resolve(__dirname, '../../logs/minecraft-control.json'), 'utf8'));
    if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.token !== 'string') throw new Error('Invalid local control configuration');
    if (expectedSession && expectedSession !== config.token) throw new Error('Bot control session changed');
    const response = await fetch(`http://127.0.0.1:${config.port}${route}`, {
      method: body === undefined ? 'GET' : 'POST',
      headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(5000)]) : AbortSignal.timeout(5000)
    });
    const value = await response.json();
    if (!response.ok) throw new Error(value.error || `Control HTTP ${response.status}`);
    return { value, session: config.token };
  }
  const register = (name, description, shape, handler, readOnly = true) => server.registerTool(name, {
    description, inputSchema: z.strictObject(shape),
    annotations: { readOnlyHint: readOnly, destructiveHint: !readOnly, openWorldHint: false }
  }, async (args, ctx) => {
    try {
      const value = await handler(args, ctx.signal);
      return { content: [{ type: 'text', text: JSON.stringify(value) }] };
    } catch (error) {
      return { isError: true, content: [{ type: 'text', text: error.message }] };
    }
  });
  register('minecraft_observe', 'Observe the connected bot. Returns a short-lived observation ID required for actions.', {}, async (_, signal) => {
    const { value, session } = await control('/observe', undefined, signal);
    const observationId = randomUUID();
    observations.set(observationId, { value, session, at: Date.now() });
    while (observations.size > 32) observations.delete(observations.keys().next().value);
    return { observationId, observedAt: new Date().toISOString(), state: value };
  });
  register('minecraft_action_schema', 'List exact supported survival actions; no raw commands or teleport.', {}, async () => SURVIVAL_ACTION_SCHEMA);
  register('minecraft_execute', 'Submit one action from the local model. Acceptance is not completion. Query minecraft_task for evidence.', {
    observationId: z.string().uuid(), action: z.fromJSONSchema(SURVIVAL_ACTION_SCHEMA)
  }, async ({ observationId, action }, signal) => {
    validateAction(action);
    const snapshot = observations.get(observationId);
    observations.delete(observationId);
    if (!snapshot || Date.now() - snapshot.at > 10000) throw new Error('Observation expired; observe and replan');
    const { value: current } = await control('/observe', undefined, signal, snapshot.session);
    if (!current.connected || current.busy || (current.health <= 0 && action.action !== 'respawn') || (!expanded && current.reactive?.mode && current.reactive.mode !== 'idle')) throw new Error('Bot unavailable, busy, or safety reflex active');
    if (current.sessionId !== snapshot.value.sessionId || current.health < snapshot.value.health || current.dimension !== snapshot.value.dimension) throw new Error('World state changed; observe and replan');
    if (current.reactive?.lifecycleEpoch !== snapshot.value.reactive?.lifecycleEpoch) throw new Error('Bot life changed; observe and replan');
    if (current.position && snapshot.value.position && Math.hypot(...['x', 'y', 'z'].map(k => current.position[k] - snapshot.value.position[k])) > 2) throw new Error('Bot moved; observe and replan');
    if (JSON.stringify(current.inventory) !== JSON.stringify(snapshot.value.inventory)) throw new Error('Inventory changed; observe and replan');
    const taskId = randomUUID();
    tasks.set(taskId, snapshot.session);
    while (tasks.size > 100) tasks.delete(tasks.keys().next().value);
    // Keep the ID even after an uncertain HTTP result so only this task can be cancelled.
    try {
      const { value } = await control('/skill', { taskId, action }, signal, snapshot.session);
      return { ...value, completed: false };
    } catch (error) {
      await control('/cancel-task', { taskId }, undefined, snapshot.session).catch(() => {});
      throw new Error(`Dispatch unconfirmed for task ${taskId}: ${error.message}`);
    }
  }, false);
  const ownedTask = id => { const session = tasks.get(id); if (!session) throw new Error('Task is not owned by this MCP session'); return session; };
  register('minecraft_defend', 'Enable the existing local safety reflex without selecting a game objective.', {}, async (_, signal) => (await control('/command', { command: 'defend' }, signal)).value, false);
  register('minecraft_task', 'Read actual task result, including partial progress and failures.', { taskId: z.string().uuid() }, async ({ taskId }, signal) => (await control(`/task?id=${encodeURIComponent(taskId)}`, undefined, signal, ownedTask(taskId))).value);
  register('minecraft_cancel', 'Cancel this MCP session task while retaining bot connection and safety.', { taskId: z.string().uuid() }, async ({ taskId }, signal) => (await control('/cancel-task', { taskId }, signal, ownedTask(taskId))).value, false);
  return server;
}
if (require.main === module) createServer().connect(new StdioServerTransport()).catch(error => { console.error(error.message); process.exitCode = 1; });
module.exports = { createServer };
