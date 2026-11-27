'use strict';
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');

function settings(env = process.env, saved = undefined) {
  if (saved === undefined) {
    const file = path.join(ROOT, 'data/minecraft-engine.local.json');
    saved = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).deepseekApiKey : '';
  }
  const dedicated = env.STS2_DEEPSEEK_API_KEY || env.DEEPSEEK_API_KEY;
  const key = dedicated || saved || env.OPENAI_API_KEY;
  const base = new URL(env.STS2_DEEPSEEK_BASE_URL || env.DEEPSEEK_BASE_URL ||
    ((dedicated || saved) ? 'https://api.deepseek.com' : env.OPENAI_BASE_URL || 'https://api.deepseek.com'));
  if (base.origin !== 'https://api.deepseek.com' || !['/', '/v1', '/v1/'].includes(base.pathname) || base.search || base.hash || base.username || base.password) {
    throw Error('STS2 requires the official DeepSeek API origin');
  }
  if (!key) throw Error('DeepSeek API Key is not configured');
  return {
    key, url: base.href.replace(/\/$/, '') + '/chat/completions',
    model: env.STS2_MODEL || env.DEEPSEEK_MODEL || 'deepseek-flash',
    keySource: dedicated ? 'environment' : saved ? 'existing-local-game-settings' : 'environment'
  };
}

module.exports = { settings };
