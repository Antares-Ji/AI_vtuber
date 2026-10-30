'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { objectArgs, textArg, intArg } = require('../registry');
const { remoteRun } = require('../local-client');
function register(registry, { root, dataRoot, env, main, sts2, runProcess }) {
  const add = definition => registry.register({ version: '1', ...definition });
  const noArgs = a => objectArgs(a, []);
  add({ id: 'streamer:context', game: 'shared', mode: 'read',
    description: '统一主播上下文格式，保留人格、记忆和语音系统，区分计划与事实。',
    validate(a) { objectArgs(a, ['context']); if (!a.context || !['minecraft', 'sts2', 'genshin'].includes(a.context.game)) throw Error('Invalid game context'); return a; },
    execute: async a => ({ message: require('../../games/live-context').gameContextMessage(a.context) }) });
}
module.exports = { register };
