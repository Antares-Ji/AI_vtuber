// Local console adapter for the same native CLI used in verified game trials.
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const ROOT = path.resolve(__dirname, '../..');
const BASE = path.join(ROOT, 'runtime/game-input');
const RUNS = path.join(BASE, 'runs');
const STOP = path.join(BASE, 'STOP_INPUT');

function localRequest(req) {
  try {
    const host = new URL(`http://${req.headers.host}`);
    return ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress) &&
      ['127.0.0.1', 'localhost', '[::1]'].includes(host.hostname) &&
      (!req.headers.origin || req.headers.origin === host.origin);
  } catch { return false; }
}
function runInfo(id) {
  if (!/^\d{15,22}$/.test(id)) return null;
  try {
    const folder = path.join(RUNS, id);
    const result = JSON.parse(fs.readFileSync(path.join(folder, 'result.json'), 'utf8'));
    const frames = fs.readdirSync(folder).filter(n => /^frame-\d{4}\.jpg$/.test(n)).sort();
    delete result.motion_trace;
    return { ...result, id, updatedAt: fs.statSync(path.join(folder, 'result.json')).mtimeMs,
      image: frames.length ? `/api/game-input/evidence/${id}/${frames.at(-1)}` : null,
      recording: `/api/game-input/evidence/${id}/recording.avi` };
  } catch { return null; }
}
function recent() {
  try { return fs.readdirSync(RUNS).filter(n => /^\d{15,22}$/.test(n)).sort().reverse().slice(0, 20).map(runInfo).filter(Boolean); }
  catch { return []; }
}
function hoverPointerMode() {
  const file = path.join(BASE, 'hover-pointer.json');
  if (!fs.existsSync(file)) return 'absolute';
  const value = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (!value || Object.keys(value).some(k => k !== 'mode') || !['absolute', 'relative'].includes(value.mode)) throw Error('Invalid local hover pointer configuration');
  return value.mode;
}
function gesture(body, pointerMode = 'absolute') {
  const point = value => {
    if (!Array.isArray(value) || value.length !== 2 || value.some(n => typeof n !== 'number' || !Number.isFinite(n) || n < 0 || n > 1)) throw new Error('坐标必须是客户区内的 [x,y]，范围 0..1');
    return value;
  };
  const wait = { action: 'wait', duration: .7 };
  switch (body.kind) {
    case 'capture': return null;
    case 'click': return [{ action: 'click', to: point(body.to), duration: .35, hold: .1 }, wait];
    case 'hover':
      if (!['absolute', 'relative'].includes(pointerMode)) throw Error('Unsupported hover pointer mode');
      return [{ action: 'move', to: point(body.to), duration: .35, ...(pointerMode === 'relative' ? { pointer_mode: 'relative' } : {}) }, wait];
    case 'drag': return [{ action: 'move', to: point(body.from), duration: .4 }, { action: 'wait', duration: .35 }, { action: 'down' }, { action: 'wait', duration: .15 }, { action: 'move', to: point(body.to), duration: .8 }, { action: 'wait', duration: .2 }, { action: 'up' }, wait, { action: 'move', to: [.5, .35], duration: .2 }];
    case 'scroll':
      if (!Number.isInteger(body.steps) || Math.abs(body.steps) > 10 || body.steps === 0) throw new Error('滚轮范围为 -10..10，不能为 0');
      return [{ action: 'scroll', to: point(body.to || [.5, .5]), steps: body.steps, duration: .3 }, wait];
    case 'key':
      if (!/^(ESC|ENTER|SPACE|TAB|LEFT|RIGHT|UP|DOWN|[A-Z0-9])$/.test(body.key)) throw new Error('不支持的游戏按键');
      return [{ action: 'key', key: body.key, hold: .1 }, wait];
    default: throw new Error('未知动作');
  }
}
function createGameInputRoutes({ parseBody, send, persona = () => ({}) }) {
  let busy = false, lastError = null;
  const { NativeAutonomy } = require('../sts2/native-autonomy');
  const autonomous = new NativeAutonomy({ persona, request: async (route, body, signal, token) => {
    const response = await fetch(`http://127.0.0.1:${Number(process.env.PORT || 3000)}/api/game-input/${route}`, {
      method: body === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', 'x-native-agent': token },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.any([signal, AbortSignal.timeout(180000)])
    });
    const result = await response.json(); if (!response.ok) throw Error(result.error || `本地接口HTTP ${response.status}`); return result;
  } });
  return async function handle(req, res, url) {
    if (!url.pathname.startsWith('/api/game-input/')) return false;
    const reply = (code, data) => { send(res, code, data); return true; };
    if (!localRequest(req)) return reply(403, { error: '仅允许本机导演控制台' });
    if (req.method === 'GET' && url.pathname === '/api/game-input/state') return reply(200, { busy, stopped: fs.existsSync(STOP), lastError, autonomous: autonomous.snapshot(), driver: 'project_native_win32', decisionMode: autonomous.state.running ? '角色API自主决策' : '手动/待启动', target: 'SlayTheSpire2.exe', runs: recent() });
    if (req.method === 'GET' && url.pathname === '/api/game-input/vision-state') {
      try { const response = await fetch('http://127.0.0.1:17646/health', { signal: AbortSignal.timeout(2000) }); return reply(response.status, await response.json()); }
      catch { return reply(200, { ready: false, error: '本地视觉模型尚未启动' }); }
    }
    const evidence = url.pathname.match(/^\/api\/game-input\/evidence\/(\d{15,22})\/(frame-\d{4}\.jpg|recording\.avi|result\.json)$/);
    if (req.method === 'GET' && evidence) {
      const file = path.join(RUNS, evidence[1], evidence[2]);
      if (!fs.existsSync(file)) return reply(404, { error: '证据不存在' });
      res.writeHead(200, { 'content-type': evidence[2].endsWith('.jpg') ? 'image/jpeg' : evidence[2].endsWith('.json') ? 'application/json' : 'video/x-msvideo', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      fs.createReadStream(file).pipe(res); return true;
    }
    if (req.method !== 'POST') return reply(404, { error: '未知接口' });
    if (!req.headers['content-type']?.startsWith('application/json')) return reply(415, { error: '需要 JSON 请求' });
    fs.mkdirSync(BASE, { recursive: true });
    if (url.pathname === '/api/game-input/window') {
      try {
        const body = await parseBody(req);
        if (!body || Object.keys(body).some(k => k !== 'mode') || !['maximize','restore'].includes(body.mode)) return reply(400, { error: '窗口操作仅支持 maximize 或 restore' });
        if (busy || autonomous.state.running || !fs.existsSync(STOP)) return reply(409, { error: '先停止游戏输入并等待任务释放，再调整窗口' });
        busy = true;
        try {
          const result = await new Promise((resolve, reject) => {
            const child = spawn(path.join(ROOT, 'runtime/vlm-env/Scripts/python.exe'), [path.join(ROOT, 'scripts/sts2/native_window.py'), body.mode], { cwd: ROOT, windowsHide: true, timeout: 10000 });
            let output = '', error = '';
            child.stdout.on('data', data => { output = (output + data).slice(-8192); });
            child.stderr.on('data', data => { error = (error + data).slice(-2000); });
            child.on('error', reject);
            child.on('close', () => { try { resolve(JSON.parse(output.trim())); } catch { reject(new Error(error || '窗口操作结果未知，请检查窗口后再继续')); } });
          });
          return reply(result.error ? 422 : 200, result);
        } finally { busy = false; }
      } catch (error) { return reply(500, { error: error.message }); }
    }
    if (url.pathname === '/api/game-input/agent/start') {
      try {
        const body = await parseBody(req);
        if (busy) return reply(409, { error: '请等当前动作结束' });
        return reply(202, autonomous.start({ maxSteps: body.maxSteps ?? 300, execute: body.execute !== false, continueAfterDefeat: body.continueAfterDefeat ?? false }));
      } catch (error) { return reply(400, { error: error.message }); }
    }
    if (url.pathname === '/api/game-input/read-card') {
      try {
        const body = await parseBody(req), run = runInfo(String(body.frameId || ''));
        if (!run?.image || run.target !== 'SlayTheSpire2.exe') return reply(400, { error: '请先取得游戏截图' });
        const image = path.join(RUNS, run.id, path.basename(run.image));
        const response = await fetch('http://127.0.0.1:17646/read', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ image, crop: body.crop, target: body.target, mode: body.mode, anchor: body.anchor }), signal: AbortSignal.timeout(180000) });
        return reply(response.status, await response.json());
      } catch (error) { return reply(503, { error: '本地读牌未完成：' + error.message }); }
    }
    if (url.pathname === '/api/game-input/stop') { autonomous.stop(); fs.writeFileSync(STOP, 'console stop'); return reply(200, { stopRequested: true, releaseComplete: !busy }); }
    if (url.pathname === '/api/game-input/resume') {
      if (busy || autonomous.state.running) return reply(409, { error: '等待当前循环和动作释放后再恢复' });
      fs.rmSync(STOP, { force: true }); return reply(200, { stopped: false });
    }
    if (url.pathname !== '/api/game-input/action') return reply(404, { error: '未知接口' });
    if (autonomous.state.running && req.headers['x-native-agent'] !== autonomous.token) return reply(409, { error: '角色正在控制游戏，请先停止自动循环再手动操作' });
    if (busy) return reply(409, { error: '动作执行中，请等待截图' });
    if (fs.existsSync(STOP)) return reply(409, { error: '已停止，请先恢复' });
    let actions, body;
    try {
      body = await parseBody(req); actions = gesture(body, body.kind === 'hover' ? hoverPointerMode() : 'absolute');
      if (actions) {
        const current = recent()[0];
        if (!current || body.frameId !== current.id || Date.now() - current.updatedAt > 120000 || !current.image || current.target !== 'SlayTheSpire2.exe') throw new Error('请先获取最新截图，再定位动作');
      }
    } catch (error) { return reply(400, { error: error.message }); }
    // Recheck after asynchronous body parsing; two requests must not both acquire.
    if (busy) return reply(409, { error: '已有动作执行中' });
    busy = true; lastError = null;
    try {
      const args = [path.join(ROOT, 'scripts/game-input-run.py'), '--exe', 'SlayTheSpire2.exe'];
      if (actions) {
        const requestFile = path.join(BASE, `console-${Date.now()}.json`);
        fs.writeFileSync(requestFile, JSON.stringify(actions)); args.push('--actions', requestFile, '--execute');
      }
      const result = await new Promise((resolve, reject) => {
        const child = spawn(path.join(ROOT, 'runtime/vlm-env/Scripts/python.exe'), args, { cwd: ROOT, windowsHide: true });
        let output = '', error = '';
        child.stdout.on('data', data => { output += data; });
        child.stderr.on('data', data => { error = (error + data).slice(-4000); });
        child.on('error', reject);
        child.on('close', () => { try { resolve(JSON.parse(output.trim())); } catch { reject(new Error(error || '控制器未返回结果')); } });
      });
      const info = runInfo(path.basename(result.directory));
      return reply(result.status === 'stopped' ? 422 : 200, info || result);
    } catch (error) { lastError = error.message; return reply(500, { error: lastError }); }
    finally { busy = false; }
  };
}
module.exports = { createGameInputRoutes, gesture, localRequest };
