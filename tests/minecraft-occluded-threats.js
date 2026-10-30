'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { ReactiveAgent, occludedThreat } = require('../src/minecraft/reactive-agent');
const solid = { shapes: [[0, 0, 0, 1, 1, 1]] };
(async () => {
  let interrupts = 0, busy = true;
  const enemy = { id: 2, name: 'skeleton', position: new Vec3(20, 64, 0), height: 1.8 };
  const bot = Object.assign(new EventEmitter(), {
    entity: { id: 1, position: new Vec3(0, 64, 0) }, health: 20, food: 20,
    entities: { 2: enemy }, inventory: { items: () => [] },
    world: { raycast: () => solid }, pathfinder: { setGoal() {} }, clearControlStates() {}
  });
  const view = { ...enemy, distance: 20 };
  assert.equal(occludedThreat(bot, view), true);
  assert.equal(occludedThreat(bot, { ...view, distance: 8 }), false, 'nearby danger retains preemption');
  assert.equal(occludedThreat(bot, { ...view, mounted: true }), false, 'mounted geometry remains conservative');
  bot.world.raycast = () => ({ shapes: [[0, 0, 0, 1, 0.5, 1]] });
  assert.equal(occludedThreat(bot, view), false, 'partial cover is insufficient');
  let rays = 0; bot.world.raycast = () => ++rays === 1 ? solid : null;
  assert.equal(occludedThreat(bot, view), false, 'one clear body ray retains danger');
  bot.world.raycast = () => { throw Error('unknown terrain'); };
  assert.equal(occludedThreat(bot, view), false);
  bot.world.raycast = () => solid;
  const agent = new ReactiveAgent(bot, { intervalMs: 100000, taskBusy: () => busy, interruptTask: () => { interrupts++; busy = false; }, log() {} });
  try {
    agent.enable(); await agent.tick();
    assert.equal(interrupts, 0, 'distant mob behind full cover does not cancel model work');
    assert.equal(agent.snapshot.entities[0].occluded, true, 'observed entity remains visible in diagnostics');
    bot.world.raycast = () => null; await agent.tick();
    assert.equal(interrupts, 1, 'exposed ranged threat still cancels work');
  } finally { agent.dispose(); }
  console.log('Occluded threats: full-cover checks, nearby/mounted/unknown fallback and real task preemption passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
