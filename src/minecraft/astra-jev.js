'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { planSurvival, decisionMessages } = require('./survival-planner');
const { validateAction } = require('./survival-skills');
const { getLocalLlmConfig } = require('../brain/local-llm');

const PLANNER = 'openai/gpt-6-astra';
const CONTROLLER = 'typesafe/jev-1.13';
const SETTINGS_PATH = path.resolve(__dirname, '../../data/minecraft-engine.local.json');
// This integration proposes bounded alternatives. JEV, not array order, chooses
// the one action passed to the existing cancellation and world-evidence loop.
function parseProposal(content, probe = false) {
  if (typeof content !== 'string' || content.length > 16000) throw new Error('Astra 返回了空白或过长规划');
  let proposal;
  try { proposal = JSON.parse(content); } catch { throw new Error('Astra 规划不是严格 JSON，未执行动作'); }
  if (!proposal || typeof proposal.objective !== 'string' || !proposal.objective.trim() || proposal.objective.length > 300 ||
      !Array.isArray(proposal.candidates) || !proposal.candidates.length || proposal.candidates.length > 6) {
    throw new Error('Astra 规划需要 objective 与 1–6 个候选动作');
  }
  const candidates = proposal.candidates.map(candidate => {
    if (!candidate || typeof candidate.reason !== 'string' || !candidate.reason.trim() || candidate.reason.length > 300) throw new Error('候选动作缺少有效理由');
    const action = validateAction(candidate.action);
    if (action.action.startsWith('creative_')) throw new Error('生存模式不接受创造动作');
    if (probe && action.action !== 'observe') throw new Error('连接检查仅接受 observe');
    return { action, reason: candidate.reason };
  });
  if (!candidates.some(c => c.action.action === 'observe')) candidates.push({ action: { action: 'observe' }, reason: '现有方案不适合时重新观察，不改变世界' });
  return { objective: proposal.objective.trim(), candidates };
}

