const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const { decide, ReactiveAgent, safetyMovements } = require('../src/minecraft/reactive-agent');
const zombie = { id: 2, name: 'zombie', distance: 2, position: new Vec3(2, 0, 0) };
assert.equal(decide({ health: 20, enabled: true, armed: true, entities: [zombie] }).action, 'fight');
assert.equal(decide({ health: 20, enabled: true, entities: [zombie] }).action, 'flee', 'unarmed survival avoids pursuit');
assert.equal(decide({ health: 20, enabled: true, armed: true, entities: [zombie, { ...zombie, id: 3 }] }).action, 'flee', 'multiple threats retreat');
assert.equal(decide({ health: 8, enabled: true, entities: [zombie] }).action, 'flee');
assert.equal(decide({ health: 20, enabled: true, entities: [{ ...zombie, name: 'creeper' }] }).action, 'flee');
assert.equal(decide({ health: 20, enabled: true, armed: true, entities: [{ ...zombie, name: 'phantom', distance: 8 }] }).action, 'flee', 'phantom must be recognized before its next dive');
assert.equal(decide({ health: 20, enabled: true, entities: [{ ...zombie, name: 'player' }] }).action, 'idle');
assert.equal(decide({ health: 20, enabled: false, entities: [zombie] }).action, 'idle');
assert.equal(decide({ health: 0, enabled: true, entities: [zombie] }).action, 'idle');
assert.equal(decide({ health: 20, enabled: true, entities: [{ ...zombie, distance: 30 }] }).action, 'idle');
assert.equal(decide({ health: 20, enabled: true, armed: true, entities: [{ ...zombie, distance: 6 }] }).action, 'flee', 'never pursue even when armed');
assert.equal(decide({ health: 20, enabled: true, armed: true, entities: [{ ...zombie, name: 'skeleton' }] }).action, 'flee', 'do not melee-rush ranged mobs');
assert.equal(decide({ health: 20, enabled: true, previousMode: 'flee', entities: [{ ...zombie, distance: 16 }] }).action, 'flee', 'retreat hysteresis exceeds trigger radius');
assert.equal(decide({ health: 20, enabled: true, previousMode: 'flee', entities: [{ ...zombie, distance: 21 }] }).action, 'idle');
for (const name of ['skeleton', 'stray', 'bogged', 'pillager', 'witch']) {
  for (const distance of [12.1, 20, 24]) assert.equal(decide({ health: 20, enabled: true, armed: true, entities: [{ ...zombie, name, distance }] }).action, 'flee', `${name} at ${distance} must not fall in melee trigger gap`);
  assert.equal(decide({ health: 20, enabled: true, previousMode: 'flee', entities: [{ ...zombie, name, distance: 24.1 }] }).action, 'idle', 'range remains bounded by existing observation');
}
assert.equal(decide({ health: 20, enabled: true, entities: [{ ...zombie, distance: 13 }] }).action, 'idle', 'melee entry radius unchanged');
(async () => {
  let attacks = 0, interrupts = 0, release;
  const bot = new EventEmitter();
  Object.assign(bot, { entity: { id: 1, position: new Vec3(0, 0, 0) }, health: 20, food: 20,
    entities: { 2: zombie }, inventory: { items: () => [{name:'stone_sword',type:1}] }, heldItem: {type:1}, world: {raycast:()=>null},
    pathfinder: { setGoal() {}, isMoving: () => false }, clearControlStates() {},
    lookAt: async () => {}, attack() { attacks++; } });
  let busy = false;
  const agent = new ReactiveAgent(bot, { interruptTask() { interrupts++; busy = false; }, taskBusy: () => busy, log() {}, intervalMs: 100000 });
  try {
    agent.enable(); agent.mode = 'fight'; agent.targetId = 2;
    await agent.tick(); await agent.tick();
    assert.equal(attacks, 1, 'attack cooldown');
    busy = true; await agent.tick(); assert.equal(interrupts, 1, 'threat preempts work');
    agent.lastHit = 0;
    bot.lookAt = () => new Promise(resolve => { release = resolve; });
    const pending = agent.tick();
    agent.halt(); release(); await pending;
    assert.equal(attacks, 1, 'stop rejects late attack');
    assert.equal(agent.snapshot.enabled, false);
    let now = 1000;
    const registry = require('prismarine-registry')('1.21.1');
    bot.registry = registry; bot.pathfinder.setMovements = () => {};
    const movement = safetyMovements(bot);
    assert.equal(movement.maxDropDown, 2); assert.equal(movement.infiniteLiquidDropdownDistance, false); assert.deepEqual(movement.scafoldingBlocks, []);
    assert(movement.blocksToAvoid.has(registry.blocksByName.water.id));
    agent.now = () => now; agent.enable(); agent.mode = 'flee'; agent.targetId = 2;
    zombie.position = new Vec3(21, 0, 0);
    await agent.tick(); assert.equal(agent.mode, 'flee'); assert.equal(agent.snapshot.calming, true);
    now += 1500; await agent.tick(); assert.equal(agent.mode, 'flee', 'requires sustained safety');
    zombie.position = new Vec3(19, 0, 0); now += 100; await agent.tick(); assert.equal(agent.safeSince, null, 'nearby returning threat resets calm timer');
    zombie.position = new Vec3(21, 0, 0); now += 100; await agent.tick(); now += 2100; await agent.tick(); assert.equal(agent.mode, 'idle');
    console.log('Reactive checks passed: threats, players, health, cooldown, preemption, cancellation, retreat hysteresis, sustained calm, terrain avoidance and no pursuit.');
  } finally { agent.dispose(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
