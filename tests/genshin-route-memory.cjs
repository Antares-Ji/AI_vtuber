'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {randomUUID}=require('node:crypto');
const {recordRouteAttempt,readRouteAttempts,withRouteHistory}=require('../src/genshin/route-memory');
const {runGoal}=require('../src/genshin/action-planner');
function temporary(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-route-memory-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
const receipt=()=>({id:randomUUID(),state:'returned',inputReleased:true,processStopped:true});
test('records terminal route receipts once, with no success claim or arbitrary error text',t=>{
 const root=temporary(t),r=receipt();
 const attempt={routeId:'user:test.json',receipt:r,errorCode:'PATH_EXECUTION_FAILED',errorMessage:'点击传送点后未出现交互面板 secret-text'};
 assert.equal(recordRouteAttempt(root,attempt,1000),true);assert.equal(recordRouteAttempt(root,attempt,1001),false);
 const history=withRouteHistory([{id:'user:test.json'},{id:'user:other.json'}],root);
 assert.equal(history[0].recentExecutions.length,1);assert.equal(history[1].recentExecutions,undefined);
 assert.equal(history[0].recentExecutions[0].verified,false);
 assert.match(history[0].recentExecutions[0].failureReason,/未出现交互面板/);
 assert.ok(!JSON.stringify(readRouteAttempts(root)).includes('secret-text'));
});
test('refuses partial cleanup and startup failures; returned is unverified',t=>{
 const root=temporary(t);
 for(const attempt of [
  {receipt:{...receipt(),inputReleased:false}},
  {receipt:{...receipt(),processStopped:false}},
  {receipt:{...receipt(),state:'running'}},
  {receipt:receipt(),errorCode:'STARTUP_SCENE_CHANGED'},
 ])assert.equal(recordRouteAttempt(root,{routeId:'user:test.json',...attempt}),false);
 assert.deepEqual(readRouteAttempts(root),[]);
 assert.equal(recordRouteAttempt(root,{routeId:'user:test.json',receipt:receipt()}),true);
 assert.equal(readRouteAttempts(root)[0].outcome,'returned-unverified');
});
test('later goal receives failed route history across runs but model retains the choice',async t=>{
 const root=temporary(t),route={id:'user:test.json',name:'史莱姆',category:'hunting'};
 let decisions=0;
 const services={policy:null,routes:[route],observe:async()=>({observation:{scene:'world',summary:'test',uncertain:false}}),
  decide:async()=>({decision:++decisions===1?{operation:'path',routeId:route.id,reason:'model choice'}:{operation:'stop',reason:'done'}}),
  execute:async()=>{throw Object.assign(Error('点击传送点后未出现交互面板'),{code:'PATH_EXECUTION_FAILED',receipt:{...receipt(),state:'error'}});}};
 await runGoal('击杀目标',{root,signal:new AbortController().signal,services});
 assert.equal(readRouteAttempts(root).length,1);
 await runGoal('击杀目标',{root,signal:new AbortController().signal,services:{...services,
   decide:async(goal,{routes})=>{assert.equal(routes.length,1);assert.equal(routes[0].recentExecutions[0].outcome,'path-failed');return {decision:{operation:'stop',reason:'model decision'}};}}});
});
test('cannot silently replace corrupt memory; planner continues with a diagnostic',async t=>{
 const root=temporary(t),directory=path.join(root,'runtime/genshin');fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(directory,'route-attempts.json'),'{broken');
 assert.throws(()=>recordRouteAttempt(root,{routeId:'user:test.json',receipt:receipt()}));
 const notices=[];
 await runGoal('击杀目标',{root,signal:new AbortController().signal,reportProgress:stage=>notices.push(stage),services:{policy:null,routes:[],
  observe:async()=>({observation:{scene:'world',uncertain:false}}),decide:async()=>({decision:{operation:'stop'}})}});
 assert.ok(notices.includes('memory-warning'));
 assert.equal(fs.readFileSync(path.join(directory,'route-attempts.json'),'utf8'),'{broken');
});