class MinecraftEngine {
  constructor({ file = SETTINGS_PATH, env = process.env, fetchImpl = fetch } = {}) {
    this.file = file; this.env = env; this.fetchImpl = fetchImpl;
    this.config = { provider: 'local-qwen', apiKey: '', astraApiKey: '' };
    if (fs.existsSync(file)) {
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (!['local-qwen', 'astra', 'astra-jev'].includes(saved.provider)) throw new Error('Minecraft 引擎配置无效');
      this.config = { provider: saved.provider, apiKey: typeof saved.apiKey === 'string' ? saved.apiKey : '', astraApiKey: typeof saved.astraApiKey === 'string' ? saved.astraApiKey : '' };
    }
    this.verification = null;
  }
  key() { if (this.config.provider === 'astra') return this.config.astraApiKey || this.env.ASTRA_API_KEY || ''; return this.config.apiKey || this.env.OPENROUTER_API_KEY || ''; }
  status() {
    return { provider: this.config.provider, plannerModel: this.config.provider === 'astra' ? 'gpt-6-astra' : PLANNER, controllerModel: this.config.provider === 'astra' ? 'program-checks' : CONTROLLER,
      keyConfigured: Boolean(this.key()), keySource: this.config.provider === 'astra' ? (this.config.astraApiKey ? 'local-file' : this.env.ASTRA_API_KEY ? 'environment' : null) : this.config.apiKey ? 'local-file' : this.env.OPENROUTER_API_KEY ? 'environment' : null,
      verification: this.verification };
  }
  save(update) {
    if (!update || !['local-qwen', 'astra', 'astra-jev'].includes(update.provider)) throw new Error('请选择有效的游戏控制方案');
    if (Object.keys(update).some(key => !['provider', 'apiKey', 'clearKey'].includes(key))) throw new Error('未知配置字段');
    if (update.clearKey !== undefined && typeof update.clearKey !== 'boolean') throw new Error('clearKey 必须为布尔值');
    if (update.apiKey !== undefined && (typeof update.apiKey !== 'string' || update.apiKey.length > 512 || /\s/.test(update.apiKey))) throw new Error('密钥格式无效');
    const keyField = update.provider === 'astra' ? 'astraApiKey' : 'apiKey';
    const next = { ...this.config, provider: update.provider, [keyField]: update.clearKey ? '' : update.apiKey || this.config[keyField] }; 
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify(next, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
    if (next.apiKey !== this.config.apiKey || next.astraApiKey !== this.config.astraApiKey || next.provider !== this.config.provider) this.verification = null;
    this.config = next;
    return this.status();
  }
  assertReady() {
    if (this.config.provider === 'astra' && !this.key()) throw new Error('请在游戏控制方案中保存 OpenAI API Key（Astra 专用）');
    if (this.config.provider === 'astra-jev' && !this.key()) throw new Error('请先在游戏控制方案中保存 OpenRouter API Key');
  }
  async request(route, body, signal) {
    const key = this.key();
    if (!key) throw new Error('请先保存 OpenRouter API Key');
    signal?.throwIfAborted();
    let response;
    try {
      response = await this.fetchImpl('https://openrouter.ai' + route, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        body: JSON.stringify(body), signal, redirect: 'error'
      });
    } catch (error) { signal?.throwIfAborted(); throw new Error('OpenRouter 网络连接失败，请检查网络后重试'); }
    // Never expose upstream error bodies: a provider can echo credentials.
    if (!response.ok) throw new Error(`OpenRouter HTTP ${response.status}${response.status === 401 ? '：密钥无效' : response.status === 402 ? '：余额不足' : response.status === 429 ? '：请求限流' : '：请求失败'}`);
    let payload;
    try { payload = await response.json(); } catch { throw new Error('OpenRouter 返回了非 JSON 响应'); }
    signal?.throwIfAborted();
    if (payload.error) throw new Error('OpenRouter 模型返回错误，未执行游戏动作');
    return payload;
  }
  async plan(observation, options = {}) {
    if (this.config.provider === 'local-qwen') return planSurvival(observation, options);
    return this.config.provider === 'astra' ? require('./astra-direct').planDirect(this, observation, options) : this.planCloud(observation, options);
  }
  async planCloud(observation, { signal, goal, history = [], currentSubgoal, probe = false,
    timeoutMs = 90000, onReview = () => {}, onMetadata = () => {}, onRequest = () => {}, onCompletion = () => {} } = {}) {
    const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
    const messages = decisionMessages(observation, { goal, history, currentSubgoal });
    messages[0].content += '\n本轮你担任 Astra 高层规划器，JEV 将选择实际动作。返回严格 JSON：{"objective":"当前阶段与依据","candidates":[{"action":动作对象,"reason":"何时应选此动作"}]}。提出 2–6 个基于当前观察可以立即尝试的替代动作，不是顺序计划；无需等待另一候选成功，数量与坐标须符合动作合同。包含 observe 作为重看选项。禁止 creative_*。不得把候选或目标视为已执行。';
    if (probe) messages[0].content += '\n这是模型连通性检查，不操作游戏。仅返回一个 action 为 {"action":"observe"} 的候选。';
    const plannerRequest = { model: PLANNER, messages, response_format: { type: 'json_object' }, max_tokens: 4096, reasoning: { effort: 'low' } };
    const started = Date.now();
    onRequest({ stage: 'astra', ...plannerRequest });
    const plannerResult = await this.request('/api/v1/chat/completions', plannerRequest, requestSignal);
    const proposal = parseProposal(plannerResult.choices?.[0]?.message?.content, probe);
    const plannerMs = Date.now() - started;
    onCompletion({ stage: 'astra', model: plannerResult.model, content: JSON.stringify(proposal), usage: plannerResult.usage });
    onReview({ subgoal: proposal.objective, reason: 'Astra 根据当前观测规划，等待 JEV 选择动作', source: 'astra-jev' });
    requestSignal.throwIfAborted();
    const criteria = Object.fromEntries(proposal.candidates.map((candidate, index) => [`a${index}`, `${candidate.reason}；执行：${JSON.stringify(candidate.action)}`]));
    const decisionRequest = { model: CONTROLLER,
      state: { ...JSON.parse(messages[1].content), objective: proposal.objective },
      questions: { action: { type: 'choice', instructions: 'Choose one available Minecraft action that best advances objective given the current state and recentResults. Survival and food take priority. Do not repeat failed actions unchanged. Candidate descriptions are proposals, not completed facts. Choose observe when no other option fits. Return only an offered choice.', criteria } } };
    onRequest({ stage: 'jev', ...decisionRequest });
    const decisionResult = await this.request('/api/alpha/decisions', decisionRequest, requestSignal);
    const answer = decisionResult.answers?.action;
    if (typeof answer?.choice !== 'string' || !Object.hasOwn(criteria, answer.choice)) throw new Error('JEV 未返回有效候选，未执行游戏动作');
    const action = validateAction(proposal.candidates[Number(answer.choice.slice(1))].action);
    requestSignal.throwIfAborted();
    const metadata = { source: 'astra-jev', used_adapter: false, planner: plannerResult.model || PLANNER, controller: decisionResult.model || CONTROLLER,
      plannerMs, controllerMs: Date.now() - started - plannerMs, choice: answer.choice,
      confidence: typeof answer.confidence === 'number' ? answer.confidence : null };
    onCompletion({ stage: 'jev', model: metadata.controller, choice: answer.choice, confidence: metadata.confidence, usage: decisionResult.usage });
    onMetadata(metadata);
    this.verification = { ok: true, at: new Date().toISOString(), kind: probe ? 'model-probe' : 'live-decision', planner: metadata.planner, controller: metadata.controller, plannerMs: metadata.plannerMs, controllerMs: metadata.controllerMs };
    return action;
  }
  async test(signal) {
    this.verification = null;
    try {
      if (this.config.provider === 'local-qwen') throw Error('请选择 Astra 后检查连接');
      await this.plan({ connected: false, inventory: [], entities: [], health: null, food: null }, { signal, goal: this.config.provider === 'astra' ? '仅检查 Astra 连通性，返回观察步骤' : '仅检查两模型连通性，返回观察动作', probe: true });
      return this.status();
    } catch (error) { this.verification = { ok: false, at: new Date().toISOString(), error: error.message }; throw error; }
  }
  modelState() {
    const cloud = this.config.provider !== 'local-qwen';
    return { provider: this.config.provider, model: this.config.provider === 'astra' ? 'gpt-6-astra' : cloud ? PLANNER : getLocalLlmConfig().model,
      controllerModel: this.config.provider === 'astra' ? 'program-checks' : cloud ? CONTROLLER : null, ...(cloud ? { modelLoaded: this.verification?.ok === true, keyConfigured: Boolean(this.key()), modelHealth: this.status(), adapter: null, adapterLoaded: false } : {}) };
  }
}
module.exports = { MinecraftEngine, parseProposal, PLANNER, CONTROLLER };
