'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AutonomyLoop, readTaskPartial } = require('../src/minecraft/autonomy-loop');
async function main() {
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'minecraft-partial-'));
  const sessionId = path.join(logDir, 'minecraft-session-123.jsonl');
  const partial = { verifiedPartial: true, gained: 1, items: ['cobblestone'], inventoryBefore: [], inventoryAfter: [{ name: 'cobblestone', count: 1 }], complete: false };
  const state = { connected: true, health: 20, food: 20, busy: false, sessionId, dimension: 'overworld', inventory: [], reactive: { enabled: true, mode: 'idle' } };
  let currentTask;
  const loop = new AutonomyLoop({ logDir, planner: async () => ({ action: 'mine', resource: 'stone', count: 4 }), request: async (route, body) => {
    if (route === '/observe') return state;
    if (route === '/skill') {
      currentTask = body.taskId;
      fs.writeFileSync(sessionId, 'x'.repeat(70000) + '\n' + JSON.stringify({ event: 'skill_failed', taskId: currentTask, partialResult: partial }) + '\n');
      return { accepted: true };
    }
    if (route.startsWith('/task')) return { status: 'failed', error: 'navigate: timeout' };
    return {};
  } });
  loop.modelHealth = async () => {};
  const result = await loop.runOnce('采矿', new AbortController().signal);
  assert.equal(result.verified, false, 'partial collection must not become full task success');
  assert.equal(result.evidence.status, 'failed');
  assert.equal(result.evidence.result.gained, 1);
  assert.equal(result.evidence.result.verified, undefined);
  assert.equal(result.evidence.partialEvidenceSource, 'correlated-skill-log');
  assert.equal(readTaskPartial(sessionId, 'different-task', logDir), null);
  assert.equal(readTaskPartial(sessionId, currentTask, path.join(logDir, 'other')), null, 'session outside permitted log directory refused');
  assert.equal(readTaskPartial(path.join(logDir, 'minecraft-session-999.jsonl'), currentTask, logDir), null, 'missing evidence stays unknown');
  loop.request = async route => route === '/observe' ? state : route.startsWith('/task') ? { status: 'completed', result: { verified: true, complete: false, gained: 1, requested: 4 } } : {};
  const incomplete = await loop.runOnce('采矿', new AbortController().signal);
  assert.equal(incomplete.verified, false, 'finished skill with partial quantity is not full goal completion');
  assert.equal(incomplete.evidence.status, 'completed', 'preserve executor lifecycle status');
  assert.match(incomplete.speech, /目标尚未完成/);
  assert.match(incomplete.speech, /已确认取得 1/);
  console.log('Partial evidence: task correlation, bounded log tail, path scope and failed status preserved.');
}
main().catch(error => { console.error(error); process.exitCode = 1; });
