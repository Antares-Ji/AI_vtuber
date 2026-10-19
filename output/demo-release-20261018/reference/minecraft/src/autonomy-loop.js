const { expanded } = require('./capability-policy');
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');
const { getLocalLlmConfig } = require('../brain/local-llm');
const { planSurvival } = require('./survival-planner');

const LOG_DIR = path.resolve(__dirname, '../../logs');
function failureKey(action) {
  if (!action) return 'rejected-plan';
  return JSON.stringify([action.action, action.item ?? null, action.resource ?? null, action.direction ?? null]);
}
function inventoryKey(inventory = []) {
  const counts = new Map();
  for (const item of inventory) counts.set(item.name, (counts.get(item.name) || 0) + item.count);
  return JSON.stringify([...counts].sort(([a], [b]) => a.localeCompare(b)));
}
function staleReasons(before, after) {
  const reasons = [];
  if (!after.connected || after.sessionId !== before.sessionId || after.dimension !== before.dimension) reasons.push('world-session');
  if (after.busy || after.health <= 0) reasons.push('unavailable');
  if (after.health < before.health) reasons.push('health-decreased');
  if (inventoryKey(before.inventory) !== inventoryKey(after.inventory)) reasons.push('inventory-changed');
  if (before.position && after.position && Math.hypot(after.position.x - before.position.x, after.position.y - before.position.y, after.position.z - before.position.z) > 2) reasons.push('position-changed');
  if (before.reactive?.lifecycleEpoch !== after.reactive?.lifecycleEpoch) reasons.push('life-changed');
  return reasons;
}
function readTaskPartial(sessionId, taskId, logDir = LOG_DIR) {
  // Compatibility with a resident control process started before partialResult
  // was added to /task. Hotloaded skills log the same taskId without reconnecting.
  if (typeof sessionId !== 'string') return null;
  const file = path.resolve(sessionId);
  if (path.dirname(file) !== path.resolve(logDir) || !/^minecraft-session-\d+\.jsonl$/.test(path.basename(file))) return null;
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size, length = Math.min(size, 65536), data = Buffer.alloc(length);
    fs.readSync(fd, data, 0, length, size - length);
    for (const line of data.toString('utf8').split('\n').reverse()) {
      let row; try { row = JSON.parse(line); } catch { continue; }
      if (row.event === 'skill_failed' && row.taskId === taskId && row.partialResult?.verifiedPartial === true && row.partialResult.gained > 0) return row.partialResult;
    }
  } catch { /* Missing evidence stays unknown; never invent a partial gain. */ }
  finally { if (fd !== undefined) fs.closeSync(fd); }
  return null;
}
async function controlRequest(route, payload, signal) {
  const config = JSON.parse(fs.readFileSync(path.join(LOG_DIR, 'minecraft-control.json'), 'utf8'));
  const response = await fetch(`http://127.0.0.1:${config.port}${route}`, {
    method: payload === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000)
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `Minecraft HTTP ${response.status}`);
  return result;
}
class AutonomyLoop {
  constructor({ onResult = () => {}, onPlanning = () => {}, request = controlRequest, planner = planSurvival, now = Date.now, logDir = LOG_DIR } = {}) {
    this.onPlanning = onPlanning;
    this.request = request; this.planner = planner; this.onResult = onResult; this.now = now;
    this.controller = null; this.activeTaskId = null; this.pending = null;
    this.observedLife = null;
    this.logDir = logDir;
    this.state = { enabled: false, running: false, goal: '由本地千问自主规划：安全生存、采集、制作工具、采矿、制作并点燃下界门，进入下界。失败后根据真实状态调整计划。', deadline: process.env.MC_LOOP_DEADLINE || '2026-10-12T23:17:01.000Z', step: 0, model: getLocalLlmConfig().model, modelLoaded: false, adapter: null, adapterLoaded: false, lastDecision: null, lastResult: null, lastError: null, latencyMs: null, history: [] };
  }
  snapshot() { return JSON.parse(JSON.stringify(this.state)); }
  prioritizeConversation(ms = 15000) {
    const epoch = this.chatHoldEpoch = (this.chatHoldEpoch || 0) + 1;
    this.chatHoldUntil = this.now() + ms;
    this.lookahead = null;
    this.planningController?.abort(new Error('Audience reply has priority'));
    return () => { if (this.chatHoldEpoch === epoch) this.chatHoldUntil = 0; };
  }
  updateRecovery() {
    const tail = this.state.history.slice(-3);
    this.state.needsRecovery = tail.length === 3 && tail.every(entry => entry.status !== 'completed' && failureKey(entry.action) === failureKey(tail[0].action));
  }
  async refreshModelHealth() {
    if (this.healthPending) return this.healthPending;
    if (this.healthCheckedAt && this.now() - this.healthCheckedAt < 5000) return;
    this.healthPending = this.modelHealth(new AbortController().signal).catch(() => {}).finally(() => { this.healthCheckedAt = this.now(); this.healthPending = null; });
    return this.healthPending;
  }
  record(event, data = {}) {
    this.state.updatedAt = new Date(this.now()).toISOString();
    fs.mkdirSync(this.logDir, { recursive: true });
    fs.appendFileSync(path.join(this.logDir, 'minecraft-autonomy.jsonl'), JSON.stringify({ at: this.state.updatedAt, event, ...data }) + '\n');
    fs.writeFileSync(path.join(this.logDir, 'minecraft-loop-state.json'), JSON.stringify(this.state, null, 2));
  }
  async modelHealth(signal) {
    const base = getLocalLlmConfig().baseUrl.replace(/\/v1\/?$/, '');
    try {
      const res = await fetch(`${base}/health`, { signal: AbortSignal.any([signal, AbortSignal.timeout(5000)]) });
      if (!res.ok) throw new Error(`Model health HTTP ${res.status}`);
      const health = await res.json();
      this.state.modelLoaded = Boolean(health.loaded ?? health.model_loaded ?? health.ok);
      this.state.adapter = health.adapter_path || health.adapter || null;
      this.state.adapterLoaded = health.adapter_loaded === true;
      this.state.modelHealth = health;
      if (!this.state.modelLoaded) throw new Error('本地模型尚未加载');
    } catch (error) { signal.throwIfAborted(); this.state.modelLoaded = false; this.state.adapterLoaded = false; throw error; }
  }
  addAudienceSuggestion(text) {
    this.lookahead = null;
    if (typeof text !== 'string' || !text.trim() || text.length > 500) throw new Error('建议应为1到500字');
    this.state.audienceSuggestions = [...(this.state.audienceSuggestions || []), { text: text.trim(), at: new Date(this.now()).toISOString() }].slice(-3);
    this.record('audience_suggestion', { text: text.trim(), applied: 'next-planning-step' });
  }
  armDeadline() {
    clearTimeout(this.deadlineTimer);
    if (this.state.untilStopped) return;
    const controller = this.controller;
    this.deadlineTimer = setTimeout(() => controller?.abort(new Error('Authorized runtime ended')), Math.max(1, Date.parse(this.state.deadline) - this.now()));
  }
  async start({ goal, durationMinutes, completionItem, continuous, untilStopped } = {}) {
    if (durationMinutes !== undefined && (!Number.isInteger(durationMinutes) || durationMinutes < 1 || durationMinutes > 720)) throw new Error('运行时长应为1到720分钟');
    if (untilStopped !== undefined && typeof untilStopped !== 'boolean') throw new Error('untilStopped must be boolean');
    if (untilStopped === true && durationMinutes !== undefined) throw new Error('Choose untilStopped or durationMinutes');
    if (continuous !== undefined && typeof continuous !== 'boolean') throw new Error('continuous must be boolean');
    if (completionItem !== undefined && !['crafting_table', 'iron_pickaxe'].includes(completionItem)) throw new Error('不支持的演示验收物品');
    if (goal !== undefined && (typeof goal !== 'string' || !goal.trim() || goal.length > 1000)) throw new Error('训练目标应为1到1000字');
    if (untilStopped !== undefined) { this.state.untilStopped = untilStopped; if (untilStopped) this.state.deadline = null; }
    if (durationMinutes !== undefined) this.state.untilStopped = false;
    if (this.state.enabled) {
      if (untilStopped !== undefined) this.armDeadline();
      if (goal && goal !== this.state.goal) throw new Error('已有目标正在执行；可以发聊天建议，或先停止再换目标');
      if (continuous !== undefined) this.state.continuous = continuous;
      if (durationMinutes !== undefined) {
        this.state.deadline = new Date(this.now() + durationMinutes * 60000).toISOString();
        this.armDeadline();
        this.record('loop_deadline_updated', { deadline: this.state.deadline, continuous: this.state.continuous });
      }
      return this.snapshot();
    }
    if (this.pending || this.state.running) throw new Error('上一轮正在取消，请稍后重试');
    if (durationMinutes !== undefined) {
      if (completionItem !== undefined && !['crafting_table', 'iron_pickaxe'].includes(completionItem)) throw new Error('不支持的演示验收物品');
      this.state.deadline = new Date(this.now() + durationMinutes * 60000).toISOString();
      this.state.completionItem = completionItem || null;
      this.state.goalCompleted = false;
      this.state.currentSubgoal = null; this.state.goalReview = null;
      this.state.history = [];
      this.state.audienceSuggestions = [];
    }
    this.state.continuous = continuous === true;
    if (!this.state.untilStopped && this.now() >= Date.parse(this.state.deadline)) throw new Error('授权窗口已结束，请从演示目标重新开始');
    if (goal !== undefined) {
      if (typeof goal !== 'string' || !goal.trim() || goal.length > 1000) throw new Error('训练目标应为1到1000字');
      this.state.goal = goal.trim();
    }
    await this.request('/command', { command: 'defend' });
    this.controller = new AbortController(); this.state.enabled = true;
    this.record('loop_started');
    this.pending = this.run(this.controller.signal).finally(() => { this.pending = null; this.state.running = false; this.state.enabled = false; this.record('loop_finished'); });
    return this.snapshot();
  }
  async stop() {
    this.lookahead = null;
    this.state.enabled = false; this.controller?.abort(new Error('Operator stopped loop'));
    if (this.activeTaskId) await this.request('/cancel-task', { taskId: this.activeTaskId }).catch(() => {});
    this.record('loop_stop_requested');
    return this.snapshot();
  }
  async run(signal) {
    // A deadline aborts inference and active skill; it does not disconnect the bot.
    this.armDeadline();
    try {
      while (this.state.enabled && !signal.aborted && (this.state.untilStopped || this.now() < Date.parse(this.state.deadline))) {
        try {
          const outcome = await this.step(this.state.goal, signal);
          this.state.lastError = outcome?.evidence?.status && outcome.evidence.status !== 'completed' ? outcome.evidence.error || outcome.evidence.status : null;
        }
        catch (error) {
          if (signal.aborted) break;
          this.state.lastError = error.message; this.record('loop_error', { error: error.message });
        }
        this.updateRecovery();
        if (!signal.aborted) await delay(this.state.needsRecovery ? 10000 : this.state.lastError ? 1000 : 150, undefined, { signal });
      }
    } catch (error) { if (!signal.aborted) { this.state.lastError = error.message; this.record('loop_error', { error: error.message }); } }
    finally {
      clearTimeout(this.deadlineTimer);
      if (this.activeTaskId) await this.request('/cancel-task', { taskId: this.activeTaskId }).catch(() => {});
      this.activeTaskId = null;
    }
  }
  async runOnce(goal, signal) {
    if (this.state.enabled || this.state.running || this.pending) throw new Error('自主循环正在运行，请先停止再发单次任务');
    if (typeof goal !== 'string' || !goal.trim() || goal.length > 1000) throw new Error('请输入1到1000字的目标');
    return this.step(goal, signal);
  }
  async step(goal, signal) {
    this.state.running = true;
    let taskId = null;
    let action = null;
    let planningController = null;
    const requestId = randomUUID();
    let modelMetadata = { used_adapter: null, metadata_missing: true };
    try {
      signal.throwIfAborted();
      const observation = await this.request('/observe', undefined, signal);
      if (!observation.connected) throw new Error('Minecraft 未连接');
      if (this.state.enabled && this.state.completionItem && observation.inventory?.some(item => item.name === this.state.completionItem && item.count > 0)) {
        if (!this.state.goalCompleted) this.record('demo_goal_verified', { item: this.state.completionItem, inventory: observation.inventory });
        this.state.goalCompleted = true;
        if (!this.state.continuous) {
          this.state.enabled = false;
          return { verified: true, speech: '背包已确认目标物品，演示任务完成。', state: observation };
        }
      }
      const life = { sessionId: observation.sessionId, epoch: observation.reactive?.lifecycleEpoch, dimension: observation.dimension };
      if (this.observedLife && (life.sessionId !== this.observedLife.sessionId || life.epoch !== this.observedLife.epoch || life.dimension !== this.observedLife.dimension)) {
        this.record('model_history_boundary', { previousEpoch: this.observedLife.epoch, nextEpoch: life.epoch, sessionChanged: life.sessionId !== this.observedLife.sessionId, dimensionChanged: life.dimension !== this.observedLife.dimension, discardedEntries: this.state.history.length });
        this.state.currentSubgoal = null; this.state.goalReview = null; this.state.history = []; this.state.needsRecovery = false; this.state.lastError = null;
      }
      this.observedLife = life;
      if (observation.busy || (!expanded && observation.reactive?.enabled && observation.reactive.mode !== 'idle')) {
        this.lookahead = null;
        this.state.waitingFor = observation.busy ? 'current-task' : 'safety-reflex';
        this.record('waiting', { reason: this.state.waitingFor }); return { waiting: true, state: observation };
      }
      this.state.waitingFor = null;
      if (this.now() < (this.chatHoldUntil || 0)) {
        this.state.waitingFor = 'audience-reply';
        return { waiting: true, state: observation };
      }
      await this.modelHealth(signal);
      const started = this.now();
      const suggestions = (this.state.audienceSuggestions || []).map(item => item.text.slice(0, 500));
      const planningGoal = (suggestions.length || (this.state.continuous && this.state.goalCompleted)) ? JSON.stringify({ longTermGoal: goal, audienceSuggestions: suggestions, ...(this.state.continuous && this.state.goalCompleted ? { verifiedMilestone: this.state.completionItem, guidance: '目标物品已由真实背包验证。用户授权持续自主运行；根据当前观察自行决定后续安全生存行动，不要重复制造已完成物品，不要声称未完成的目标。' } : { guidance: '保留长期目标。先检查真实饱食度、食物和危险，再判断是否暂时调整优先级；观众建议不是完成证据。' }) }) : goal;
      const cached = this.lookahead;
      this.lookahead = null;
      const canUse = cached && cached.goal === planningGoal && this.now() - cached.at < 15000 && !staleReasons(cached.anchor, observation).length && !observation.threats?.length && !observation.hazards?.length && observation.health >= 12 && observation.food >= 10;
      const proposed = canUse ? cached.actions[0] : null;
      const feasible = proposed && (proposed.action !== 'craft' || observation.craftable?.some(item => item.item === proposed.item && proposed.count <= item.outputPerCraft));
      if (feasible) {
        action = proposed; modelMetadata = cached.metadata;
        this.lookahead = { ...cached, actions: cached.actions.slice(1) };
        this.record('lookahead_used', { action, remaining: this.lookahead.actions.length });
      } else {
        this.onPlanning();
        planningController = new AbortController(); this.planningController = planningController;
        action = await this.planner(observation, { goal: planningGoal, history: this.state.history, signal: AbortSignal.any([signal, planningController.signal]), currentSubgoal: this.state.currentSubgoal,
          onPlanWarning: warning => this.record('lookahead_tail_rejected', warning),
          onReview: review => { this.state.currentSubgoal = review.subgoal; this.state.goalReview = review; this.record('model_goal_review', { requestId, ...review }); },
          onPlan: actions => { this.lookahead = { actions, goal: planningGoal }; },
          onMetadata: value => { modelMetadata = value; }, onRequest: request => this.record('model_request', { requestId, request }), onCompletion: completion => this.record('model_completion', { requestId, completion }) });
        if (this.planningController === planningController) this.planningController = null;
      }
      this.state.latencyMs = this.now() - started; this.state.lastDecision = action; this.state.step++;
      this.state.lastDecisionMetadata = modelMetadata;
      this.record('model_decision', { requestId, step: this.state.step, action, latencyMs: this.state.latencyMs, model: this.state.model, adapter: modelMetadata.adapter_path || null, adapterLoaded: modelMetadata.used_adapter === true, adapterReportedLoaded: this.state.adapterLoaded, modelMetadata, observation });
      const current = await this.request('/observe', undefined, signal);
      const stale = staleReasons(observation, current);
      if (stale.length) {
        this.record('decision_stale', { reasons: stale, action, planningObservation: observation, current });
        throw new Error(`推理期间世界状态已变化，本次决策作废：${stale.join(', ')}`);
      }
      if (!expanded && current.reactive?.enabled && current.reactive.mode !== 'idle') throw new Error('推理期间出现危险，本次决策作废，安全层正在避险');
      taskId = randomUUID(); this.activeTaskId = taskId;
      await this.request('/skill', { taskId, action }, signal);
      const deadline = this.now() + 130000;
      let result;
      while (this.now() < deadline) {
        signal.throwIfAborted();
        result = await this.request(`/task?id=${taskId}`, undefined, signal);
        if (result.status !== 'running') break;
        await delay(300, undefined, { signal });
      }
      if (result?.status === 'running') throw new Error('等待技能执行结果超时');
      const after = await this.request('/observe', undefined, signal);
      const partial = result.status === 'completed' ? null : result.partialResult || readTaskPartial(observation.sessionId, taskId, this.logDir);
      const entry = { taskId, action, status: result.status, result: result.result || partial || undefined, ...(partial ? { partialEvidenceSource: result.partialResult ? 'task-response' : 'correlated-skill-log' } : {}), error: result.error, at: new Date(this.now()).toISOString() };
      this.state.history = [...this.state.history, entry].slice(-12); this.state.lastResult = entry;
      this.record('model_action_result', { requestId, ...entry, before: current, planningObservation: observation, after, latencyMs: this.state.latencyMs, adapterLoaded: modelMetadata.used_adapter === true, modelMetadata });
      const success = result.status === 'completed';
      const incomplete = success && result.result?.complete === false;
      if (success && !incomplete && this.lookahead?.actions.length) {
        this.lookahead = { ...this.lookahead, anchor: after, at: this.now(), metadata: modelMetadata };
      } else this.lookahead = null;
      const activity = { explore: '找路', mine: '采矿', gather_wood: '收集木头', hunt: '寻找食物', craft: '制作东西', eat: '吃东西', flee: '避开危险', collect: '拾取物品' }[action.action] || '这一步';
      const speech = incomplete ? `刚才${activity}还没做完，我再看看周围。` : success ? (action.action === 'eat' ? '吃过东西了，接着走吧。' : `刚才${activity}这一步做完了，我看看接下来做什么。`) : `这次${activity}没顺利完成，得重新看看情况。`;
      const output = { decision: { ...action, source: 'local-qwen', model: this.state.model, adapterLoaded: modelMetadata.used_adapter === true, modelMetadata }, verified: success && !incomplete && result.result?.verified === true, speech, state: after, evidence: entry };
      await this.onResult(output);
      if (String(after.dimension).includes('nether')) { if (!this.state.continuous) this.state.enabled = false; this.record('nether_dimension_observed', { dimension: after.dimension, verified: true }); }
      return output;
    } catch (error) {
      this.lookahead = null;
      if (planningController?.signal.aborted && !signal.aborted && !taskId) {
        this.state.waitingFor = 'audience-reply';
        this.record('planning_yielded_to_conversation');
        return { waiting: true };
      }
      if (taskId) await this.request('/cancel-task', { taskId }).catch(() => {});
      if (!signal.aborted) {
        const rejected = { action, status: 'rejected', error: error.message, at: new Date(this.now()).toISOString() };
        this.state.history = [...this.state.history, rejected].slice(-12);
        this.state.lastError = error.message;
        this.record('decision_rejected', { requestId, ...rejected });
      }
      throw error;
    } finally { if (this.planningController === planningController) this.planningController = null; if (this.activeTaskId === taskId) this.activeTaskId = null; this.state.running = false; }
  }
}
module.exports = { AutonomyLoop, controlRequest, readTaskPartial };
