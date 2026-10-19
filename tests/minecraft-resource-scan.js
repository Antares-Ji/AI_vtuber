'use strict';
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {Vec3}=require('vec3');
const scan=require('../src/minecraft/resource-scan');
const LIFE=Symbol.for('ai-vtuber.minecraft.lifecycleEpoch');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
function fixture(){const bot=new EventEmitter();let removed=false;Object.assign(bot,{game:{dimension:'overworld',minY:-64,height:384},entity:{position:new Vec3(0,0,0)},world:{getColumn:()=>({})},reads:0,blockAt(p){bot.reads++;return {position:p,name:removed?'air':p.y<=0?'stone':'air'};},remove(){removed=true;}});return bot;}
async function finish(s){for(let i=0;i<1000&&!s.complete&&!s.cancelled;i++)await sleep(2);assert(s.complete,JSON.stringify(scan.status(s)));}
(async()=>{
 const bot=fixture();let turns=0;const timer=setInterval(()=>turns++,1);
 const state=scan.ensure(bot,['stone'],{radius:8});
 assert.equal(bot.reads,0,'observe starts scan without synchronous traversal');
 assert.equal(scan.status(state).status,'pending');
 assert.equal(scan.ensure(bot,['stone'],{radius:8}),state,'concurrent observations share one scan');
 await finish(state);clearInterval(timer);
 assert(turns>1,'other event-loop work runs between scan slices');assert(state.maxSliceReads<=256);
 const found=scan.candidates(bot,state,['stone']);assert(found.length>0);assert(found.every(b=>b.position.y===0),'buried matches do not occupy candidate quota');
 assert(state.reads>80,'surface remains discoverable beyond buried candidate count');
 bot.remove();assert.equal(scan.candidates(bot,state,['stone']).length,0,'cache is re-read against real blocks');
 const same=scan.ensure(bot,['stone'],{radius:8});assert.equal(same,state);
 bot[LIFE]=1;const life=scan.ensure(bot,['stone'],{radius:8});assert.notEqual(life,state);assert(state.cancelled);
 bot.game.dimension='nether';const dimension=scan.ensure(bot,['stone'],{radius:8});assert(life.cancelled);
 bot.entity.position.x=8;const moved=scan.ensure(bot,['stone'],{radius:8});assert(dimension.cancelled);assert.notEqual(moved,dimension);
 const reads=bot.reads;scan.cancel(bot);await sleep(10);assert.equal(bot.reads,reads);assert.equal(bot.listenerCount('death'),0);assert.equal(bot.listenerCount('end'),0);
 const unknown=fixture();unknown.world.getColumn=()=>null;const unknownScan=scan.ensure(unknown,['stone'],{radius:2});await finish(unknownScan);assert(unknownScan.unknownCells>0);assert.equal(unknownScan.positions.length,0);
 const reloaded=fixture(),active=scan.ensure(reloaded,['stone'],{radius:8});delete require.cache[require.resolve('../src/minecraft/resource-scan')];const again=require('../src/minecraft/resource-scan');assert.equal(again.ensure(reloaded,['stone'],{radius:8}),active,'module reload shares existing owned worker rather than spawning duplicate');
 reloaded.emit('death');assert(active.cancelled);assert.equal(reloaded.listenerCount('end'),0);
 console.log('Async resource scan passed: zero synchronous start, slice reads <=256, event-loop yielding, exposed candidates, live revalidation, pending/unknown, movement/life/dimension cancellation, reload sharing and listener cleanup.');
})().catch(e=>{console.error(e);process.exitCode=1;});
