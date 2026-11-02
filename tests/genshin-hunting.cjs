'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {routeCandidates,validLocation}=require('../src/genshin/route-candidates');
const {runGoal}=require('../src/genshin/action-planner');
const location=()=>({x:100,y:100,map:'Teyvat',source:'bettergi_local_minimap_cv',capturedAt:Date.now()});
const routes=[{id:'builtin_leyline:1',name:'地脉',category:'leyline'},...[[1000,1000],[110,100]].map(([x,y],i)=>({id:'user:'+i,name:'史莱姆'+i,category:'hunting',map:'Teyvat',firstFight:{x,y}}))];
test('hunting excludes leyline and ranks by fresh CV position, never stale position',()=>{
  const candidates=routeCandidates('找到最近敌方怪物并击杀',routes,location());
  assert.deepEqual(candidates.map(x=>x.id),['user:1','user:0']);assert.equal(candidates[0].distanceToFirstFight,10);
  const old={...location(),capturedAt:Date.now()-100000};assert.equal(validLocation(old),false);
  assert.ok(routeCandidates('打怪',routes,old).every(x=>x.distanceToFirstFight===null));
  assert.ok(routeCandidates('向前走一段',routes,location()).every(x=>x.category!=='hunting'));
});
test('model requests CV location then selects route; executor observes after completion',async()=>{
  const operations=[];let calls=0,observed=0;
  const result=await runGoal('找到最近敌方怪物并击杀',{signal:new AbortController().signal,services:{routes,
    observe:async()=>{observed++;return {observation:{scene:'world',summary:'test',uncertain:false}};},
    decide:async(goal,input)=>{calls++;return {decision:calls===1?{operation:'locate',reason:'定位'}:calls===2?{operation:'path',routeId:input.routes[0].id,reason:'前往最近已知路线'}:{operation:'stop',reason:'模型结束本轮'}};},
    execute:async command=>{operations.push(command);return {state:'returned',inputReleased:true,processStopped:true,receipt:{location:location()}};}}});
  assert.deepEqual(operations.map(x=>x.operation),['locate','path']);assert.equal(operations[1].routeId,'user:1');assert.equal(observed,3);assert.equal(result.verified,false);assert.ok(result.current);assert.equal(result.executed,true);
});
test('failed location never leads to route execution',async()=>{
  let executions=0;
  await assert.rejects(runGoal('最近敌人',{signal:new AbortController().signal,services:{routes,
    observe:async()=>({observation:{scene:'world',uncertain:false}}),decide:async()=>({decision:{operation:'locate'}}),
    execute:async()=>{executions++;return {state:'returned',inputReleased:true,processStopped:true,receipt:{location:{...location(),x:NaN}}};}}}),/定位/);
  assert.equal(executions,1);
});
