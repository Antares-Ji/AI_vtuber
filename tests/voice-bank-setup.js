const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { prepare, apply } = require('../scripts/configure-voice');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-bank-'));
// A fixed temp directory owned by this test; no user/service files are touched.
try {
  const service = path.join(root, 'service with spaces');
  const project = path.join(root, 'project');
  fs.mkdirSync(project);
  for (const name of ['api_v2.py', 'runtime/python.exe', 'GPT_weights_v4/希儿-e10.ckpt', 'SoVITS_weights_v4/voice.pth', 'reference.wav']) {
    const file = path.join(service, name);
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, 'fixture');
  }
  for (const name of ['chinese-roberta-wwm-ext-large', 'chinese-hubert-base']) fs.mkdirSync(path.join(service, 'GPT_SoVITS/pretrained_models', name), { recursive: true });
  const profile = { id: 'seele', version: 'v4', serviceRoot: service, gptWeights: 'GPT_weights_v4/希儿-e10.ckpt', sovitsWeights: 'SoVITS_weights_v4/voice.pth', referenceAudio: path.join(service, 'reference.wav'), referenceText: '今天，我说：“你好”。', device: 'cpu' };
  const file = path.join(root, 'voice.json');
  const save = p => fs.writeFileSync(file, JSON.stringify(p));
  save(profile);
  const planned = prepare(file, project);
  assert.equal(fs.existsSync(path.join(project, '.env.local')), false, 'dry run must not write');
  const config = JSON.parse(planned.yaml).custom;
  assert.equal(config.is_half, false);
  assert.ok(config.t2s_weights_path.endsWith('希儿-e10.ckpt'));
  const oldEnv = '# keep this\nOPENAI_API_KEY=fixture-secret\nGPT_SOVITS_PROFILE=old\nGPT_SOVITS_PROFILE=duplicate\nGPT_SOVITS_REF_AUDIO_HAPPY=old.wav\n';
  fs.writeFileSync(path.join(project, '.env.local'), oldEnv);
  const backup = apply(planned, project);
  assert.equal(fs.readFileSync(path.join(backup, 'env.local'), 'utf8'), oldEnv);
  const result = fs.readFileSync(path.join(project, '.env.local'), 'utf8');
  assert.ok(result.includes('OPENAI_API_KEY=fixture-secret'));
  assert.equal((result.match(/GPT_SOVITS_PROFILE=/g) || []).length, 1);
  assert.ok(result.includes('GPT_SOVITS_REF_AUDIO_HAPPY=""'));
  // Exercise the real .env loader in an isolated child using a temporary layout.
  fs.mkdirSync(path.join(project, 'src/config'), { recursive: true });
  fs.copyFileSync(path.join(__dirname, '../src/config/env.js'), path.join(project, 'src/config/env.js'));
  const child = spawnSync(process.execPath, ['-e', "require('./src/config/env').loadEnv(); console.log(JSON.stringify({text:process.env.GPT_SOVITS_PROMPT_TEXT,emotion:process.env.GPT_SOVITS_REF_AUDIO_HAPPY}))"], { cwd: project, encoding: 'utf8' });
  assert.equal(child.status, 0, child.stderr);
  assert.deepEqual(JSON.parse(child.stdout), { text: profile.referenceText, emotion: '' });
  for (const override of [{ gptWeights: 'missing.ckpt' }, { referenceText: 'bad\nPORT=9999' }, { referenceText: '请填写原文' }, { version: 'unknown' }, { speed: 9 }, { port: 1 }, { emotions: { fake: {} } }]) {
    save({ ...profile, ...override });
    assert.throws(() => prepare(file, project));
    assert.equal(fs.readFileSync(path.join(project, '.env.local'), 'utf8'), result, 'failed validation must preserve configuration');
  }
  console.log('Voice bank setup: dry run, exact weights, backup, env round-trip, stale emotion reset and invalid-input checks passed.');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
