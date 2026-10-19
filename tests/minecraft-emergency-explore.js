'use strict';
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Vec3 } = require('vec3');
const registry = require('prismarine-registry')('1.21.1');
const Block = require('prismarine-block')(registry);
const { executeSkill, DIRECTIONS } = require('../src/minecraft/survival-skills');
function fixture() {
  const bot = new EventEmitter(), blocks = new Map();
  Object.assign(bot, { registry, health: 5, food: 17, game: { gameMode: 'survival', dimension: 'overworld' }, entity: { position: new Vec3(0.5, 64, 0.5) }, entities: {}, inventory: { items: () => [] },
    blockAt(p) { const name = blocks.get(p.toString()) || (p.y < 64 ? 'stone' : 'air'); if (name === 'unknown') return null; const block = Block.fromStateId(registry.blocksByName[name].minStateId, 0); block.position = p; return block; },
    clearControlStates() {}, stopDigging() {}, deactivateItem() {},
    pathfinder: { navigations: 0, setMovements(m) { this.movements = m; }, setGoal() {}, goto: async goal => { bot.pathfinder.navigations++; bot.entity.position = new Vec3(goal.x + 0.5, goal.y, goal.z + 0.5); },
      *getPathFromTo(m, start, goal) { const path = []; let x = Math.floor(start.x), z = Math.floor(start.z); while (x !== goal.x || z !== goal.z) { x += Math.sign(goal.x - x); z += Math.sign(goal.z - z); path.push({ x, y: goal.y, z, toBreak: [], toPlace: [] }); } yield { result: { status: 'success', path } }; } }
  });
  return { bot, blocks };
}
(async () => {
  // Use the installed neighbor generator and A*: mocked paths do not exercise
  // exclusionAreasStep's calls for both feet and headroom.
  const Move=require('mineflayer-pathfinder/lib/move');
  const AStar=require('mineflayer-pathfinder/lib/astar');
  function actualFixture() {
    const f=fixture(); f.bot.game.minY=-64; f.bot.entity.effects={};
    f.bot.pathfinder.bestHarvestTool=()=>null;
    f.bot.pathfinder.getPathFromTo=function*(m,start,goal,opts) {
      const p=start.floored(), astar=new AStar(new Move(p.x,p.y,p.z,0,0),m,goal,opts.timeout,opts.tickTimeout);
      let result; do { result=astar.compute(); yield {result}; } while(result.status==='partial');
    };
    return f;
  }
  const real=actualFixture();
  const walked=await executeSkill(real.bot,{action:'explore',direction:'east',distance:8});
  assert.equal(walked.to.x,7.5,'actual Movements permits ordinary flat route');
  const m=real.bot.pathfinder.movements;
  const neighbors=m.getNeighbors(new Move(3,64,0,0,0));
  assert(neighbors.some(n=>n.x===4&&n.y===64&&n.z===0),'verified route feet are usable despite head air');
  assert(neighbors.every(n=>n.z===0&&n.y===64&&n.x>=0&&n.x<=7),'actual neighbors cannot leave verified corridor');
  real.blocks.set(new Vec3(4,64,0).toString(),'lava');
  assert(!m.getNeighbors(new Move(3,64,0,0,0)).some(n=>n.x===4),'new hazard invalidates previously approved landing');
  const raised=actualFixture(), raisedRead=raised.bot.blockAt;
  raised.bot.blockAt=p=>{const b=raisedRead(p.offset(0,p.x>=1?-1:0,0));if(b)b.position=p;return b;};
  const climbed=await executeSkill(raised.bot,{action:'explore',direction:'east',distance:8});
  assert.equal(climbed.to.y,65,'actual Movements permits supported one-block rise');
  assert.equal(raised.bot.pathfinder.navigations,climbed.verifiedSteps,'every landing dispatched and verified individually');
  for(const mode of ['two-high','low-ceiling','gap']) {
    const f=actualFixture(), read=f.bot.blockAt;
    f.bot.blockAt=p=>{
      if(mode==='low-ceiling'&&p.x<=0&&p.y===66){const b=Block.fromStateId(registry.blocksByName.stone.minStateId,0);b.position=p;return b;}
      if(mode==='gap'&&p.x===1&&p.y<64){const b=Block.fromStateId(registry.blocksByName.air.minStateId,0);b.position=p;return b;}
      const offset=mode==='two-high'&&p.x>=1?-2:mode==='low-ceiling'&&p.x>=1?-1:0;
      const b=read(p.offset(0,offset,0));if(b)b.position=p;return b;
    };
    if(mode==='low-ceiling')f.blocks.set(new Vec3(0,66,0).toString(),'stone');
    await assert.rejects(executeSkill(f.bot,{action:'explore',direction:'east',distance:8}),/infeasible/,mode);
    assert.equal(f.bot.pathfinder.navigations,0,mode+' must not dispatch');
  }
  for(const danger of ['water','lava','unknown']) {
    const f=actualFixture();
    for(let x=1;x<=7;x++) for(let y=58;y<=64;y++) f.blocks.set(new Vec3(x,y,0).toString(),danger);
    await assert.rejects(executeSkill(f.bot,{action:'explore',direction:'east',distance:8}),/infeasible|dry supported terrain/);
    assert.equal(f.bot.pathfinder.navigations,0,'unsafe endpoint never dispatches movement');
  }

  for (const direction of Object.keys(DIRECTIONS)) {
    const { bot } = fixture(), result = await executeSkill(bot, { action: 'explore', direction, distance: 48 });
    assert(result.emergencyRecovery); assert.equal(result.distanceLimit, 8); assert.equal(result.complete, false);
    assert(Math.hypot(result.to.x - result.from.x, result.to.z - result.from.z) <= 8);
    const [dx, dz] = DIRECTIONS[direction];
    assert((result.to.x - result.from.x) * dx + (result.to.z - result.from.z) * dz > 0, 'only model-selected direction');
    assert.equal(bot.pathfinder.movements.allowSprinting, false); assert.equal(bot.pathfinder.movements.maxDropDown, 2); assert.equal(bot.pathfinder.movements.canDig, false);
  }
  const enemy = fixture().bot; enemy.entities[1] = { name: 'zombie', position: new Vec3(20, 64, 0) };
  await assert.rejects(executeSkill(enemy, { action: 'explore', direction: 'east', distance: 8 }), /hostile within 24/); assert.equal(enemy.pathfinder.navigations, 0);
  for (const block of ['water', 'lava', 'unknown', 'air']) {
    const f = fixture(); for (let x = 1; x <= 7; x++) for (let y = 58; y <= 63; y++) f.blocks.set(new Vec3(x, y, 0).toString(), block);
    await assert.rejects(executeSkill(f.bot, { action: 'explore', direction: 'east', distance: 8 }), /infeasible/); assert.equal(f.bot.pathfinder.navigations, 0);
  }
  for (const node of [{ x: 3, y: 63, z: 0 }, { x: 3, y: 64, z: 0, toBreak: [1] }, { x: 3, y: 64, z: 0, toPlace: [1] }, { x: 3, y: 64, z: 7 }]) {
    const { bot } = fixture(); bot.pathfinder.getPathFromTo = function * (m, start, goal) { yield { result: { status: 'success', path: [node, { x: goal.x, y: goal.y, z: goal.z }] } }; };
    await assert.rejects(executeSkill(bot, { action: 'explore', direction: 'east', distance: 8 }), /infeasible/); assert.equal(bot.pathfinder.navigations, 0);
  }
  const transient=fixture().bot,landings=[];
  transient.pathfinder.goto=async goal=>{
    transient.pathfinder.navigations++;
    transient.entity.position=new Vec3(goal.x+.5,goal.y+.5,goal.z+.5);transient.entity.onGround=false;
    setTimeout(()=>{transient.entity.position.y=goal.y;transient.entity.onGround=true;},60);
  };
  await executeSkill(transient,{action:'explore',direction:'east',distance:8},{log:e=>landings.push(e)});
  assert(landings.filter(e=>e.event==='emergency_explore_landing').every(e=>e.confirmed&&e.waitedMs>=50));
  const suspended=fixture().bot;
  suspended.pathfinder.goto=async goal=>{suspended.entity.position=new Vec3(goal.x+.5,goal.y+.5,goal.z+.5);suspended.entity.onGround=false;};
  await assert.rejects(executeSkill(suspended,{action:'explore',direction:'east',distance:8}),/landing was not reached safely/);
  const injuredLanding=fixture().bot;
  injuredLanding.pathfinder.goto=async goal=>{injuredLanding.entity.position=new Vec3(goal.x+.5,goal.y+.5,goal.z+.5);injuredLanding.entity.onGround=false;setTimeout(()=>{injuredLanding.health=4;},20);};
  await assert.rejects(executeSkill(injuredLanding,{action:'explore',direction:'east',distance:8}),/health decreased/);
  const short = fixture(); short.blocks.set(new Vec3(7, 63, 0).toString(), 'unknown');
  const shorter = await executeSkill(short.bot, { action: 'explore', direction: 'east', distance: 8 });
  assert.equal(shorter.to.x, 6.5, 'blocked distant endpoint falls back to a verified shorter route');
  const one = fixture(); for (let x = 2; x <= 7; x++) for (let y = 58; y <= 63; y++) one.blocks.set(new Vec3(x, y, 0).toString(), 'unknown');
  assert.equal((await executeSkill(one.bot, { action: 'explore', direction: 'east', distance: 8 })).moved, 1, 'one block progress is valid, not a four-block minimum');
  const descending = fixture(), flatRead = descending.bot.blockAt;
  descending.bot.blockAt = p => { const q = p.offset(0, p.x >= 1 ? 1 : 0, 0); const b = flatRead(q); if (b) b.position = p; return b; };
  const down = await executeSkill(descending.bot, { action: 'explore', direction: 'east', distance: 8 });
  assert.equal(down.to.y, 63); assert(down.verifiedSteps > 0); assert.equal(descending.bot.pathfinder.navigations, down.verifiedSteps, 'each landing is separately verified');
  const cliff = fixture(), cliffRead = cliff.bot.blockAt;
  cliff.bot.blockAt = p => { const b = cliffRead(p.offset(0, p.x >= 1 ? 3 : 0, 0)); if (b) b.position = p; return b; };
  await assert.rejects(executeSkill(cliff.bot, { action: 'explore', direction: 'east', distance: 8 }), /infeasible/); assert.equal(cliff.bot.pathfinder.navigations, 0);
  for (const change of [bot => { bot.health = 4; }, bot => { bot.entities[1] = { name: 'skeleton', position: new Vec3(15, 64, 0) }; }]) {
    const { bot } = fixture(); let release; bot.pathfinder.goto = () => new Promise(resolve => { release = resolve; });
    const pending = executeSkill(bot, { action: 'explore', direction: 'north', distance: 8 });
    await new Promise(resolve => setTimeout(resolve, 20)); change(bot);
    await assert.rejects(pending, /Emergency explore stopped/); release(); await new Promise(resolve => setTimeout(resolve, 10));
  }
  console.log('Emergency explore checks passed: model direction, eight-block cap, shorter dry verified paths, supported single-block landing, no sprint/large drop/dig/place, hostile and health-change cancellation.');
})().catch(error => { console.error(error); process.exitCode = 1; });
