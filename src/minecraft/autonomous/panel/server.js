'use strict';
// Local control/monitor panel for the MC companion. Binds 127.0.0.1 only.
//   GET  /            -> panel HTML (with the per-start CSRF token injected)
//   GET  /api/state   -> live snapshot (processes, milestones, metrics, log tail)
//   POST /api/ctl     -> {action: start|stop|restart|server-start|server-stop}
// Deliberately: fixed argv arrays (never a shell string), digit-validated PIDs, and a
// tail-only read of logs/run.log because that file is already hundreds of MB.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const cfg = require('../config'); // env-overridable paths, so a second instance gets its own panel
const ds = require('./deepseek');

const ROOT = cfg.root;
const PORT = parseInt(process.env.MC_PANEL_PORT || '8790', 10);
const HOST = '127.0.0.1';
const TOKEN = crypto.randomBytes(16).toString('hex');
// Which processes this panel owns. The bot is told apart by its entry script; the world server by
// the port it listens on (see serverPid) - the two instances run byte-identical java command lines.
const BOT_MATCH = process.env.MC_BOT_MATCH || 'src/index.js';
const MC_PORT = Number(cfg.mc.port) || 25565; // this instance's own world server, found by port
const LAUNCHER_MATCH = process.env.MC_LAUNCHER_MATCH || 'server/start.js';
const RUN_LOG = path.join(cfg.paths.logs, 'run.log');
const OUT_LOG = path.join(cfg.paths.logs, 'run.out');
const STATE_JSON = cfg.paths.state;

// One page for every running instance. Each panel can read AND drive its peers, so the browser only
// ever talks to one origin and never sees another instance's control token (it stays server-side).
const SELF_ID = process.env.MC_PANEL_ID || 'inst1';
const PEERS = (() => {
  if (process.env.MC_PANEL_PEERS) { try { return JSON.parse(process.env.MC_PANEL_PEERS); } catch { return []; } }
  return SELF_ID === 'inst3'
    ? [{ id: 'inst1', label: '实例1 · 辅助图 Numen:25565', port: 8790, tokenFile: 'logs/panel.out' }]
    : [{ id: 'inst3', label: '实例3 · 不作弊新世界 NumenC:25567', port: 8791, tokenFile: 'logs3/panel.out' }];
})();
const peerToken = (p) => {
  try {
    // The out log accumulates one "token <hex>" line per panel start, so the peer's live token is
    // the LAST match, not the first - taking the first silently authenticated against a dead panel.
    const all = [...fs.readFileSync(path.join(ROOT, p.tokenFile), 'utf8').matchAll(/token ([0-9a-f]{16,})/g)];
    return all.length ? all[all.length - 1][1] : '';
  } catch { return ''; }
};
const httpJson = (opts, body) => new Promise((resolve) => {
  const req = http.request(Object.assign({ host: HOST, headers: { 'Content-Type': 'application/json' } }, opts), (r) => {
    let b = '';
    r.on('data', (d) => { b += d; if (b.length > 4e6) r.destroy(); });
    r.on('end', () => { try { resolve({ ok: r.statusCode === 200, status: r.statusCode, body: JSON.parse(b) }); } catch { resolve({ ok: false, note: '对端返回非 JSON' }); } });
  });
  req.on('error', (e) => resolve({ ok: false, note: e.code || e.message }));
  req.setTimeout(9000, () => { req.destroy(); resolve({ ok: false, note: '对端超时' }); });
  if (body) req.write(body);
  req.end();
});
const peerFetch = (p, what) => httpJson({ port: p.port, path: what === 'llm' ? '/api/llm?balance=0' : '/api/state', method: 'GET' });

const LADDER_ORDER = ['wood', 'crafting_table', 'wooden_pickaxe', 'stone', 'stone_tools', 'food', 'coal', 'iron_ore', 'iron_ingots', 'iron_gear', 'armor', 'diamond_pick', 'diamond_gear', 'bow', 'obsidian', 'flint_steel', 'nether', 'blaze_rods', 'pearls', 'eyes', 'stronghold', 'enter_end', 'kill_dragon'];

let botChild = null; // the child this panel spawned (may be null if the bot was started by hand)
let botPid = null;
let botStartedAt = 0;
let serverChild = null;

const ps = (script) => new Promise((resolve) => {
  execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, maxBuffer: 8 << 20 }, (err, out) => resolve(err ? '' : String(out)));
});

