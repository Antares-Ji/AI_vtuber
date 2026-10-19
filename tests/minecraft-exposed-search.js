'use strict';
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {Vec3}=require('vec3');
const registry=require('prismarine-registry')('1.21.1');
const Block=require('prismarine-block')(registry);
const {observe,executeSkill}=require('../src/minecraft/survival-skills');
function fixture({surface=true,tool=true}={}) {
 const bot=new EventEmitter(),target=new Vec3(15,64,0);
 const buried=Array.from({length:100},(_,i)=>new Vec3(i%10,60,Math.floor(i/10)));
 Object.assign(bot,{registry,health:20,food:20,game:{gameMode:'survival'},entity:{position:new Vec3(.5,64,.5)},entities:{},time:{timeOfDay:6000},
 inventory:{items:()=>tool?[{name:'wooden_pickaxe',type:registry.itemsByName.wooden_pickaxe.id,count:1}]:[]},
 blockAt(p){const name=p.y<64||(surface&&p.equals(target))?'stone':'air';const b=Block.fromStateId(registry.blocksByName[name].minStateId,0);b.position=p;return b;},
 findBlocks(options){assert(Array.isArray(options.matching),'numeric IDs retain palette pruning');const positions=[...buried,...(surface?[target]:[])];return positions.filter(p=>options.matching.includes(bot.blockAt(p).type)&&(!options.useExtraInfo||options.useExtraInfo(bot.blockAt(p)))).slice(0,options.count);},
 canDigBlock:()=>false,world:{raycast:()=>({position:target})},clearControlStates(){},stopDigging(){},deactivateItem(){},
 pathfinder:{setMovements(){},setGoal(){},async goto(){throw Error('unconfirmed path dispatched');},*getPathFromTo(){yield {result:{status:'noPath',path:[]}};}}
 }); return {bot,target};
}
(async()=>{
 const pendingBot=fixture().bot;pendingBot.world.getColumn=()=>null;
 const pendingObservation=observe(pendingBot);assert.equal(pendingObservation.resourceScan.status,'pending');assert.deepEqual(pendingObservation.resources.stone,[]);
 const controller=new AbortController();const pendingTask=executeSkill(pendingBot,{action:'mine',resource:'stone',count:1},{signal:controller.signal});
 setTimeout(()=>controller.abort(new Error('cancel resource wait')),20);
 await assert.rejects(pendingTask,/cancel resource wait/);
 assert.equal(pendingBot[Symbol.for('ai-vtuber.minecraft.resourceScan')],undefined,'cancelled skill removes its scan worker');
 const {bot,target}=fixture();
 assert(observe(bot).resources.stone.some(b=>b.position.x===target.x&&b.position.y===target.y),'100 buried matches cannot crowd exposed stone out of observation');
 const logs=[];await assert.rejects(executeSkill(bot,{action:'mine',resource:'stone',count:1},{log:e=>logs.push(e)}),/no safe path/);
 assert(logs.some(e=>e.event==='candidate_target'&&e.position.x===15),'execution sees the same exposed candidate after count80');
 await assert.rejects(executeSkill(fixture({surface:false}).bot,{action:'mine',resource:'stone',count:1}),/No exposed resource candidates.*reachability not tested/);
 await assert.rejects(executeSkill(fixture({tool:false}).bot,{action:'mine',resource:'stone',count:1}),/Missing correct tool.*no route attempted/);
 console.log('Exposure-before-count checks passed: buried candidates cannot crowd surface resources out; observation/mine agree; absence, missing tool, and unconfirmed route are distinct.');
})().catch(e=>{console.error(e);process.exitCode=1;});
