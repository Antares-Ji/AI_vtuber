'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { objectArgs, textArg, intArg } = require('../registry');
const { remoteRun } = require('../local-client');
function register(registry, { root, dataRoot, env, main, sts2, runProcess }) {
  const add = definition => registry.register({ version: '1', ...definition });
  const noArgs = a => objectArgs(a, []);
  add({id:'genshin:window-restore',game:'genshin',mode:'live',resources:['desktop','genshin'],
    description:'显式恢复原神窗口；原生互斥及实际权限检查，无游戏按键，不改变观察接口。',validate:noArgs,
    execute:(a,{signal})=>require('../../genshin/window-restore').restoreWindow({root,signal,runProcess})});
  add({id:'genshin:story',game:'genshin',mode:'live',resources:['desktop','genshin'],
    description:'BetterGI持续剧情会话：本地OCR与视觉观察，DeepSeek逐步选择任务、对话与追踪，并生成主播解说。',
    validate(a){objectArgs(a,['goal']);return {goal:textArg(a.goal,'goal')};},
    execute:(a,{signal,reportProgress,jobId})=>require('../../genshin/story-runtime').runStory(a.goal,{root,env,signal,reportProgress,runId:jobId})});
  add({id:'genshin:run-goal',game:'genshin',mode:'live',resources:['desktop','genshin'],
    description:'BetterGI截图→本地视觉API→所选模型决定一项路线/自动任务→BetterGI执行；不循环，无法确认场景则停止。',
    validate(a){objectArgs(a,['goal']);return {goal:textArg(a.goal,'goal')};},
    execute:(a,{signal,reportProgress})=>require('../../genshin/action-planner').runGoal(a.goal,{root,env,signal,reportProgress})});
  add({id:'genshin:bridge-observe',game:'genshin',mode:'live',resources:['desktop','genshin'],
    description:'通过 BetterGI 截图并调用本地视觉模型解释；不启用云端视觉，不生成游戏按键。BetterGI 启动可能激活游戏窗口。',validate:noArgs,
    execute:(a,{signal,reportProgress})=>require('../../genshin/bridge-observe').observe({root,signal,reportProgress})});
  add({ id:'genshin:bridge-start',game:'genshin',mode:'live',resources:['desktop','genshin'],
    description:'连接固定 BetterGI 管理进程；reuseSession仅复用现有授权，不新建提权进程。',
    validate(a){objectArgs(a,['reuseSession']);if(a.reuseSession!==undefined&&(typeof a.reuseSession!=='string'||!/^[0-9a-f-]{36}$/.test(a.reuseSession)))throw Error('Invalid reuse session');return a;},
    execute:(a,{signal})=>require('../../genshin/bridge').start({root,signal,reuseSession:a.reuseSession}) });
  add({ id:'genshin:bridge-command',game:'genshin',mode:'live',resources:['desktop','genshin'],
    description:'BetterGI 官方脚本桥：截图、已安装路线、9类独立任务；支持停止、超时和原生按键释放。接口返回不代表游戏成功。',
    validate:a=>require('../../genshin/bridge').validate(a),
    async execute(a,{signal,reportProgress}) {
      const bridge=require('../../genshin/bridge');
      reportProgress('connecting','正在连接 BetterGI；如系统弹出权限窗口，请完成 Windows 确认');
      await bridge.start({root,signal});
      reportProgress('executing','BetterGI 正在执行；停止后将等待键鼠释放');
      return bridge.execute(a,{signal,reportProgress});
    } });
  add({ id: 'genshin:launch', game: 'genshin', mode: 'live', resources: ['desktop', 'genshin'],
    description: '启动原神；systemPrompt=true 时允许 Windows 显示正常权限确认。',
    validate(a) { objectArgs(a, ['systemPrompt']); if (a.systemPrompt !== undefined && typeof a.systemPrompt !== 'boolean') throw Error('systemPrompt must be boolean'); return { systemPrompt: a.systemPrompt === true }; },
    execute: (a, { signal }) => require('../../genshin/launch').launch({ root, dataRoot, env, signal, runProcess, systemPrompt: a.systemPrompt }) });
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
    description: '通过手动选定的 OpenAI / DeepSeek 规划原神有限技能；不自动切换供应商，生成计划不发送游戏输入。', arguments: { goal: 'string' },
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
