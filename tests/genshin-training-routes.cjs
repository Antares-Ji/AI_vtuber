'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const bridge=require('../src/genshin/bridge'),story=require('../src/genshin/story-runtime');
const {createGenshinConsole}=require('../src/genshin/console-routes');
const NATIVE='11111111-1111-4111-8111-111111111111';
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-training-routes-'));
 const checkpoint=path.join(root,'runtime/genshin/training-session.json');
 const runs=[],starts=[],stops=[];let body,latest=null;
 const bridgeState={ready:true,busy:false,active:null,lastResult:{id:NATIVE,inputReleased:true,processStopped:true}};
 t.mock.method(bridge,'status',()=>bridgeState);t.mock.method(story,'snapshot',()=>latest);
 const health=t.mock.method(globalThis,'fetch',async url=>{assert.equal(url,'http://127.0.0.1:17646/health');return {ok:true,json:async()=>({ready:true,busy:false})};});
 const host={recent:()=>runs,status:id=>runs.find(r=>r.id===id),
  start:input=>{starts.push(input);const run={id:'r'+starts.length,game:'genshin',skill:input.skill,state:'RUNNING',startedAt:new Date().toISOString()};runs.unshift(run);return run;},
  stop:id=>{stops.push(id);const run=runs.find(r=>r.id===id);if(run)Object.assign(run,{state:'INTERRUPTED',finishedAt:new Date().toISOString()});return run;}};
 const api=createGenshinConsole({host,root,env:{},brain:{},parseBody:async()=>body,send:(res,code,value)=>Object.assign(res,{code,value})});
 t.after(()=>{api.dispose();fs.rmSync(root,{recursive:true,force:true});});
 async function request(route,data){body=data;const res={};await api.handle({method:data===undefined?'GET':'POST',headers:{host:'127.0.0.1:3000','content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}},res,new URL('http://127.0.0.1:3000/api/genshin'+route));return res;}
 return {request,runs,starts,stops,bridgeState,checkpoint,health,setStory:value=>{latest=value;},read:()=>JSON.parse(fs.readFileSync(checkpoint,'utf8'))};
}
test('invalid continuation mode is rejected before a skill starts or a checkpoint is created',async t=>{
 const f=fixture(t),r=await f.request('/story/start',{goal:'继续当前剧情',continuationMode:'forever_unbounded'});
 assert.equal(r.code,400);assert.match(r.value.error,/continuationMode/);assert.equal(f.starts.length,0);assert.equal(fs.existsSync(f.checkpoint),false);
});
test('omitting the mode preserves the two-hour bounded default and native segment budget',async t=>{
 const f=fixture(t);assert.equal((await f.request('/story/start',{goal:'继续当前剧情'})).code,202);
 const saved=f.read();assert.equal(saved.mode,'bounded');assert.equal(saved.until-saved.startedAt,7200000);assert.equal(saved.active,true);assert.equal(f.starts[0].timeoutMs,740000);
});
test('until_stopped persists the explicit mode while every skill remains bounded',async t=>{
 const f=fixture(t);assert.equal((await f.request('/story/start',{goal:'继续当前剧情',continuationMode:'until_stopped'})).code,202);
 const saved=f.read();assert.equal(saved.mode,'until_stopped');assert.equal(saved.until,null);assert.equal(saved.active,true);assert.equal(f.starts[0].allowLive,true);assert.equal(f.starts[0].timeoutMs,740000);
});
test('user stop persists revocation and rejects both old and current resume tokens',async t=>{
 const f=fixture(t);await f.request('/story/start',{goal:'继续当前剧情',continuationMode:'until_stopped'});const old=f.read();
 // Stop also works before a native job ID exists.
 f.setStory({runId:'r1',state:'connecting',startedAt:Date.now()});
 const stopped=await f.request('/stop',{});assert.equal(stopped.code,200);assert.deepEqual(f.stops,['r1']);assert.equal(f.read().revoked,true);assert.equal(f.read().reason,'user_stop');
 assert.equal((await f.request('/story/resume',{sessionId:old.sessionId,revision:old.revision})).code,400);
 const saved=f.read();assert.equal((await f.request('/story/resume',{sessionId:saved.sessionId,revision:saved.revision})).code,400);assert.equal(f.starts.length,1);
});
test('checkpoint lock failure is reported but never prevents actual host stop',async t=>{
 const f=fixture(t);await f.request('/story/start',{goal:'继续当前剧情',continuationMode:'until_stopped'});
 f.setStory({runId:'r1',nativeId:NATIVE});fs.writeFileSync(f.checkpoint+'.lock','busy');
 const stopped=await f.request('/stop',{});assert.equal(stopped.code,200);assert.deepEqual(f.stops,['r1']);assert.equal(stopped.value.storyContinuation.active,false);assert.equal(stopped.value.storyContinuation.revoked,true);
 assert.match(stopped.value.checkpointError,/busy/);assert.match(stopped.value.storyContinuation.persistenceError,/busy/);
 fs.unlinkSync(f.checkpoint+'.lock');await f.request('/stop',{});assert.equal(f.read().revoked,true);assert.equal(f.read().reason,'user_stop');
});
test('maintenance pause saves the exact native job and can explicitly resume the same session',async t=>{
 const f=fixture(t);await f.request('/story/start',{goal:'继续当前剧情',continuationMode:'until_stopped'});
 f.setStory({runId:'r1',nativeId:NATIVE});const paused=await f.request('/story/pause-for-repair',{});
 assert.equal(paused.code,200);const saved=f.read();assert.equal(saved.reason,'repair');assert.equal(saved.revoked,false);assert.equal(saved.active,false);assert.equal(saved.nativeId,NATIVE);
 // Simulate runtime snapshot loss on a console restart. Saved nativeId must
 // still match the latest released native receipt before resume is accepted.
 f.setStory(null);const resumed=await f.request('/story/resume',{sessionId:saved.sessionId,revision:saved.revision});
 assert.equal(resumed.code,202);assert.equal(f.starts.length,2);assert.equal(f.starts[1].args.goal,'继续当前剧情');assert.equal(f.read().sessionId,saved.sessionId);assert.equal(f.read().segments,2);assert.equal(f.read().nativeId,null);
});
test('resume rejects mismatched tokens and unrelated cleanup receipts without starting a skill',async t=>{
 const f=fixture(t);await f.request('/story/start',{goal:'继续当前剧情',continuationMode:'until_stopped'});f.setStory({runId:'r1',nativeId:NATIVE});await f.request('/story/pause-for-repair',{});const saved=f.read();
 for(const token of [{sessionId:'different',revision:saved.revision},{sessionId:saved.sessionId,revision:saved.revision-1}])assert.equal((await f.request('/story/resume',token)).code,400);
 assert.equal(f.health.mock.calls.length,0);
 f.setStory(null);f.bridgeState.lastResult.id='22222222-2222-4222-8222-222222222222';
 assert.equal((await f.request('/story/resume',{sessionId:saved.sessionId,revision:saved.revision})).code,400);assert.equal(f.starts.length,1);
});
test('a later unrelated story snapshot cannot supply native evidence to the current session',async t=>{
 const f=fixture(t);await f.request('/story/start',{goal:'继续当前剧情',continuationMode:'until_stopped'});
 f.setStory({runId:'different-run',startedAt:Date.now()+10000,nativeId:NATIVE});
 const paused=await f.request('/story/pause-for-repair',{});assert.equal(paused.code,200);assert.equal(f.read().nativeId,undefined);assert.deepEqual(f.stops,['r1']);
});
