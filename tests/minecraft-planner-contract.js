'use strict';
const assert = require('node:assert/strict');
const { SURVIVAL_SYSTEM, SURVIVAL_ACTION_SCHEMA, decisionMessages, planSurvival } = require('../src/minecraft/survival-planner');
const { validateAction } = require('../src/minecraft/survival-skills');

// Decode the compact model-facing contract independently of its formatter.
// Every legal action must retain all required/optional fields and exact bounds.
const commonLine = SURVIVAL_SYSTEM.split('\n').find(line => line.startsWith('公共定义：'));
const common = new Map(commonLine.slice('公共定义：'.length).split(';').map(part => {
  const at = part.indexOf(':'); return [part.slice(0, at), part.slice(at + 1)];
}));
const rows = new Map(SURVIVAL_SYSTEM.split('\n').flatMap(line => {
  const match = /^([a-z_]+)\((.*)\)$/.exec(line);
  return match ? [[match[1], match[2] ? match[2].split(',') : []]] : [];
}));
assert.equal(rows.size, SURVIVAL_ACTION_SCHEMA.oneOf.length);
assert.equal(rows.size, 75);
for (const schema of SURVIVAL_ACTION_SCHEMA.oneOf) {
  const action = schema.properties.action.const, fields = new Map();
  assert(rows.has(action), `missing action ${action}`);
  for (const entry of rows.get(action)) {
    const match = /^([a-zA-Z]+)(\?)?(?::(.*))?$/.exec(entry);
    assert(match, `invalid field declaration ${entry}`);
    const [, name, optional, inline] = match, type = inline || common.get(name);
    assert(type, `missing type for ${action}.${name}`);
    let rule, sample;
    const int = /^int\[(-?\d+)\.\.(-?\d+)\]$/.exec(type);
    const str = /^str\[(\d+)\.\.(\d+)\]$/.exec(type);
    if (int) { rule = { type: 'integer', minimum: Number(int[1]), maximum: Number(int[2]) }; sample = rule.minimum; }
    else if (str) { rule = { type: 'string', minLength: Number(str[1]), maxLength: Number(str[2]) }; sample = 'x'.repeat(rule.minLength); }
    else { rule = { enum: type.split('|').map(value => JSON.parse(value)) }; sample = rule.enum[0]; }
    fields.set(name, { rule, optional: Boolean(optional), sample });
  }
  assert.deepEqual([...fields.keys()], Object.keys(schema.properties).filter(name => name !== 'action'), `${action} fields`);
  const example = { action };
  for (const [name, { rule, optional, sample }] of fields) {
    const actual = { ...schema.properties[name] };
    if (actual.type === 'string') actual.minLength ??= 0;
    assert.deepEqual(rule, actual, `${action}.${name} bounds or enum changed`);
    assert.equal(optional, !schema.required.includes(name), `${action}.${name} required status changed`);
    example[name] = sample;
  }
  assert.deepEqual(validateAction(example), example, `${action} model-facing example must remain callable`);
}
assert(SURVIVAL_SYSTEM.length < 5500, 'compact shared contract and guidance should not regrow the old 7,311-character system prompt');
assert(!SURVIVAL_SYSTEM.includes('进度参考：'), 'a home goal must not inherit a fixed Nether tutorial');
for (const fact of ['71块', 'home.material', '3同色羊毛+3木板', '生肉可直接eat', 'count指所需输出数', 'unknownCells', 'not_checked', '10 obsidian+4 cobblestone', 'verified=false']) assert(SURVIVAL_SYSTEM.includes(fact), fact);

const state = { health: 6, inventory: [{ name: 'spruce_planks', count: 4 }],
  recipeHints: [{ item: 'wooden_sword', missing: [{ name: 'stick', count: 1 }], oneRecipeExample: true }],
  resources: { stone: [{ name: 'stone', position: { x: 1, y: 64, z: 2 }, reachability: { status: 'unknown', reason: 'not_checked' } }] },
  animals: [{ id: 21, name: 'sheep', position: { x: 4, y: 64, z: 2 }, direction: 'east' }] };
const goal = JSON.stringify({ longTermGoal: '建房做床', guidance: '先核验工作台和木剑材料', audienceSuggestions: ['按最新攻略缺口规划'], verifiedMilestone: 'crafting_table' });
const body = JSON.parse(decisionMessages(state, { goal })[1].content);
assert.equal(body.goal, '建房做床'); assert.equal(body.guidance, '先核验工作台和木剑材料');
assert.equal(body.latestAudienceSuggestion, '按最新攻略缺口规划');
assert.deepEqual(body.inventoryTotals, { spruce_planks: 4 });
assert.deepEqual(body.state.recipeHints, state.recipeHints);
assert.equal(body.state.resources.stone[0].reachability.reason, 'not_checked');
assert.equal(body.state.animals[0].id, 21);

(async () => {
  let request;
  const selected = { subgoal: '补齐木棍', reason: '木剑缺一根', plan: [{ action: 'craft', item: 'stick', count: 4 }] };
  const result = await planSurvival(state, { goal, onPlan() {}, onReview() {}, onRequest(value) { request = value; },
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify(selected) } }] }) }) });
  assert.deepEqual(result, selected.plan[0], 'model alone still chooses the next action');
  assert.equal((request.messages[0].content.match(/返回\{"subgoal"/g) || []).length, 1, 'one output contract for review mode');
  assert(!request.messages[0].content.includes('返回{"plan"'), 'no competing shorter output contract');
  assert(!request.messages[0].content.includes('当前非扩展模式'), 'expanded mode must not receive disabled low-health rules');
  assert.equal(request.max_tokens, 220);
  console.log(`Planner contract checks passed: all ${rows.size} actions and exact fields/bounds retained; facts and Qwen choices preserved; system ${SURVIVAL_SYSTEM.length} chars.`);
})().catch(error => { console.error(error); process.exitCode = 1; });
