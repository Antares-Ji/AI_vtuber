'use strict';
const { decisionMessages } = require('./survival-planner');
const { validateAction } = require('./survival-skills');
const { deepseekFetch } = require('../runtime/deepseek-transport');

function model(env = process.env, savedKey = '') {
  return env.DEEPSEEK_MODEL || (savedKey || env.DEEPSEEK_API_KEY ? 'deepseek-flash' : env.OPENAI_MODEL || 'deepseek-flash');
}
function config(env = process.env, savedKey = '') {
  const dedicatedKey = savedKey || env.DEEPSEEK_API_KEY;
  const base = new URL(env.DEEPSEEK_BASE_URL || (dedicatedKey ? 'https://api.deepseek.com' : env.OPENAI_BASE_URL || 'https://api.deepseek.com'));
  // Reuse the user's DeepSeek credential only for its original provider.
  if (base.origin !== 'https://api.deepseek.com' || !['', '/', '/v1', '/v1/'].includes(base.pathname) || base.search || base.hash || base.username || base.password) throw Error('DeepSeek 游戏规划需要官方 DeepSeek 地址');
  const key = dedicatedKey || env.OPENAI_API_KEY;
  if (!key) throw Error('请在游戏控制面板保存 DeepSeek API Key，或配置 DEEPSEEK_API_KEY');
  return { url: base.href.replace(/\/$/, '') + '/chat/completions', model: model(env, savedKey), key };
}
async function planDeepseek(state, options = {}, env = process.env, fetchImpl = deepseekFetch, savedKey = '') {
  const { signal, probe = false, goal, history, currentSubgoal, onRequest = () => {}, onCompletion = () => {}, onMetadata = () => {}, onReview = () => {} } = options;
  const settings = config(env, savedKey);
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(45000)]) : AbortSignal.timeout(45000);
  requestSignal.throwIfAborted();
  const messages = probe ? [{ role: 'user', content: '只检查连接，不操作游戏。只返回JSON：{"subgoal":"检查连接","reason":"只读检查","plan":[{"action":"observe"}]}' }] : decisionMessages(state, { goal, history, currentSubgoal });
  if (!probe) messages[0].content += '\n只返回严格JSON：{"subgoal":"当前阶段","reason":"状态依据","plan":[动作对象]}。plan必须恰好一个动作；每轮根据真实结果重规划。生存模式严禁creative_动作。';
  const body = { model: settings.model, messages, temperature: 0, max_tokens: 600, thinking: { type: 'disabled' }, response_format: { type: 'json_object' } };
  onRequest(body);
  const started = Date.now();
  let response;
  try { response = await fetchImpl(settings.url, { method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${settings.key}` }, body: JSON.stringify(body), signal: requestSignal, redirect: 'error' }); }
  catch { requestSignal.throwIfAborted(); throw Error('DeepSeek 网络请求失败'); }
  if (!response.ok) throw Error(`DeepSeek HTTP ${response.status}`);
  let payload;
  try { payload = await response.json(); } catch { throw Error('DeepSeek 返回无效响应'); }
  requestSignal.throwIfAborted();
  const choice = payload.choices?.[0];
  if (choice?.finish_reason !== 'stop') throw Error('DeepSeek 输出未完整结束，未执行动作');
  const content = choice.message?.content;
  if (typeof content !== 'string' || content.length > 4000) throw Error('DeepSeek 规划为空或过长');
  let parsed;
  try { parsed = JSON.parse(content); } catch { throw Error('DeepSeek 未返回严格 JSON'); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || Object.keys(parsed).some(k => !['subgoal', 'reason', 'plan'].includes(k)) || !Array.isArray(parsed.plan) || parsed.plan.length !== 1 || typeof parsed.subgoal !== 'string' || !parsed.subgoal.trim() || typeof parsed.reason !== 'string' || !parsed.reason.trim()) throw Error('DeepSeek 规划格式错误，未执行动作');
  const action = validateAction(parsed.plan[0]);
  if (action.action.startsWith('creative_') || (probe && action.action !== 'observe')) throw Error('DeepSeek 提议的动作不适用于本次生存任务/连接检查');
  const metadata = { source: 'deepseek', planner: payload.model || settings.model, used_adapter: false, plannerMs: Date.now() - started };
  onCompletion({ content, usage: payload.usage, metadata });
  onMetadata(metadata);
  onReview({ subgoal: parsed.subgoal.trim().slice(0, 120), reason: parsed.reason.trim().slice(0, 120), source: 'deepseek' });
  return { action, metadata };
}
module.exports = { config, model, planDeepseek };
