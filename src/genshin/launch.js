'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { processRun } = require('../skills/process');
const { TARGETS } = require('./observe');

function configuredExecutable({ dataRoot, env = process.env }) {
  let executable = env.GENSHIN_EXE;
  if (!executable) {
    const file = path.join(dataRoot, 'data/genshin.local.json');
    if (fs.existsSync(file)) executable = JSON.parse(fs.readFileSync(file, 'utf8')).executable;
  }
  if (typeof executable !== 'string' || !path.isAbsolute(executable)) throw Error('Configure a local absolute GENSHIN_EXE or data/genshin.local.json executable');
  const real = fs.realpathSync(executable);
  if (!TARGETS.some(t => t.toLowerCase() === path.basename(real).toLowerCase()) || !fs.statSync(real).isFile()) {
    throw Error('Only the configured YuanShen.exe or GenshinImpact.exe game executable may launch');
  }
  return real;
}

async function launch({ root, dataRoot = root, env = process.env, signal, runProcess = processRun }) {
  signal.throwIfAborted();
  const executable = configuredExecutable({ dataRoot, env }), nonce = randomUUID();
  const output = await runProcess(path.join(root, 'runtime/vlm-env/Scripts/python.exe'),
    [path.join(root, 'scripts/genshin/launch.py'), '--exe', executable, '--nonce', nonce], { cwd: root, signal });
  signal.throwIfAborted();
  const result = JSON.parse(output.trim());
  if (result.nonce !== nonce || result.target?.toLowerCase() !== path.basename(executable).toLowerCase() ||
      !Number.isInteger(result.pid) || result.pid < 1 || typeof result.started !== 'boolean' ||
      result.inputSent !== false || result.verified !== false || typeof result.windowFound !== 'boolean' ||
      typeof result.foreground !== 'boolean' || (result.foreground && !result.windowFound)) {
    throw Error('Invalid Genshin launch receipt');
  }
  return { ...result, note: 'Process/window receipt only; no login, scene recognition, or gameplay completion. Cancellation does not close the game.' };
}
module.exports = { configuredExecutable, launch };
