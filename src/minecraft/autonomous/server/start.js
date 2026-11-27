'use strict';
// Local Paper 1.21.1 server launcher for autonomous Minecraft runs.
// Applies operator-chosen gamerules (like keepInventory=true) from the SERVER console after boot,
// because Minecraft ignores `keepInventory=true` in server.properties - keeping the bot completely
// non-OP (MC_NO_SELF_OP=1) while still honoring the operator's death-keep-inventory rule.
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const cfg = require('../config');

const dir = cfg.paths.server;
const jar = path.join(dir, 'server.jar');
const version = cfg.mc.version;
const keepInventory = process.env.MC_KEEP_INVENTORY !== '0';
const difficulty = process.env.MC_DIFFICULTY || 'easy';

function ensureDir(p = dir) { try { fs.mkdirSync(p, { recursive: true }); } catch {} }
function get(url) {
  return new Promise((resolve, reject) => {
    https.get(url, res => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) return get(res.headers.location).then(resolve, reject);
      if (res.statusCode !== 200) return reject(new Error('HTTP ' + res.statusCode + ' for ' + url));
      const chunks = []; res.on('data', d => chunks.push(d)); res.on('end', () => resolve(Buffer.concat(chunks))); res.on('error', reject);
    }).on('error', reject);
  });
}

async function downloadServer() {
  ensureDir();
  if (fs.existsSync(jar) && fs.statSync(jar).size > 1_000_000) {
    console.log('server.jar cached (' + fs.statSync(jar).size + ' bytes)');
    return;
  }
  const cacheCandidates = [
    process.env.MC_SERVER_JAR_CACHE,
    'E:/ai_mc/server3/server.jar',
    'E:/ai_mc/server/server.jar',
  ].filter(Boolean);
  for (const c of cacheCandidates) {
    try {
      if (fs.existsSync(c) && fs.statSync(c).size > 1_000_000) {
        fs.copyFileSync(c, jar);
        console.log('copied cached Paper server.jar from', c, '(' + fs.statSync(jar).size + ' bytes)');
        return;
      }
    } catch {}
  }
  try {
    const meta = JSON.parse((await get(`https://fill.papermc.io/v3/projects/paper/versions/${version}/builds/latest`)).toString());
    const dl = (meta.downloads && (meta.downloads['server:default'] || Object.values(meta.downloads)[0])) || null;
    if (dl && dl.url) {
      console.log('downloading Paper:', dl.name || dl.url);
      const buf = await get(dl.url);
      fs.writeFileSync(jar, buf);
      console.log('saved server.jar (Paper)', buf.length, 'bytes');
      return;
    }
  } catch (e) { console.log('Paper download failed, falling back to vanilla:', e.message); }
  const manifest = JSON.parse((await get('https://piston-meta.mojang.com/mc/game/version_manifest_v2.json')).toString());
  const entry = manifest.versions.find(v => v.id === version);
  if (!entry) throw new Error('version ' + version + ' not in manifest');
  const meta2 = JSON.parse((await get(entry.url)).toString());
  const serverUrl = meta2.downloads && meta2.downloads.server && meta2.downloads.server.url;
  if (!serverUrl) throw new Error('no server download url for ' + version);
  console.log('downloading', serverUrl);
  const buf = await get(serverUrl);
  fs.writeFileSync(jar, buf);
  console.log('saved server.jar (vanilla)', buf.length, 'bytes');
}

function rconPassword() {
  const f = path.join(dir, 'rcon.password');
  try { const have = fs.readFileSync(f, 'utf8').trim(); if (have) return have; } catch {}
  const pw = crypto.randomBytes(16).toString('hex');
  try { fs.writeFileSync(f, pw, 'utf8'); } catch {}
  return pw;
}

