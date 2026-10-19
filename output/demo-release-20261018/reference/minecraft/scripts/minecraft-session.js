const { expanded } = require('../src/minecraft/capability-policy');
// Resident Minecraft connection: task completion/failure never disconnects it.
const mineflayer = require('mineflayer');
const { pathfinder } = require('mineflayer-pathfinder');
const readline = require('node:readline');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomBytes } = require('node:crypto');
const { parseCommand, validateCommand } = require('../src/minecraft/commands');
const { makeWorkbench } = require('../src/minecraft/workbench-task');
const { ReactiveAgent } = require('../src/minecraft/reactive-agent');
const bot = mineflayer.createBot({ host: process.env.MC_HOST || '127.0.0.1', port: Number(process.env.MC_PORT || 25565), username: process.env.MC_USERNAME || 'SuiGeBot', auth: process.env.MC_AUTH || 'offline' });
bot.loadPlugin(pathfinder);
let task = null;
let activeTaskId = null;
const taskResults = new Map();
let connected = false;
const logDir = path.resolve(__dirname, '../logs');
fs.mkdirSync(logDir, { recursive: true });
const logPath = path.join(logDir, `minecraft-session-${Date.now()}.jsonl`);
const log = data => { const line = JSON.stringify({ at: new Date().toISOString(), ...data }); fs.appendFileSync(logPath, line + '\n'); console.log(line); };
const status = () => log({ event: 'status', position: bot.entity?.position, mode: bot.game?.gameMode, players: Object.values(bot.players || {}).map(p => ({ name: p.username, position: p.entity?.position })) });
bot.on('spawn', () => { connected = true; status(); if (process.env.MC_AUTO_DEFENSE !== 'false') reactive.enable(); });
bot.on('messagestr', text => log({ event: 'server_message', text }));
bot.on('error', e => log({ event: 'error', error: e.message }));
bot.on('kicked', reason => log({ event: 'kicked', reason }));
bot.on('end', reason => { connected = false; task?.abort(); log({ event: 'disconnected', reason }); });
const stop = () => { task?.abort(); bot.pathfinder.setGoal(null); bot.clearControlStates(); try { bot.stopDigging(); } catch {} };
const isBusy = () => Boolean(task) || Boolean(require('../src/minecraft/survival-skills').isSkillBusy(bot));
let reactive = new ReactiveAgent(bot, { interruptTask: stop, taskBusy: isBusy, log });
// Movement failures do not silently retry forever; the next observation decides.
bot.on('path_update', result => { if (result.status === 'noPath') log({ event: 'path_unreachable', mode: reactive.mode }); });
async function execute(line) {
  const command = parseCommand(line);
  validateCommand(command, { connected, busy: isBusy(), mode: bot.game?.gameMode });
  if (command === 'status') return status();
  if (command === 'defend') { reactive.enable(); return; }
  if (command === 'tp') {
    const owner = process.env.MC_OWNER || 'Antares_Ji';
    if (![bot.username, owner].every(name => /^[A-Za-z0-9_]{1,16}$/.test(name))) throw new Error('Invalid player name');
    bot.chat(`/tp ${bot.username} ${owner}`); log({ event: 'tp_requested', verified: false }); setTimeout(status, 2000); return;
  }
  if (command === 'stop') { reactive.halt(); stop(); return; }
  if (command === 'quit') { reactive.dispose(); stop(); bot.quit(); control.close(); input.close(); return; }
  if (command === 'workbench' && !expanded && reactive.mode !== 'idle') throw new Error('正在处理敌对威胁，暂不采集');
  if (command !== 'workbench' || isBusy()) return;
  if (bot.game?.gameMode !== 'survival') return log({ event: 'task_blocked', reason: 'Harvesting drops requires survival mode' });
  task = new AbortController();
  const timeout = setTimeout(stop, 180000);
  try {
    // Reload task implementation only at a new task boundary, never mid-action.
    const taskPath = require.resolve('../src/minecraft/workbench-task');
    delete require.cache[taskPath];
    await require(taskPath).makeWorkbench(bot, { signal: task.signal, log });
  }
  catch (e) { stop(); log({ event: 'task_failed', error: e.message }); }
  finally { clearTimeout(timeout); task = null; log({ event: 'idle', connected }); }
}
const input = readline.createInterface({ input: process.stdin });
input.on('line', line => execute(line).catch(e => log({ event: 'command_rejected', error: e.message })));
// Local authenticated control remains usable when launched without stdin.
const token = randomBytes(32).toString('hex');
function skillModule() { return require('../src/minecraft/survival-skills'); }
async function runSkill(taskId, action) {
  const controller = new AbortController();
  task = controller; activeTaskId = taskId;
  const entry = { taskId, action, status: 'running', startedAt: new Date().toISOString() };
  taskResults.set(taskId, entry);
  while (taskResults.size > 100) taskResults.delete(taskResults.keys().next().value);
  const timer = setTimeout(() => controller.abort(new Error('Skill deadline exceeded')), 120000);
  const onAbort = () => { bot.pathfinder.setGoal(null); bot.clearControlStates(); try { bot.stopDigging(); } catch {} };
  controller.signal.addEventListener('abort', onAbort, { once: true });
  log({ event: 'skill_started', taskId, action });
  try {
    entry.result = await skillModule().executeSkill(bot, action, { signal: controller.signal, timeoutMs: 110000, log: data => log({ ...data, taskId }) });
    controller.signal.throwIfAborted();
    entry.status = 'completed';
  } catch (error) { entry.status = controller.signal.aborted ? 'cancelled' : 'failed'; entry.error = error.message; if (error.partialResult) entry.partialResult = error.partialResult; onAbort(); }
  finally {
    clearTimeout(timer); controller.signal.removeEventListener('abort', onAbort);
    entry.finishedAt = new Date().toISOString();
    if (task === controller) { task = null; activeTaskId = null; }
    log({ event: 'skill_finished', ...entry });
  }
}
const control = http.createServer(async (req, res) => {
  const send = (code, value) => { res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(value)); };
  if (req.headers.authorization !== `Bearer ${token}`) return send(401, { error: 'Unauthorized' });
  const url = new URL(req.url, 'http://127.0.0.1');
  if (req.method === 'GET' && url.pathname === '/capabilities') {
    const schema = skillModule().SURVIVAL_ACTION_SCHEMA;
    return send(200, { expanded, count: schema.oneOf.length, actions: schema.oneOf.map(s => s.properties.action.const), schema });
  }
  if (req.method === 'POST' && url.pathname === '/reload') {
    if (isBusy()) return send(409, { error: 'Task still running; reload refused' });
    try {
      const enabled = reactive.enabled;
      delete require.cache[require.resolve('../src/minecraft/reactive-agent')];
      delete require.cache[require.resolve('../src/minecraft/survival-skills')];
      delete require.cache[require.resolve('../src/minecraft/extended-actions')];
      delete require.cache[require.resolve('../src/minecraft/native-actions')];
      const nextModule = require('../src/minecraft/reactive-agent');
      require('../src/minecraft/survival-skills');
      reactive.dispose();
      reactive = new nextModule.ReactiveAgent(bot, { interruptTask: stop, taskBusy: isBusy, log });
      if (enabled) reactive.enable();
      log({ event: 'skills_reloaded', connected });
      return send(200, { reloaded: true, connected });
    } catch (error) { return send(500, { error: error.message }); }
  }
  if (req.method === 'GET' && url.pathname === '/task') {
    const entry = taskResults.get(url.searchParams.get('id'));
    return send(entry ? 200 : 404, entry || { error: 'Unknown task' });
  }
  if (req.method === 'GET' && url.pathname === '/observe') {
    try { return send(200, { ...skillModule().observe(bot), connected, busy: isBusy(), activeTaskId, reactive: reactive.snapshot, sessionId: logPath }); }
    catch (error) { return send(503, { error: error.message }); }
  }
  if (req.method === 'GET' && req.url === '/status') return send(200, { connected, busy: isBusy(), activeTaskId, position: bot.entity?.position, mode: bot.game?.gameMode, health: bot.health, food: bot.food, reactive: reactive.snapshot, inventory: bot.inventory?.items().map(({ name, count }) => ({ name, count })), logPath });
  if (req.method === 'POST' && ['/skill', '/cancel-task'].includes(url.pathname)) {
    try {
      let body = ''; for await (const chunk of req) { body += chunk; if (body.length > 4096) return send(413, { error: 'Too large' }); }
      const payload = JSON.parse(body);
      if (url.pathname === '/cancel-task') {
        if (payload.taskId === activeTaskId) stop();
        return send(200, { requested: true, matched: payload.taskId === activeTaskId });
      }
      if (typeof payload.taskId !== 'string' || !/^[a-zA-Z0-9_-]{1,80}$/.test(payload.taskId)) throw new Error('Invalid taskId');
      if (taskResults.has(payload.taskId)) return send(200, taskResults.get(payload.taskId));
      skillModule().validateAction(payload.action);
      if (!connected || !bot.entity || (bot.health <= 0 && payload.action.action !== 'respawn')) return send(409, { error: 'Bot unavailable' });
      if (isBusy() || (!expanded && reactive.mode !== 'idle')) return send(409, { error: 'Bot busy or safety reflex active' });
      void runSkill(payload.taskId, payload.action);
      return send(202, { taskId: payload.taskId, status: 'running' });
    } catch (error) { return send(400, { error: error.message }); }
  }
  if (req.method !== 'POST' || req.url !== '/command') return send(404, { error: 'Not found' });
  try {
    let body = '';
    for await (const chunk of req) { body += chunk; if (body.length > 2048) return send(413, { error: 'Too large' }); }
    const command = parseCommand(JSON.parse(body).command);
    validateCommand(command, { connected, busy: isBusy(), mode: bot.game?.gameMode });
    const running = execute(command);
    running.catch(e => log({ event: 'command_failed', error: e.message }));
    send(202, { accepted: command, completed: false, logPath });
  } catch (error) { send(400, { error: error.message }); }
});
control.on('error', error => log({ event: 'control_error', error: error.message }));
control.listen(Number(process.env.MC_CONTROL_PORT || 3001), '127.0.0.1', () => {
  fs.writeFileSync(path.join(logDir, 'minecraft-control.json'), JSON.stringify({ port: control.address().port, token, pid: process.pid }));
  log({ event: 'control_ready', port: control.address().port });
});
