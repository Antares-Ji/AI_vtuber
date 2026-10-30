'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createSkillRoutes } = require('../src/api/skills');
const { createSkillHost } = require('../src/skills');
test('HTTP skill discovery, invocation, result and local-origin boundary', async () => {
  const host = createSkillHost({ directory: null });
  const route = createSkillRoutes({ host,
    parseBody: async req => { let text = ''; for await (const b of req) text += b; return JSON.parse(text); },
    send: (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); } });
  const server = http.createServer((req, res) => route(req, res, new URL(req.url, 'http://localhost')));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const list = await (await fetch(base + '/api/skills')).json();
    assert(list.skills.some(s => s.id === 'sts2:learn'));
    const forbidden = await fetch(base + '/api/skills', { headers: { origin: 'https://example.com' } });
    assert.equal(forbidden.status, 403);
    const rejected = await fetch(base + '/api/skills/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skill: 'sts2:play' }) });
    assert.equal(rejected.status, 400);
    const accepted = await fetch(base + '/api/skills/run', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ skill: 'genshin:demo' }) });
    assert.equal(accepted.status, 202); const job = await accepted.json(); await host.wait(job.id);
    const result = await (await fetch(base + `/api/skills/runs/${job.id}`)).json();
    assert.equal(result.state, 'SIMULATED');
    assert.equal((await fetch(base + '/api/skills/runs/00000000-0000-0000-0000-000000000000')).status, 404);
  } finally { await host.close(); await new Promise(r => server.close(r)); }
});
