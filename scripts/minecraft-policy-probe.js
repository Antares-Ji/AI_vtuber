'use strict';
// Read-only A/B diagnosis on one immutable observed state. Never executes skills.
require('../src/config/env').loadEnv();
const fs = require('node:fs');
const path = require('node:path');
const { controlRequest } = require('../src/minecraft/autonomy-loop');
const { decisionMessages } = require('../src/minecraft/survival-planner');
const { getLocalLlmConfig } = require('../src/brain/local-llm');
async function main() {
  const state = await controlRequest('/observe');
  const loop = await fetch('http://127.0.0.1:3000/api/minecraft/loop').then(r => r.json());
  const messages = decisionMessages(state, { history: loop.history, goal: loop.goal });
  const config = getLocalLlmConfig();
  const results = [];
  for (const task of [null, 'minecraft-survival']) {
    const start = Date.now();
    const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: config.model, task, temperature: 0, max_tokens: 160, messages }), signal: AbortSignal.timeout(60000)
    });
    if (!response.ok) throw new Error(`Model HTTP ${response.status}`);
    const payload = await response.json();
    results.push({ task, latencyMs: Date.now() - start, metadata: payload.metadata, content: payload.choices?.[0]?.message?.content });
  }
  const output = path.resolve(__dirname, `../output/minecraft-training/live-probe-${Date.now()}.json`);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify({ at: new Date().toISOString(), readOnly: true, state, messages, results }, null, 2));
  console.log(JSON.stringify({ output, results }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
