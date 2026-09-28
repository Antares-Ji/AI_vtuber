const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

function error(message, statusCode = 400) { return Object.assign(new Error(message), { statusCode }); }

function describeOcr(raw) {
  if (!raw || typeof raw.text !== 'string' || !Number.isInteger(raw.width) || !Number.isInteger(raw.height) || raw.width < 1 || raw.height < 1) throw error('OCR 返回格式不正确', 502);
  const text = raw.text.slice(0, 16000);
  const compact = text.replace(/\s/g, '');
  const rules = [
    ['home', '主界面', ['终端', '干员', '基建', '采购中心']],
    ['results', '结算界面', ['行动结束', '作战记录', '获得奖励']],
    ['stage-select', '关卡选择', ['开始行动', '代理指挥', '推荐等级']]
  ];
  const matches = rules.map(([id, label, words]) => ({ id, label, evidence: words.filter(word => compact.includes(word)) })).filter(item => item.evidence.length >= 2);
  const candidate = matches.length === 1 ? matches[0] : null;
  return {
    provider: 'windows-ocr-arknights-rules-v1', game: 'arknights', scene: candidate?.id || 'unknown',
    description: candidate ? `根据文字线索，可能是${candidate.label}；这是规则推断，请对照原图核验。` : '无法可靠确定游戏场景；请参考识别文字和原始画面。',
    evidence: candidate?.evidence || [], text, width: raw.width, height: raw.height,
    language: raw.language || null, verified: false,
    limitations: ['仅文字规则，不是游戏视觉模型', '不能确认人物、敌人、战斗状态或操作目标']
  };
}

function runOcr(file, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'windows-ocr.ps1'), '-ImagePath', file], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', failed = null;
    const stop = reason => { failed ||= reason; child.kill(); };
    const onAbort = () => stop(error('识别已取消', 499));
    const timer = setTimeout(() => stop(error('本地 OCR 超时', 504)), 20000);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      if (output.length + chunk.length > 256000) stop(error('OCR 输出过大', 502));
      else output += chunk;
    });
    child.stderr.resume();
    child.on('error', () => { failed ||= error('无法启动系统 OCR', 503); });
    child.on('close', code => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (failed) return reject(failed);
      if (code !== 0) return reject(error('系统 OCR 无法读取图片', 422));
      try { resolve(JSON.parse(output.replace(/^\uFEFF/, ''))); }
      catch { reject(error('系统 OCR 返回无效数据', 502)); }
    });
  });
}

function createAnalyzer({ recognize = runOcr } = {}) {
  let busy = false;
  return async function analyze(buffer, signal) {
    signal?.throwIfAborted();
    if (!Buffer.isBuffer(buffer) || buffer.length < 12 || buffer.length > 12000000) throw error('图片大小不合法');
    const png = buffer.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]));
    const jpeg = buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255;
    if (!png && !jpeg) throw error('仅支持 PNG/JPEG 图片');
    if (busy) throw error('正在识别上一帧，请稍后重试', 409);
    busy = true;
    let directory;
    const startedAt = Date.now();
    try {
      directory = await fs.mkdtemp(path.join(os.tmpdir(), 'vtuber-ocr-'));
      const file = path.join(directory, png ? 'frame.png' : 'frame.jpg');
      await fs.writeFile(file, buffer);
      signal?.throwIfAborted();
      const raw = await recognize(file, signal);
      signal?.throwIfAborted();
      return { ...describeOcr(raw), latencyMs: Date.now() - startedAt };
    } finally {
      try {
        if (directory) {
          await fs.unlink(path.join(directory, png ? 'frame.png' : 'frame.jpg')).catch(e => { if (e.code !== 'ENOENT') throw e; });
          await fs.rmdir(directory);
        }
      } finally { busy = false; }
    }
  };
}
module.exports = { describeOcr, createAnalyzer, analyzeArknights: createAnalyzer() };
