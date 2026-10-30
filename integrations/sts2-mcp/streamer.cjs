'use strict';
const { randomUUID } = require('node:crypto');
const { setTimeout: delay } = require('node:timers/promises');

class StreamerSync {
  constructor({ startTimeout = 65000, endTimeout = 65000 } = {}) {
    this.enabled = false; this.pending = null; this.startTimeout = startTimeout; this.endTimeout = endTimeout;
    this.last = null; this.lastReceipt = null;
  }
  snapshot() { return { enabled: this.enabled, pending: this.pending ? { id: this.pending.id, line: this.pending.line, emotion: this.pending.emotion, state: this.pending.state, tool: this.pending.tool } : null, last: this.last, lastReceipt: this.lastReceipt }; }
  configure(enabled) { this.enabled = enabled; if (!enabled) this.cancel(); return this.snapshot(); }
  cancel() { if (this.pending) this.last = { ...this.pending, state: 'cancelled' }; this.pending = null; }
  queueCommentary(line, emotion = 'playful', source = 'learning') {
    if (!this.enabled || this.pending || typeof line !== 'string' || !line.trim() || line.length > 180) return false;
    this.pending = { id: randomUUID(), at: new Date().toISOString(), state: 'queued', line: line.trim(), emotion, tool: source, scene: 'learning' };
    return true;
  }
  take() {
    if (!this.enabled || !this.pending || this.pending.state !== 'queued') return null;
    this.pending.state = 'delivered';
    return { ...this.pending };
  }
  receipt(id, phase) {
    if (!['started', 'ended', 'failed'].includes(phase) || this.pending?.id !== id) return false;
    this.pending.state = phase;
    this.lastReceipt = { id, phase, at: new Date().toISOString() };
    if (phase === 'ended' || phase === 'failed') { this.last = { ...this.pending, state: phase }; this.pending = null; }
    return true;
  }
  async beforeAction(decision, state, signal) {
    if (!this.enabled || !decision.streamerLine) return;
    const previous = this.pending;
    const previousDeadline = Date.now() + this.endTimeout;
    while (this.pending === previous && previous && this.enabled) {
      signal?.throwIfAborted();
      if (Date.now() >= previousDeadline) { this.cancel(); throw Error('主播播放回执超时，游玩已暂停'); }
      await delay(100, undefined, { signal });
    }
    signal?.throwIfAborted();
    if (!this.enabled) return;
    const entry = { id: randomUUID(), at: new Date().toISOString(), state: 'queued', line: decision.streamerLine,
      emotion: decision.streamerEmotion || 'focused', tool: decision.name, args: decision.args, scene: state.state_type };
    this.pending = entry;
    const abort = () => { if (this.pending === entry) this.cancel(); };
    signal?.addEventListener('abort', abort, { once: true });
    try {
      const deadline = Date.now() + this.startTimeout;
      while (this.pending === entry && !['started', 'ended'].includes(entry.state) && this.enabled) {
        signal?.throwIfAborted();
        if (Date.now() >= deadline) { this.last = { ...entry, state: 'renderer-timeout' }; this.pending = null; throw Error('主播语音尚未就绪，游玩已暂停；请检查直播场景和语音服务'); }
        await delay(100, undefined, { signal });
      }
      if (this.last?.id === entry.id && this.last.state === 'failed') throw Error('主播语音播放失败，游玩已暂停');
    } finally { signal?.removeEventListener('abort', abort); }
  }
}

function liveContext(state, status, capturedAt = Date.now(), sync = null) {
  if (!state || !status) return null;
  return {
    game: 'sts2', gameName: '杀戮尖塔2', schemaVersion: 1, capturedAt,
    active: Boolean(status.running || sync?.enabled), connected: true, stale: false, localOnly: false,
    goal: status.goal || '完成当前单人冒险', phase: status.running ? '自主游玩' : '暂停',
    subgoal: status.lastDecision?.reason || null, run: state.run || null, scene: state.state_type,
    player: state.player ? { character: state.player.character, hp: state.player.hp, maxHp: state.player.max_hp, block: state.player.block, energy: state.player.energy, gold: state.player.gold,
      hand: (state.player.hand || []).slice(0, 12), relics: state.player.relics, potions: state.player.potions } : null,
    battle: state.battle || null, menu: state.menu_screen || null,
    options: state.options || state.event?.options || state.map?.next_options || null,
    intent: status.lastDecision || null, lastResult: status.lastResult || null, error: status.lastError || null,
    speakingHint: '第一人称解释自己的游戏计划。intent只是打算，lastResult只表示接口结果；伤害、击杀、奖励和胜负以最新游戏状态为准。'
  };
}
module.exports = { StreamerSync, liveContext };
