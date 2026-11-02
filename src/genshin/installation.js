'use strict';
const fs = require('node:fs');
const path = require('node:path');
const {createHash}=require('node:crypto');
const ROOT = path.resolve(__dirname, '../..');
function installation({ root = ROOT, env = process.env } = {}) {
  let saved = {};
  const file = path.join(root, 'data/genshin.local.json');
  if (fs.existsSync(file)) saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  const executable = env.BETTERGI_EXE || saved.bettergiExecutable || '';
  if (!executable || !path.isAbsolute(executable) || path.basename(executable).toLowerCase() !== 'bettergi.exe' || !fs.existsSync(executable))
    throw Error('未配置有效的 BetterGI.exe 安装路径');
  return { executable, directory: path.dirname(fs.realpathSync(executable)) };
}
function redact(value, key = '') {
  if (/password|secret|token|api.?key|authorization|webhook|cookie|user.?id|uid/i.test(key)) return '[已隐藏]';
  if (Array.isArray(value)) return value.map(v => redact(v));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k,v]) => [k, redact(v,k)]));
  return value;
}
function walk(root, relative = '') {
  if (!fs.existsSync(path.join(root, relative))) return [];
  return fs.readdirSync(path.join(root, relative), { withFileTypes: true }).flatMap(item => {
    if (item.isSymbolicLink()) return [];
    const name = path.join(relative, item.name);
    return item.isDirectory() ? walk(root, name) : item.isFile() ? [name] : [];
  });
}
function inspect(options) {
  const { directory } = installation(options);
  const deploymentFile = path.join(directory, 'aivtuber-installation.json');
  const deployment = fs.existsSync(deploymentFile) ? JSON.parse(fs.readFileSync(deploymentFile, 'utf8')) : null;
  const manifestFile=path.join(options?.root||ROOT,'data/genshin-hunting-routes.json');
  const hunting=fs.existsSync(manifestFile)?JSON.parse(fs.readFileSync(manifestFile,'utf8')):[];
  const notesFile=path.join(options?.root||ROOT,'data/genshin-route-observations.json');
  const notes=fs.existsSync(notesFile)?JSON.parse(fs.readFileSync(notesFile,'utf8')):{};
  const config = JSON.parse(fs.readFileSync(path.join(directory, 'User/config.json'), 'utf8').replace(/^\uFEFF/, ''));
  const routes = [];
  for (const [source, folder] of [['user', 'User/AutoPathing'], ['builtin_leyline', 'GameTask/AutoLeyLineOutcrop/Assets/pathing']]) {
    for (const file of walk(path.join(directory, folder)).filter(f => f.endsWith('.json'))) {
      const id = `${source}:${file.replaceAll('\\','/')}`;
      const metadata=hunting.find(r=>r.id===id);
      const audited=metadata&&createHash('sha256').update(fs.readFileSync(path.join(directory,folder,file))).digest('hex')===metadata.sha256;
      const encounterNotes=notes[metadata?.originalRouteId||id];
      routes.push({ id, source, name: path.basename(file, '.json'), category:audited?'hunting':source==='builtin_leyline'?'leyline':'other',...(audited?{map:metadata.map,firstFight:metadata.firstFight,sourceUrl:metadata.sourceUrl,combatMode:metadata.combatMode,originalRouteId:metadata.originalRouteId}:{}), executionAvailable: true, validatedInGame: false, requiresBridge: true, reason: '可通过官方脚本桥执行；该路线尚未逐条实战验证' });
      if(audited&&typeof encounterNotes==='string')routes.at(-1).encounterNotes=encounterNotes.slice(0,500);
    }
  }
  const groups = walk(path.join(directory, 'User/ScriptGroup')).filter(f=>f.endsWith('.json')).map(f=>path.basename(f,'.json'));
  return { version: deployment?.version || '0.66.0 (本机安装记录)', sourceCommit: deployment?.sourceCommit || '0af68c28f6b0e714d5304625ce644736d508022e',
    distribution: deployment?.distribution || 'BetterGI + AI-VTuber',
    config: redact(config), routes, groups, configSections: Object.keys(config).length,
    bridgeReady: require('./bridge').status().ready, note: '当前版本 IPC 没有 task.*；路线通过官方 JS 调度桥执行，接口返回不代表游戏目标完成。' };
}
module.exports = { installation, inspect, redact };
