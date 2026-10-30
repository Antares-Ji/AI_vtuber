'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { objectArgs, textArg, intArg } = require('../registry');
const { remoteRun } = require('../local-client');
function register(registry, { root, dataRoot, env, main, sts2, runProcess }) {
  const add = definition => registry.register({ version: '1', ...definition });
  const noArgs = a => objectArgs(a, []);
  add({ id: 'mcplayer:harness-demo', game: 'minecraft', mode: 'simulation', resources: ['mcplayer-demo'],
    description: '运行原版 Java AgentHarness 的确定性演示，保留原始验收与任务记录。',
    validate: noArgs, async execute(args, { signal, jobId }) {
      const lib = path.join(root, 'mc-player-agent/harness/build/install/mc-player-agent-harness/lib');
      if (!fs.existsSync(lib)) throw Error('Build mc-player-agent harness installDist first');
      const output = await runProcess(env.JAVA_COMMAND || 'java', ['-cp', path.join(lib, '*'),
        'dev.mcplayeragent.harness.HarnessMain', 'demo', path.join(root, 'runtime/skills/mc-demo', jobId)],
      { cwd: root, signal });
      const result = JSON.parse(output.trim());
      if (!result || result.state !== 'VERIFIED' || result.simulation !== true) throw Error('Java harness demo did not verify');
      return { ...result, simulated: true, verified: false, note: 'Original harness VERIFIED in simulation only.' };
    } });
  add({ id: 'mcplayer:inspect-profile', game: 'minecraft', mode: 'read',
    description: '查看 ZIP 的版本化示例配置与原生 Skill 清单；实际 MC 继续使用 F8/F9。',
    validate: noArgs, async execute() {
      const profile = JSON.parse(fs.readFileSync(path.join(root, 'mc-player-agent/examples/profiles/collector.json'), 'utf8'));
      return { profile, transport: 'native-client-F8-F9', remoteControl: false,
        docs: 'mc-player-agent/docs/EXTENSIONS.md' };
    } });
  add({ id: 'minecraft:legacy-status', game: 'minecraft', mode: 'read',
    description: '读取本地 Mineflayer 兼容后端、反射与自主任务状态。', validate: noArgs,
    async execute(args, { signal }) {
      const [world, loop] = await Promise.all([main('/api/minecraft/status', undefined, signal), main('/api/minecraft/loop', undefined, signal)]);
      return { backend: 'legacy-mineflayer', world, loop };
    } });
  add({ id: 'minecraft:legacy-play', game: 'minecraft', mode: 'live', resources: ['desktop', 'minecraft'],
    description: '保留 Mineflayer 生存反射、脱困、任务复盘及解说；与原生 MC 后端分开运行。',
    arguments: { goal: 'string', durationMinutes: '1..20' },
    validate(a) { objectArgs(a, ['goal', 'durationMinutes']); return { enabled: true,
      goal: textArg(a.goal, 'goal'), durationMinutes: intArg(a.durationMinutes, 'durationMinutes', 5, 20), continuous: false, untilStopped: false }; },
    execute: (a, { signal }) => remoteRun({ request: main,
      routes: { state: '/api/minecraft/loop', start: '/api/minecraft/loop', stop: '/api/minecraft/stop' },
      start: a, busy: s => s.enabled === true || s.running === true,
      failed: s => Boolean(s.lastError), signal }) });

}
module.exports = { register };
