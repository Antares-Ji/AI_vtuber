'use strict';
const assert=require('node:assert/strict'); const {EventEmitter}=require('node:events'); const {Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.1'); const Block=require('prismarine-block')(registry);
const {executeSkill}=require('../src/minecraft/survival-skills');
function fixture(cover='snow',height=64){
 const bot=new EventEmitter(), map=new Map(), items=[{name:'crafting_table',count:3},{name:'oak_planks',count:204}];
 Object.assign(bot,{registry,health:20,food:20,game:{gameMode:'survival'},entity:{position:new Vec3(.5,64,.5)},entities:{},inventory:{items:()=>items},calls:[],findBlocks:()=>[],
 blockAt(p){let name=map.get(p.toString()) || (p.y<height?'grass_block':p.y===height?cover:'air'); if(name==='unknown')return null; const b=Block.fromStateId(registry.blocksByName[name].minStateId,0);b.position=p;return b;},
 recipesFor:(id,meta,count,table)=>table?[{requiresTable:true,result:{id:registry.itemsByName.chest.id,count:1}}]:[],
 canDigBlock:()=>true, async dig(b){bot.calls.push(['dig',b.name]);map.set(b.position.toString(),'air');}, async equip(i){bot.heldItem=i;},
 async placeBlock(b,face){bot.calls.push(['place']);map.set(b.position.plus(face).toString(),bot.heldItem.name);bot.heldItem.count--;},
 async craft(){bot.calls.push(['craft']);items[1].count-=8;items.push({name:'chest',count:1});},
 pathfinder:{setMovements(){},setGoal(){},async goto(){}},clearControlStates(){},stopDigging(){},deactivateItem(){}
 }); return bot;
}
(async()=>{
 const staleSelection=fixture('air');let serverSlot=0;
 staleSelection.quickBarSlot=1;
 staleSelection._syncWindow=async()=>{staleSelection.calls.push(['sync']);};
 staleSelection._client={write(name,data){assert.equal(name,'held_item_slot');assert.equal(data.slotId,1);serverSlot=data.slotId;staleSelection.calls.push(['select',data.slotId]);}};
 const placeSelected=staleSelection.placeBlock;
 staleSelection.placeBlock=async(...args)=>{assert.equal(serverSlot,1,'server selection must be restored before placement');return placeSelected(...args);};
 await executeSkill(staleSelection,{action:'craft',item:'chest',count:1});
 assert.deepEqual(staleSelection.calls,[['sync'],['select',1],['sync'],['place'],['craft']]);
 const wrongServer=fixture('air'),placeWrong=wrongServer.placeBlock;
 wrongServer.placeBlock=async(...args)=>{const requested=wrongServer.heldItem;wrongServer.heldItem={name:'spruce_log',count:23};await placeWrong(...args);wrongServer.heldItem=requested;};
 await assert.rejects(executeSkill(wrongServer,{action:'craft',item:'chest',count:1}),/Placement inhibited.*observed spruce_log/);
 await assert.rejects(executeSkill(wrongServer,{action:'craft',item:'chest',count:1}),/Placement inhibited/);
 assert.equal(wrongServer.calls.filter(c=>c[0]==='place').length,1,'wrong block latches placement off before next attempt consumes another item');
 const wrongHand=fixture('air');wrongHand.equip=async()=>{wrongHand.heldItem={name:'spruce_log',count:21};};
 await assert.rejects(executeSkill(wrongHand,{action:'craft',item:'chest',count:1}),/Placement equip not confirmed/);
 assert.equal(wrongHand.calls.length,0,'wrong equipped item never gets placed');
 const correctedByServer=fixture('air');correctedByServer._syncWindow=async()=>{correctedByServer.calls.push(['sync']);correctedByServer.heldItem={name:'spruce_log',count:21};};
 await assert.rejects(executeSkill(correctedByServer,{action:'craft',item:'chest',count:1}),/Placement equip not confirmed/);
 assert.deepEqual(correctedByServer.calls,[['sync']],'server correction after equip is checked before placement');
 const synced=fixture('air'),evidence=[];synced._syncWindow=async()=>{synced.calls.push(['sync']);};
 await executeSkill(synced,{action:'craft',item:'chest',count:1},{log:e=>evidence.push(e)});
 assert.deepEqual(synced.calls,[['sync'],['place'],['craft']]);
 assert.equal(evidence.find(e=>e.event==='placement_preflight').heldItem,'crafting_table');
 assert.equal(evidence.find(e=>e.event==='placement_readback').observedBlock,'crafting_table');
 for(const cover of ['snow','short_grass','fern']){
  const bot=fixture(cover),r=await executeSkill(bot,{action:'craft',item:'chest',count:1});assert.equal(r.gained,1);assert.deepEqual(bot.calls,[['dig',cover],['place'],['craft']]);
 }
 const raised=fixture('air',65);await executeSkill(raised,{action:'craft',item:'chest',count:1});assert.deepEqual(raised.calls,[['place'],['craft']],'natural adjacent one-block higher floor is usable without terrain digging');
 for(const cover of ['water','lava','unknown']){const bot=fixture(cover);await assert.rejects(executeSkill(bot,{action:'craft',item:'chest',count:1}),/No safe nearby site/);assert.equal(bot.calls.length,0);}
 for(const cover of ['chest','stone','snow_block']){const bot=fixture(cover);await executeSkill(bot,{action:'craft',item:'chest',count:1});assert(!bot.calls.some(c=>c[0]==='dig'),'solid cover is never removed; can only place above supported solid ground');}
 const late=fixture(),ctrl=new AbortController();late.dig=async()=>{late.calls.push(['dig']);ctrl.abort(new Error('user stop'));};
 await assert.rejects(executeSkill(late,{action:'craft',item:'chest',count:1},{signal:ctrl.signal}),/user stop/);assert.deepEqual(late.calls,[['dig']]);
 const noAck=fixture();noAck.dig=async()=>{noAck.calls.push(['dig']);};await assert.rejects(executeSkill(noAck,{action:'craft',item:'chest',count:1},{timeoutMs:60}),/deadline/);assert.deepEqual(noAck.calls,[['dig']],'no server-readback clearing means no placement');
 console.log('Station surface checks passed: thin snow/short grass/fern only, adjacent floor height, no building/full-snow/liquid/unknown destruction, cancel and readback guards. Simulated only.');
})().catch(e=>{console.error(e);process.exitCode=1;});
