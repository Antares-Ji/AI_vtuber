// Resident Minecraft connection: task completion/failure never disconnects it.
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const readline = require('node:readline');
const { makeWorkbench } = require('../src/minecraft/workbench-task');
const bot = mineflayer.createBot({ host: process.env.MC_HOST || '127.0.0.1', port: Number(process.env.MC_PORT || 25565), username: process.env.MC_USERNAME || 'SuiGeBot', auth: process.env.MC_AUTH || 'offline' });
bot.loadPlugin(pathfinder);
let task = null;
const log = data => console.log(JSON.stringify({ at: new Date().toISOString(), ...data }));
const status = () => log({ event: 'status', position: bot.entity?.position, mode: bot.game?.gameMode, players: Object.values(bot.players || {}).map(p => ({ name: p.username, position: p.entity?.position })) });
bot.on('spawn', status);
bot.on('messagestr', text => log({ event: 'server_message', text }));
bot.on('error', e => log({ event: 'error', error: e.message }));
bot.on('kicked', reason => log({ event: 'kicked', reason }));
bot.on('end', reason => { task?.abort(); log({ event: 'disconnected', reason }); });
const stop = () => { task?.abort(); bot.pathfinder.setGoal(null); bot.clearControlStates(); try { bot.stopDigging(); } catch {} };
readline.createInterface({ input: process.stdin }).on('line', async line => {
  const command = line.trim();
  if (command === 'status') return status();
  if (command === 'tp') { bot.chat('/tp SuiGeBot Antares_Ji'); setTimeout(status, 2000); return; }
  if (command === 'stop') { stop(); return; }
  if (command === 'quit') { stop(); bot.quit(); process.exitCode = 0; return; }
  if (command !== 'workbench' || task) return;
  if (bot.game?.gameMode !== 'survival') return log({ event: 'task_blocked', reason: 'Harvesting drops requires survival mode' });
  task = new AbortController();
  const timeout = setTimeout(stop, 180000);
  try { await makeWorkbench(bot, { signal: task.signal, log }); }
  catch (e) { stop(); log({ event: 'task_failed', error: e.message }); }
  finally { clearTimeout(timeout); task = null; log({ event: 'idle', connected: true }); }
});
