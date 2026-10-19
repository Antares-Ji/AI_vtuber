'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const AStar = require('mineflayer-pathfinder/lib/astar');
const Move = require('mineflayer-pathfinder/lib/move');
const registry = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(registry);
const { executeSkill } = require('../src/minecraft/survival-skills');
function fixture(slope = true) {
  const bot = new EventEmitter(), target = new Vec3(8, 70, 0), items = [], events = [];
  let removed = false;
  Object.assign(bot, { registry, game: { gameMode: 'survival', minY: 0 }, health: 20, food: 20, entities: {},
    entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 }, inventory: { items: () => items },
    findBlocks: () => [target],
    blockAt(p) {
      if (p.x < -2 || p.x > 12 || Math.abs(p.z) > 2 || p.y < 60 || p.y > 80) return null;
      const floor = 64 + (slope ? Math.min(5, Math.max(0, p.x)) : 0);
      const name = p.equals(target) && !removed ? 'oak_log' : p.y < floor ? 'stone' : 'air';
      const b = Block.fromStateId(registry.blocksByName[name].minStateId, 0); b.position = p; return b;
    },
    canDigBlock: b => b.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.62, 0)) <= 4.5,
    world: { raycast(eye, direction, length) { for (let t = 0; t <= length; t += 0.05) { const b = bot.blockAt(eye.plus(direction.scaled(t)).floored()); if (!b || b.boundingBox === 'block') return b; } return null; } },
    _digs: 0, _goals: 0, _routes: [],
    dig: async () => { removed = true; bot._digs++; items.push({ name: 'oak_log', count: 1 }); },
    clearControlStates() {}, stopDigging() {}, deactivateItem() {},
    pathfinder: { setMovements(m) { this.movements = m; }, setGoal() {},
      *getPathFromTo(movement, origin, goal, options) {
        assert.equal(movement.canDig, false); assert.equal(movement.allow1by1towers, false); assert.equal(movement.allowParkour, false); assert.equal(movement.maxDropDown, 2); assert.deepEqual(movement.scafoldingBlocks, []);
        const p = origin.floored(), search = new AStar(new Move(p.x, p.y, p.z, 0, 0), movement, goal, options.timeout, options.tickTimeout);
        let result;
        do { result = search.compute(); if (result.status === 'success') bot._routes.push(result.path); yield { result }; } while (result.status === 'partial');
      },
      async goto() { bot._goals++; bot.entity.position = bot._routes.at(-1).at(-1).offset(0.5, 0, 0.5); }
    }
  });
  return { bot, target, events, run: options => executeSkill(bot, { action: 'gather_wood', count: 1 }, { log: e => events.push(e), ...options }) };
}
(async () => {
  const ramp = fixture();
  const result = await ramp.run(); assert.equal(result.gained, 1); assert.equal(ramp.bot._digs, 1);
  assert(ramp.bot.entity.position.y > 64, 'installed Movements and A* climb actual synthetic natural slope');
  assert(ramp.events.some(e => e.event === 'candidate_target' && e.naturalApproachRequired));
  assert(ramp.bot._routes[0].every(p => !p.toBreak.length && !p.toPlace.length));
  console.log(JSON.stringify({ fixture: 'installed Movements+AStar, natural solid slope', path: ramp.bot._routes[0].map(p => [p.x, p.y, p.z]), metrics: ramp.events.filter(e => e.event === 'candidate_path_preflight') }));
  const floating = fixture(false); await assert.rejects(floating.run(), /no safe path|unconfirmed/); assert.equal(floating.bot._digs, 0); assert.equal(floating.bot._goals, 0, 'floating remnant stays unreachable');
  const lowFirst = fixture(), low = new Vec3(0, 64, 1), originalBlockAt = lowFirst.bot.blockAt;
  let lowRemoved = false;
  lowFirst.bot.findBlocks = () => [lowFirst.target, low];
  lowFirst.bot.blockAt = p => { if (!lowRemoved && p.equals(low)) { const b = Block.fromStateId(registry.blocksByName.oak_log.minStateId, 0); b.position = p; return b; } return originalBlockAt(p); };
  lowFirst.bot.dig = async block => { assert(block.position.equals(low)); lowRemoved = true; lowFirst.bot._digs++; lowFirst.bot.inventory.items().push({ name: 'oak_log', count: 1 }); };
  await lowFirst.run(); assert.equal(lowFirst.bot._goals, 0, 'reachable low target is tried before high targets, without spending path budget');
  for (const kind of ['unsupported', 'noncontiguous', 'partial', 'not-arrived']) {
    const f = fixture();
    if (kind === 'not-arrived') f.bot.pathfinder.goto = async () => {};
    else f.bot.pathfinder.getPathFromTo = function * () {
      if (kind === 'partial') { yield { result: { status: 'partial', path: [new Vec3(5, 69, 0)] } }; return; }
      const path = kind === 'noncontiguous' ? [new Vec3(5, 69, 0)] : [new Vec3(0, 64, 1), new Vec3(0, 65, 2)];
      yield { result: { status: 'success', path } };
    };
    await assert.rejects(f.run()); assert.equal(f.bot._digs, 0, `${kind} cannot authorize high-target digging`);
  }
  const cancelled = fixture(), controller = new AbortController(); let cleaned = 0;
  cancelled.bot.pathfinder.getPathFromTo = function * () { try { queueMicrotask(() => controller.abort(new Error('stop slope search'))); yield { result: { status: 'partial', path: [] } }; } finally { cleaned++; } };
  await assert.rejects(cancelled.run({ signal: controller.signal }), /stop slope search/); assert.equal(cleaned, 1); assert.equal(cancelled.bot._goals, 0); assert.equal(cancelled.bot._digs, 0);
  console.log('Natural-slope harvesting passed: real installed search on supported ramp, floating remnant refused, no partial/unsupported/teleport path or false arrival, cancellation preserved.');
})().catch(error => { console.error(error); process.exitCode = 1; });
