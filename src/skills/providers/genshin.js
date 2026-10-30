'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { objectArgs, textArg, intArg } = require('../registry');
const { remoteRun } = require('../local-client');
function register(registry, { root, dataRoot, env, main, sts2, runProcess }) {
  const add = definition => registry.register({ version: '1', ...definition });
  const noArgs = a => objectArgs(a, []);
  add({ id: 'genshin:plan', game: 'genshin', mode: 'read',
    description: '复用原神有限技能规划；生成计划不发送游戏输入。', arguments: { goal: 'string' },
    validate(a) { objectArgs(a, ['goal']); return { goal: textArg(a.goal, 'goal') }; },
    execute: async a => ({ plan: await require('../../genshin/planner').planGoal(a.goal), executed: false }) });
  for (const mode of ['demo', 'bettergi']) {
    add({ id: `genshin:${mode}`, game: 'genshin', mode: mode === 'demo' ? 'simulation' : 'live',
      resources: mode === 'demo' ? ['genshin-simulation'] : ['desktop', 'genshin'],
      description: mode === 'demo' ? '运行原神模拟技能，明确标记无游戏输入。' : '保留 BetterGI 接入：未完成启动、取消与证据桥接时拒绝实机执行。',
      arguments: { goal: 'string' },
      validate(a) { objectArgs(a, ['goal']); return { goal: textArg(a.goal, 'goal', '观察当前场景') }; },
      async execute(a, { signal }) {
        const { MockAdapter, BetterGiAdapter } = require('../../genshin/adapters');
        const { GenshinRuntime } = require('../../genshin/runtime');
        const plan = await require('../../genshin/planner').planGoal(a.goal);
        const runtime = new GenshinRuntime({ adapter: mode === 'demo' ? new MockAdapter() : new BetterGiAdapter({ executable: env.BETTERGI_EXE }) });
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
    description: '诊断 BGI 路径与桥接成熟度；程序存在不代表已连接游戏。', validate: noArgs,
    async execute() { const { BetterGiAdapter } = require('../../genshin/adapters'); return new BetterGiAdapter({ executable: env.BETTERGI_EXE }).status(); } });

}
module.exports = { register };
