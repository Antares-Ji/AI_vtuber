'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AutonomyLoop } = require('../src/minecraft/autonomy-loop');
async function main() {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-demo-test-'));
  const state = { connected: true, health: 20, food: 8, inventory: [], busy: false, sessionId: 'test', dimension: 'overworld', reactive: { enabled: true, mode: 'idle' } };
  let plannedGoal, dispatches = 0;
  const loop = new AutonomyLoop({ logDir, planner: async (_state, options) => { plannedGoal = options.goal; return { action: 'eat' }; }, request: async route => {
    if (route === '/observe') return structuredClone(state);
    if (route === '/skill') dispatches++;
    if (route.startsWith('/task')) return { status: 'completed', result: { verified: true } };
    return { accepted: true };
  } });
  loop.modelHealth = async () => {};
  loop.addAudienceSuggestion('先看看饱食度和食物，再继续制作铁镐');
  await loop.runOnce('制作铁镐', new AbortController().signal);
  const goal = JSON.parse(plannedGoal);
  assert.equal(goal.longTermGoal, '制作铁镐'); assert.match(goal.audienceSuggestions[0], /饱食度/);
  assert.equal(dispatches, 1);
  const fullSuggestion = '核对真实观察。'.repeat(30) + '末尾纠错：unknown不是不可达，mine会检查路径。';
  loop.addAudienceSuggestion(fullSuggestion);
  await loop.runOnce('制作铁镐', new AbortController().signal);
  assert.equal(JSON.parse(plannedGoal).audienceSuggestions.at(-1), fullSuggestion);
  dispatches = 1;
  loop.state.enabled = true; loop.state.completionItem = 'crafting_table';
  state.inventory = [{ name: 'crafting_table', count: 1 }];
  await loop.step('制作工作台', new AbortController().signal);
  assert.equal(loop.state.enabled, false); assert.equal(loop.state.goalCompleted, true); assert.equal(dispatches, 1);
  loop.state.enabled = true; loop.state.goal = '制作铁镐';
  await assert.rejects(loop.start({ goal: '制作工作台', durationMinutes: 15 }), /已有目标/);
  loop.state.enabled = false;
  await assert.rejects(loop.start({ durationMinutes: 999 }), /时长/);
  console.log('Demo goals passed: audience context retains objective, inventory verifies completion, active goals cannot be overwritten.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
