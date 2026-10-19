// Local-only voice bank preparation. No download, training or service restart.
const fs = require('node:fs');
const path = require('node:path');
const { TTS_EMOTIONS } = require('../src/tts/style');
function line(value, name) {
  if (typeof value !== 'string' || !value.trim() || /[\r\n\0]/.test(value)) throw Error(`${name}: expected a non-empty single line`);
  return value.trim();
}
function existing(root, value, name, directory = false) {
  const resolved = path.resolve(root, line(value, name));
  const stat = fs.statSync(resolved, { throwIfNoEntry: false });
  if (!stat || (directory ? !stat.isDirectory() : !stat.isFile())) throw Error(`${name}: missing ${resolved}`);
  return resolved;
}
const portable = value => value.replace(/\\/g, '/');
function prepare(profileFile, projectRoot) {
  const p = JSON.parse(fs.readFileSync(profileFile, 'utf8').replace(/^\uFEFF/, ''));
  const profileDir = path.dirname(path.resolve(profileFile));
  const id = line(p.id, 'id');
  if (!/^[a-z0-9_-]+$/i.test(id)) throw Error('id: use letters, digits, dash or underscore');
  if (!['v1', 'v2', 'v3', 'v4', 'v2Pro', 'v2ProPlus'].includes(p.version)) throw Error('version: specify the actual voice bank version');
  const root = existing(profileDir, p.serviceRoot, 'serviceRoot', true);
  existing(root, 'api_v2.py', 'api_v2.py');
  const python = existing(root, p.python || 'runtime/python.exe', 'python');
  const gpt = existing(root, p.gptWeights, 'gptWeights');
  const sovits = existing(root, p.sovitsWeights, 'sovitsWeights');
  const bert = existing(root, p.bertPath || 'GPT_SoVITS/pretrained_models/chinese-roberta-wwm-ext-large', 'bertPath', true);
  const hubert = existing(root, p.hubertPath || 'GPT_SoVITS/pretrained_models/chinese-hubert-base', 'hubertPath', true);
  const reference = existing(profileDir, p.referenceAudio, 'referenceAudio');
  const text = line(p.referenceText, 'referenceText');
  if (text.includes('请填写')) throw Error('referenceText: replace the example with the exact transcript');
  const device = p.device || 'cuda';
  if (!/^(cpu|cuda(?::\d+)?)$/.test(device)) throw Error('device: expected cpu or cuda[:index]');
  const speed = p.speed === undefined ? 1.0 : p.speed;
  if (typeof speed !== 'number' || !Number.isFinite(speed) || speed < 0.84 || speed > 1.16) throw Error('speed: expected 0.84–1.16');
  const port = p.port === undefined ? 9880 : p.port;
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw Error('port: expected 1024–65535');
  const lang = p.promptLanguage || 'zh';
  if (!['zh', 'en', 'ja', 'ko', 'yue', 'all_zh', 'all_ja', 'all_ko', 'all_yue', 'auto', 'auto_yue'].includes(lang)) throw Error('promptLanguage: unsupported value');
  const config = path.join(projectRoot, 'runtime/gpt-sovits/tts_infer.yaml');
  const env = {
    TTS_PROVIDER: 'gpt-sovits', GPT_SOVITS_PROFILE: id,
    GPT_SOVITS_ROOT: portable(root), GPT_SOVITS_PYTHON: portable(python),
    GPT_SOVITS_INFER_CONFIG: portable(config), GPT_SOVITS_PORT: String(port),
    GPT_SOVITS_BASE_URL: `http://127.0.0.1:${port}`,
    GPT_SOVITS_REF_AUDIO: portable(reference), GPT_SOVITS_PROMPT_TEXT: text,
    GPT_SOVITS_PROMPT_LANG: lang, GPT_SOVITS_TEXT_LANG: 'zh', GPT_SOVITS_SPEED: String(speed)
  };
  // Clear previous-bank emotion references, including inherited .env values.
  for (const emotion of TTS_EMOTIONS) {
    env[`GPT_SOVITS_REF_AUDIO_${emotion.toUpperCase()}`] = '';
    env[`GPT_SOVITS_PROMPT_TEXT_${emotion.toUpperCase()}`] = '';
  }
  for (const [emotion, ref] of Object.entries(p.emotions || {})) {
    if (!TTS_EMOTIONS.includes(emotion)) throw Error(`Unknown emotion: ${emotion}`);
    env[`GPT_SOVITS_REF_AUDIO_${emotion.toUpperCase()}`] = portable(existing(profileDir, ref.audio, `emotions.${emotion}.audio`));
    env[`GPT_SOVITS_PROMPT_TEXT_${emotion.toUpperCase()}`] = line(ref.text, `emotions.${emotion}.text`);
  }
  // JSON is valid YAML. Quoted paths/transcripts cannot inject YAML fields.
  const yaml = JSON.stringify({ custom: {
    device, is_half: device !== 'cpu', version: p.version,
    t2s_weights_path: portable(gpt), vits_weights_path: portable(sovits),
    bert_base_path: portable(bert), cnhuhbert_base_path: portable(hubert)
  } }, null, 2) + '\n';
  return { id, config, yaml, env };
}
function mergeEnv(content, updates) {
  const lines = content.split(/\r?\n/).filter(raw => {
    const match = raw.match(/^\s*([A-Z0-9_]+)\s*=/);
    return !match || !Object.hasOwn(updates, match[1]);
  });
  while (lines.at(-1) === '') lines.pop();
  // src/config/env.js strips only surrounding quotes, without unescaping.
  for (const [key, value] of Object.entries(updates)) lines.push(`${key}="${value}"`);
  return lines.join('\n') + '\n';
}
function apply(prepared, projectRoot) {
  const envFile = path.join(projectRoot, '.env.local');
  const oldEnv = fs.existsSync(envFile) ? fs.readFileSync(envFile, 'utf8') : '';
  fs.mkdirSync(path.dirname(prepared.config), { recursive: true });
  const backup = path.join(projectRoot, 'runtime/gpt-sovits/backups', `${Date.now()}-${process.pid}`);
  fs.mkdirSync(backup, { recursive: true });
  if (fs.existsSync(envFile)) fs.copyFileSync(envFile, path.join(backup, 'env.local'));
  if (fs.existsSync(prepared.config)) fs.copyFileSync(prepared.config, path.join(backup, 'tts_infer.yaml'));
  fs.writeFileSync(prepared.config, prepared.yaml, 'utf8');
  fs.writeFileSync(envFile, mergeEnv(oldEnv, prepared.env), 'utf8');
  return backup;
}
if (require.main === module) {
  try {
    const args = process.argv.slice(2);
    if (args.length < 1 || args.length > 2 || (args[1] && args[1] !== '--apply')) throw Error('Usage: node scripts/configure-voice.js <private-profile.json> [--apply]');
    const root = path.resolve(__dirname, '..');
    const prepared = prepare(path.resolve(args[0]), root);
    if (args[1] === '--apply') console.log(`Voice ${prepared.id} configured. Restart GPT-SoVITS and Node to activate it. Backup: ${apply(prepared, root)}`);
    else console.log(`Voice ${prepared.id}: required paths validated; no files changed. Use --apply to configure. Model compatibility and speech need a live test.`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
module.exports = { prepare, mergeEnv, apply };
