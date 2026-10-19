'use strict';
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.1');
const {Movements}=require('mineflayer-pathfinder');
const {validateAction,setSafeMovements}=require('../src/minecraft/survival-skills');
const extended=require('../src/minecraft/extended-actions');
const {decide}=require('../src/minecraft/reactive-agent');
function fixture(action){
  const bot=new EventEmitter(); let inventory=[{name:'dirt',type:registry.itemsByName.dirt.id,count:8,slot:9}];
  Object.assign(bot,{registry,food:3,health:5,entities:{},entity:{position:new Vec3(0,64,0)},inventory:{items:()=>inventory,slots:[]},pathfinder:{setMovements(m){this.movements=m}},world:{raycast:()=>null}});
  const ctx={bot,action,check(){},step:async(n,fn)=>fn(),sleep:async()=>{},until:async(n,p)=>assert(p(),n),goto:async g=>{bot.entity.position=new Vec3(g.x??0,g.y??64,g.z??0)}};
  return {bot,ctx,setInventory:items=>inventory=items};
}
(async()=>{
  for(const schema of extended.schemas){const action=Object.fromEntries(Object.entries(schema.properties).map(([k,v])=>[k,v.const??v.enum?.[0]??(v.type==='integer'?v.minimum:'dirt')]));validateAction(action);}
  assert.throws(()=>validateAction({action:'navigate',x:NaN,y:64,z:0}));
  assert.throws(()=>validateAction({action:'equip_item',item:{},destination:'hand'}));
  assert.throws(()=>validateAction({action:'navigate',x:0,y:64,z:0,command:'/give'}));
  validateAction({action:'craft',item:'fishing_rod',count:1});
  const f=fixture({action:'navigate',x:6,y:64,z:0}),m=setSafeMovements(f.bot),native=new Movements(f.bot);
  assert(m.canDig&&m.allowParkour&&m.allow1by1towers&&m.allowSprinting);
  assert(!m.blocksToAvoid.has(registry.blocksByName.water.id));assert.equal(m.maxDropDown,native.maxDropDown);
  assert(m.scafoldingBlocks.includes(registry.itemsByName.dirt.id));
  assert.equal(decide({enabled:true,health:5,armed:false,entities:[{id:1,name:'skeleton',distance:10}],previousMode:'flee'}).action,'flee');
  assert((await extended.execute(f.ctx)).arrived);
  f.ctx.goto=async()=>{};f.ctx.action={action:'navigate',x:20,y:64,z:0};await assert.rejects(()=>extended.execute(f.ctx),/not reached/);
  f.ctx.action={action:'sleep',x:6,y:64,z:0};f.bot.blockAt=()=>({name:'white_bed'});f.bot.sleep=async()=>{f.bot.isSleeping=true};assert((await extended.execute(f.ctx)).sleeping);
  f.ctx.action={action:'wake'};f.bot.wake=async()=>{f.bot.isSleeping=false};assert.equal((await extended.execute(f.ctx)).sleeping,false);
  let closed=0;
  f.ctx.action={action:'container_transfer',x:6,y:64,z:0,direction:'deposit',item:'dirt',count:3};
  f.bot.openContainer=async()=>({close(){closed++},deposit:async()=>f.setInventory([{name:'dirt',count:5}])});
  assert.equal((await extended.execute(f.ctx)).transferred,3);assert.equal(closed,1);
  f.bot.openContainer=async()=>({close(){closed++},deposit:async()=>{throw Error('server rejection')}});
  await assert.rejects(()=>extended.execute(f.ctx),/server rejection/);assert.equal(closed,2);
  f.ctx.action={action:'attack_entity',entityId:42};f.bot.entities[42]={id:42,name:'zombie',position:f.bot.entity.position.offset(1,0,0)};f.bot.lookAt=async()=>{};f.bot.attack=e=>{f.bot.emit('entityDead',e);delete f.bot.entities[e.id]};
  assert((await extended.execute(f.ctx)).killVerified);assert.equal(f.bot.listenerCount('entityDead'),0);
  f.bot.entities[42]={id:42,name:'zombie',position:f.bot.entity.position.offset(1,0,0)};f.bot.attack=e=>{delete f.bot.entities[e.id]};
  assert.equal((await extended.execute(f.ctx)).killVerified,false,'unloaded entity is not a verified kill');
  f.ctx.check=()=>{throw Error('cancelled')};f.bot.entities[42]={id:42,position:f.bot.entity.position.offset(1,0,0)};
  await assert.rejects(()=>extended.execute(f.ctx),/cancelled/);assert.equal(f.bot.listenerCount('entityDead'),0);
  console.log('Expanded capabilities passed: schemas, native movement defaults, attack policy, arrival evidence, sleep/wake, container delta, close on failure, kill evidence, cancellation cleanup.');
})().catch(e=>{console.error(e);process.exitCode=1});
