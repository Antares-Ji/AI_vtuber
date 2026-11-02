const {test}=require('node:test'),assert=require('node:assert/strict');
const {StoryContinuation}=require('../src/genshin/story-continuation');
function fixture({ready=async()=>true,cleanup=async()=>false,clock=()=>0,mode='bounded'}={}){
 const runs=new Map(),starts=[];
 const host={status:id=>runs.get(id),start:input=>{starts.push(input);const run={id:'r'+starts.length,state:'RUNNING'};runs.set(run.id,run);return run;}};
 const first=host.start({skill:'genshin:story'});
 const controller=new StoryContinuation({host,ready,cleanup,clock,timer:false});controller.begin('继续已选剧情',first,{mode});
 const returned=(reason='segment_budget',cleanup=true)=>Object.assign(first,{state:'UNVERIFIED',finishedAt:'now',result:{execution:{state:'returned',inputReleased:cleanup,processStopped:cleanup,receipt:{state:'returned',endReason:reason}}}});
 return {runs,starts,host,first,controller,returned};
}
test('normal segment continues once with same goal only after native cleanup and idle vision',async()=>{
 let idle=false;const f=fixture({ready:async()=>idle});f.returned();
 await f.controller.tick();assert.equal(f.starts.length,1);
 idle=true;await Promise.all([f.controller.tick(),f.controller.tick()]);
 assert.equal(f.starts.length,2);assert.equal(f.starts[1].args.goal,'继续已选剧情');assert.equal(f.controller.snapshot().segments,2);
 await f.controller.tick();assert.equal(f.starts.length,2);
});
test('until_stopped removes the total window while keeping every segment bounded',async()=>{
 let now=0;const f=fixture({clock:()=>now,mode:'until_stopped'});f.returned();now=48*3600000;
 await f.controller.tick();assert.equal(f.starts.length,2);assert.equal(f.starts[1].timeoutMs,740000);assert.equal(f.controller.snapshot().until,null);
 f.controller.stop();assert.equal(f.controller.snapshot().revoked,true);
});
test('only one transient failure may recover and only after confirmed cleanup',async()=>{
 const f=fixture({cleanup:async()=>true});Object.assign(f.first,{state:'FAILED',finishedAt:'now',error:'fetch failed'});
 await f.controller.tick();assert.equal(f.starts.length,2);assert.equal(f.controller.snapshot().recoveryAttempts,1);
 Object.assign(f.runs.get('r2'),{state:'FAILED',finishedAt:'now',error:'剧情本地视觉读取失败'});
 await f.controller.tick();assert.equal(f.starts.length,2);assert.equal(f.controller.snapshot().reason,'transient_recovery_exhausted');
 const dirty=fixture();Object.assign(dirty.first,{state:'FAILED',finishedAt:'now',error:'fetch failed'});
 await dirty.controller.tick();assert.equal(dirty.starts.length,1);assert.equal(dirty.controller.snapshot().reason,'cleanup_unconfirmed');
});
test('balance, permission, unknown errors and model stops never recover',async()=>{
 for(const error of ['DeepSeek HTTP 402：余额不足','DeepSeek HTTP 401：权限','DeepSeek HTTP 403','permission denied: fetch failed','unknown script failure','model_stop: fetch failed']){
  const f=fixture({cleanup:async()=>true});Object.assign(f.first,{state:'FAILED',finishedAt:'now',error});await f.controller.tick();assert.equal(f.starts.length,1,error);
 }
});
test('stop during failure cleanup remains authoritative even when cleanup returns false',async()=>{
 let resolve;const f=fixture({cleanup:()=>new Promise(r=>resolve=r)});Object.assign(f.first,{state:'FAILED',finishedAt:'now',error:'fetch failed'});
 const pending=f.controller.tick();f.controller.stop();resolve(false);await pending;
 assert.equal(f.starts.length,1);assert.equal(f.controller.snapshot().reason,'user_stop');
});
test('model stops, errors, interrupts and missing cleanup never automatically restart',async()=>{
 for(const variant of ['model_stop','unknown','cleanup','FAILED','INTERRUPTED','STOPPING']){
  const f=fixture();f.returned();
  if(variant==='cleanup')f.first.result.execution.inputReleased=false;
  else if(['FAILED','INTERRUPTED','STOPPING'].includes(variant))f.first.state=variant;
  else f.first.result.execution.receipt.endReason=variant;
  await f.controller.tick();assert.equal(f.starts.length,1,variant);
 }
});
test('user stop during idle check revokes pending continuation',async()=>{
 let resolve;const f=fixture({ready:()=>new Promise(r=>resolve=r)});f.returned();
 const pending=f.controller.tick();f.controller.stop();resolve(true);await pending;
 assert.equal(f.starts.length,1);assert.equal(f.controller.snapshot().reason,'user_stop');
});
test('temporary health failure waits for the same boundary and closing or time window cancels continuation',async()=>{
 let calls=0;const f=fixture({ready:async()=>{if(++calls===1)throw Error('temporary timeout');return true;}});f.returned();
 await f.controller.tick();assert.equal(f.controller.snapshot().active,true);assert.equal(f.starts.length,1);
 await f.controller.tick();assert.equal(f.starts.length,2);
 let now=0;const bounded=fixture({clock:()=>now});bounded.returned();now=7200001;await bounded.controller.tick();assert.equal(bounded.starts.length,1);
 const closed=fixture();closed.returned();closed.host.closing=true;await closed.controller.tick();assert.equal(closed.starts.length,1);
});