// Find a running node process whose command line contains `needle` (e.g. "src/index.js").
async function findPid(needle) {
  const raw = await ps(`Get-CimInstance Win32_Process -Filter "Name='node.exe'" | ForEach-Object { "$($_.ProcessId)|$($_.CommandLine)" }`);
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf('|');
    if (i < 0) continue;
    if (line.slice(i + 1).includes(needle)) return parseInt(line.slice(0, i), 10) || null;
  }
  return null;
}
// The world server is found by the port it LISTENS on, never by its command line. Both instances
// launch an identical "server.jar", so the old MC_JAVA_MATCH regex could not tell them apart: it
// reported 服务端 离线 for a server that was provably up, and its stop button would have killed the
// first java PID in the list - possibly the other instance's world.
async function serverPid(port) {
  if (!Number.isInteger(port) || port <= 0) return null;
  const raw = await ps(`(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1 -ExpandProperty OwningProcess)`);
  const pid = parseInt(String(raw).trim().split(/\r?\n/)[0], 10);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}
function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return Promise.resolve('无效 PID');
  // Report the failure instead of swallowing it. The old callback ignored `err` entirely, so a
  // taskkill that did NOT land still read as "stopped" upstream: at 22:11 a bot-restart killed
  // nothing, startBot then found the same PID alive and answered `已在运行 (PID 93416)`, and the
  // restart silently became no restart - the running process kept the old code with no signal that
  // the deploy had not happened.
  return new Promise((resolve) => execFile('taskkill.exe', ['/PID', String(pid), '/F'], (err, so, se) => {
    if (!err) return resolve('');
    resolve(`taskkill 失败：${String(se || so || err.message).trim().slice(0, 140)}`);
  }));
}

// Read only the tail of a possibly huge file.
function readTail(file, bytes) {
  try {
    const fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const len = Math.min(size, bytes);
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, size - len);
    fs.closeSync(fd);
    return buf.toString('utf8');
  } catch { return ''; }
}

// The End is the one stage where the numbers that matter are not in live.json: how many crystals have
// actually come down, what killed the bot last, and whether the dragon is finished. All three come from
// the same log tail this snapshot already read, plus the two records the bot writes itself. `dragon.json`
// only exists after a confirmed kill, so its presence IS the victory signal (the 1.21.1 achievement event
// never fires - see src/skills/endgame.js:6317).
function endInfo(lines, live) {
  const downs = [];
  let lastDeath = '';
  for (const l of lines) {
    const m = /crystal \d+ destroyed \(down=(\d+)\)/.exec(l);
    if (m) downs.push(+m[1]);
    if (/ DIED at /.test(l)) lastDeath = l.replace(/^\[[^\]]+\]\s*/, '').slice(0, 170);
  }
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(path.join(cfg.paths.runs, f), 'utf8')); } catch { return null; } };
  const rec = readJson('end_deaths.json') || {};
  const room = readJson('portal_room.json') || {};
  return {
    crystalsDown: downs.length ? Math.max(...downs) : 0,
    crystalKillsInTail: downs.length,
    endDeaths: Number.isFinite(rec.endDeaths) ? rec.endDeaths : null,
    deathsTotal: Number.isFinite(rec.deaths) ? rec.deaths : null,
    inEnd: !!live && live.dim === 'the_end',
    ringComplete: !!room.ringComplete,
    portalRoom: Number.isFinite(room.x) ? `${room.x},${room.y},${room.z}` : null,
    lastDeath,
    // The log-tail clause is what let ONE false `*** ENDER DRAGON DEFEATED ***` line (12:04:53, an
    // end_portal block found in the Overworld stronghold one second after the bot died) mark the run as
    // cleared forever - the line never leaves the log, so the board could never go back to "not cleared".
    // The persisted record written by `dragonIsDead` (which now requires the centre structure, in the End)
    // is the only accepted evidence.
    dragonKilled: !!readJson('dragon.json'),
  };
}

const stripNoise = (s) => s.split(/\r?\n/).filter(l => l && !/protodef|eval at compile|at Object\.|at eval|^\s+at /.test(l)).slice(-90).join('\n');

function parseState() {
  try { return JSON.parse(fs.readFileSync(STATE_JSON, 'utf8')).done || {}; } catch { return {}; }
}

