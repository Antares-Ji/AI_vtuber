'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { decide, ReactiveAgent } = require('../src/minecraft/reactive-agent');
const zombie = { id: 2, name: 'zombie', position: new Vec3(2, 64, 0), distance: 2 };
for (const state of [
  { health: 20, armed: false, entities: [zombie] },
  { health: 5, armed: true, entities: [zombie] },
  { health: 20, armed: true, entities: [zombie, { ...zombie, id: 3 }] },
  { health: 20, armed: true, entities: [{ ...zombie, distance: 10 }] },
  { health: 20, armed: true, entities: [{ ...zombie, name: 'creeper' }] }
]) assert.equal(decide({ enabled: true, ...state }).action, 'flee');
(async () => {
  let attacks = 0, busy = false, interrupts = 0, goalsChanged = 0;
  let items = [{ name: 'wooden_sword', type: 1 }];
  const bot = new EventEmitter();
  Object.assign(bot, {
    entity: { id: 1, position: new Vec3(0, 64, 0) }, health: 20, food: 20,
    entities: { 2: zombie }, inventory: { items: () => items }, heldItem: { type: 1 },
    world: { raycast: () => null }, lookAt: async () => {}, attack: () => attacks++,
    pathfinder: { setGoal: () => goalsChanged++, isMoving: () => true, setMovements() {} },
    clearControlStates() {}
  });
  const agent = new ReactiveAgent(bot, {
    interruptTask() { interrupts++; busy = false; }, taskBusy: () => busy,
    log() {}, intervalMs: 100000
  });
  try {
    agent.enabled = true; agent.mode = 'flee'; agent.targetId = 2;
    await agent.flee(zombie, [zombie], agent.epoch);
    const retreatGoals = goalsChanged;
    await agent.flee(zombie, [zombie], agent.epoch);
    assert.equal(attacks, 1, 'armed contact hit while retreating');
    assert.equal(goalsChanged, retreatGoals, 'counterattack preserves retreat path');
    await agent.flee(zombie, [zombie], agent.epoch);
    assert.equal(attacks, 1, 'cooldown prevents repeated spam');
    agent.lastHit = 0; items = [];
    await agent.counterattack(zombie, agent.epoch);
    assert.equal(attacks, 1, 'no empty-handed counterattack');
    items = [{ name: 'wooden_sword', type: 1 }]; bot.health = 4;
    await agent.counterattack(zombie, agent.epoch);
    assert.equal(attacks, 1, 'critical health prioritizes retreat');
    busy = true;
    await agent.tick();
    assert.equal(interrupts, 1, 'danger is checked during collection');
    agent.enabled = false;
    await agent.counterattack(zombie, agent.epoch);
    assert.equal(attacks, 1, 'stop prevents late attack');
  } finally { agent.dispose(); }
  console.log('Retreat combat passed: outmatched retreat, moving counterattack, no pursuit, cooldown, unarmed/critical retreat, busy-task preemption and stop.');
})().catch(error => { console.error(error); process.exitCode = 1; });
