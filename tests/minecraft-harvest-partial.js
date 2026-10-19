'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(registry);
const { executeSkill, isSkillBusy } = require('../src/minecraft/survival-skills');
const first = new Vec3(2, 64, 0), second = new Vec3(10, 64, 0);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fakeBot() {
  const bot = new EventEmitter(), removed = new Set(), items = [{ name: 'wooden_pickaxe', count: 1, type: registry.itemsByName.wooden_pickaxe.id }];
  Object.assign(bot, {
    registry, game: { gameMode: 'survival' }, health: 20, food: 20, entities: {}, entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 },
    inventory: { items: () => items }, _items: items, _dug: [], _goals: [],
    findBlocks: () => [first, second],
    blockAt(p) { const name = !removed.has(p.toString()) && (p.equals(first) || p.equals(second)) || p.y < 64 ? 'stone' : 'air'; const b = Block.fromStateId(registry.blocksByName[name].minStateId, 0); b.position = p; return b; },
    canDigBlock: b => b.position.distanceTo(bot.entity.position) < 5,
    world: { raycast: eye => bot.blockAt(eye.x > 5 ? second : first) },
    equip: async item => { bot.heldItem = item; },
    dig: async block => { bot._dug.push(block.position.toString()); removed.add(block.position.toString()); items.push({ name: 'cobblestone', count: 1 }); },
    clearControlStates() {}, stopDigging() {}, deactivateItem() {},
    pathfinder: { setMovements() {}, setGoal() {}, *getPathFromTo(movement, start, goal) { yield { result: { status: 'success', path: [new Vec3(goal.position.x - 2, goal.position.y, goal.position.z)] } }; }, async goto(goal) { bot._goals.push(goal); if ((goal.position?.x ?? goal.x) === second.x) throw new Error('No path to candidate'); } }
  });
  return bot;
}
async function rejected(promise) { try { await promise; assert.fail('Expected rejection'); } catch (error) { return error; } }
(async () => {
  const bot = fakeBot(), logs = [];
  const partial = await executeSkill(bot, { action: 'mine', resource: 'stone', count: 4 }, { log: event => logs.push(event) });
  assert.equal(partial.gained, 1); assert.equal(partial.complete, false); assert.equal(partial.verified, true);
  assert(!bot._goals.some(g => g.constructor.name === 'GoalGetToBlock' && g.x === first.x), 'visible reachable safe stone skips approach navigation');
  assert(logs.some(e => e.event === 'candidate_target' && e.directDig && e.position.x === first.x));
  assert(logs.some(e => e.event === 'candidate_failed' && e.position.x === second.x));
  for (const guard of ['missing-raycast', 'blocked-raycast', 'out-of-reach', 'adjacent-lava']) {
    const blocked = fakeBot(); blocked.findBlocks = () => [first];
    if (guard === 'missing-raycast') blocked.world = {};
    if (guard === 'blocked-raycast') blocked.world.raycast = () => ({ position: new Vec3(1, 64, 0) });
    if (guard === 'out-of-reach') blocked.canDigBlock = () => false;
    if (guard === 'adjacent-lava') { const original = blocked.blockAt; blocked.blockAt = p => p.equals(first.offset(0, 0, 1)) ? { name: 'lava', position: p } : original(p); }
    blocked.pathfinder.goto = async () => { throw new Error('No path'); };
    const error = await rejected(executeSkill(blocked, { action: 'mine', resource: 'stone', count: 1 }));
    assert.match(error.message, /No inventory gain/); assert.equal(blocked._dug.length, 0, guard); assert.equal(error.partialResult, undefined);
  }
  for (const mode of ['deadline', 'cancel']) {
    const interrupted = fakeBot(), controller = new AbortController(), trace = []; let release, entered;
    const started = new Promise(resolve => { entered = resolve; });
    interrupted.pathfinder.goto = async goal => { interrupted._goals.push(goal); if ((goal.position?.x ?? goal.x) === second.x) { entered(); await new Promise(resolve => { release = resolve; }); } };
    const task = executeSkill(interrupted, { action: 'mine', resource: 'stone', count: 4 }, { timeoutMs: mode === 'deadline' ? 40 : 1000, signal: controller.signal, log: e => trace.push(e) });
    await started;
    if (mode === 'cancel') controller.abort(new Error('External cancellation'));
    const error = await rejected(task);
    assert.match(error.message, mode === 'deadline' ? /deadline/ : /External cancellation/);
    assert.equal(error.partialResult.verifiedPartial, true); assert.equal(error.partialResult.gained, 1);
    assert.equal(error.partialResult.complete, false); assert.equal(error.partialResult.verified, undefined);
    assert.deepEqual(error.partialResult.inventoryAfter.filter(i => i.name === 'cobblestone'), [{ name: 'cobblestone', count: 1 }]);
    assert(trace.some(e => e.event === 'skill_failed' && e.partialResult?.gained === 1));
    assert(!trace.some(e => e.event === 'skill_verified')); assert(isSkillBusy(interrupted));
    const operations = interrupted._goals.length; release(); await sleep(5);
    assert.equal(interrupted._dug.length, 1); assert.equal(interrupted._goals.length, operations, 'no new operations after cancellation'); assert(!isSkillBusy(interrupted));
  }
  const noGain = fakeBot(); noGain.findBlocks = () => [second];
  noGain.pathfinder.goto = () => new Promise(() => {});
  const error = await rejected(executeSkill(noGain, { action: 'mine', resource: 'stone', count: 1 }, { timeoutMs: 25 }));
  assert.equal(error.partialResult, undefined, 'no partial evidence without relevant positive inventory delta');
  console.log('Harvest checks passed: direct digging guarded by reach/hazards/LOS; ordinary partial completion; failed deadline/cancel retain corroborated partial evidence; no postcancel operations.');
})().catch(error => { console.error(error); process.exitCode = 1; });