// The stall verdict, straight from the three files src/stageLock.js and the two samplers write. A human
// reading the panel should be able to answer "is it stuck, on what, for how long, and what did the bot
// try about it" without opening a terminal - which is the whole reason the detectors exist.
function stallInfo(logLines) {
  const rj = (p) => { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } };
  const sl = rj(path.join(cfg.paths.runs, 'stage_lock.json'));
  const rep = rj(path.join(cfg.paths.runs, 'stall_report.json'));
  let verdict = null;
  try {
    const v = readTail(path.join(cfg.paths.logs, 'stall_snap.log'), 40000).split(/\r?\n/).filter(l => /VERDICT/.test(l));
    verdict = v.length ? v[v.length - 1].replace(/^\[([^\]]+)\]\s*/, '') : null;
  } catch { /* no sampler yet */ }
  const cur = sl && sl.current;
  const st = sl && cur && sl.stages && sl.stages[cur.id];
  // Reuse the tail snapshot() already read (this endpoint runs every 3 s; a second 400 KB read of a
  // 250 MB log would be pure I/O tax).
  const tail = Array.isArray(logLines) ? logLines : [];
  const lines = [];
  for (let i = tail.length - 1; i >= 0 && lines.length < 5; i--) {
    if (/STAGE AGE|STAGE LOOP|STAGE LOCK|stage lock: \w+ route #|STEP QUIET ABORT|path guard:/.test(tail[i]) && !/selftest/.test(tail[i])) {
      lines.push(tail[i].replace(/^\[([^\]]+)\]\s*\[[^\]]+\]\s*/, '$1 ').slice(0, 200));
    }
  }
  return {
    stage: cur ? cur.id : null,
    segmentMin: cur ? Math.round((Date.now() - cur.since) / 60000) : null,
    tiers: cur ? Object.keys(cur.tiers || {}) : [],
    idle: st ? st.idle : null,
    tries: st ? st.tries : null,
    lastObs: st ? String(st.lastObs || '').slice(0, 180) : null,
    verdict,
    dossier: rep ? { at: rep.at, level: rep.level, attempts: rep.attempts, spanMin: rep.spanMin, alt: rep.alt, position: rep.position, dominant: rep.dominant } : null,
    recent: lines,
  };
}

function snapshot() {
  const tail = readTail(RUN_LOG, 1_400_000);
  const lines = tail.split(/\r?\n/);
  const done = parseState();
  const current = LADDER_ORDER.find(id => !done[id]) || null;
  // The newest inventory dump, whatever it is, so the panel shows what it is carrying right now.
  let inv = null;
  for (let i = lines.length - 1; i >= 0 && !inv; i--) {
    const m = /slots=(\{[^{}]*\})/.exec(lines[i]);
    if (m) { try { inv = JSON.parse(m[1]); } catch { /* truncated dump; keep looking */ } }
  }
  const activity = [];
  for (let i = lines.length - 1; i >= 0 && activity.length < 6; i--) {
    const l = lines[i];
    if (/\[(skill|info|warn)\]/.test(l) && /-> |plan\(|plan ->|OK |not done|DIED|filled|lava found|roam|smelt|placed|crafted|survive gate|RE-OPENED|ate up to|falling through/.test(l)) {
      activity.push(l.replace(/^\[[^\]]+\]\s*/, '').slice(0, 190));
    }
  }
  // Milestone completion times, for the progress sparkline. run.log writes these as
  // "[ISO ts] [skill] OK <id>: ..." - capture the id, not the timestamp.
  const stamps = [];
  for (const l of lines) {
    const m = /^\[([\d\-T:.Z]+)\] \[(?:skill|info)\] OK ([a-z_]+):/.exec(l);
    if (!m || !LADDER_ORDER.includes(m[2])) continue;
    if (stamps.some(s => s.id === m[2])) continue;
    stamps.push({ id: m[2], at: Date.parse(m[1]) || 0 });
  }
  const seen = stamps.length;
  const invCount = inv ? Object.keys(inv).length : 0;
  // The bot writes runs/live.json every planner loop - structured truth beats regexing prose logs,
  // which are truncated for the console. Fall back to the log parse if the file is missing/stale.
  let live = null;
  try { live = JSON.parse(fs.readFileSync(path.join(cfg.paths.runs, 'live.json'), 'utf8')); } catch {}
  if (live && (Date.now() - live.ts > 120000)) live.stale = true; else if (live) live.stale = false;
  // run.log is one long append-only file, so a byte tail is NOT a time window. Parse the leading
  // [ISO] timestamp of each line and count "recent" over a real 10-minute window, plus the totals
  // that happen to sit in the tail - otherwise the panel shows 80 deaths as if they just happened.
  const WINDOW_MS = 10 * 60 * 1000, cutoff = Date.now() - WINDOW_MS;
  const tsOf = (l) => { const m = /^\[([\d\-T:.Z]+)\]/.exec(l); const t = m ? Date.parse(m[1]) : 0; return Number.isFinite(t) ? t : 0; };
  let deathsRecent = 0, llmRecent = 0, deathsTail = 0, unhTail = 0, llmTail = 0;
  for (const l of lines) {
    const t = tsOf(l), fresh = t >= cutoff;
    if (/ DIED at /.test(l)) { deathsTail++; if (fresh) deathsRecent++; }
    if (/unhandledRejection/.test(l)) unhTail++;
    if (/\[llm \]/.test(l)) { llmTail++; if (fresh) llmRecent++; }
  }
  return {
    now: Date.now(),
    windowMinutes: WINDOW_MS / 60000,
    current,
    stall: stallInfo(lines),
    end: endInfo(lines, live),
    doneCount: Object.keys(done).filter(k => LADDER_ORDER.includes(k)).length,
    ladder: LADDER_ORDER.map(id => ({ id, state: done[id] ? 'done' : id === current ? 'current' : 'todo' })),
    metrics: {
      deaths: deathsRecent, deathsTail, unhandled: unhTail, llmCalls: llmRecent, llmTail,
      milestonesLogged: seen,
      slotsUsed: invCount,
      freeSlots: invCount ? Math.max(0, 36 - invCount) : null,
    },
    live,
    inventory: (() => {
      if (live && live.inv) { try { return JSON.parse(live.inv); } catch {} }
      return inv;
    })(),
    activity: activity.reverse(),
    stamps,
    log: stripNoise(tail).split(/\r?\n/).slice(-40).join('\n'),
    bot: { pid: botPid, running: !!botPid, owned: !!botChild, startedAt: botStartedAt },
    server: { javaPid: null, launcherPid: null, running: false },
    port: PORT,
    // Which file the tail above came from: with two instances on one page the reader needs to know
    // they are looking at logs3/run.log and not logs/run.log.
    logFile: path.relative(ROOT, RUN_LOG).split(path.sep).join('/'),
  };
}

