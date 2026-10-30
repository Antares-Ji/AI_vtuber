'use strict';
const path = require('node:path');
const { localClient } = require('./local-client');
const { processRun } = require('./process');
const ROOT = path.resolve(__dirname, '../..');
function registerBuiltins(registry, { root = ROOT, env = process.env, clients = {}, runProcess = processRun } = {}) {
  const context = { root, env, runProcess, dataRoot: path.resolve(env.AIVTUBER_LOCAL_DATA_ROOT || root),
    main: clients.main || localClient(`http://127.0.0.1:${env.PORT || 3000}`),
    sts2: clients.sts2 || localClient(`http://127.0.0.1:${env.STS2_CONTROL_PORT || 15527}`) };
  for (const name of ['minecraft', 'sts2', 'genshin', 'streamer']) require(`./providers/${name}`).register(registry, context);
}
module.exports = { registerBuiltins, processRun };
