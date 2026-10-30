'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { validatePlan } = require('./planner');
const { MockAdapter } = require('./adapters');

// Adapters must honor AbortSignal and settle after releasing input ownership.
// A timeout requests cancellation, but never grants another task input ownership
// while an unresponsive adapter is still running.
class GenshinRuntime {
  constructor({ adapter = new MockAdapter(), logFile = null } = {}) {
    this.adapter = adapter;
    this.logFile = logFile;
    this.events = [];
    this.sequence = 0;
    this.job = null;
    this.active = null;
    this.done = Promise.resolve();
    if (logFile) fs.mkdirSync(path.dirname(logFile), { recursive: true });
  }
  emit(type, detail = {}) {
    const event = { sequence: ++this.sequence, at: new Date().toISOString(),
      jobId: this.job?.id ?? null, mode: this.adapter.mode, type, ...detail };
    if (this.logFile) fs.appendFileSync(this.logFile, `${JSON.stringify(event)}\n`);
    this.events.push(event);
    if (this.events.length > 200) this.events.shift();
  }
  status() {
    return structuredClone({ adapter: this.adapter.status(), busy: Boolean(this.active),
      job: this.job, lastEventSequence: this.sequence });
  }
  context() {
    return { game: 'genshin', mode: this.adapter.mode, gameConnected: this.adapter.status().gameConnected,
      running: Boolean(this.active), goal: this.job?.goal ?? null, phase: this.job?.state ?? 'idle',
      currentSkill: this.job?.currentSkill ?? null, lastResult: this.job?.lastResult ?? null,
      observation: null, note: '任务回执不等于游戏结果；没有当前画面，不能声称击杀、奖励或通关。' };
  }
  start(input) {
    if (this.active) throw new Error('已有任务占用执行器');
    const plan = validatePlan(input);
    const available = this.adapter.status();
    if (!available.ready) throw new Error(available.reason || '执行器未就绪');
    const controller = new AbortController();
    this.active = controller;
    this.job = { id: randomUUID(), ...plan, planner: input.planner === 'llm' ? 'llm' : 'rules-or-client',
      state: 'running', startedAt: new Date().toISOString(), finishedAt: null,
      completedSteps: 0, currentSkill: null, lastResult: null, error: null };
    this.done = this.run(controller);
    return this.status();
  }
  stop() {
    if (this.active && !this.active.signal.aborted) {
      this.job.state = 'stopping';
      this.active.abort(new Error('用户请求停止'));
    }
    return this.status();
  }
  async run(controller) {
    try {
      this.emit('job.started', { goal: this.job.goal });
      for (const step of this.job.steps) {
        controller.signal.throwIfAborted();
        this.job.currentSkill = step.skill;
        this.emit('step.started', { skill: step.skill });
        const timeout = new AbortController();
        const timer = setTimeout(() => {
          if (!controller.signal.aborted) {
            this.job.state = 'stopping';
            timeout.abort(new Error(`步骤 ${step.skill} 超时`));
          }
        }, step.timeoutMs);
        const signal = AbortSignal.any([controller.signal, timeout.signal]);
        let result;
        try {
          result = await this.adapter.execute(step, { signal, onProgress: detail => {
            if (!signal.aborted) this.emit('step.progress', { skill: step.skill, message: String(detail.message || '').slice(0, 500) });
          } });
          signal.throwIfAborted();
        } catch (error) {
          if (signal.aborted) throw signal.reason;
          throw error;
        } finally { clearTimeout(timer); }
        if (!result || typeof result !== 'object') throw new Error('执行器返回了无效回执');
        if (this.adapter.mode === 'simulation') result = { ...result, simulated: true, verified: false, evidence: null };
        // A receipt alone must never become a verified world observation.
        if (result.verified && !result.evidence) throw new Error('缺少游戏结果证据');
        this.job.lastResult = structuredClone(result);
        this.job.completedSteps++;
        this.emit('step.finished', { skill: step.skill, result: this.job.lastResult });
      }
      this.job.state = this.adapter.mode === 'simulation' ? 'simulated' : 'completed';
    } catch (error) {
      this.job.state = controller.signal.aborted ? 'cancelled' : 'failed';
      this.job.error = error.message || '执行异常';
    } finally {
      this.job.finishedAt = new Date().toISOString();
      this.job.currentSkill = null;
      this.active = null;
      try { this.emit('job.finished', { state: this.job.state, error: this.job.error }); }
      catch { this.job.state = 'failed'; this.job.error = '无法保存执行日志'; }
    }
  }
}

module.exports = { GenshinRuntime };
