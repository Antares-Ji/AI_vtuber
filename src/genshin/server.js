'use strict';

const http = require('node:http');
const { SKILLS, planGoal } = require('./planner');

async function readJson(request) {
  let size = 0;
  const parts = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 16384) throw new Error('请求内容过长');
    parts.push(chunk);
  }
  const value = JSON.parse(Buffer.concat(parts).toString('utf8') || '{}');
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('需要 JSON 对象');
  return value;
}

function createServer({ runtime, token, planner = planGoal, plannerMode = 'rules' }) {
  if (typeof token !== 'string' || token.length < 24) throw new Error('需要至少24字符的服务令牌');
  const pending = new Set();
  const server = http.createServer(async (request, response) => {
    const reply = (status, value) => {
      if (!response.destroyed) {
        response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        response.end(JSON.stringify(value));
      }
    };
    if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(request.headers.host || '') || request.headers.origin) {
      reply(403, { error: '仅允许本机非浏览器请求' }); return;
    }
    const pathname = new URL(request.url, 'http://localhost').pathname;
    if (request.method === 'GET' && pathname === '/health') {
      reply(200, { service: 'genshin-framework', mode: runtime.adapter.mode, liveEnabled: false }); return;
    }
    if (request.headers.authorization !== `Bearer ${token}`) { reply(401, { error: '缺少有效服务令牌' }); return; }
    try {
      if (request.method === 'GET') {
        if (pathname === '/state') return reply(200, runtime.status());
        if (pathname === '/capabilities') return reply(200, { skills: SKILLS, plannerMode, adapter: runtime.adapter.status() });
        if (pathname === '/context') return reply(200, runtime.context());
        if (pathname === '/events') return reply(200, { events: runtime.events, retained: 200 });
      }
      if (request.method === 'POST' && pathname === '/stop') {
        for (const controller of pending) controller.abort();
        return reply(200, runtime.stop());
      }
      if (request.method === 'POST' && pathname === '/plan') {
        if (pending.size) return reply(409, { error: '规划进行中' });
        const controller = new AbortController();
        pending.add(controller);
        const abort = () => { if (!response.writableEnded) controller.abort(); };
        response.once('close', abort);
        try {
          const body = await readJson(request);
          const plan = await planner(body.goal, { mode: plannerMode, signal: controller.signal });
          controller.signal.throwIfAborted();
          return reply(200, plan);
        } finally { pending.delete(controller); response.off('close', abort); }
      }
      if (request.method === 'POST' && pathname === '/run') {
        const body = await readJson(request);
        if (runtime.status().busy) return reply(409, { error: '已有执行中的任务' });
        return reply(202, runtime.start(body.plan));
      }
      reply(404, { error: '未知接口' });
    } catch (error) { reply(400, { error: error.message }); }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 10000;
  server.on('close', () => { for (const controller of pending) controller.abort(); runtime.stop(); });
  return server;
}

module.exports = { createServer };
