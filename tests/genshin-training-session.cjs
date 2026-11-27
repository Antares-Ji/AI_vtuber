const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {TrainingSessionStore}=require('../src/genshin/training-session');
const {StoryContinuation}=require('../src/genshin/story-continuation');
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-training-'));t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const file=path.join(dir,'session.json'),store=new TrainingSessionStore({file});
 const runs=new Map(),starts=[];const host={status:id=>runs.get(id),start:input=>{starts.push(input);const run={id:'r'+starts.length,state:'RUNNING'};runs.set(run.id,run);return run;}};
 const make=(options={})=>new StoryContinuation({host,store,ready:async()=>true,cleanup:async()=>true,timer:false,...options});
 const controller=make(),first=host.start({});controller.begin('继续当前剧情并调试',first,{mode:'until_stopped'});
 const finish=()=>Object.assign(first,{state:'UNVERIFIED',finishedAt:'now',result:{execution:{state:'returned',inputReleased:true,processStopped:true,receipt:{state:'returned',endReason:'segment_budget'}}}});
 return {file,store,make,controller,first,finish,host,runs,starts};
}
test('checkpoint persists goal, session, segment count and revoked user stop',t=>{
 const f=fixture(t),initial=f.store.read();assert.equal(initial.goal,'继续当前剧情并调试');assert.equal(initial.segments,1);assert.equal(initial.mode,'until_stopped');
 f.controller.stop();const saved=f.store.read();assert.equal(saved.sessionId,initial.sessionId);assert.ok(saved.revision>initial.revision);assert.equal(saved.revoked,true);assert.equal(saved.status,'stopped');
 const loaded=f.make();assert.equal(loaded.snapshot().active,false);assert.equal(loaded.snapshot().reason,'user_stop');
});
test('restart does not start input; explicit matching resume starts exactly one bounded segment',async t=>{
 const f=fixture(t);f.finish();const loaded=f.make(),checkpoint=loaded.snapshot();
 assert.equal(checkpoint.reason,'restart_resume_required');await loaded.tick();assert.equal(f.starts.length,1);
 const next=await loaded.resume({sessionId:checkpoint.sessionId,revision:checkpoint.revision});
 assert.equal(next.id,'r2');assert.equal(f.starts[1].timeoutMs,740000);assert.equal(f.store.read().segments,2);
 await assert.rejects(()=>loaded.resume({sessionId:checkpoint.sessionId,revision:checkpoint.revision}),/changed/);
});
test('user stop cannot be revived by stale or even current explicit resume token',async t=>{
 const f=fixture(t);f.finish();const old=f.controller.snapshot();f.controller.stop();
 await assert.rejects(()=>f.controller.resume(old),/changed/);await assert.rejects(()=>f.controller.resume(f.controller.snapshot()),/stopped/);assert.equal(f.starts.length,1);
});
test('persisted stop from another controller wins against an awaiting continuation',async t=>{
 const f=fixture(t);f.finish();let resolve;f.controller.ready=()=>new Promise(r=>resolve=r);
 const pending=f.controller.tick();const newer=f.make();newer.stop();resolve(true);await pending;
 assert.equal(f.starts.length,1);assert.equal(f.store.read().reason,'user_stop');assert.equal(f.controller.snapshot().active,false);
});
test('stop during explicit resume readiness wins and remains persisted',async t=>{
 const f=fixture(t);f.finish();const loaded=f.make();let resolve;loaded.ready=()=>new Promise(r=>resolve=r);
 const pending=loaded.resume(loaded.snapshot());await new Promise(r=>setImmediate(r));loaded.stop();resolve(true);
 await assert.rejects(()=>pending,/revoked/);assert.equal(f.starts.length,1);assert.equal(f.store.read().revoked,true);
});
test('store compare-and-swap rejects stale mutation and leaves latest checkpoint intact',t=>{
 const f=fixture(t),old=f.store.read();const next=f.store.update(old,{reason:'fresh'});
 assert.throws(()=>f.store.update(old,{revoked:false}),{code:'TRAINING_SESSION_CONFLICT'});
 assert.deepEqual(f.store.read(),next);assert.equal(fs.existsSync(f.file+'.lock'),false);
});
test('resume rejects unknown cleanup and running old segments',async t=>{
 const f=fixture(t),loaded=f.make();await assert.rejects(()=>loaded.resume(loaded.snapshot()),/not finished/);
 f.finish();loaded.cleanup=async()=>false;await assert.rejects(()=>loaded.resume(loaded.snapshot()),/cleanup/);assert.equal(f.starts.length,1);
});
test('repair pause and disposal retain resumability; persistence failure cannot prevent local stop',async t=>{
 const f=fixture(t);f.finish();f.controller.stop('repair');assert.equal(f.store.read().revoked,false);
 const loaded=f.make();await loaded.resume(loaded.snapshot());assert.equal(f.starts.length,2);
 loaded.dispose();assert.equal(f.store.read().revoked,false);assert.equal(f.store.read().reason,'host_disposed');
 const blocked=f.make();fs.writeFileSync(f.file+'.lock','busy');assert.doesNotThrow(()=>blocked.stop());
 assert.equal(blocked.snapshot().active,false);assert.equal(blocked.snapshot().revoked,true);assert.match(blocked.snapshot().persistenceError,/busy/);
 fs.unlinkSync(f.file+'.lock');
});
test('native job evidence persists during running, survives repair, and never alters a revoked stop',async t=>{
 const f=fixture(t),nativeId='11111111-1111-4111-8111-111111111111';
 f.controller.evidence=run=>run.id===f.first.id?{nativeId}:null;
 await f.controller.tick();assert.equal(f.store.read().nativeId,nativeId);
 const before=f.store.read().revision;await f.controller.tick();assert.equal(f.store.read().revision,before);
 f.controller.stop('repair');const loaded=f.make();assert.equal(loaded.snapshot().nativeId,nativeId);
 loaded.stop();const stopped=f.store.read();loaded.recordNative('22222222-2222-4222-8222-222222222222');assert.deepEqual(f.store.read(),stopped);
});
test('associated structured error code allows one cleaned-up transient recovery',async t=>{
 const f=fixture(t);Object.assign(f.first,{state:'FAILED',finishedAt:'now',error:'本轮读取未完成'});
 f.controller.evidence=()=>({errorCode:'STORY_FRAME_TIMEOUT'});await f.controller.tick();assert.equal(f.starts.length,2);assert.equal(f.store.read().recoveryAttempts,1);
});
test('explicit stop refreshes a stale same-session token and persists revocation',t=>{
 const f=fixture(t),current=f.store.read();f.store.update(current,{reason:'newer_state'});
 f.controller.stop();assert.equal(f.store.read().revoked,true);assert.equal(f.store.read().reason,'user_stop');
});