async function withPids(snap) {  const [bot, java, launcher] = await Promise.all([findPid(BOT_MATCH), serverPid(MC_PORT), findPid(LAUNCHER_MATCH)]);
  snap.bot.pid = bot || snap.bot.pid;
  snap.bot.running = !!bot || !!(snap.bot.owned && snap.botChild && snap.botChild.exitCode === null);
  snap.server.javaPid = java; snap.server.launcherPid = launcher;
  snap.server.mcPort = MC_PORT;
  snap.server.running = !!java;
  return snap;
}

function startBot() {
  return new Promise(async (resolve) => {
    const existing = await findPid(BOT_MATCH);
    if (existing) { botPid = existing; return resolve({ ok: true, note: `bot 已在运行 (PID ${existing})` }); }
    fs.appendFileSync(OUT_LOG, `\n===== panel start ${new Date().toISOString()} =====\n`);
    // Detached + unref: the bot must outlive this panel (the app writes logs/run.log itself, so no
    // pipe is needed). Otherwise closing the console silently killed the companion too.
    const child = spawn(process.execPath, ['--max-old-space-size=4096'].concat(process.env.MC_BOT_ENTRY ? process.env.MC_BOT_ENTRY.split(',') : ['src/index.js']), { cwd: ROOT, stdio: 'ignore', detached: true, env: process.env });
    child.unref();
    botChild = null; botPid = child.pid; botStartedAt = Date.now();
    resolve({ ok: true, note: `已启动 (PID ${child.pid}，已脱离面板)` });
  });
}
async function stopBot() {
  const pid = botPid || await findPid(BOT_MATCH);
  if (!pid) return { ok: false, note: '没有正在运行的 bot' };
  const err = await killPid(pid);
  // `stopped: false` tells bot-restart not to go on. A failed kill used to be reported as a clean
  // stop, and the next findPid then saw the same live process and answered `已在运行` - a restart that
  // never happened, on the old code, with no signal (22:11).
  if (err) return { ok: false, stopped: false, note: `${err}（PID ${pid} 仍在运行，部署没有生效）` };
  if (botChild && botChild.pid === pid) botChild = null;
  botPid = null;
  return { ok: true, note: `已停止 PID ${pid}` };
}
async function startServer() {
  const java = await serverPid(MC_PORT);
  if (java) return { ok: true, note: `服务端已在运行 (:${MC_PORT} java PID ${java})` };
  const logFile = path.join(cfg.paths.logs, 'server.out');
  // File descriptors + detached, not pipes: while the launcher was OUR child on OUR pipes, restarting the
  // panel (to load a new panel build) took the game server down with it - stdout closed, java exited, and
  // the run lost its world (05:19 and 05:24 both times the listener count went to zero). The bot already
  // starts this way ("已脱离面板"); the server should not be the one thing that dies with its supervisor.
  const fd = fs.openSync(logFile, 'a');
  const child = spawn(process.execPath, (process.env.MC_SERVER_ENTRY || 'server/start.js').split(','), { cwd: ROOT, stdio: ['ignore', fd, fd], env: process.env, detached: true, windowsHide: true });
  child.unref();
  serverChild = child;
  return { ok: true, note: `服务端启动中 (launcher PID ${child.pid})，需要等它打印 SERVER READY` };
}
// Send one command to the MINECRAFT SERVER console over RCON - deliberately not through the bot,
// because the whole point is to have an operator channel when the bot is disconnected or its event
// loop is starved (05:10: Numen had no ESTABLISHED socket at all, so every panel button that acts
// through bot.chat was useless). Each command and its reply are appended to logs/rcon.log.
async function serverCmd(text) {
  const t = String(text || '').trim();
  if (!t) return { ok: false, note: '指令是空的' };
  const dir = process.env.MC_SERVER_DIR || 'server';
  const props = path.join(cfg.paths.server, 'server.properties');
  let pw = '', port = 25575, enabled = false;
  try {
    const sp = fs.readFileSync(props, 'utf8');
    const m = sp.match(/^rcon\.password=(.*)$/m); pw = m ? m[1].trim() : '';
    const pm = sp.match(/^rcon\.port=(\d+)$/m); port = pm ? Number(pm[1]) : 25575;
    enabled = /^enable-rcon=true$/m.test(sp);
  } catch (e) { return { ok: false, note: '读不到 ' + props + '：' + e.message }; }
  if (!enabled || !pw) return { ok: false, note: `${dir} 的 RCON 没开（enable-rcon=true + rcon.password 要有），改完这两项必须重启服务端才生效` };
  // The server CONSOLE takes bare commands: RCON with a leading slash answers
  // "Unknown or incomplete command ... /list<--[HERE]" (measured 05:16). The panel box keeps the familiar
  // chat spelling and strips it for the wire.
  const wire = t.replace(/^\/+/, '');
  let r;
  try { r = await require('../rcon').exec('127.0.0.1', port, pw, wire, { timeoutMs: 15000 }); }
  catch (e) { r = { ok: false, note: 'rcon threw ' + e.message }; }
  try {
    const trail = `[${new Date().toISOString()}] ${t} -> ${String(r.ok ? r.response : r.note).split(String.fromCharCode(10)).join(' | ').slice(0, 600)}${String.fromCharCode(10)}`;
    fs.appendFileSync(path.join(cfg.paths.logs, 'rcon.log'), trail);
  } catch {}
  return r;
}

