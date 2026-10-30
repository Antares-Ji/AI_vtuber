'use strict';
const assert = require('node:assert/strict');
const { createSkillHost } = require('../src/skills');
(async () => {
  const host = createSkillHost();
  const job = host.start({ skill: 'mcplayer:harness-demo' });
  const result = await host.wait(job.id);
  assert.equal(result.state, 'SIMULATED', result.error || 'simulation classification');
  assert.equal(result.result.state, 'VERIFIED');
  assert.equal(result.result.steps, 3);
  console.log('PASS: unified Skill -> original Java Harness -> three actions -> verified simulated receipt');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
