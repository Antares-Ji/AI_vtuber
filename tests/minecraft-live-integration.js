const assert = require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {liveGameContext,gameContextMessage}=require('../src/minecraft/live-context');
const {buildRealtimeMessages}=require('../src/brain/realtime-context');
const {AutonomyLoop}=require('../src/minecraft/autonomy-loop');
(async()=>{
 const state={connected:true,sessionId:'s',dimension:'overworld',health:20,food:20,inventory:[{name:'iron_ingot',count:2}],reactive:{enabled:true,mode:'idle',lifecycleEpoch:1}};
 const game=liveGameContext({...state,token:'SECRET'},{goal:'制作铁镐',currentSubgoal:'寻找铁矿'},1000,1001);
 assert.equal(game.inventory.iron_ingot,2);assert(!JSON.stringify(game).includes('SECRET'));assert.equal(liveGameContext(state,{goal:'x'},0,7000),null);
 const messages=buildRealtimeMessages({text:'现在在干什么'},{game});assert(messages[0].content.includes('制作铁镐'));assert(messages[0].content.includes('iron_ingot'));
 let began,dispatch=0;const ready=new Promise(r=>began=r);
 const loop=new AutonomyLoop({logDir:fs.mkdtempSync(path.join(os.tmpdir(),'live-priority-')),request:async route=>{if(route==='/skill')dispatch++;return state},planner:async(_,opts)=>{began();await new Promise((resolve,reject)=>opts.signal.addEventListener('abort',()=>reject(opts.signal.reason),{once:true}));}});
 loop.modelHealth=async()=>{};
 const step=loop.step('制作铁镐',new AbortController().signal);await ready;
 const releaseOld=loop.prioritizeConversation();assert((await step).waiting);assert.equal(dispatch,0);assert.equal(loop.state.history.length,0);
 const releaseNew=loop.prioritizeConversation();releaseOld();assert(loop.chatHoldUntil>Date.now());releaseNew();assert.equal(loop.chatHoldUntil,0);
 console.log('PASS live game context, fresh facts, credential exclusion, human priority cancels planning only, stale release isolation');
})().catch(e=>{console.error(e);process.exitCode=1});