async function stopServer() {
  const java = await serverPid(MC_PORT), launcher = await findPid(LAUNCHER_MATCH);
  if (!java && !launcher) return { ok: false, note: `服务端没在运行（:${MC_PORT} 无人监听）` };
  if (launcher) await killPid(launcher);
  if (java) await killPid(java);
  return { ok: true, note: `已停止 ${process.env.MC_SERVER_DIR || 'server'} 服务端${java ? ' (java PID ' + java + ')' : ''}；世界数据保留，不删除` };
}

const html = () => fs.readFileSync(path.join(__dirname, 'ui.html'), 'utf8').replace('__TOKEN__', TOKEN);

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  // Read-only GETs are safe to mirror into an embedded dashboard (the Qoder sidebar polls this
  // origin); control still needs the per-start token, and POST keeps no cross-origin grant.
  const send = (code, body, type) => { const h = { 'Content-Type': type || 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }; if (req.method === 'GET') h['Access-Control-Allow-Origin'] = '*'; res.writeHead(code, h); res.end(body); };
  try {
    if (req.method === 'GET' && (u.pathname === '/' || u.pathname === '/index.html')) return send(200, html(), 'text/html; charset=utf-8');
    if (req.method === 'GET' && u.pathname === '/api/state') {
      const snap = await withPids(snapshot());
      // 中文摘要在快照之后算：它要读同一份 live/inventory/stall/activity，避免第二次读几百 MB 的日志。
      try { snap.cn = require('./nowcn').summarize(snap); } catch (e) { snap.cn = { headline: '中文摘要生成失败：' + e.message, judgeLevel: 'unknown' }; }
      return send(200, JSON.stringify(snap));
    }
    if (req.method === 'GET' && u.pathname === '/api/peer') {
      const p = PEERS.find(x => x.id === u.searchParams.get('id'));
      if (!p) return send(200, JSON.stringify({ ok: false, note: '未知实例' }));
      const r = await peerFetch(p, u.searchParams.get('what') || 'state');
      return send(r.ok ? 200 : 502, JSON.stringify(r.ok ? r.body : { ok: false, note: r.note }));
    }
    if (req.method === 'GET' && u.pathname === '/api/fleet') {
      // Every instance in one payload: this panel's own snapshot plus each peer's state and LLM
      // numbers, so the page can show tabs, summaries and dead-man signals without a second origin.
      const self = await withPids(snapshot());
      const peers = [];
      for (const p of PEERS) {
        const st = await peerFetch(p, 'state');
        const lm = await peerFetch(p, 'llm');
        peers.push({ id: p.id, label: p.label, port: p.port, online: st.ok, note: st.ok ? null : st.note, state: st.ok ? st.body : null, llm: lm.ok ? lm.body : null });
      }
      return send(200, JSON.stringify({ selfId: SELF_ID, selfLabel: process.env.MC_PANEL_LABEL || ('本面板 · 端口 ' + PORT), self, peers }));
    }
    if (req.method === 'GET' && u.pathname === '/api/llm') {
      // Tokens come from our own per-call ledger (exact); money comes from balance + estimated price.
      const wantBalance = u.searchParams.get('balance') !== '0';
      const body = { stats: ds.stats(), balance: wantBalance ? await ds.balance(u.searchParams.get('refresh') === '1') : null, priceNote: '成本=按 .env 里可调的官方区间估算；精确每日账单需要平台登录令牌，本面板不碰' };
      return send(200, JSON.stringify(body));
    }
    if (req.method === 'POST' && u.pathname === '/api/ctl') {
      let body = ''; req.on('data', d => { body += d; if (body.length > 2e4) req.destroy(); });
      req.on('end', async () => {
        let j; try { j = JSON.parse(body || '{}'); } catch { return send(400, JSON.stringify({ ok: false, note: 'bad json' })); }
        if (j.token !== TOKEN) return send(403, JSON.stringify({ ok: false, note: 'token 不匹配（请用面板按钮操作）' }));
        if (j.instance && j.instance !== SELF_ID) {
          const p = PEERS.find(x => x.id === j.instance);
          if (!p) return send(200, JSON.stringify({ ok: false, note: '未知实例 ' + j.instance }));
          const tk = peerToken(p);
          if (!tk) return send(200, JSON.stringify({ ok: false, note: '读不到 ' + p.id + ' 的 token（' + p.tokenFile + '），那个面板可能没在跑' }));
          const r = await httpJson({ port: p.port, path: '/api/ctl', method: 'POST' }, JSON.stringify({ action: j.action, token: tk, text: j.text }));
          return send(200, JSON.stringify(r.ok ? r.body : { ok: false, note: '转发失败：' + (r.note || r.status) }));
        }
        const r = await ({
          'bot-start': startBot, 'bot-stop': stopBot,
          'bot-restart': async () => {
            const st = await stopBot();
            if (st && st.ok === false && st.stopped === false) return st;
            // Wait until the death is actually visible. taskkill returns before Windows reaps the
            // process, and a 1200 ms nap was not enough: startBot's findPid matched the dying bot,
            // answered `已在运行`, and the restart became a no-op on the old code (22:11:08).
            for (let i = 0; i < 16; i++) {
              await new Promise(r => setTimeout(r, 500));
              if (!(await findPid(BOT_MATCH))) break;
            }
            return startBot();
          },
          'server-start': startServer, 'server-stop': stopServer, 'server-cmd': () => serverCmd(j.text),
        }[j.action] || (() => ({ ok: false, note: '未知动作 ' + j.action })))();
        send(200, JSON.stringify(r));
      });
      return;
    }
    send(404, JSON.stringify({ ok: false, note: 'not found' }));
  } catch (e) { send(500, JSON.stringify({ ok: false, note: e.message })); }
});

server.listen(PORT, HOST, () => {
  console.log(`panel http://${HOST}:${PORT}  (open in a browser; Ctrl+C to close)`);
  console.log(`token ${TOKEN}`);
});
process.on('SIGINT', () => { try { if (botChild) botChild.kill(); } catch {} server.close(); process.exit(0); });
