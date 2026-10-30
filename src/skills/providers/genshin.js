'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { objectArgs, textArg, intArg } = require('../registry');
const { remoteRun } = require('../local-client');
function register(registry, { root, dataRoot, env, main, sts2, runProcess }) {
  const add = definition => registry.register({ version: '1', ...definition });
  const noArgs = a => objectArgs(a, []);
  add({ id: 'genshin:observe', game: 'genshin', mode: 'read', resources: ['desktop', 'genshin'],
    description: '原神前台窗口原生截图，再调用本地视觉 API；不切换窗口、不发送键鼠、不启动 BetterGI 任务。',
    arguments: { target: 'YuanShen.exe | GenshinImpact.exe (default YuanShen.exe)' },
    validate(a) {
      objectArgs(a, ['target']); const target = a.target ?? 'YuanShen.exe';
      if (!require('../../genshin/observe').TARGETS.includes(target)) throw Error('Unsupported Genshin executable');
      return { target };
    },
    execute: (a, { signal }) => require('../../genshin/observe').observe({ root, target: a.target, signal, runProcess }) });
  add({ id: 'genshin:plan', game: 'genshin', mode: 'read',
    description: '通过 DeepSeek API 规划原神有限技能；生成计划不发送游戏输入。', arguments: { goal: 'string' },
    validate(a) { objectArgs(a, ['goal']); return { goal: textArg(a.goal, 'goal') }; },
    execute: async (a, { signal }) => ({ plan: await require('../../genshin/api-planner').planWithApi(a.goal, { dataRoot, env, signal }), executed: false }) });
  for (const mode of ['demo', 'bettergi']) {
    add({ id: `genshin:${mode}`, game: 'genshin', mode: mode === 'demo' ? 'simulation' : 'live',
      resources: mode === 'demo' ? ['genshin-simulation'] : ['desktop', 'genshin'],
      description: mode === 'demo' ? '运行原神模拟技能，明确标记无游戏输入。' : '保留 BetterGI 接入：未完成启动、取消与证据桥接时拒绝实机执行。',
      arguments: { goal: 'string' },
      validate(a) { objectArgs(a, ['goal']); return { goal: textArg(a.goal, 'goal', '观察当前场景') }; },
      async execute(a, { signal }) {
        const { MockAdapter, BetterGiAdapter } = require('../../genshin/adapters');
        const { GenshinRuntime } = require('../../genshin/runtime');
        const adapter = mode === 'demo' ? new MockAdapter() : new BetterGiAdapter({ executable: env.BETTERGI_EXE });
        if (mode === 'bettergi' && !adapter.status().ready) throw Error(adapter.status().reason);
        const plan = mode === 'demo' ? await require('../../genshin/planner').planGoal(a.goal, { mode: 'rules', signal }) :
          await require('../../genshin/api-planner').planWithApi(a.goal, { dataRoot, env, signal });
        const runtime = new GenshinRuntime({ adapter });
        signal.throwIfAborted();
        runtime.start(plan);
        const stop = () => runtime.stop(); signal.addEventListener('abort', stop, { once: true });
        if (signal.aborted) stop();
        try { await runtime.done; signal.throwIfAborted();
          const state = runtime.status();
          if (state.job.state === 'failed') throw Error(state.job.error);
          return { simulated: mode === 'demo', verified: false, ...state, context: runtime.context() };
        } finally { signal.removeEventListener('abort', stop); runtime.stop(); await runtime.done; }
      } });
  }
  add({ id: 'genshin:doctor', game: 'genshin', mode: 'read',
    description: '通过本机 IPC 检查 BetterGI 实例及路径；在线不代表游戏或执行桥接就绪。', validate: noArgs,
    async execute(a, { signal }) { const { BetterGiAdapter } = require('../../genshin/adapters'); return new BetterGiAdapter({ executable: env.BETTERGI_EXE }).diagnose({ signal }); } });

}
module.exports = { register };
