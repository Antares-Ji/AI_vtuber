'use strict';
const assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {harvestRoute}=require('../src/minecraft/survival-skills');
const {goals}=require('mineflayer-pathfinder');
(async()=>{
 let options,closed=false;
 const bot={entity:{position:new Vec3(0,64,0)},pathfinder:{movements:{},getPathFromTo:function*(m,p,g,o){options=o;try{const until=performance.now()+30;while(performance.now()<until){}yield {result:{status:'partial'}};yield {result:{status:'success',path:[new Vec3(1,64,0),new Vec3(2,64,0)]}};}finally{closed=true}}}};
 const ctx={bot,safe(){},sleep:async()=>{},log(){}};
 const route=await harvestRoute(ctx,{position:new Vec3(2,64,0)},{cpuMs:0,probes:0},{goal:new goals.GoalBlock(2,64,0)});
 assert(route.confirmed);assert.equal(options.timeout,12000);assert(closed);
 bot.pathfinder.getPathFromTo=function*(){yield {result:{status:'noPath',path:[]}}};
 assert.equal((await harvestRoute(ctx,{position:new Vec3(2,64,0)},{cpuMs:0,probes:0})).confirmed,false);
 console.log('Expanded route budget passed: frontier survives old 24ms limit, bounded timeout, generator cleanup, noPath remains failure.');
})().catch(e=>{console.error(e);process.exitCode=1});
