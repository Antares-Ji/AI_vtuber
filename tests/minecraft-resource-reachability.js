'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(registry);
const Move = require('mineflayer-pathfinder/lib/move');
const { executeSkill, observe, setSafeMovements, HarvestGoal } = require('../src/minecraft/survival-skills');
const LIFE = Symbol.for('ai-vtuber.minecraft.lifecycleEpoch');
const target = new Vec3(10, 64, 0);
function fixture(status = 'noPath') {
  const bot = new EventEmitter();
  Object.assign(bot, { registry, game: { gameMode: 'survival', dimension: 'overworld' }, health: 20, food: 20, time: { timeOfDay: 6000 },
    entity: { position: new Vec3(0.5, 64, 0.5), equipment: [] }, entities: {}, inventory: { items: () => [] },
    findBlocks: ({ matching }) => matching.includes(registry.blocksByName.oak_log.id) ? [target] : [],
    blockAt(p) { const name = p.equals(target) ? 'oak_log' : p.y < 64 ? 'stone' : 'air'; const b = Block.fromStateId(registry.blocksByName[name].minStateId, 0); b.position = p; return b; },
    canDigBlock: () => false, world: { raycast: () => ({ position: target }) }, clearControlStates() {}, stopDigging() {}, deactivateItem() {},
    pathfinder: { setMovements(m) { this.movements = m; }, setGoal() {}, goto: async () => { throw Error('must not dispatch unconfirmed route'); },
      *getPathFromTo() { yield { result: { status, path: [] } }; } }
  });
  return bot;
}
(async () => {
  const crowded = fixture(), candidates = Array.from({ length: 25 }, (_, i) => new Vec3(i + 2, 64, 0)), searched = [];
  crowded.findBlocks = () => candidates;
  const originalRead = crowded.blockAt;
  crowded.blockAt = p => {
    if (!candidates.some(v => v.equals(p))) return originalRead(p);
    const b = Block.fromStateId(registry.blocksByName.oak_log.minStateId, 0); b.position = p; return b;
  };
  crowded.pathfinder.getPathFromTo = function* (movements, origin, goal) { searched.push(goal.position.x); yield { result: { status: 'noPath', path: [] } }; };
  const prepare = HarvestGoal.prototype.prepare;
  try {
    // Twelve cheaply rejected canopy targets precede supported endpoints.
    HarvestGoal.prototype.prepare = function () { return this.position.x < 14 ? [] : [this.position]; };
    await assert.rejects(executeSkill(crowded, { action: 'gather_wood', count: 1 }), /No inventory gain/);
    assert.equal(searched[0], 14, 'zero-endpoint candidates cannot consume all A* probes');
    assert.equal(searched.length, 12, 'actual search probe limit remains twelve');
  } finally { HarvestGoal.prototype.prepare = prepare; }
  for (const searchStatus of ['noPath', 'timeout', 'partial']) {
    const bot = fixture(searchStatus);
    assert.equal(observe(bot).resources.wood[0].reachability.reason, 'not_checked');
    await assert.rejects(executeSkill(bot, { action: 'gather_wood', count: 1 }), /No inventory gain/);
    const state = observe(bot), candidate = state.resources.wood[0];
    assert.equal(candidate.reachability.status, searchStatus === 'noPath' ? 'no_path_found' : 'unknown');
    assert.equal(candidate.reachability.stale, false); assert.equal(state.recentResourceAttempts.length, 1);
    assert.deepEqual(state.recentResourceAttempts[0].position, { x: 10, y: 64, z: 0 });
    assert.equal(state.recentResourceAttempts[0].outcome, 'route_unconfirmed');
    bot.entity.position.x += 5;
    assert.equal(observe(bot).resources.wood[0].reachability.status, 'unknown');
    assert.equal(observe(bot).resources.wood[0].reachability.stale, true, 'previous-origin result cannot be reused after movement');
    bot.entity.position.x -= 5; bot[LIFE] = 1;
    assert.equal(observe(bot).resources.wood[0].reachability.reason, 'not_checked');
    assert.equal(observe(bot).recentResourceAttempts.length, 0, 'new life clears reachability evidence');
  }
  const expired = fixture();
  await assert.rejects(executeSkill(expired, { action: 'gather_wood', count: 1 }));
  const now = Date.now;
  try {
    const later = now() + 61000; Date.now = () => later;
    assert.equal(observe(expired).resources.wood[0].reachability.stale, true);
    assert.equal(observe(expired).resources.wood[0].reachability.status, 'unknown');
  } finally { Date.now = now; }
  expired.game.dimension = 'the_nether';
  assert.equal(observe(expired).recentResourceAttempts.length, 0, 'same coordinates in another dimension are unrelated');
  const sampled = fixture(); let scans = 0;
  sampled.entities = new Proxy({}, { ownKeys: target => { scans++; return Reflect.ownKeys(target); } });
  const movements = setSafeMovements(sampled);
  movements.getNeighbors(new Move(0, 64, 0, 0, 0));
  assert.equal(scans, 1, 'one synchronous neighbor expansion samples entities once');
  sampled.entities[1] = { id: 1, name: 'zombie', position: new Vec3(1, 64, 0) };
  movements.getNeighbors(new Move(0, 64, 0, 0, 0));
  assert.equal(scans, 2, 'next expansion refreshes threats immediately');
  assert.equal(movements.exclusionAreasStep.at(-1)({ position: new Vec3(1, 64, 0) }), 100, 'outside a search, exclusion reads live threats');
  console.log('Resource reachability passed: noPath versus unconfirmed, candidate-specific feedback, origin/time/life/dimension expiry, live per-node hostile sampling. Simulated tests only.');
})().catch(error => { console.error(error); process.exitCode = 1; });
