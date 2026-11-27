'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { config } = require('../minecraft/deepseek-planner');
const { planGoal } = require('./planner');

async function planWithApi(goal, { dataRoot = path.resolve(__dirname, '../..'), env = process.env, signal, fetchImpl } = {}) {
  signal?.throwIfAborted();
  const dedicated = env.GENSHIN_LLM_API_KEY || env.DEEPSEEK_API_KEY;
  const file = path.join(dataRoot, 'data/minecraft-engine.local.json');
  const saved = !dedicated && fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')).deepseekApiKey : '';
  // Reuse the saved game credential only at the original provider's origin.
  const settings = config({ ...env, DEEPSEEK_API_KEY: dedicated,
    DEEPSEEK_BASE_URL: env.GENSHIN_LLM_BASE_URL || env.DEEPSEEK_BASE_URL,
    DEEPSEEK_MODEL: env.GENSHIN_LLM_MODEL || env.DEEPSEEK_MODEL }, saved);
  return planGoal(goal, { mode: 'llm', signal, fetchImpl, env: { ...env,
    GENSHIN_LLM_API_KEY: settings.key, GENSHIN_LLM_MODEL: settings.model,
    GENSHIN_LLM_BASE_URL: settings.url.replace(/\/chat\/completions$/, '') } });
}
module.exports = { planWithApi };
