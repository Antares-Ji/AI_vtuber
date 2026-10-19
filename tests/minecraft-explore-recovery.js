'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(registry);
const { executeSkill, setSafeMovements } = require('../src/minecraft/survival-skills');
function fixture(mode) {
  const bot = new EventEmitter(); let rejectPath;
  Object.assign(bot, { registry, health: 20, food: 20, game: { gameMode: 'survival', dimension: 'overworld' }, entity: { position: new Vec3(.5, 64, .5) }, entities: {}, inventory: { items: () => [] },
    blockAt(p) { const b = Block.fromStateId(registry.blocksByName[p.y < 64 ? 'stone' : 'air'].minStateId, 0); b.position = p; return b; },
    clearControlStates() {}, stopDigging() {}, deactivateItem() {},
    pathfinder: { navigations: 0, setMovements(m) { this.movements = m; }, setGoal() { rejectPath?.(new Error('Path stopped')); rejectPath = null; },
      async goto(goal) { this.navigations++; if (this.navigations === 1) { if (mode === 'stall') return new Promise((_, reject) => { rejectPath = reject; }); throw new Error('No path'); } bot.entity.position = new Vec3(goal.x + .5, 64, goal.z + .5); },
      *getPathFromTo(m, start, goal) { yield { result: { status: mode === 'blocked' ? 'noPath' : 'success', path: [{ x: goal.x, y: 64, z: goal.z, toBreak: mode === 'unsafe' ? [1] : [], toPlace: [] }] } }; }
    }
  }); return bot;
}
(async () => {
  const nativeGoto=require('mineflayer-pathfinder/lib/goto');
  for (const status of ['noPath','timeout','partial']) {
    const bot=fixture('noPath');let calls=0;
    bot.pathfinder.goto=goal=>{bot.pathfinder.navigations++;return nativeGoto(bot,goal);};
    bot.pathfinder.setGoal=goal=>{
      if(!goal)return;
      calls++;
      if(calls===1) bot.emit('path_update',{status,path:[]});
      else {bot.entity.position=new Vec3(goal.x+.5,64,goal.z+.5);bot.emit('goal_reached',goal);}
    };
    const arrivalLogs=[];
    const result=await executeSkill(bot,{action:'explore',direction:'east',distance:20},{log:e=>arrivalLogs.push(e)});
    if(status==='partial')assert(arrivalLogs.some(e=>e.event==='explore_arrival_unconfirmed'&&e.pathStatus==='partial'&&e.pathLength===0));
    assert.equal(result.recovered,true,'native empty '+status+' must enter bounded recovery');
    assert.equal(calls,2);
    assert.equal(bot.listenerCount('path_update'),0);
  }

  // A real goto may return an empty path when already within the original
  // GoalNearXZ radius. Height is deliberately irrelevant for this goal.
  const reached=fixture('noPath');let reachedCalls=0;
  reached.pathfinder.goto=goal=>nativeGoto(reached,goal);
  reached.pathfinder.setGoal=goal=>{if(!goal)return;reachedCalls++;reached.entity.position=new Vec3(goal.x+.5,70,goal.z+.5);reached.emit('path_update',{status:'success',path:[]});};
  const reachedResult=await executeSkill(reached,{action:'explore',direction:'east',distance:20});
  assert.equal(reachedCalls,1);assert.equal(reachedResult.recovered,undefined,'satisfied original XZ goal needs no recovery');
  const bouncing = fixture('stall');
  const diagnostics = [];
  bouncing.entity.onGround = false; bouncing.entity.velocity = new Vec3(0, .4, 0);
  bouncing.controlState = { jump: true, forward: true };
  const nodes = Array.from({ length: 12 }, (_, i) => ({ x: i, y: 65, z: 0, toBreak: [], toPlace: [] }));
  const pathTimer = setTimeout(() => { bouncing.emit('path_update', { status: 'success', path: nodes }); nodes[0].x = 999; }, 50);
  const bounce = setInterval(() => { bouncing.entity.position.y = bouncing.entity.position.y === 64 ? 65 : 64; }, 220);
  try {
    const result = await executeSkill(bouncing, { action: 'explore', direction: 'east', distance: 20 }, { log: e => diagnostics.push(e) });
    assert.equal(result.recovered, true, 'vertical bouncing must not reset horizontal progress watchdog');
    const snapshots = diagnostics.filter(e => e.event === 'explore_stalled'); assert.equal(snapshots.length, 1);
    const d = snapshots[0].diagnostics;
    assert.equal(d.controls.jump, true); assert.equal(d.controls.forward, true); assert.equal(d.controls.back, null);
    assert.equal(d.onGround, false); assert.equal(d.lastPathUpdate.firstNodes.length, 6);
    assert.equal(d.lastPathUpdate.firstNodes[0].x, 0, 'path snapshot cannot mutate with live path');
    assert(d.lastPathUpdate.ageMs >= 3000); assert.equal(d.lastPathUpdate.navigationId, d.navigationId);
    assert.equal(d.terrain.reads, 175); assert.equal(bouncing.listenerCount('path_update'), 0);
  } finally { clearInterval(bounce); clearTimeout(pathTimer); }
  const ranged = fixture('noPath'); ranged.entities[1] = { name: 'skeleton', position: new Vec3(30, 64, 0) };
  const movement = setSafeMovements(ranged), exclusion = movement.exclusionAreasStep.at(-1);
  assert.equal(exclusion({ position: new Vec3(7, 64, 0) }), 100, 'avoid approaching ranged enemies before reflex preemption');
  assert.equal(exclusion({ position: new Vec3(-2, 64, 0) }), 0);
  for (const mode of ['noPath', 'stall']) {
    const bot = fixture(mode), result = await executeSkill(bot, { action: 'explore', direction: 'east', distance: 20 });
    assert.equal(result.recovered, true); assert.equal(result.complete, false); assert(result.moved >= 4); assert.equal(bot.pathfinder.navigations, 2);
    assert.equal(bot.pathfinder.movements.canDig, false);
  }
  for (const mode of ['blocked', 'unsafe']) {
    const bot = fixture(mode);
    await assert.rejects(executeSkill(bot, { action: 'explore', direction: 'east', distance: 20 }), /detours exhausted/);
    assert.equal(bot.pathfinder.navigations, 1, 'unverified/unsafe paths never dispatched');
  }
  const bot = fixture('stall'), controller = new AbortController();
  const task = executeSkill(bot, { action: 'explore', direction: 'east', distance: 20 }, { signal: controller.signal });
  setTimeout(() => controller.abort(new Error('Operator stopped')), 30);
  await assert.rejects(task, /Operator stopped/); assert.equal(bot.pathfinder.navigations, 1);
  assert.equal(bot.listenerCount('path_update'), 0, 'abort removes diagnostic listener');
  console.log('PASS: stall recovery, no-path recovery, bounded unsafe rejection, incomplete progress, operator cancellation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
