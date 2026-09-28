const fs = require('node:fs/promises');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { buildFlow } = require('./ui-flow');
const ROOT = path.resolve(__dirname, '../../runtime/vision/page-sessions');
const PYTHON = path.resolve(__dirname, '../../runtime/vision-env/Scripts/python.exe');
const busy = new Set();
let stitching = false;
const fail = (message, statusCode = 400) => Object.assign(new Error(message), { statusCode });
function validJpeg(image) {
  if (image.length < 12 || image[0] !== 255 || image[1] !== 216) return false;
  let i = 2;
  while (i + 8 < image.length) {
    if (image[i++] !== 255) return false;
    while (image[i] === 255) i++;
    const marker = image[i++];
    if (marker === 218 || marker === 217) return false;
    const length = image.readUInt16BE(i);
    if (length < 2 || i + length > image.length) return false;
    if ([192,193,194].includes(marker)) {
      const h = image.readUInt16BE(i+3), w = image.readUInt16BE(i+5);
      return w >= 100 && h >= 100 && w <= 4096 && h <= 4096 && w * h <= 12000000;
    }
    i += length;
  }
  return false;
}
async function write(dir, data) {
  await fs.writeFile(path.join(dir, 'manifest.tmp'), JSON.stringify(data, null, 2));
  await fs.rename(path.join(dir, 'manifest.tmp'), path.join(dir, 'manifest.json'));
}
function runStitch(dir) {
  return new Promise((resolve, reject) => execFile(PYTHON, [path.join(__dirname, 'stitch-pages.py'), dir],
    { windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 }, (err, out) => {
      if (err) return reject(fail('拼接失败；原始帧已保存，可稍后重试。', 500));
      try { resolve(JSON.parse(out)); } catch { reject(fail('拼接结果无效；原始帧已保留。', 500)); }
    }));
}
async function handlePageSessions(req, res, url, { parseBody, parseBinaryBody, send }) {
  if (!url.pathname.startsWith('/api/vision/page-sessions')) return false;
  let lock;
  try {
    if (url.pathname === '/api/vision/page-sessions' && req.method === 'POST') {
      const body = await parseBody(req);
      const reviewed = JSON.parse(await fs.readFile(path.resolve(__dirname, '../../public/annotations/home-reviewed.json'), 'utf8'));
      const entry = reviewed.boxes.find(b => String(b.id) === String(body.entryId));
      if (!entry) throw fail('请选择有效的主界面入口');
      const id = randomUUID(), dir = path.join(ROOT, id);
      await fs.mkdir(dir, { recursive: true });
      const data = { schemaVersion: 1, id, parentScene: 'home', entryId: entry.id, entryLabel: entry.label,
        createdAt: new Date().toISOString(), status: 'capturing', frames: [], segments: [] };
      await write(dir, data);
      send(res, 200, data); return true;
    }
    const match = /^\/api\/vision\/page-sessions\/([0-9a-f-]{36})(?:\/(frames|finish|flow|flow-scroll-\d+-\d+\.png|(?:frame-\d{3}\.jpg|segment-\d{3}\.png)))?$/.exec(url.pathname);
    if (!match) throw fail('Not found', 404);
    const [, id, action] = match, dir = path.join(ROOT, id);
    if (busy.has(id)) throw fail('此采集正在处理，请稍后重试', 409);
    busy.add(id); lock = id;
    const data = JSON.parse(await fs.readFile(path.join(dir, 'manifest.json'), 'utf8'));
    if (req.method === 'GET') {
      if(action==='flow')send(res,200,JSON.parse(await fs.readFile(path.join(dir,'flow.json'),'utf8')));
      else if (!action) send(res, 200, data);
      else {
        const flow=action.startsWith('flow-scroll-')?JSON.parse(await fs.readFile(path.join(dir,'flow.json'),'utf8')):null;
        if (![...data.frames, ...data.segments,...(flow?.images||[])].some(f => f.file === action)) throw fail('Not found', 404);
        const image = await fs.readFile(path.join(dir, action));
        res.writeHead(200, { 'Content-Type': action.endsWith('.png') ? 'image/png' : 'image/jpeg', 'Cache-Control': 'no-store' });
        res.end(image);
      }
      return true;
    }
    if (req.method !== 'POST') throw fail('Method not allowed', 405);
    if (action === 'frames') {
      if (data.status !== 'capturing' || data.frames.length >= 40) throw fail('采集已结束或达到40帧上限', 409);
      if (Number(url.searchParams.get('seq')) !== data.frames.length) throw fail('帧序号不匹配，请结束本次采集', 409);
      const image = await parseBinaryBody(req, 12000000);
      if (!validJpeg(image)) throw fail('需要有效 JPEG 图片，尺寸100–4096像素且不超过1200万像素');
      const file = `frame-${String(data.frames.length + 1).padStart(3, '0')}.jpg`;
      await fs.writeFile(path.join(dir, file), image);
      data.frames.push({ file, at: new Date().toISOString() });
      await write(dir, data);
      send(res, 200, data);
    } else if (action === 'finish') {
      if (stitching) throw fail('另一次拼接正在处理，请稍后重试', 409);
      stitching = true;
      try {
      data.status = 'processing'; await write(dir, data);
      try { data.segments = await runStitch(dir); data.status = 'complete'; }
      catch (error) { data.status = 'failed'; await write(dir, data); throw error; }
      await write(dir, data);
      // Flow analysis is lazy in the review page to avoid delaying capture completion.
      send(res, 200, data);
      } finally { stitching = false; }
    } else if(action==='flow') {send(res,200,await buildFlow(dir));}
    else throw fail('Not found', 404);
  } catch (error) {
    send(res, error.code === 'ENOENT' ? 404 : error.statusCode || 500, { error: error.statusCode ? error.message : '采集处理失败，已有文件保留在本机。' });
  } finally { if (lock) busy.delete(lock); }
  return true;
}
module.exports = { handlePageSessions, validJpeg };
