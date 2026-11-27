'use strict';

const fs = require('node:fs');
const { setTimeout: delay } = require('node:timers/promises');

class MockAdapter {
  mode = 'simulation';
  constructor({ delayMs = 300 } = {}) { this.delayMs = delayMs; }
  status() { return { mode: this.mode, ready: true, gameConnected: false }; }
  async execute(step, { signal, onProgress }) {
    signal.throwIfAborted();
    onProgress({ message: `模拟 ${step.skill}，没有发送游戏输入` });
    await delay(this.delayMs, undefined, { signal });
    return { simulated: true, verified: false, evidence: null, message: '模拟步骤完成；未观察或操作原神' };
  }
}

class BetterGiAdapter {
  mode = 'bettergi';
  constructor({ executable = process.env.BETTERGI_EXE || '' } = {}) { this.executable = executable; }
  status() {
    let executableFound = false;
    try { executableFound = fs.statSync(this.executable).isFile(); } catch { /* not configured */ }
    return { mode: this.mode, ready: false, gameConnected: false, executableConfigured: Boolean(this.executable), executableFound,
      reason: 'BetterGI 实机桥接待验证：需要启动、取消、回执及截图证据，暂不发送键鼠或启动进程' };
  }
  async diagnose({ signal, ping = require('./bettergi-ipc').pingBetterGi } = {}) {
    const ipc = await ping({ signal });
    return { ...this.status(), ipc, bridgeReady: false,
      note: ipc.online ? '已收到 BetterGI 本机实例存活回执；ping 不证明游戏已连接、任务可取消或截图有效。' : '未收到 BetterGI 本机实例存活回执；未启动程序或游戏。' };
  }
  async execute() { throw new Error(this.status().reason); }
}

module.exports = { MockAdapter, BetterGiAdapter };