function writeConfigs() {
  ensureDir();
  fs.writeFileSync(path.join(dir, 'eula.txt'), 'eula=true\n', 'utf8');
  const worldExists = fs.existsSync(path.join(dir, 'world', 'level.dat'));
  const seed = process.env.MC_SEED ? String(process.env.MC_SEED).trim() : String(Math.floor(Math.random() * 1e9));
  const props = [
    'online-mode=false',
    `level-seed=${seed}`,
    'level-name=world',
    'view-distance=10',
    'simulation-distance=10',
    'spawn-protection=0',
    `difficulty=${difficulty}`,
    'gamemode=survival',
    'allow-nether=true',
    'enable-command-block=false',
    'max-world-size=20000',
    `server-port=${cfg.mc.port}`,
    'enable-rcon=true',
    `rcon.port=${Number(process.env.MC_RCON_PORT) || (Number(cfg.mc.port) + 10)}`,
    `rcon.password=${rconPassword()}`,
    `motd=AI_vtuber Autonomous MC (${worldExists ? 'resumed' : 'seed ' + seed})`,
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(dir, 'server.properties'), props, 'utf8');
  if (!worldExists) {
    ensureDir(cfg.paths.runs);
    const provPath = path.join(cfg.paths.runs, 'provenance.json');
    if (!fs.existsSync(provPath)) {
      fs.writeFileSync(provPath, JSON.stringify({
        createdAt: new Date().toISOString(),
        seed,
        version,
        port: cfg.mc.port,
        botUsername: cfg.mc.username,
        difficulty,
        keepInventory,
        assistFree: process.env.MC_ASSIST === '0',
        noSelfOp: process.env.MC_NO_SELF_OP === '1',
      }, null, 2));
    }
    console.log('server.properties written; NEW RANDOM level-seed =', seed);
  } else {
    console.log('server.properties written (existing world retained)');
  }
  return seed;
}

function offlineUuid(name) {
  const md5 = crypto.createHash('md5').update('OfflinePlayer:' + name).digest();
  md5[6] = (md5[6] & 0x0f) | 0x30;
  md5[8] = (md5[8] & 0x3f) | 0x80;
  const h = md5.toString('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
}

function writeOps() {
  ensureDir();
  const names = (process.env.MC_NO_SELF_OP === '1' ? [] : [cfg.mc.username])
    .concat(String(process.env.MC_EXTRA_OPS || '').split(',').map(x => x.trim()).filter(Boolean));
  const list = [...new Set(names)].map(n => ({ uuid: offlineUuid(n), name: n, level: 4, bypassPlayerLimit: false }));
  fs.writeFileSync(path.join(dir, 'ops.json'), JSON.stringify(list, null, 2), 'utf8');
  console.log(list.length ? 'ops.json: OP ' + list.map(o => o.name).join(',') : 'ops.json: NO operator (MC_NO_SELF_OP=1)');
}

function start() {
  const seed = writeConfigs();
  writeOps();
  const args = ['-Xmx' + (process.env.MC_JAVA_XMX || '2G'), '-Xms1G', '-jar', 'server.jar', '--nogui'];
  console.log('starting:', 'java', args.join(' '), '(cwd=' + dir + ')');
  // Pipe stdin so the server launcher itself can enforce operator gamerules (keepInventory)
  // without ever granting OP to the bot account.
  const p = spawn('java', args, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  ensureDir(cfg.paths.logs);
  const out = fs.createWriteStream(path.join(cfg.paths.logs, 'server.log'), { flags: 'a' });
  let rulesApplied = false;
  p.stdout.on('data', d => {
    out.write(d);
    const s = d.toString();
    if (/Done \(|Time elapsed/.test(s)) {
      console.log('SERVER READY -> join with MC 1.21.1 at 127.0.0.1:' + cfg.mc.port + '  seed=' + seed);
      if (!rulesApplied) {
        rulesApplied = true;
        try {
          p.stdin.write(`gamerule keepInventory ${keepInventory ? 'true' : 'false'}\n`);
          p.stdin.write(`difficulty ${difficulty}\n`);
          console.log(`operator gamerule applied via server console: keepInventory=${keepInventory}, difficulty=${difficulty}`);
        } catch (e) { console.error('failed to write server gamerules:', e.message); }
      }
    }
    if (/Gamerule keepInventory is now set to:/i.test(s)) console.log(s.trim());
    // Auto-grant permanent night vision to watching human operators (MC_EXTRA_OPS) on join so underground
    // spectating is always clear, while NEVER granting any effect or OP privilege to the bot account.
    const extraOps = String(process.env.MC_EXTRA_OPS || '').split(',').map(x => x.trim()).filter(x => x && x !== cfg.mc.username);
    for (const opName of extraOps) {
      if (s.includes(`${opName} joined the game`)) {
        try {
          p.stdin.write(`effect give ${opName} minecraft:night_vision infinite 0 true\n`);
          console.log(`spectator night_vision auto-applied to human observer ${opName}`);
        } catch {}
      }
    }
  });
  p.stderr.on('data', d => out.write(d));
  p.on('exit', c => { console.log('server exited', c); try { out.end(); } catch {} });
  process.on('SIGINT', () => { try { p.stdin.write('stop\n'); } catch {} });
  process.on('SIGTERM', () => { try { p.stdin.write('stop\n'); } catch {} });
  return p;
}

(async () => { await downloadServer(); start(); })().catch(e => { console.error(e); process.exit(1); });
