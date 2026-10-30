'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID, createHash } = require('node:crypto');
const { performance } = require('node:perf_hooks');

// This owns a skill invocation, not the game's planning loop. Engines retain
// their own native action, receipt, emergency and goal acceptance semantics.
class SkillRuntime {
  constructor({ registry, directory = null, maxRuntimeMs = 1200000, clock = () => performance.now() }) {
    this.registry = registry; this.directory = directory; this.maxRuntimeMs = maxRuntimeMs;
    this.clock = clock; this.active = new Map(); this.jobs = new Map(); this.owners = new Map();
    if (directory) fs.mkdirSync(directory, { recursive: true });
  }
  list() { return this.registry.list(); }
  status(id) { return structuredClone(this.jobs.get(id) || null); }
  recent() { return [...this.jobs.keys()].slice(-30).reverse().map(id => this.status(id)); }
  event(job, type) {
    if (!this.directory) return;
    // Do not persist user goals, prompts, raw model answers, endpoint credentials,
    // arbitrary provider data or raw errors in the public execution timeline.
    fs.appendFileSync(path.join(this.directory, `${job.id}.jsonl`), JSON.stringify({
      at: new Date().toISOString(), id: job.id, skill: job.skill, version: job.version,
      type, state: job.state, mode: job.mode, profileHash: job.profileHash
    }) + '\n');
  }
  start({ skill: id, args = {}, allowLive = false, timeoutMs = this.maxRuntimeMs } = {}) {
    if (this.closing) throw Error('Skill host is shutting down');
    const skill = this.registry.get(id);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > this.maxRuntimeMs) throw Error('Invalid runtime budget');
    if (skill.mode === 'live' && allowLive !== true) throw Error('Live skill requires allowLive=true');
    const input = skill.validate(structuredClone(args));
    const resources = skill.resources;
    for (const resource of resources) if (this.owners.has(resource)) throw Error(`Resource busy: ${resource}`);
    const job = { id: randomUUID(), skill: skill.id, version: skill.version, game: skill.game,
      mode: skill.mode, state: 'RUNNING', startedAt: new Date().toISOString(), finishedAt: null,
      timeoutMs, result: null, error: null, reason: null,
      profileHash: createHash('sha256').update(JSON.stringify({ skill: skill.id, version: skill.version, input, timeoutMs })).digest('hex') };
    const controller = new AbortController();
    const handle = { controller, started: this.clock(), task: null };
    for (const resource of resources) this.owners.set(resource, job.id);
    this.jobs.set(job.id, job); this.active.set(job.id, handle);
    const timer = setTimeout(() => this.stop(job.id, 'BUDGET_EXHAUSTED'), timeoutMs);
    handle.task = Promise.resolve().then(async () => {
      try {
        this.event(job, 'started');
        controller.signal.throwIfAborted();
        const result = await skill.execute(input, { signal: controller.signal, jobId: job.id });
        if (this.clock() - handle.started >= timeoutMs) this.stop(job.id, 'BUDGET_EXHAUSTED');
        controller.signal.throwIfAborted();
        if (!result || typeof result !== 'object') throw Error('Missing skill receipt');
        job.result = structuredClone(result);
        // A result's `verified:true` never bypasses a provider's evidence verifier.
        job.state = skill.mode === 'simulation' || result.simulated === true ? 'SIMULATED' :
          skill.mode === 'read' ? 'COMPLETED' :
          typeof skill.verify === 'function' && await skill.verify(result, input) === true ? 'VERIFIED' : 'UNVERIFIED';
        if (this.clock() - handle.started >= timeoutMs) this.stop(job.id, 'BUDGET_EXHAUSTED');
        controller.signal.throwIfAborted();
      } catch (error) {
        job.state = controller.signal.aborted ? 'INTERRUPTED' : 'FAILED';
        job.error = controller.signal.aborted ? null : String(error.message || 'Skill failed').slice(0, 500);
      } finally {
        clearTimeout(timer);
        // execute must settle only AFTER input cleanup. A wedged provider keeps
        // its resources while STOPPING; elapsed time never grants a second owner.
        job.finishedAt = new Date().toISOString();
        this.active.delete(job.id);
        for (const resource of resources) if (this.owners.get(resource) === job.id) this.owners.delete(resource);
        try { this.event(job, 'finished'); } catch { job.state = 'FAILED'; job.error = 'Cannot persist execution timeline'; }
        // Bound public history; never evict an active job.
        for (const id of this.jobs.keys()) if (this.jobs.size > 100 && !this.active.has(id)) this.jobs.delete(id);
      }
      return this.status(job.id);
    });
    return this.status(job.id);
  }
  stop(id, reason = 'USER_STOP') {
    const handle = this.active.get(id), job = this.jobs.get(id);
    if (handle && !handle.controller.signal.aborted) {
      job.state = 'STOPPING'; job.reason = reason;
      handle.controller.abort(Error(reason));
    }
    return this.status(id);
  }
  async wait(id) { const handle = this.active.get(id); return handle ? handle.task : this.status(id); }
  async close() { this.closing = true; const ids = [...this.active.keys()]; ids.forEach(id => this.stop(id)); await Promise.all(ids.map(id => this.wait(id))); }
}
module.exports = { SkillRuntime };
