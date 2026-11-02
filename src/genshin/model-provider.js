'use strict';
const fs = require('node:fs');
const path = require('node:path');
const openai = require('./openai');
const { deepseekFetch } = require('../runtime/deepseek-transport');
const ROOT = path.resolve(__dirname, '../..');
function read(file) { return fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {}; }
function settings({ dataRoot = ROOT, env = process.env } = {}) {
  const provider = read(path.join(dataRoot, 'data/genshin.local.json')).provider || 'openai';
  if (!['openai', 'deepseek'].includes(provider)) throw Error('原神模型供应商配置无效');
  if (provider === 'openai') return { ...openai.settings({ dataRoot, env }), provider };
  const saved = read(path.join(dataRoot, 'data/minecraft-engine.local.json'));
  const legacy = /^https:\/\/api\.deepseek\.com(?:\/v1)?\/?$/.test(env.OPENAI_BASE_URL || '');
  const key = env.GENSHIN_DEEPSEEK_API_KEY || saved.deepseekApiKey || env.DEEPSEEK_API_KEY || (legacy ? env.OPENAI_API_KEY : '') || '';
  const model = env.GENSHIN_DEEPSEEK_MODEL || env.DEEPSEEK_MODEL || 'deepseek-chat';
  if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(model)) throw Error('DeepSeek 模型名称无效');
  return { provider, key, model, url: 'https://api.deepseek.com/chat/completions' };
}
function publicSettings(options) { const c = settings(options); return { provider: c.provider, model: c.model, keyConfigured: Boolean(c.key), fallback: false }; }
function selectProvider(provider, { dataRoot = ROOT } = {}) {
  if (!['openai', 'deepseek'].includes(provider)) throw Error('只能选择 OpenAI 或 DeepSeek');
  const file = path.join(dataRoot, 'data/genshin.local.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const config = { ...read(file), provider };
  fs.writeFileSync(file + '.tmp', JSON.stringify(config, null, 2)); fs.renameSync(file + '.tmp', file);
  return provider;
}
async function respond(input, options = {}) {
  const c = settings(options); options.signal?.throwIfAborted();
  if (c.provider === 'openai') return openai.respond(input, options);
  if (!c.key) throw Error('未配置 DeepSeek API 密钥');
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  const response = await (options.fetchImpl || deepseekFetch)(c.url, { method: 'POST', redirect: 'error', signal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` },
    body: JSON.stringify({ model: c.model, max_tokens: 2048, messages: [
      { role: 'system', content: (options.instructions || '用中文准确回答。') + (options.schema ? '\n仅返回符合以下 schema 的 JSON：' + JSON.stringify(options.schema) : '') },
      { role: 'user', content: input }], ...(options.schema ? { response_format: { type: 'json_object' } } : {}) }) });
  const data = await response.json(); signal.throwIfAborted();
  if (!response.ok) {
    const detail=response.status===402?'API 余额不足，请补充 DeepSeek API 余额后继续':'请求失败，请检查模型权限或网络';
    throw Object.assign(Error(`DeepSeek HTTP ${response.status}：${detail}；未切换供应商`),{code:response.status===402?'PROVIDER_INSUFFICIENT_BALANCE':'PROVIDER_HTTP_ERROR',status:response.status});
  }
  const choice = data.choices?.[0];
  if (choice?.finish_reason !== 'stop' || typeof choice.message?.content !== 'string' || !choice.message.content.trim() || choice.message.content.length > 16000) throw Error('DeepSeek 未返回完整有效文本，未执行任务');
  return { text: choice.message.content.trim(), provider: 'deepseek', model: data.model || c.model, usage: data.usage || null };
}
module.exports = { settings, publicSettings, selectProvider, respond };
