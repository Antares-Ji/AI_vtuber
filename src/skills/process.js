'use strict';
const { spawn } = require('node:child_process');
async function processRun(command, args, { cwd, signal }) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', errors = '';
    child.stdout.on('data', b => { output = (output + b).slice(-100000); });
    child.stderr.on('data', b => { errors = (errors + b).slice(-2000); });
    const abort = () => child.kill();
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', error => { signal.removeEventListener('abort', abort); reject(error); });
    child.once('close', code => {
      signal.removeEventListener('abort', abort);
      if (signal.aborted) return reject(signal.reason);
      if (code !== 0) return reject(Error(`Skill process exited ${code}; inspect local setup (${errors.slice(-300)})`));
      resolve(output);
    });
  });
}

module.exports = { processRun };
