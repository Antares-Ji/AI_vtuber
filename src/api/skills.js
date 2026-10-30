'use strict';
const { localRequest } = require('./game-input');
const { createSkillHost } = require('../skills');

function createSkillRoutes({ parseBody, send, host = createSkillHost() }) {
  const handle = async (req, res, url) => {
    if (!url.pathname.startsWith('/api/skills')) return false;
    const reply = (code, body) => { send(res, code, body); return true; };
    if (!localRequest(req)) return reply(403, { error: 'Local skill host only' });
    try {
      if (req.method === 'GET' && url.pathname === '/api/skills') return reply(200, { skills: host.list() });
      if (req.method === 'GET' && url.pathname === '/api/skills/runs') return reply(200, { runs: host.recent() });
      const match = url.pathname.match(/^\/api\/skills\/runs\/([a-f0-9-]{36})(\/stop)?$/);
      if (match && req.method === 'GET' && !match[2]) return reply(host.status(match[1]) ? 200 : 404, host.status(match[1]) || { error: 'Unknown run' });
      if (req.method !== 'POST') return reply(404, { error: 'Unknown skill endpoint' });
      if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: 'JSON required' });
      if (match?.[2]) return reply(host.status(match[1]) ? 200 : 404, host.stop(match[1]) || { error: 'Unknown run' });
      if (url.pathname === '/api/skills/run') return reply(202, host.start(await parseBody(req)));
      return reply(404, { error: 'Unknown skill endpoint' });
    } catch (error) { return reply(/busy|already running/.test(error.message) ? 409 : 400, { error: error.message }); }
  };
  handle.host = host;
  return handle;
}
module.exports = { createSkillRoutes };
