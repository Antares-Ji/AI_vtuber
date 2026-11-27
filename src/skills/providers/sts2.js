'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { objectArgs, textArg, intArg } = require('../registry');
const { remoteRun } = require('../local-client');
function register(registry, { root, dataRoot, env, main, sts2, runProcess }) {
  const add = definition => registry.register({ version: '1', ...definition });
  const noArgs = a => objectArgs(a, []);
  add({ id: 'sts2:knowledge', game: 'sts2', mode: 'read',
    description: '检索现有卡牌知识、人工核验经验与条件化复盘，不重新训练或覆盖资料。',
    arguments: { query: 'string', maxCards: '1..20' },
    validate(a) { objectArgs(a, ['query', 'maxCards']); return { query: textArg(a.query, 'query'), maxCards: intArg(a.maxCards, 'maxCards', 10, 20) }; },
    async execute(a) {
      const knowledge = require('../../sts2/knowledge').retrieve(a.query, { file: path.join(dataRoot, 'data/sts2/knowledge.json'), maxCards: a.maxCards });
      const experienceFile = path.join(root, 'docs/sts2-native-experiences-2026-10-26.json');
      const experiences = JSON.parse(fs.readFileSync(experienceFile, 'utf8')).experiences || [];
      const reviewedFile = path.join(dataRoot, 'runtime/game-input/learning/reviewed-cards.json');
      const reviewed = fs.existsSync(reviewedFile) ? JSON.parse(fs.readFileSync(reviewedFile, 'utf8')) : [];
      return { knowledge, experiences: experiences.filter(e => JSON.stringify(e).includes(a.query)).slice(0, 20),
        reviewedCards: reviewed.filter(e => JSON.stringify(e).includes(a.query)).slice(0, 20),
        knowledgeAvailable: Boolean(knowledge), trainingPerformed: false };
    } });
  add({ id: 'sts2:play', game: 'sts2', mode: 'live', resources: ['desktop', 'sts2'],
    description: '复用尖塔 MCP/DeepSeek 执行与复盘链路；停止后等待执行器释放。',
    arguments: { goal: 'string', steps: '1..500' },
    validate(a) { objectArgs(a, ['goal', 'steps']); return { goal: textArg(a.goal, 'goal', '继续当前单人冒险', 1000), steps: intArg(a.steps, 'steps', 100, 500), execute: true }; },
    execute: (a, { signal }) => remoteRun({ request: sts2, routes: { state: '/api/status', start: '/api/start', stop: '/api/stop' },
      start: a, busy: s => s.running === true, failed: s => Boolean(s.lastError), signal }) });
  add({ id: 'sts2:native-play', game: 'sts2', mode: 'live', resources: ['desktop', 'sts2'],
    description: '复用纯视觉、角色决策及原生键鼠循环，保留已核验的通关经验。',
    arguments: { maxSteps: '1..1000', continueAfterDefeat: 'boolean; allow current defeat settlement (up to 3 confirmed clicks), revoked on new adventure' },
    validate(a) { objectArgs(a, ['maxSteps','continueAfterDefeat']); if(a.continueAfterDefeat!==undefined&&typeof a.continueAfterDefeat!=='boolean')throw Error('Invalid continueAfterDefeat'); return { maxSteps: intArg(a.maxSteps, 'maxSteps', 100, 1000), execute: true, continueAfterDefeat:a.continueAfterDefeat??false }; },
    execute: (a, { signal }) => remoteRun({ request: main, routes: { state: '/api/game-input/state', start: '/api/game-input/agent/start', stop: '/api/game-input/stop' },
      start: a, busy: s => s.busy === true || s.autonomous?.running === true,
      failed: s => Boolean(s.lastError || s.autonomous?.lastError), signal }) });
  add({ id: 'sts2:learning-status', game: 'sts2', mode: 'read',
    description: '查看持久学习覆盖率、审核集数量和经验来源；模型推断不升级为实战事实。',
    validate: noArgs, async execute() {
      const data = require('../../sts2/knowledge').read(path.join(dataRoot, 'data/sts2/knowledge.json'));
      const reviewed = path.join(dataRoot, 'runtime/game-input/learning/reviewed-cards.json');
      return { available: Boolean(data), version: data?.version, coverage: data?.coverage,
        reviewedObservations: fs.existsSync(reviewed) ? JSON.parse(fs.readFileSync(reviewed, 'utf8')).length : 0,
        historicalRun: { source: 'docs/sts2-native-learning-2026-10-26.md', floor: 48, result: '胜利……？',
          method: 'Codex监督决策＋本地Qwen辅助视觉＋原生输入', newlyRevalidated: false }, trainingPerformed: false };
    } });
  add({ id: 'sts2:learn', game: 'sts2', mode: 'learning', resources: ['sts2-knowledge'],
    description: '运行既有卡库导入、有限批次分析和长期记忆写入。analyze=true会调用模型；不是权重微调。',
    arguments: { import: 'boolean', analyze: 'boolean', memory: 'boolean', maxCards: '1..120' },
    validate(a) {
      objectArgs(a, ['import', 'analyze', 'memory', 'maxCards']);
      for (const key of ['import', 'analyze', 'memory']) if (a[key] !== undefined && typeof a[key] !== 'boolean') throw Error(`Invalid ${key}`);
      if (!a.import && !a.analyze && !a.memory) throw Error('Select at least one learning operation');
      return { ...a, maxCards: intArg(a.maxCards, 'maxCards', 12, 120) };
    },
    async execute(a, { signal }) {
      const args = [path.join(root, 'scripts/sts2/learn.cjs')];
      for (const key of ['import', 'analyze', 'memory']) if (a[key]) args.push(`--${key}`);
      if (a.analyze) args.push('--limit', String(a.maxCards));
      const output = await runProcess(process.execPath, args, { cwd: root, signal });
      const events = output.split(/\r?\n/).filter(s => s.startsWith('{')).map(s => JSON.parse(s));
      const last = events.at(-1);
      if (last?.event !== 'complete') throw Error('Learning script did not complete');
      return { verified: false, coverage: last, trainingPerformed: false,
        note: 'Knowledge persisted; model hypotheses are not playtested results.' };
    } });

}
module.exports = { register };
