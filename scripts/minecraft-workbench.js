const fs = require('node:fs');
const path = require('node:path');
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const { makeWorkbench } = require('../src/minecraft/workbench-task');

async function main() {
  const host = process.env.MC_HOST || '127.0.0.1';
  const port = Number(process.env.MC_PORT || 25565);
  const auth = process.env.MC_AUTH || 'offline';
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Invalid MC_PORT');
  if (!['offline', 'microsoft'].includes(auth)) throw new Error('MC_AUTH must be offline or microsoft');
  const logDir = path.resolve(__dirname, '../logs');
  fs.mkdirSync(logDir, { recursive: true });
  const logPath = path.join(logDir, `minecraft-workbench-${Date.now()}.jsonl`);
  const log = event => {
    const line = JSON.stringify({ at: new Date().toISOString(), ...event });
    fs.appendFileSync(logPath, line + '\n');
    console.log(line);
  };
  const controller = new AbortController();
  const bot = mineflayer.createBot({ host, port, auth, username: process.env.MC_USERNAME || 'SuiGeBot',
    ...(process.env.MC_VERSION ? { version: process.env.MC_VERSION } : {}) });
  bot.loadPlugin(pathfinder);
  const abort = reason => { if (!controller.signal.aborted) controller.abort(new Error(reason)); };
  const onInterrupt = () => abort('operator interrupted');
  const timer = setTimeout(() => abort('Task exceeded 180 seconds'), 180000);
  process.once('SIGINT', onInterrupt);
  bot.on('error', error => abort(error.message));
  bot.on('kicked', reason => abort(`server kicked bot: ${JSON.stringify(reason)}`));
  bot.on('end', reason => abort(`connection ended: ${reason}`));
  const stop = () => {
    bot.pathfinder.setGoal(null);
    bot.clearControlStates();
    try { bot.stopDigging(); } catch {}
    bot.quit();
  };
  controller.signal.addEventListener('abort', stop, { once: true });
  try {
    log({ step: 'connect', host, port, auth });
    await new Promise((resolve, reject) => {
      const onSpawn = () => { cleanup(); resolve(); };
      const onAbort = () => { cleanup(); reject(controller.signal.reason); };
      const cleanup = () => { bot.removeListener('spawn', onSpawn); controller.signal.removeEventListener('abort', onAbort); };
      bot.once('spawn', onSpawn);
      controller.signal.addEventListener('abort', onAbort, { once: true });
      if (controller.signal.aborted) onAbort();
    });
    bot.once('death', () => abort('Bot died; task stopped'));
    log({ step: 'spawned', version: bot.version, position: bot.entity.position });
    await makeWorkbench(bot, { signal: controller.signal, log });
    log({ status: 'success', logPath });
  } catch (error) {
    abort(error.message);
    log({ status: 'failed', error: error.message, logPath });
    process.exitCode = 1;
  } finally {
    clearTimeout(timer);
    process.removeListener('SIGINT', onInterrupt);
    controller.signal.removeEventListener('abort', stop);
    stop();
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
