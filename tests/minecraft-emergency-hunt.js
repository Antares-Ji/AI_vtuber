'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(registry);
const { executeSkill, FOODS, observe } = require('../src/minecraft/survival-skills');
function fixture() {
  const bot = new EventEmitter(), items = [], blocks = new Map();
  Object.assign(bot, { registry, health: 5, food: 17, game: { gameMode: 'survival', dimension: 'overworld' }, entity: { position: new Vec3(0.5, 64, 0.5) },
    entities: { 1: { id: 1, name: 'pig', position: new Vec3(3.5, 64, 0.5), height: 0.9 } }, inventory: { items: () => items }, attacks: 0,
    blockAt(p) { const name = blocks.get(p.toString()) || (p.y < 64 ? 'stone' : 'air'); const block = Block.fromStateId(registry.blocksByName[name].minStateId, 0); block.position = p; return block; },
    world: { raycast: () => null }, findBlocks: () => [], clearControlStates() {}, stopDigging() {}, deactivateItem() {}, lookAt: async () => {},
    attack(prey) { bot.attacks++; delete bot.entities[prey.id]; bot.emit('entityDead', prey); items.push({ name: 'porkchop', count: 2, type: registry.itemsByName.porkchop.id }); },
    equip: async item => { bot.heldItem = item; }, consume: async () => { bot.heldItem.count--; bot.food = 20; },
    pathfinder: { setMovements(m) { this.movements = m; }, setGoal() {}, goto: async goal => { bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); },
      *getPathFromTo(m, start, goal) { yield { result: { status: 'success', path: [{ x: goal.x, y: goal.y, z: goal.z, toBreak: [], toPlace: [] }] } }; } }
  });
  return { bot, blocks };
}
(async () => {
  assert(FOODS.includes('beef') && FOODS.includes('porkchop') && FOODS.includes('mutton'));
  assert(!FOODS.includes('chicken'), 'raw chicken remains excluded');
  const observationBot=fixture().bot;
  observationBot.entities[2]={id:2,name:'cow',position:new Vec3(.5,64,-16.5)};
  observationBot.entities[3]={id:3,name:'chicken',position:new Vec3(.5,64,-3.5)};
  observationBot.entities[4]={id:4,name:'zombie',position:new Vec3(23.5,64,.5)};
  const observed=observe(observationBot);
  const {compactObservation,SURVIVAL_SYSTEM}=require('../src/minecraft/survival-planner');
  const compact=compactObservation(observed);
  const pig=compact.animals.find(a=>a.name==='pig');
  assert.equal(pig.direction,'east');assert.deepEqual(pig.position,{x:3.5,y:64,z:.5});
  assert.equal(pig.emergencyHuntCandidate,true);
  assert.equal(pig.reachability.status,'unknown','species/range never proves safe route');
  assert.equal(compact.animals.find(a=>a.name==='cow').emergencyHuntCandidate,false,'17 blocks exceeds emergency range');
  assert.equal(compact.animals.find(a=>a.name==='chicken').emergencyHuntCandidate,false);
  assert.equal(compact.emergencyHunt.hostilesWithin24,1);
  assert.equal(compact.emergencyHunt.routeStatus,'not_checked');
  assert.equal(observationBot.attacks,0,'observation cannot execute hunt');
  assert(SURVIVAL_SYSTEM.includes('生肉可直接eat'));
  assert(!SURVIVAL_SYSTEM.includes('猪牛羊肉需要smelt烤熟'));
  const { bot } = fixture();
  const result = await executeSkill(bot, { action: 'hunt', count: 3 });
  assert.equal(result.emergencyRecovery, true); assert.equal(result.preyLimit, 1); assert.equal(result.gained, 2); assert.equal(bot.attacks, 1);
  const ate = await executeSkill(bot, { action: 'eat' }); assert.equal(ate.foodAfter, 20); assert.equal(ate.item, 'porkchop', 'raw safe meat permits recovery without furnace chain');
  const nearby = fixture().bot; nearby.entities[2] = { id: 2, name: 'zombie', position: new Vec3(20, 64, 0) };
  await assert.rejects(executeSkill(nearby, { action: 'hunt', count: 1 }), /hostile within 24/); assert.equal(nearby.attacks, 0);
  const unsafe = fixture(); unsafe.blocks.set(new Vec3(0, 63, 0).toString(), 'lava');
  await assert.rejects(executeSkill(unsafe.bot, { action: 'hunt', count: 1 }), /safe dry supported terrain/);
  const noPath = fixture().bot; noPath.pathfinder.getPathFromTo = function * () { yield { result: { status: 'noPath', path: [] } }; };
  await assert.rejects(executeSkill(noPath, { action: 'hunt', count: 1 }), /safe short route/); assert.equal(noPath.attacks, 0);
  const chicken = fixture().bot; chicken.entities[1].name = 'chicken';
  await assert.rejects(executeSkill(chicken, { action: 'hunt', count: 1 }), /No nearby passive/);
  const miner = fixture().bot; miner.inventory.items = () => [{name:'wooden_pickaxe',type:registry.itemsByName.wooden_pickaxe.id,count:1}]; miner.findBlocks = () => [new Vec3(1, 63, 0)];
  await assert.rejects(executeSkill(miner, { action: 'mine', resource: 'stone', count: 1 }), /critical health/);
  const interrupted = fixture().bot; let release;
  interrupted.pathfinder.goto = () => new Promise(resolve => { release = resolve; });
  const pending = executeSkill(interrupted, { action: 'hunt', count: 1 });
  await new Promise(resolve => setTimeout(resolve, 20));
  interrupted.entities[2] = { id: 2, name: 'skeleton', position: new Vec3(12, 64, 0) };
  await assert.rejects(pending, /hostile within 24/); assert.equal(interrupted.attacks, 0); release();
  await new Promise(resolve => setTimeout(resolve, 10));
  console.log('Emergency hunt checks passed: one safe passive prey, verified raw-food gain/eating, hostile/terrain/path guards, mid-navigation abort, critical mining still blocked.');
})().catch(error => { console.error(error); process.exitCode = 1; });
