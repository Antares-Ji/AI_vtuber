'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(registry);
const { executeSkill, isSkillBusy } = require('../src/minecraft/survival-skills');
const target = new Vec3(2, 66, 0), landing = new Vec3(2.5, 64, 0.5);
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
function fakeBot(mode = 'new') {
  const bot = new EventEmitter(), items = []; let removed = false, stack = 1;
  const drop = { id: 41, position: landing.clone(), getDroppedItem: () => ({ name: mode === 'unrelated' ? 'dirt' : 'oak_log', count: stack }) };
  Object.assign(bot, { registry, game: { gameMode: 'survival' }, health: 20, food: 20, entities: {}, entity: { position: new Vec3(0.5, 64, 0.5) }, inventory: { items: () => items }, _goals: [], _digs: 0, _drop: drop,
    findBlocks: () => [target],
    blockAt(p) { let name = !removed && p.equals(target) ? 'oak_log' : p.y < 64 ? 'stone' : 'air'; if (mode === 'water' && p.equals(landing.floored())) name = 'water'; if (mode === 'cliff' && p.equals(landing.floored().offset(0,-1,0))) name = 'air'; const b = Block.fromStateId(registry.blocksByName[name].minStateId, 0); b.position = p; return b; },
    canDigBlock: () => true, world: { raycast: () => bot.blockAt(target) },
    dig: async () => { removed = true; bot._digs++; if (mode === 'merged') stack++; bot.entities[41] = drop; if (mode === 'falling') { drop.position.y = 65; setTimeout(() => { drop.position.y = 64; }, 180); } },
    clearControlStates() {}, stopDigging() {}, deactivateItem() {},
    pathfinder: { setMovements(m) { this.movements = m; }, setGoal() {},
      *getPathFromTo(movement, origin, goal) { if (mode === 'moved') drop.position.x += 3; yield { result: { status: 'success', path: [new Vec3(goal.x, goal.y, goal.z)] } }; },
      async goto(goal) { bot._goals.push(goal); bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); delete bot.entities[41]; if (mode !== 'disappeared') items.push({ name: 'oak_log', count: 1 }); }
    }
  });
  if (['old', 'merged'].includes(mode)) bot.entities[41] = drop;
  return bot;
}
(async () => {
  const airborne = fakeBot(), landingLogs = [];
  airborne.entity.onGround = false;
  const originalDig = airborne.dig;
  airborne.dig = async () => { assert.equal(airborne.entity.onGround, true, 'dig cannot snapshot airborne penalty'); return originalDig(); };
  setTimeout(() => { airborne.entity.onGround = true; }, 50);
  assert.equal((await executeSkill(airborne, { action: 'gather_wood', count: 1 }, { log: e => landingLogs.push(e) })).gained, 1);
  assert(landingLogs.some(e => e.event === 'harvest_dig_start' && e.onGround === true));
  const movedDuringLanding = fakeBot(); movedDuringLanding.entity.onGround = false;
  setTimeout(() => { movedDuringLanding.entity.onGround = true; movedDuringLanding.world.raycast = () => null; }, 50);
  await assert.rejects(executeSkill(movedDuringLanding, { action: 'gather_wood', count: 1 }), /no longer safely diggable/);
  assert.equal(movedDuringLanding._digs, 0, 'landing must recheck sight and reach');
  const interruptedLanding = fakeBot(), landingAbort = new AbortController(); interruptedLanding.entity.onGround = false;
  setTimeout(() => landingAbort.abort(new Error('cancel landing')), 30);
  await assert.rejects(executeSkill(interruptedLanding, { action: 'gather_wood', count: 1 }, { signal: landingAbort.signal }), /cancel landing/);
  assert.equal(interruptedLanding._digs, 0);
  const neverLands = fakeBot(); neverLands.entity.onGround = false;
  await assert.rejects(executeSkill(neverLands, { action: 'gather_wood', count: 1 }), /harvest landing: server verification failed/);
  assert.equal(neverLands._digs, 0, 'bounded landing wait never mines while still airborne');
  for (const mode of ['new', 'merged', 'falling']) {
    const bot = fakeBot(mode), logs = [];
    const result = await executeSkill(bot, { action: 'gather_wood', count: 1 }, { log: x => logs.push(x) });
    assert.equal(result.gained, 1); assert.equal(bot._goals.length, 1); assert.equal(bot._goals[0].y, 64, 'approaches landing, not high vacated log');
    assert(logs.some(e => e.event === 'harvest_drop_approach')); assert.match(result.gainAttribution, /not proven/);
  }
  for (const mode of ['old', 'unrelated', 'water', 'cliff', 'moved', 'disappeared']) {
    const bot = fakeBot(mode);
    await assert.rejects(executeSkill(bot, { action: 'gather_wood', count: 1 }, { timeoutMs: 240 }), /deadline/);
    assert.equal(bot._goals.length, mode === 'disappeared' ? 1 : 0, mode);
  }
  const bot = fakeBot(), controller = new AbortController(); let entered, release;
  const started = new Promise(resolve => { entered = resolve; });
  bot.pathfinder.goto = async goal => { bot._goals.push(goal); entered(); await new Promise(resolve => { release = resolve; }); };
  const task = executeSkill(bot, { action: 'gather_wood', count: 2 }, { signal: controller.signal });
  await started; controller.abort(new Error('cancel pickup'));
  await assert.rejects(task, /cancel pickup/); assert(isSkillBusy(bot));
  release(); await sleep(10); assert(!isSkillBusy(bot)); assert.equal(bot._goals.length, 1); assert.equal(bot._digs, 1);
  console.log('Harvest pickup passed: post-dig metadata/stack evidence, landing wait, dry supported routes, moved target rejection, disappearance unconfirmed, cancellation/native lock.');
})().catch(error => { console.error(error); process.exitCode = 1; });
