// Emit only launcher settings, never the complete environment or credentials.
require('../src/config/env').loadEnv();
const path = require('node:path');
const fs = require('node:fs');
const projectRoot = path.resolve(__dirname, '..');
const legacyRoot = 'D:/GPT-SoVITS-v2pro-20250604-nvidia50';
const root = process.env.GPT_SOVITS_ROOT || (fs.existsSync(path.join(legacyRoot, 'runtime/python.exe')) ? legacyRoot : path.join(projectRoot, 'third_party/GPT-SoVITS'));
console.log(JSON.stringify({
  root: path.resolve(root),
  python: process.env.GPT_SOVITS_PYTHON || path.join(root, fs.existsSync(path.join(root, 'runtime/python.exe')) ? 'runtime/python.exe' : '.venv/Scripts/python.exe'),
  config: process.env.GPT_SOVITS_INFER_CONFIG || path.join(projectRoot, 'runtime/gpt-sovits/tts_infer.yaml'),
  port: process.env.GPT_SOVITS_PORT || '9880'
}));
