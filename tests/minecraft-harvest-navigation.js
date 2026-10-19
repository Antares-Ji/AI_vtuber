'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(registry);
const { executeSkill } = require('../src/minecraft/survival-skills');
const targets = [new Vec3(2, 64, 0), new Vec3(10, 64, 0)];
function fakeBot() {
  const bot = new EventEmitter(), removed = new Set(), items = [{ name: 'wooden_pickaxe', count: 1, type: registry.itemsByName.wooden_pickaxe.id }];
  Object.assign(bot, { registry, game: { gameMode: 'survival' }, health: 20, food: 20, entities: {}, entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 }, inventory: { items: () => items },
    _digs: [], _probes: [], _rays: [], _goals: [], _stops: 0,
    findBlocks: () => targets,
    blockAt(p) { const name = (targets.some(t => t.equals(p)) && !removed.has(p.toString())) || p.y < 64 ? 'stone' : 'air'; const b = Block.fromStateId(registry.blocksByName[name].minStateId, 0); b.position = p; return b; },
    canDigBlock: b => b.position.distanceTo(bot.entity.position) < 4,
    world: { raycast(eye) { bot._rays.push(eye.clone()); return eye.x > 5 ? bot.blockAt(targets[1]) : null; } },
    equip: async item => { bot.heldItem = item; }, dig: async b => { bot._digs.push(b.position); removed.add(b.position.toString()); items.push({ name: 'cobblestone', count: 1 }); },
    clearControlStates() {}, stopDigging() {}, deactivateItem() {},
    pathfinder: { setMovements(m) { this.movements = m; }, setGoal() { bot._stops++; },
      *getPathFromTo(movement, origin, goal) {
        bot._probes.push(goal.position);
        assert.equal(movement.canDig, false); assert.equal(movement.maxDropDown, 2); assert.equal(movement.allowParkour, false);
        assert.equal(goal.isEnd(goal.position.offset(0, 1, 0)), false, 'standing on target never satisfies harvest goal');
        assert.equal(goal.isEnd(goal.position.offset(0, -2, 0)), false, 'target directly above head never satisfies harvest goal');
        yield { result: goal.position.equals(targets[0]) ? { status: 'noPath', path: [] } : { status: 'success', path: [new Vec3(8, 64, 0)] } };
      },
      async goto(goal) { bot._goals.push(goal); bot.entity.position = goal.position ? new Vec3(8.5, 64, 0.5) : new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); }
    }
  }); return bot;
}
(async () => {
  const bot = fakeBot(), trace = [];
  const result = await executeSkill(bot, { action: 'mine', resource: 'stone', count: 1 }, { log: x => trace.push(x) });
  assert.equal(result.gained, 1); assert.deepEqual(bot._probes, [targets[1]]); assert.deepEqual(bot._digs, [targets[1]], 'try reachable same-resource candidate after noPath');
  assert(bot._rays.some(p => p.x === 8.5 && p.y === 65.62), 'preflight ray originates at hypothetical endpoint eye');
  assert(trace.some(x => x.event === 'candidate_rejected' && x.reason.includes('no loaded dry supported dig-reach endpoint')));
  const noArrival = fakeBot(); noArrival.pathfinder.goto = async () => {};
  await assert.rejects(executeSkill(noArrival, { action: 'mine', resource: 'stone', count: 1 }), /arrival not safely diggable/);
  assert.equal(noArrival._digs.length, 0, 'goto resolution alone is not arrival');
  const unavailable = fakeBot(); unavailable.pathfinder.getPathFromTo = undefined;
  await assert.rejects(executeSkill(unavailable, { action: 'mine', resource: 'stone', count: 1 }), /preflight unavailable/);
  assert.equal(unavailable._goals.length, 0);
  const uncertain = fakeBot(), events = []; let probes = 0;
  uncertain.findBlocks = () => Array.from({ length: 20 }, (_, i) => new Vec3(10 + i, 64, 0));
  const blockAt = uncertain.blockAt; uncertain.blockAt = p => p.y === 64 && p.x >= 10 ? { ...blockAt(targets[1]), position: p } : blockAt(p);
  uncertain.pathfinder.getPathFromTo = function * () { probes++; while (true) { const start = performance.now(); while (performance.now() - start < 4) {} yield { result: { status: 'partial', path: [] } }; } };
  await assert.rejects(executeSkill(uncertain, { action: 'mine', resource: 'stone', count: 1 }, { log: e => events.push(e) }), /unconfirmed/);
  assert.equal(uncertain._goals.length, 0); assert(probes <= 12);
  const metrics = events.filter(e => e.event === 'candidate_path_preflight');
  assert(metrics.length); assert(metrics.at(-1).totalCpuMs <= 800, 'cooperative total CPU budget');
  assert(metrics.every(e => e.cpuMs <= e.candidateCpuBudgetMs && !e.budgetOverrun));
  assert.equal(metrics.filter(e => e.continued).length, 1, 'only one partial candidate receives continuation');
  assert(metrics.some(e => e.cpuMs > 24 && e.candidateCpuBudgetMs === 600), 'continued search retains frontier past original candidate allowance');
  const cancel = fakeBot(), controller = new AbortController(); let cleaned = 0, started = 0;
  cancel.pathfinder.getPathFromTo = function * () { started++; try { queueMicrotask(() => controller.abort(new Error('Cancel preflight'))); yield { result: { status: 'partial', path: [] } }; } finally { cleaned++; } };
  await assert.rejects(executeSkill(cancel, { action: 'mine', resource: 'stone', count: 1 }, { signal: controller.signal }), /Cancel preflight/);
  assert.equal(started, 1); assert.equal(cleaned, 1); assert.equal(cancel._goals.length, 0); assert.equal(cancel._digs.length, 0);
  const lateCancel = fakeBot(), lateController = new AbortController(), lateEvents = [];
  let lateSlices = 0, lateCleaned = 0;
  lateCancel.pathfinder.getPathFromTo = function * () {
    try { while (true) {
      const until = performance.now() + 6; while (performance.now() < until) {}
      if (++lateSlices === 4) queueMicrotask(() => lateController.abort(new Error('Cancel continuation')));
      yield { result: { status: 'partial', path: [] } };
    } } finally { lateCleaned++; }
  };
  await assert.rejects(executeSkill(lateCancel, { action: 'mine', resource: 'stone', count: 1 }, { signal: lateController.signal, log: e => lateEvents.push(e) }), /Cancel continuation/);
  assert.equal(lateSlices, 4); assert.equal(lateCleaned, 1); assert.equal(lateCancel._goals.length, 0); assert.equal(lateCancel._digs.length, 0);
  assert(lateEvents.some(e => e.event === 'candidate_path_preflight' && e.continued), 'cancellation during continuation cleans frontier and never retries another candidate');
  // Use the installed A* implementation, with reproducible six-millisecond
  // synthetic terrain-neighbor cost. This is a CPU scheduling fixture, not a
  // reconstruction or proof of reachability of the logged Minecraft terrain.
  const AStar = require('mineflayer-pathfinder/lib/astar');
  const Move = require('mineflayer-pathfinder/lib/move');
  const continued = fakeBot(), continuationEvents = [];
  continued.findBlocks = () => [targets[1]];
  let searches = 0, heartbeat = 0, maxGap = 0, previousBeat = performance.now();
  const pulse = setInterval(() => { const now = performance.now(); maxGap = Math.max(maxGap, now - previousBeat); previousBeat = now; heartbeat++; }, 1);
  continued.pathfinder.getPathFromTo = function * (movement, origin, goal, options) {
    searches++; assert.equal(options.tickTimeout, 5); assert.equal(options.timeout, 3000);
    const search = new AStar(new Move(0, 64, 0, 0, 0), { getNeighbors(node) {
      const until = performance.now() + 6; while (performance.now() < until) {}
      return node.x < 8 ? [new Move(node.x + 1, 64, 0, 0, 1)] : [];
    } }, goal, options.timeout, options.tickTimeout);
    let result;
    do { result = search.compute(); yield { result }; } while (result.status === 'partial');
  };
  try {
    const gained = await executeSkill(continued, { action: 'mine', resource: 'stone', count: 1 }, { log: e => continuationEvents.push(e) });
    assert.equal(gained.gained, 1); assert.equal(searches, 1, 'same generator frontier continues without restarting A*');
    const metric = continuationEvents.find(e => e.event === 'candidate_path_preflight');
    assert(metric.continued && metric.cpuMs > 24 && metric.cpuMs <= 60 && metric.status === 'success');
    assert(heartbeat >= metric.slices, 'timer callback runs between each search slice');
    console.log(JSON.stringify({ fixture: 'installed AStar, synthetic 6ms neighbor work, 8-block corridor', ...metric, heartbeat, measuredMaxTimerGapMs: Math.round(maxGap * 10) / 10 }));
  } finally { clearInterval(pulse); }
  const slow = fakeBot(), slowEvents = [];
  slow.findBlocks = () => [targets[1]];
  slow.pathfinder.getPathFromTo = function * () {
    const until = performance.now() + 90; while (performance.now() < until) {}
    yield { result: { status: 'success', path: [new Vec3(8, 64, 0)] } };
  };
  await assert.rejects(executeSkill(slow, { action: 'mine', resource: 'stone', count: 1 }, { log: e => slowEvents.push(e) }), /unconfirmed/);
  assert.equal(slow._goals.length, 0, 'noncooperative over-budget success is not accepted');
  assert(slowEvents.some(e => e.event === 'candidate_path_preflight' && e.budgetOverrun && e.maxSliceMs >= 90), 'actual synchronous overrun is exposed rather than hidden as wall time');
  console.log('Harvest navigation checks passed: safe hypothetical endpoint, bounded/yielding preflight, same-resource alternatives, no false goto arrival, cancellation without retries or preflight goal mutation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
