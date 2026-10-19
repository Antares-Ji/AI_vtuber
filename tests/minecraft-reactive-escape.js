'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(registry);
const { ReactiveAgent, escapeCandidates, escapeLeaf, safeThreatClearance, routeEdge, trackRouteProgress } = require('../src/minecraft/reactive-agent');
function fixture(options = {}) {
  const bot = new EventEmitter(), world = new Map(), goals = [], events = [];
  let now = 1000;
  Object.assign(bot, { registry, entity: { position: new Vec3(0.5, 64, 0.5), eyeHeight: 1.62 }, health: 8, food: 20,
    entities: { 2: { id: 2, name: 'zombie', position: new Vec3(4.5, 64, 0.5), height: 1.8 } }, inventory: { items: () => [] },
    blockAt(p) { const name = world.get(p.toString()) || (p.y < 64 ? 'stone' : 'air'); if (name === 'unknown') return null; const b = Block.fromStateId(registry.blocksByName[name].minStateId, 0); b.position = p; return b; },
    setBlock(p, name) { world.set(p.toString(), name); },
    pathfinder: { setGoal(goal) { if (goal) goals.push(goal); }, setMovements() {}, isMoving: () => false,
      *getPathFromTo(m, start, goal) { yield { result: { status: 'success', path: [{ x: goal.x, y: goal.y, z: goal.z, toBreak: [], toPlace: [] }] } }; } },
    clearControlStates() {}, stopDigging() {}, canDigBlock: () => true, dig: async block => { bot.setBlock(block.position, 'air'); },
    world: { raycast: () => null }, lookAt: async () => {}, attack() { bot.attacks = (bot.attacks || 0) + 1; }
  });
  const agent = new ReactiveAgent(bot, { interruptTask() {}, taskBusy: () => false, log: e => events.push(e), intervalMs: 100000, now: () => now, ...options });
  agent.enable();
  return { bot, agent, goals, events, advance(ms) { now += ms; } };
}
(async () => {
  const pinned = fixture();
  try {
    pinned.bot.entity.position = new Vec3(-5.5,69,150.5);
    pinned.bot.blockAt = p => {
      const floor = p.equals(new Vec3(-7,68,150));
      const b = Block.fromStateId(registry.blocksByName[floor ? 'stone' : 'air'].minStateId,0); b.position=p;return b;
    };
    const spider = { name:'spider',position:new Vec3(-20.7,72.1,158.954) };
    const detours=escapeCandidates(pinned.bot,[spider]);
    assert.equal(detours.length,1);assert(detours[0].distantDetour);assert(detours[0].position.equals(new Vec3(-7,69,150)));
    assert(detours[0].separation>=12);assert(detours[0].separation>=pinned.bot.entity.position.distanceTo(spider.position)-1);
    for(const name of ['skeleton','creeper']) assert.equal(escapeCandidates(pinned.bot,[{...spider,name}]).length,0);
    assert.equal(escapeCandidates(pinned.bot,[{...spider,mounted:true}]).length,0);
    assert.equal(escapeCandidates(pinned.bot,[{name:'spider',position:new Vec3(-18,69,150.5)}]).length,0,'near trigger has no distant-detour exception');
    assert.equal(escapeCandidates(pinned.bot,[spider],new Map([['(-7, 69, 150)',Date.now()+1000]])).length,0,'failed site remains excluded');
  } finally { pinned.agent.dispose(); }
  const contact = fixture();
  try {
    // Recorded 00:48:41 ledge: west is solid; east/north are unsupported,
    // south blocked. A zombie overlaps the bot, so one retreat is still <2.8m.
    contact.bot.entity.position = new Vec3(5.314865, 65, 15.506365);
    contact.bot.blockAt = p => {
      const floor = p.equals(new Vec3(4, 64, 15));
      const b = Block.fromStateId(registry.blocksByName[floor ? 'stone' : 'air'].minStateId, 0); b.position = p; return b;
    };
    const zombie = { name: 'zombie', position: new Vec3(5.173693, 65, 15.419356) };
    const candidates = escapeCandidates(contact.bot, [zombie]);
    assert.equal(candidates.length, 1); assert(candidates[0].position.equals(new Vec3(4, 65, 15)));
    assert(candidates[0].separation > contact.bot.entity.position.distanceTo(zombie.position) + 0.2);
    assert.equal(escapeCandidates(contact.bot, [{ ...zombie, name: 'creeper' }]).length, 0);
    assert.equal(escapeCandidates(contact.bot, [{ ...zombie, name: 'skeleton' }]).length, 0);
    assert.equal(escapeCandidates(contact.bot, [zombie, { name: 'zombie', position: new Vec3(4.4, 65, 15.5) }]).length, 0, 'never improve one enemy by entering another');
    contact.bot.blockAt = p => { const b = Block.fromStateId(registry.blocksByName.water.minStateId, 0); b.position = p; return b; };
    assert.equal(escapeCandidates(contact.bot, [zombie]).length, 0, 'contact never bypasses terrain guards');
  } finally { contact.agent.dispose(); }
  const sand = fixture();
  try {
    const destination = new Vec3(-1, 64, 0), enemies = [{ name: 'zombie', position: new Vec3(4.5, 64, 0.5), distance: 4 }];
    const available = () => escapeCandidates(sand.bot, enemies).some(c => c.position.equals(destination));
    for (const name of ['sand', 'red_sand', 'gravel']) {
      sand.bot.setBlock(destination.offset(0, -1, 0), name);
      assert(available(), `${name} over loaded stone permits a walking candidate`);
    }
    for (const name of ['air', 'water', 'lava', 'unknown', 'sand', 'gravel', 'white_concrete_powder', 'anvil']) {
      sand.bot.setBlock(destination.offset(0, -2, 0), name);
      assert(!available(), `${name} is not confirmed stable support for a gravity floor`);
    }
    sand.bot.setBlock(destination.offset(0, -2, 0), 'stone');
    for (const name of ['water', 'lava', 'fire', 'unknown']) {
      sand.bot.setBlock(destination.offset(0, -1, 1), name);
      assert(!available(), `gravity floor next to ${name} remains forbidden`);
    }
    sand.bot.setBlock(destination.offset(0, -1, 1), 'stone');
    sand.bot.setBlock(destination, 'oak_leaves');
    assert.equal(escapeLeaf(sand.bot, enemies), null, 'walking exception never permits leaf excavation above gravel');
    sand.bot.setBlock(destination, 'air');
    // Even a successful search response must still satisfy the no-dig guard.
    await sand.agent.tick(); sand.bot.emit('path_update', { status: 'noPath' }); sand.advance(200);
    sand.bot.pathfinder.getPathFromTo = function * (m, start, goal) {
      yield { result: { status: 'success', path: [{ x: -1, y: 64, z: 0, toBreak: ['sand'], toPlace: [] }] } };
    };
    await sand.agent.tick();
    assert(!sand.events.some(e => e.event === 'escape_short_route'), 'a supported gravity floor does not allow a path that digs');
  } finally { sand.agent.dispose(); }
  const f = fixture();
  try {
    await f.agent.tick(); assert.equal(f.goals.length, 1);
    f.bot.emit('path_update', { status: 'noPath' }); f.advance(200); await f.agent.tick();
    assert.equal(f.agent.escape.strategy, 'short_safe_site'); assert.equal(f.goals.length, 2); assert(f.events.some(e => e.event === 'escape_short_route'));
    const failedSite = f.agent.escape.site.toString();
    f.bot.emit('path_update', { status: 'noPath' });
    for (let i = 0; i < 3; i++) { f.advance(200); await f.agent.tick(); }
    assert.equal(f.goals.length, 2, 'failed route does not resubmit every 200ms');
    f.advance(300); await f.agent.tick(); assert.notEqual(f.agent.escape.site?.toString(), failedSite, 'failed destination is excluded');
    assert.equal(f.goals.filter(g => g.constructor.name === 'GoalInvert').length, 1, 'one long retreat attempt per encounter');
  } finally { f.agent.dispose(); }
  for (const searchStatus of ['partial', 'timeout', 'noPath']) {
    const unfinished = fixture(); let closed = 0;
    try {
      unfinished.bot.pathfinder.getPathFromTo = function * () {
        try { while (true) yield { result: { status: searchStatus, path: [] } }; }
        finally { closed++; }
      };
      await unfinished.agent.tick(); unfinished.bot.emit('path_update', { status: 'noPath' }); unfinished.advance(200); await unfinished.agent.tick();
      assert(closed > 0, 'every bounded preflight closes its generator');
      assert.equal(unfinished.agent.failedEscapeSites.size > 0, searchStatus === 'noPath', 'unconfirmed search must not become a twelve-second unreachable cache');
      assert(!unfinished.events.some(event => event.event === 'escape_short_route'), 'partial routes never dispatch as safe routes');
      assert(unfinished.agent.escape.candidateCursor > 0, 'unfinished searches still rotate through candidates');
    } finally { unfinished.agent.dispose(); }
  }
  const airborne = fixture();
  try {
    await airborne.agent.tick();
    const site = new Vec3(1, 64, 0);
    airborne.agent.escape.strategy = 'short_safe_site'; airborne.agent.escape.site = site;
    airborne.bot.entity.position = site.offset(0.5, 0.2, 0.5); airborne.bot.entity.onGround = false;
    airborne.bot.pathfinder.isMoving = () => true;
    airborne.advance(200); await airborne.agent.tick();
    assert.equal(airborne.agent.escape.site, site, 'passing within arrival radius while airborne must not cancel a climb and replan');
    assert(!airborne.agent.escape.recentSites.has(site.toString()), 'airborne waypoint is not a verified landing');
  } finally { airborne.agent.dispose(); }
  const bouncing = fixture();
  try {
    await bouncing.agent.tick(); bouncing.bot.pathfinder.isMoving = () => true;
    for (const y of [64.8, 64, 64.8]) { bouncing.bot.entity.position.y = y; bouncing.advance(600); await bouncing.agent.tick(); }
    assert(bouncing.events.some(e => e.event === 'escape_no_progress' && e.strategy === 'long_retreat'), 'in-place vertical bouncing cannot reset long-retreat progress timer');
  } finally { bouncing.agent.dispose(); }
  const trapped = fixture();
  try {
    trapped.bot.entities[2].position = new Vec3(2.5, 64, 0.5);
    trapped.bot.pathfinder.getPathFromTo = function * () { yield { result: { status: 'noPath', path: [] } }; };
    let sightLength;
    trapped.bot.world.raycast = (eye, direction, length) => { sightLength = length; return null; };
    await trapped.agent.tick(); trapped.bot.emit('path_update', { status: 'noPath' }); trapped.advance(200); await trapped.agent.tick();
    assert.equal(trapped.bot.attacks, 1, 'cornered unarmed bot may knock back a near hostile'); assert(sightLength > 1.5, 'visibility ray covers the full target distance');
    assert.equal(trapped.goals.length, 1, 'counterattack never chases');
    trapped.advance(200); await trapped.agent.tick(); assert.equal(trapped.bot.attacks, 1, 'counterattack cooldown');
    trapped.bot.entities[2].name = 'player'; trapped.advance(1000); await trapped.agent.tick(); assert.equal(trapped.bot.attacks, 1, 'never attacks players');
  } finally { trapped.agent.dispose(); }
  const leaves = fixture();
  try {
    leaves.bot.pathfinder.getPathFromTo = function * () { yield { result: { status: 'noPath', path: [] } }; };
    leaves.bot.setBlock(new Vec3(-1, 64, 0), 'oak_leaves');
    const enemies = [{ id: 2, name: 'zombie', position: leaves.bot.entities[2].position, distance: 4 }];
    assert(escapeLeaf(leaves.bot, enemies));
    await leaves.agent.tick(); leaves.bot.emit('path_update', { status: 'noPath' }); leaves.advance(200); await leaves.agent.tick();
    assert.equal(leaves.agent.escape.leavesCleared, 1); assert.equal(leaves.bot.blockAt(new Vec3(-1, 64, 0)).name, 'air');
    assert(leaves.events.some(e => e.event === 'escape_leaf_removed' && e.verified));
    leaves.bot.setBlock(new Vec3(-1, 64, 0), 'oak_log'); assert.equal(escapeLeaf(leaves.bot, enemies), null, 'fallback never mines logs or terrain');
    leaves.bot.setBlock(new Vec3(-1, 64, 0), 'air');
    leaves.bot.setBlock(new Vec3(-1, 65, 0), 'oak_leaves');
    for (const name of ['red_sand', 'white_concrete_powder', 'anvil']) {
      leaves.bot.setBlock(new Vec3(-1, 66, 0), name);
      assert.equal(leaves.bot.blockAt(new Vec3(-1, 66, 0)).name, name, 'uses actual registry block states');
      assert.equal(escapeLeaf(leaves.bot, enemies), null, `${name} above a removable leaf could fall and is forbidden`);
    }
    leaves.bot.setBlock(new Vec3(-1, 66, 0), 'air');
    assert(escapeLeaf(leaves.bot, enemies), 'removing the falling overhead hazard restores the otherwise safe leaf candidate');
    leaves.bot.setBlock(new Vec3(-1, 65, 0), 'air');
    leaves.bot.setBlock(new Vec3(-1, 64, 0), 'oak_leaves'); leaves.bot.setBlock(new Vec3(-1, 63, 0), 'lava'); assert.equal(escapeLeaf(leaves.bot, enemies), null, 'no leaf escape above lava');
    const candidates = escapeCandidates(leaves.bot, enemies); assert(candidates.every(c => c.position.x !== -1 || c.position.z !== 0 || c.position.y !== 64));
  } finally { leaves.agent.dispose(); }
  const cancel = fixture();
  try {
    cancel.bot.entities[2].position = new Vec3(2.5, 64, 0.5); cancel.bot.pathfinder.getPathFromTo = function * () { yield { result: { status: 'noPath', path: [] } }; };
    let release; cancel.bot.lookAt = () => new Promise(resolve => { release = resolve; });
    await cancel.agent.tick(); cancel.bot.emit('path_update', { status: 'noPath' }); cancel.advance(200);
    const pending = cancel.agent.tick(); await new Promise(resolve => setTimeout(resolve, 5)); cancel.agent.halt(); release(); await pending;
    assert.equal(cancel.bot.attacks || 0, 0, 'halt cancels a delayed cornered counterattack');
  } finally { cancel.agent.dispose(); }
  let cpu = 0;
  const budget = fixture({ monotonic: () => cpu, fallbackBudgetMs: 60 });
  try {
    const queried = [];
    budget.bot.pathfinder.getPathFromTo = function * (m, start, goal, options) {
      assert(options.timeout <= 12); assert(options.tickTimeout <= 6);
      queried.push(`${goal.x},${goal.y},${goal.z}`); cpu += 20;
      yield { result: { status: 'partial', path: [] } };
      cpu += 20; yield { result: { status: 'noPath', path: [] } };
    };
    await budget.agent.tick(); budget.bot.emit('path_update', { status: 'noPath' }); budget.advance(200); cpu += 250;
    await budget.agent.tick();
    assert.equal(queried.length, 2, 'stops candidate work when total planning budget is exhausted');
    assert.equal(budget.agent.timing.fallbackMs, 60); assert.equal(budget.agent.timing.maxTickMs, 60);
    assert.equal(budget.agent.snapshot.timing.sampleGapMs, 250, 'reports actual sample gap, not configured interval');
    const first = [...queried]; budget.advance(800); cpu += 800; await budget.agent.tick();
    assert(queried.slice(2).every(key => !first.includes(key)), 'next attempt rotates away from earlier candidates');
    assert.equal(budget.agent.snapshot.timing.intervalIsSchedulingTarget, true);
    budget.bot.pathfinder.getPathFromTo = function * () { cpu += 90; yield { result: { status: 'noPath', path: [] } }; };
    budget.advance(800); await budget.agent.tick();
    assert.equal(budget.agent.timing.fallbackOverruns, 1, 'a noncooperative synchronous query cannot be preempted and is reported');
    assert.equal(budget.agent.timing.maxTickMs, 90); assert(budget.events.some(e => e.event === 'reactive_timing' && e.tickMs === 90));
  } finally { budget.agent.dispose(); }
  let logCpu = 0;
  const logEvents = [];
  const slowLog = fixture({ monotonic: () => logCpu, log: event => { logEvents.push(event); if (event.event === 'escape_short_route') logCpu += 495; } });
  try {
    await slowLog.agent.tick(); slowLog.bot.emit('path_update', { status: 'noPath' }); slowLog.advance(200);
    await slowLog.agent.tick();
    assert.equal(slowLog.agent.timing.fallbackLogCallbackMs, 495, 'synchronous logger stalls remain measured inside fallback');
    assert.equal(slowLog.agent.timing.fallbackSearchMs, 0, 'logging delay is not mislabeled as search work');
    assert.equal(slowLog.agent.timing.fallbackMs, 495); assert.equal(slowLog.agent.timing.maxTickMs, 495);
    assert.equal(slowLog.agent.timing.fallbackOverruns, 1, 'measurement never erases the real overrun');
    assert.equal(logEvents.filter(e => e.event === 'escape_short_route').length, 1);
    assert(logEvents.length < 10, 'callback measurement produces no recursive or per-tick extra events');
  } finally { slowLog.agent.dispose(); }
  let sampleCpu = 0;
  const slowSample = fixture({ monotonic: () => sampleCpu, log: event => { if (event.event === 'reactive_timing') sampleCpu += 90; } });
  try {
    await slowSample.agent.tick();
    assert.equal(slowSample.agent.snapshot.timing.maxLogCallbackMs, 90);
    assert.equal(slowSample.agent.snapshot.timing.maxTickMs, 90, 'timing record own write retained in subsequent snapshot, not silently subtracted');
  } finally { slowSample.agent.dispose(); }
  const lifecycle = fixture();
  lifecycle.bot.emit('death'); assert.equal(lifecycle.agent.snapshot.lifecycleEpoch, 1);
  lifecycle.agent.dispose();
  const replacement = new ReactiveAgent(lifecycle.bot, { interruptTask() {}, taskBusy: () => false, log() {}, intervalMs: 100000 });
  try {
    assert.equal(replacement.snapshot.lifecycleEpoch, 1, 'hot reload retains bot life epoch');
    lifecycle.bot.emit('death'); assert.equal(replacement.snapshot.lifecycleEpoch, 2, 'disposed agent does not double-count death');
    await replacement.tick(); assert.equal(replacement.snapshot.lifecycleEpoch, 2);
  } finally { replacement.dispose(); }
  const arrived = fixture();
  try {
    await arrived.agent.tick(); arrived.bot.emit('path_update', { status: 'noPath' }); arrived.advance(200); await arrived.agent.tick();
    assert.equal(arrived.agent.escape.candidateCursor, 0, 'success resets rotation for the next origin');
    arrived.bot.entity.position = arrived.agent.escape.site.offset(0.5, 0, 0.5);
    const reachedKey = arrived.agent.escape.site.toString();
    const issued = arrived.goals.length;
    arrived.advance(200); await arrived.agent.tick();
    assert(arrived.goals.length > issued, 'reaching a safe endpoint permits the next route without waiting 800ms');
    assert(arrived.agent.escape.recentSites.has(reachedKey), 'actual reached endpoint is remembered');
  } finally { arrived.agent.dispose(); }
  const creeper = [{ name: 'creeper', position: new Vec3(0, 64, 0) }];
  const progress = { lastProgressAt: 0, routeProgress: { points: [new Vec3(-0.5,64,0.5),new Vec3(-1.5,64,0.5)], index: 0, bestDistance: 1 } };
  trackRouteProgress(progress, new Vec3(0.8,64,0.5), 1000);
  trackRouteProgress(progress, new Vec3(0.5,64,0.5), 2000);
  assert.equal(progress.lastProgressAt, 0, 'knockback away then back does not advance route');
  trackRouteProgress(progress, new Vec3(-0.5,64,0.5), 3000);
  assert.equal(progress.routeProgress.index, 1); assert.equal(progress.lastProgressAt, 3000);
  assert.equal(progress.routeEdge, '(-1, 64, 0)->(-2, 64, 0)', 'stalled segment tracks current next waypoint, not completed prefix');
  const shared = fixture();
  try {
    const origin = shared.bot.entity.position.clone(), first = new Vec3(-1,64,0);
    const edges = [];
    shared.bot.pathfinder.isMoving = () => true;
    shared.bot.pathfinder.getPathFromTo = function * (m, start, goal) { edges.push(routeEdge(start,[first])); yield { result: { status:'success', path:[first, new Vec3(goal.x,goal.y,goal.z)] } }; };
    await shared.agent.tick(); shared.bot.emit('path_update',{status:'noPath'}); shared.advance(200); await shared.agent.tick();
    const key = shared.agent.escape.routeEdge;
    const issued = shared.goals.length;
    shared.advance(800); await shared.agent.tick(); assert.equal(shared.goals.length,issued,'still-progressing grace does not reset live route');
    shared.advance(900); await shared.agent.tick();
    assert(shared.agent.escape.stalledEdges.has(key));
    assert(shared.events.some(e=>e.event==='escape_short_route'&&e.reusedStalledEdge),'only same-prefix route remains eligible as explicit fallback');
    const firstFailure=shared.events.find(e=>e.event==='escape_no_progress'&&e.routeEdge);
    assert.equal(firstFailure.waypointIndex,0); assert(firstFailure.waypointDistance>0);
    assert(shared.bot.entity.position.equals(origin));
    // All computed destinations share a stationary blocked prefix. A safe leaf
    // exit is considered before reissuing that prefix indefinitely.
    shared.bot.setBlock(new Vec3(-1,64,0),'oak_leaves');
    shared.bot.pathfinder.getPathFromTo = function * (m,start,goal) { yield { result:{status:'success',path:[new Vec3(0,64,-1),new Vec3(goal.x,goal.y,goal.z)]} }; };
    // Test edge memory expiry independently from physical route feasibility.
    const expired = shared.agent.escape.stalledEdges.get(key);
    shared.advance(7000); shared.agent.escape.failed=true; await shared.agent.tick();
    assert(!shared.agent.escape.stalledEdges.has(key) || shared.agent.escape.stalledEdges.get(key)>expired,'old stalled memory expires');
  } finally { shared.agent.dispose(); }
  const rotation = fixture();
  try {
    rotation.bot.pathfinder.isMoving = () => true;
    const enemies = [{ id: 2, name: 'zombie', position: rotation.bot.entities[2].position, distance: 4 }];
    const ranked = escapeCandidates(rotation.bot, enemies);
    assert(ranked.length > 4, 'fixture has unexamined destinations beyond one batch');
    const repeated = new Set(ranked.slice(0, 4).map(c => c.key)), queried = [];
    rotation.bot.pathfinder.getPathFromTo = function * (m, start, goal) {
      const destination = new Vec3(goal.x, goal.y, goal.z);
      queried.push(destination.toString());
      const first = repeated.has(destination.toString()) ? new Vec3(-1, 64, 0) : new Vec3(0, 64, -1);
      yield { result: { status: 'success', path: [first, destination] } };
    };
    await rotation.agent.tick(); rotation.bot.emit('path_update', { status: 'noPath' });
    rotation.advance(200); await rotation.agent.tick();
    rotation.advance(1700); await rotation.agent.tick();
    const deferred = rotation.events.filter(e => e.event === 'escape_short_route').at(-1);
    assert.equal(deferred.reusedStalledEdge, true, 'stalled route remains provisional fallback');
    assert.equal(deferred.candidatesExamined, 4);
    assert.equal(deferred.nextCandidateCursor, 4, 'reusing blocked edge cannot reset candidate rotation');
    rotation.advance(1700); await rotation.agent.tick();
    assert(queried.includes(ranked[4].key), 'later candidate is actually searched under unchanged per-tick batch limit');
    const changed = rotation.events.filter(e => e.event === 'escape_short_route').at(-1);
    assert.equal(changed.reusedStalledEdge, false);
    assert.equal(changed.routeEdge, '(0, 64, 0)->(0, 64, -1)');
    assert.equal(changed.nextCandidateCursor, 0, 'fresh route may resume highest-ranked search later');
  } finally { rotation.agent.dispose(); }
  const leafBeforeRepeat = fixture();
  try {
    const first = new Vec3(0,64,-1);
    leafBeforeRepeat.bot.pathfinder.isMoving = () => true;
    leafBeforeRepeat.bot.pathfinder.getPathFromTo = function * (m,start,goal) { yield {result:{status:'success',path:[first,new Vec3(goal.x,goal.y,goal.z)]}}; };
    await leafBeforeRepeat.agent.tick(); leafBeforeRepeat.bot.emit('path_update',{status:'noPath'}); leafBeforeRepeat.advance(200); await leafBeforeRepeat.agent.tick();
    leafBeforeRepeat.bot.setBlock(new Vec3(-1,64,0),'oak_leaves');
    const issued=leafBeforeRepeat.goals.length;
    leafBeforeRepeat.advance(1700); await leafBeforeRepeat.agent.tick();
    assert.equal(leafBeforeRepeat.agent.escape.leavesCleared,1,'safe alternate leaf is cleared before retrying stationary shared prefix');
    assert.equal(leafBeforeRepeat.goals.length,issued,'no new shared-prefix route preempts bounded leaf recovery');
  } finally { leafBeforeRepeat.agent.dispose(); }
  assert.equal(leafBeforeRepeat.bot.listenerCount('path_update'),0,'dispose removes path listener before reload');
  const alternative = fixture();
  try {
    let probes=0;
    alternative.bot.pathfinder.isMoving=()=>true;
    alternative.bot.pathfinder.getPathFromTo=function * (m,start,goal) { const first=++probes<=2?new Vec3(-1,64,0):new Vec3(0,64,-1); yield {result:{status:'success',path:[first,new Vec3(goal.x,goal.y,goal.z)]}}; };
    await alternative.agent.tick(); alternative.bot.emit('path_update',{status:'noPath'}); alternative.advance(200); await alternative.agent.tick();
    alternative.bot.entity.position.x-=0.3; alternative.advance(1000); await alternative.agent.tick();
    const issued=alternative.goals.length; alternative.advance(1000); await alternative.agent.tick();
    assert.equal(alternative.goals.length,issued,'measured progress towards waypoint extends active route without resetting');
    alternative.advance(700); await alternative.agent.tick();
    assert.equal(alternative.agent.escape.routeEdge,'(0, 64, 0)->(0, 64, -1)','different endpoint sharing blocked prefix is deferred for another first segment');
    assert.equal(alternative.events.filter(e=>e.event==='escape_short_route').at(-1).reusedStalledEdge,false);
  } finally { alternative.agent.dispose(); }
  const memory = fixture();
  try {
    const enemies = [{ name: 'zombie', position: memory.bot.entities[2].position }];
    const candidates = escapeCandidates(memory.bot, enemies), preferred = candidates[0];
    const recent = new Map([[preferred.key, { until: 9000, visits: 2 }]]);
    const ranked = escapeCandidates(memory.bot, enemies, new Map(), 1000, recent);
    assert.notEqual(ranked[0].key, preferred.key, 'fresh endpoints preferred over repeated successful endpoints');
    assert(ranked.some(c => c.key === preferred.key), 'revisited safe endpoint remains eligible');
    const only = new Map(candidates.filter(c => c.key !== preferred.key).map(c => [c.key, 9000]));
    assert.equal(escapeCandidates(memory.bot, enemies, only, 1000, recent)[0].key, preferred.key, 'only usable retreat is never excluded by visit memory');
    assert.equal(escapeCandidates(memory.bot, enemies, new Map(), 10000, recent)[0].key, preferred.key, 'visit penalty expires');
    memory.bot.pathfinder.isMoving = () => true;
    await memory.agent.tick();
    for (let i = 0; i < 6; i++) { memory.bot.entity.position.x += 1; memory.bot.entities[2].position.x += 1; memory.advance(1000); await memory.agent.tick(); }
    assert(memory.events.some(e => e.event === 'escape_no_separation_progress' && !e.escapeVerified), 'moving while pursued is not separation progress');
    assert.equal(memory.goals.length, 1, 'stagnation telemetry does not reset active route');
  } finally { memory.agent.dispose(); }
  assert.equal(safeThreatClearance(new Vec3(3, 64, 0), new Vec3(8, 64, 0), creeper), false);
  assert.equal(safeThreatClearance(new Vec3(1, 64, 0), new Vec3(2, 64, 0), creeper), false);
  assert.equal(safeThreatClearance(new Vec3(3, 64, 0), new Vec3(2, 64, 0), creeper), true);
  const crossing = fixture();
  try {
    crossing.bot.pathfinder.getPathFromTo = function * (m, start, goal) { yield { result: { status: 'success', path: [{ x: 4, y: 64, z: 0 }, { x: goal.x, y: goal.y, z: goal.z }] } }; };
    await crossing.agent.tick(); crossing.bot.emit('path_update', { status: 'noPath' }); crossing.advance(200); await crossing.agent.tick();
    assert.equal(crossing.goals.length, 1, 'safe endpoint cannot excuse a path passing through a hostile');
  } finally { crossing.agent.dispose(); }
  const switched = fixture();
  try {
    let movementResets = 0;
    switched.bot.pathfinder.setMovements = () => { movementResets++; };
    switched.bot.pathfinder.isMoving = () => true;
    switched.bot.entities[3] = { id: 3, name: 'skeleton', position: new Vec3(5.5, 64, 0.5) };
    await switched.agent.tick(); assert.equal(movementResets, 1);
    switched.bot.entities[3].position = new Vec3(3.5, 64, 0.5); switched.advance(200); await switched.agent.tick();
    assert.equal(switched.agent.targetId, 3); assert.equal(movementResets, 1, 'nearest-target change never resets an active flee path');
    assert.equal(switched.goals.length, 1, 'target tracking changes do not replace the route');
    switched.bot.entities[3].position = new Vec3(6.5, 64, 0.5); switched.advance(200); await switched.agent.tick();
    assert.equal(switched.agent.targetId, 2); assert.equal(movementResets, 1);
  } finally { switched.agent.dispose(); }
  const ranged = fixture();
  try {
    ranged.bot.entities[2].name = 'stray'; ranged.bot.entities[2].position = new Vec3(22.5, 64, 0.5);
    await ranged.agent.tick(); assert.equal(ranged.agent.mode, 'flee', 'remote loaded stray triggers actual retreat');
    ranged.bot.entities[2].position.x = 24.6; ranged.advance(200); await ranged.agent.tick();
    assert.equal(ranged.agent.snapshot.calming, true);
    ranged.bot.entities[2].position.x = 24.4; ranged.advance(1900); await ranged.agent.tick();
    assert.equal(ranged.agent.safeSince, null, 'ranged threat re-entry resets temporal hysteresis');
    ranged.bot.entities[2].position.x = 25; ranged.advance(100); await ranged.agent.tick(); ranged.advance(2100); await ranged.agent.tick();
    assert.equal(ranged.agent.mode, 'idle', 'sustained absence clears ranged threat');
    ranged.bot.entities[3] = { id: 3, name: 'arrow', position: new Vec3(2, 64, 0.5) };
    ranged.bot.entities[4] = { id: 4, name: 'stray', position: new Vec3(23, 64, 0.5) };
    const effect = { id: 19, amplifier: 0, duration: 240 }; effect.circular = effect;
    ranged.bot.entity.effects = { 19: effect }; ranged.bot.entity.onGround = true;
    ranged.bot.emit('entityHurt', ranged.bot.entities[4], ranged.bot.entities[3]);
    assert.equal(ranged.agent.lastHurtEvidence, null, 'other entity damage is not ours');
    ranged.bot.emit('entityHurt', ranged.bot.entity, ranged.bot.entities[4]);
    ranged.bot.health = 5; ranged.bot.emit('health'); await new Promise(resolve => setImmediate(resolve));
    const damage = ranged.events.find(e => e.event === 'reactive_damage_observed');
    assert.equal(damage.previousHealth, 8); assert.equal(damage.health, 5); assert.equal(damage.damageSource, 'unknown');
    assert.deepEqual(damage.effects, [{ id: 19, amplifier: 0, duration: 240 }]);
    assert.equal(damage.onGround, true); assert.equal(damage.recentHurtEvidence.source.id, 4);
    assert.match(damage.recentHurtEvidence.correlation, /not_proven/); assert.doesNotThrow(() => JSON.stringify(damage));
    effect.duration = 100; assert.equal(damage.effects[0].duration, 240, 'evidence is a scalar snapshot');
    assert.deepEqual(damage.nearby.map(e => e.id), [3, 4], 'damage evidence includes loaded nearby projectile/hostile only, never out-of-radius attacker guesses');
    ranged.bot.health = 6; ranged.bot.emit('health'); await new Promise(resolve => setImmediate(resolve));
    assert.equal(ranged.events.filter(e => e.event === 'reactive_damage_observed').length, 1, 'healing does not manufacture injury');
    ranged.advance(2001); ranged.bot.entity.effects = Object.fromEntries(Array.from({length: 40}, (_, id) => [id, {id, amplifier: 1, duration: 10}]));
    ranged.bot.health = 0; ranged.bot.emit('health');
    assert.equal(ranged.events.filter(e => e.event === 'reactive_damage_observed').at(-1).health, 0, 'fatal health packet still preserves diagnostic evidence');
    const fatal = ranged.events.filter(e => e.event === 'reactive_damage_observed').at(-1);
    assert.equal(fatal.recentHurtEvidence, null, 'old hurt event is not attributed to later injury'); assert.equal(fatal.effects.length, 32);
    ranged.bot.emit('entityHurt', ranged.bot.entity);
    const hurtAfterHealth = ranged.events.filter(e => e.event === 'reactive_hurt_evidence').at(-1);
    assert.equal(hurtAfterHealth.source, 'unknown', 'health-before-hurt ordering retains independent evidence without an invented attacker');
  } finally { ranged.agent.dispose(); }
  assert.equal(ranged.bot.listenerCount('health'), 0, 'reload removes damage listener');
  assert.equal(ranged.bot.listenerCount('entityHurt'), 0, 'reload removes hurt listener');
  for (const cause of ['health', 'approach']) {
    const watched = fixture(); let release, stops = 0;
    watched.bot.setBlock(new Vec3(-1, 64, 0), 'oak_leaves');
    watched.bot.dig = () => new Promise((resolve, reject) => { release = () => reject(new Error('native cancelled and settled')); });
    watched.bot.stopDigging = () => { stops++; };
    const leaf = watched.bot.blockAt(new Vec3(-1, 64, 0));
    const pending = watched.agent.clearLeaf(leaf, watched.agent.epoch);
    if (cause === 'health') watched.bot.health = 7;
    else watched.bot.entities[2].position = new Vec3(2.5, 64, 0.5);
    await new Promise(resolve => setTimeout(resolve, 70));
    assert(stops > 0, `${cause} requests native cancellation while waiting`);
    assert(watched.events.some(e => e.event === 'escape_leaf_cancel_requested'));
    await watched.agent.tick(); assert.equal(watched.goals.length, 0, 'unsettled native leaf prevents concurrent path/action');
    watched.agent.dispose();
    const replacement = new ReactiveAgent(watched.bot, { interruptTask() {}, taskBusy: () => false, log() {}, intervalMs: 100000 });
    try {
      replacement.enable(); await replacement.tick(); assert.equal(watched.goals.length, 0, 'hotreload preserves unsettled native barrier');
      const afterDispose = stops;
      await new Promise(resolve => setTimeout(resolve, 60)); assert.equal(stops, afterDispose, 'dispose clears leaf monitor');
      release(); await assert.rejects(pending, /native cancelled and settled/);
      assert.equal(watched.bot[Symbol.for('ai-vtuber.minecraft.reactiveLeafNative')], undefined);
      assert(watched.agent.timing.leafAwaitMs >= 120, 'await wall time is measured separately without hiding actual duration');
    } finally { replacement.dispose(); watched.agent.dispose(); }
  }
  console.log('Escape fallback checks passed: noPath memory/backoff, checked short routes, failed-site exclusion, bounded leaf clearing, terrain guards, cornered counterattack without chase, ray length, cancellation, ranged trigger/calm and damage evidence.');
})().catch(error => { console.error(error); process.exitCode = 1; });
