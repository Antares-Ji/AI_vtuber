'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const ROOT = path.resolve(__dirname, '../..');
function settings({ dataRoot = ROOT, env = process.env } = {}) {
  const file = path.join(dataRoot, '.env.openai.local');
  const saved = fs.existsSync(file) ? parseEnv(fs.readFileSync(file, 'utf8')) : {};
  // Legacy OPENAI_API_KEY can contain a DeepSeek credential. Never reuse it
  // unless its configured origin explicitly identifies OpenAI.
  const officialEnv = env.OPENAI_BASE_URL === 'https://api.openai.com/v1';
  const key = env.GENSHIN_OPENAI_API_KEY || saved.OPENAI_API_KEY || (officialEnv ? env.OPENAI_API_KEY : '') || '';
  const model = env.GENSHIN_OPENAI_MODEL || saved.OPENAI_MODEL || 'gpt-6-astra';
  if (!/^[a-zA-Z0-9_.:-]{1,100}$/.test(model)) throw Error('OpenAI 模型名称无效');
  return { key, model, url: 'https://api.openai.com/v1/responses' };
}
function publicSettings(options) { const c = settings(options); return { provider: 'openai', model: c.model, keyConfigured: Boolean(c.key), fallback: false }; }
async function respond(input, { instructions, schema, signal, fetchImpl = fetch, ...options } = {}) {
  signal?.throwIfAborted();
  const c = settings(options);
  if (!c.key) throw Error('未配置 OpenAI API 密钥：请完成本机 API 设置');
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(60000)]) : AbortSignal.timeout(60000);
  const response = await fetchImpl(c.url, { method: 'POST', redirect: 'error', signal: requestSignal,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${c.key}` },
    body: JSON.stringify({ model: c.model, input, instructions, store: false, max_output_tokens: 2048,
      ...(schema ? { text: { format: { type: 'json_schema', name: 'genshin_plan', strict: true, schema } } } : {}) }) });
  const data = await response.json(); requestSignal.throwIfAborted();
  if (!response.ok) {
    const code = /^[a-zA-Z0-9_]{1,80}$/.test(data?.error?.code) ? data.error.code : 'request_failed';
    const detail = ['billing_not_active', 'insufficient_quota'].includes(code) ? '请在 OpenAI Platform 激活 API 账单或补充可用额度' : '请检查 API 项目、模型权限或网络状态';
    const error = Error(`OpenAI HTTP ${response.status} · ${code}：${detail}`); error.code = code; throw error;
  }
  if (data.status !== 'completed') throw Error('OpenAI 输出未完整结束，未执行任务');
  const text = (data.output || []).filter(x => x.type === 'message').flatMap(x => x.content || [])
    .filter(x => x.type === 'output_text').map(x => x.text).join('\n').trim();
  if (!text || text.length > 16000) throw Error('OpenAI 未返回有效文本');
  return { text, provider: 'openai', model: data.model || c.model, usage: data.usage || null };
}
module.exports = { settings, publicSettings, respond };
