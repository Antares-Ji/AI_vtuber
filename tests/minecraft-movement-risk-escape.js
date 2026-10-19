'use strict';
const assert=require('node:assert/strict'),{Vec3}=require('vec3'),reg=require('prismarine-registry')('1.21.1'),Block=require('prismarine-block')(reg),Move=require('mineflayer-pathfinder/lib/move');
const {setSafeMovements}=require('../src/minecraft/survival-skills');
const saved=require('./fixtures/minecraft-spawn-risk-terrain.json');
function fixture(real=false){
 const map=new Map(saved.terrainDiagnostics.blocks.map(b=>[[b.x,b.y,b.z].join(','),b]));
 const bot={registry:reg,food:20,game:{minY:-64},entity:{position:real?new Vec3(49.2,70,2.3):new Vec3(.5,64,.5),effects:{}},entities:{},inventory:{items:()=>[]},pathfinder:{setMovements(m){this.movements=m},bestHarvestTool(){return null}},blockAt(p){
  if(real&&(p.x<47||p.x>51||p.z<0||p.z>4||p.y<66||p.y>72))return null;
  const d=real?map.get([p.x,p.y,p.z].join(',')):null,name=real?(d?.name||'air'):(p.y<64?'stone':'air');
  const b=Block.fromStateId(reg.blocksByName[name].minStateId,0);b.position=p;if(d){b.shapes=d.shapes;b.boundingBox=d.boundingBox}return b;
 }};return bot;
}
const real=fixture(true);real.entities=Object.fromEntries(saved.entityDiagnostics.entities.map(e=>[e.id,{...e,position:new Vec3(e.position.x,e.position.y,e.position.z)}]));
const node=new Move(49,70,2,0,0),enemy=real.entities[92093];
const completeNeighbors=setSafeMovements(real).getNeighbors(node);
assert(completeNeighbors.length>0,'full captured terrain and all entities permit boundary-safe departure');
console.log('Full captured scene safe neighbors:',completeNeighbors.map(n=>[n.x,n.y,n.z]));
const neighbors=setSafeMovements(real).getNeighbors(node);
assert(neighbors.length>0,'captured terrain with primary blocking enemy has safe escape edges');
assert(neighbors.every(n=>n.distanceTo(enemy.position)>node.distanceTo(enemy.position)));
const b=fixture();b.entities[1]={name:'skeleton',position:new Vec3(24,64,0)};
const m=setSafeMovements(b),start=new Move(0,64,0,0,0);
assert(m.getNeighbors(start).some(n=>n.x===-1));
assert(!m.getNeighbors(start).some(n=>n.x===1),'cannot walk toward original enemy');
b.entities[2]={name:'zombie',position:new Vec3(-30,64,0)};
assert(m.getNeighbors(start).some(n=>n.x===-1),'may approach distant second enemy without crossing its boundary');
b.entities[2].position=new Vec3(-13.5,64,0);
assert(!m.getNeighbors(start).some(n=>n.x===-1),'cannot cross second enemy boundary');
// A near-tangent diagonal chord can enter a sphere despite both endpoints
// being outside; the complete edge must be tested.
const tangentOffset=(13-.005)/Math.sqrt(2);
b.entities[2].position=new Vec3(-.5+tangentOffset,64,.5+tangentOffset);
assert(start.distanceTo(b.entities[2].position)>13);
assert(new Vec3(-1,64,1).distanceTo(b.entities[2].position)>13);
const diagonal=m.getNeighbors(start);
assert(!diagonal.some(n=>n.x===-1&&n.z===1),'edge cannot cross exclusion sphere');
const outside=fixture();outside.entities[1]={name:'skeleton',position:new Vec3(25,64,0)};
assert(!setSafeMovements(outside).getNeighbors(start).some(n=>n.x===1),'outside cannot enter forbidden radius');
// A solid low ceiling and a liquid landing remain excluded in recovery.
const unsafe=fixture(),originalRead=unsafe.blockAt;unsafe.entities[1]={name:'skeleton',position:new Vec3(24,64,0)};
for(const name of ['stone','lava']) {
 unsafe.blockAt=p=>{if(p.x===-1&&p.z===0&&p.y===(name==='stone'?65:64)){const block=Block.fromStateId(reg.blocksByName[name].minStateId,0);block.position=p;return block;}return originalRead(p);};
 assert(!setSafeMovements(unsafe).getNeighbors(start).some(n=>n.x===-1&&n.z===0));
}
console.log('PASS captured spawn terrain escape, approaching original/second threats blocked, outside entry blocked.');
