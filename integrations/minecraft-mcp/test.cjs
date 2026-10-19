'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { Client } = require('@modelcontextprotocol/client');
const { StdioClientTransport } = require('@modelcontextprotocol/client/stdio');

test('real MCP stdio: observations, validation, stale rejection, results and ownership', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-mcp-test-'));
  const state = { connected: true, busy: false, health: 20, inventory: [], dimension: 'overworld', sessionId: 'fixture', position: { x: 0, y: 64, z: 0 }, reactive: { mode: 'idle', lifecycleEpoch: 1 } };
  const tasks = new Map(); let submitted = 0, cancelled = 0;
  const control = http.createServer(async (req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.headers.authorization !== 'Bearer fixture-token') { res.writeHead(401); res.end('{}'); return; }
    let body = ''; for await (const chunk of req) body += chunk;
    const data = body ? JSON.parse(body) : {};
    if (req.url === '/observe') res.end(JSON.stringify(state));
    else if (req.url === '/skill') { submitted++; const result = { taskId: data.taskId, status: 'running' }; tasks.set(data.taskId, result); res.end(JSON.stringify(result)); }
    else if (req.url.startsWith('/task?')) res.end(JSON.stringify(tasks.get(new URL(req.url, 'http://localhost').searchParams.get('id'))));
    else if (req.url === '/cancel-task') { cancelled++; tasks.get(data.taskId).status = 'cancelled'; res.end('{"requested":true}'); }
    else { res.writeHead(404); res.end('{}'); }
  });
  await new Promise(resolve => control.listen(0, '127.0.0.1', resolve));
  const config = path.join(dir, 'control.json'); fs.writeFileSync(config, JSON.stringify({ port: control.address().port, token: 'fixture-token' }));
  const client = new Client({ name: 'integration-test', version: '1.0.0' });
  const call = (name, args = {}) => client.callTool({ name, arguments: args });
  const data = result => JSON.parse(result.content[0].text);
  try {
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [path.join(__dirname, 'server.cjs')], env: { ...process.env, MC_CONTROL_FILE: config } }));
    assert.equal((await client.listTools()).tools.length, 6);
    let snapshot = data(await call('minecraft_observe'));
    const invalid = await call('minecraft_execute', { observationId: snapshot.observationId, action: { action: 'give', item: 'diamond' } });
    assert.equal(invalid.isError, true); assert.equal(submitted, 0);
    state.health = 15;
    assert.equal((await call('minecraft_execute', { observationId: snapshot.observationId, action: { action: 'observe' } })).isError, true);
    assert.equal(submitted, 0);
    snapshot = data(await call('minecraft_observe'));
    state.reactive.lifecycleEpoch++;
    assert.equal((await call('minecraft_execute', { observationId: snapshot.observationId, action: { action: 'observe' } })).isError, true);
    snapshot = data(await call('minecraft_observe'));
    const accepted = data(await call('minecraft_execute', { observationId: snapshot.observationId, action: { action: 'gather_wood', count: 1 } }));
    assert.equal(accepted.completed, false); assert.equal(submitted, 1);
    assert.equal((await call('minecraft_execute', { observationId: snapshot.observationId, action: { action: 'observe' } })).isError, true);
    tasks.get(accepted.taskId).result = { complete: false, gained: 0 };
    assert.equal(data(await call('minecraft_task', { taskId: accepted.taskId })).result.complete, false);
    assert.equal((await call('minecraft_cancel', { taskId: randomUUID() })).isError, true);
    assert.equal(cancelled, 0);
    await call('minecraft_cancel', { taskId: accepted.taskId }); assert.equal(cancelled, 1);
    fs.writeFileSync(config, JSON.stringify({ port: control.address().port, token: 'new-session' }));
    assert.equal((await call('minecraft_task', { taskId: accepted.taskId })).isError, true);
  } finally { await client.close(); await new Promise(resolve => control.close(resolve)); fs.rmSync(dir, { recursive: true, force: true }); }
});
