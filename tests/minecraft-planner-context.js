'use strict';
const assert = require('node:assert/strict');
const { decisionMessages, SURVIVAL_SYSTEM } = require('../src/minecraft/survival-planner');
const state = { inventory: [{ name: 'spruce_planks', count: 64 }, { name: 'spruce_planks', count: 60 }], food: 20 };
const goal = JSON.stringify({ longTermGoal: '建立小家', audienceSuggestions: ['过时原料快照80木板', '第二条过时快照', '最新建议：核验真实库存和目标'], guidance: '保留用户长期目标', verifiedMilestone: 'crafting_table' });
const history = [
 { action: { action: 'craft', item: 'planks', count: 16 }, status: 'failed', error: 'old failure', result: { gained: 0, complete: false } },
 { action: { count: 16, item: 'planks', action: 'craft' }, status: 'failed', error: 'latest failure', result: { gained: 4, complete: false, verifiedPartial: true } },
 { action: { action: 'craft', item: 'planks', count: 16 }, status: 'completed', result: { gained: 16, complete: true, verified: true } },
 { action: { action: 'craft', item: 'planks', count: 16 }, status: 'completed', result: { gained: 20, complete: true, verified: true } },
 { action: { action: 'mine', resource: 'stone', count: 2 }, status: 'failed', error: 'no path' }
];
const before = JSON.stringify({state,history});
const messages = decisionMessages(state, { goal, history, currentSubgoal: '重复采木' });
const body = JSON.parse(messages[1].content);
assert.equal(body.goal, '建立小家'); assert.equal(body.latestAudienceSuggestion, '最新建议：核验真实库存和目标');
assert(!messages[1].content.includes('过时')); assert.equal(body.guidance, '保留用户长期目标'); assert.equal(body.verifiedMilestone, 'crafting_table');
assert.deepEqual(body.currentSubgoal, { text: '重复采木', status: 'needs_review' });
assert.equal(body.inventoryTotals.spruce_planks, 124); assert.deepEqual(body.state.inventory, state.inventory);
assert.equal(body.recentResults.length, 3); assert.equal(body.recentResults[0].error, 'latest failure');
assert.equal(body.recentResults[0].result.gained, 4); assert.equal(body.recentResults[0].result.verifiedPartial, true); assert.equal(body.recentResults[0].repeatedEntries, 2);
assert.equal(body.recentResults[1].result.gained, 20); assert.equal(body.recentResults[1].repeatedEntries, 2); assert.equal(body.recentResults[2].error, 'no path');
assert(messages[0].content.startsWith(SURVIVAL_SYSTEM), 'entire legal skill contract remains verbatim');
for (const tool of ['build_home', 'furnish_home', 'hunt', 'mine', 'build_portal']) assert(messages[0].content.includes(tool));
assert.equal(JSON.stringify({state,history}), before, 'request compaction never mutates game state or history');
for (const text of ['普通字符串目标', '{不合法JSON', JSON.stringify({ unrelated: 'data' })]) assert.equal(JSON.parse(decisionMessages(state, { goal: text })[1].content).goal, text);
assert.equal(JSON.parse(decisionMessages(state, { goal: JSON.stringify({ longTermGoal: '小家', audienceSuggestions: ['有效最新', null, ''] }) })[1].content).latestAudienceSuggestion, '有效最新');
assert.equal(JSON.parse(decisionMessages(state)[1].content).currentSubgoal, null);
console.log('Planner context checks passed: structured goal, latest-only suggestion, truthful inventory totals, old phase requires review, newest repeated results preserved, all tools retained, no input mutation.');
