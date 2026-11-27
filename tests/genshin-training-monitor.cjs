const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {runMonitor,cleanupStatus,acquireLock,releaseLock,modeFrom}=require('../scripts/genshin/training-monitor.cjs');
const {ensureMonitor}=require('../scripts/genshin/ensure-training-monitor.cjs');
const clone=x=>JSON.parse(JSON.stringify(x));
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-monitor-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,folder:path.join(root,'runtime/genshin/training-monitor')};}
const base=()=>({at:1,continuation:{sessionId:'training',runId:'run',nativeId:'native',revoked:false,status:'running'},run:{id:'run',state:'RUNNING'},story:{runId:'run',nativeId:'native',steps:1,lastFrameAt:1,state:'executing',scene:'world',decision:{action:{kind:'wait'}}},bridge:{busy:false,active:null,lastResult:{id:'native',inputReleased:true,processStopped:true}}});
function readerFor(rows,visions=[{ready:true,busy:false}]){let i=-1;const urls=[];return {urls,reader:async url=>{urls.push(url);if(url.endsWith('training-status')){i++;const value=rows[Math.min(i,rows.length-1)];if(value instanceof Error)throw value;return clone(value);}const value=visions[Math.min(i,visions.length-1)];if(value instanceof Error)throw value;return clone(value);}};}
test('numeric samples remain supported, latest refreshes every poll and stable telemetry logs only once',async t=>{
 const {root,folder}=fixture(t),source=readerFor([base()]),logs=[];let now=0;
 const result=await runMonitor({root,argument:'3',reader:source.reader,now:()=>now,sleep:async ms=>{assert.equal(ms,5000);now+=ms;},log:x=>logs.push(x)});
 assert.equal(result.samples,3);assert.equal(result.reason,'sample_limit_reached');assert.equal(logs.length,1);
 const latest=JSON.parse(fs.readFileSync(path.join(folder,'latest.json')));assert.equal(latest.sampledAt,10000);assert.equal(latest.monitor.sample,3);
 assert.equal(fs.readFileSync(path.join(folder,'events.jsonl'),'utf8').trim().split('\n').length,1);
 assert.equal(fs.existsSync(path.join(folder,'monitor.lock.json')),false);
 assert.deepEqual(new Set(source.urls),new Set(['http://127.0.0.1:3000/api/genshin/story/training-status','http://127.0.0.1:17646/health']));
 assert.equal(modeFrom('until_stopped').count,Infinity);assert.throws(()=>modeFrom('0'));
});
test('revocation waits for the matching native receipt, bridge idle and vision idle before exiting',async t=>{
 const {root,folder}=fixture(t),wrong=base();wrong.continuation.revoked=true;wrong.run.state='INTERRUPTED';wrong.bridge.lastResult.id='previous';
 const stillBusy=clone(wrong);stillBusy.bridge.lastResult.id='native';stillBusy.bridge.busy=true;
 const clean=clone(stillBusy);clean.bridge.busy=false;
 const source=readerFor([wrong,stillBusy,clean,clean],[{ready:true,busy:false},{ready:true,busy:false},{ready:true,busy:true},{ready:true,busy:false}]);let now=0;
 const result=await runMonitor({root,argument:'until_stopped',reader:source.reader,now:()=>now,sleep:async ms=>{now+=ms;},log(){}});
 assert.equal(result.samples,4);assert.equal(result.reason,'stopped_clean');
 const events=fs.readFileSync(path.join(folder,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(events[0].alert,'waiting_for_cleanup');assert.equal(events.at(-1).alert,'stopped_clean');
});
test('finite sample limit never truncates pending cleanup and temporary API failures stay observable',async t=>{
 const {root,folder}=fixture(t),pending=base();pending.continuation.revoked=true;pending.run.state='STOPPING';
 const clean=clone(pending);clean.run.state='INTERRUPTED';
 const source=readerFor([pending,new Error('status offline'),clean]);let now=0;
 const result=await runMonitor({root,argument:'1',reader:source.reader,now:()=>now,sleep:async ms=>{now+=ms;},log(){}});
 assert.equal(result.samples,3);assert.equal(result.reason,'stopped_clean');
 const rows=fs.readFileSync(path.join(folder,'events.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
 assert.equal(rows[1].statusAvailable,false);assert.equal(rows[1].alert,'monitor_unavailable');assert.equal(rows[1].sampledAt,5000);
});
test('failed training does not end until-stopped supervision and missing target or health cannot prove cleanup',async t=>{
 const {root}=fixture(t),failed=base();failed.run.state='FAILED';failed.story.state='error';
 const clean=clone(failed);clean.continuation.revoked=true;
 const source=readerFor([failed,failed,clean]);let now=0;
 const result=await runMonitor({root,argument:'until_stopped',reader:source.reader,now:()=>now,sleep:async ms=>{now+=ms;},log(){}});
 assert.equal(result.samples,3);
 assert.equal(cleanupStatus({continuation:{revoked:true},bridge:{busy:false}},{}).confirmed,false);
 assert.equal(cleanupStatus(clean,{ready:true,busy:false,error:'health failed'}).confirmed,false);
 clean.bridge.lastResult.processStopped=false;assert.equal(cleanupStatus(clean,{ready:true,busy:false}).confirmed,false);
});
test('live PID lock reuses a monitor without API reads; stale lock is replaced and token guards release',async t=>{
 const {root,folder}=fixture(t),lock=acquireLock(folder,'until_stopped',{pid:123,isAlive:()=>false});
 let calls=0;const result=await runMonitor({root,reader:async()=>{calls++;},isAlive:pid=>pid===123,log(){}});
 assert.equal(result.reused,true);assert.equal(result.pid,123);assert.equal(calls,0);
 const replacement=acquireLock(folder,'until_stopped',{pid:456,isAlive:()=>false});assert.equal(replacement.owned,true);
 releaseLock(lock);assert.equal(fs.existsSync(replacement.file),true);
 releaseLock(replacement);assert.equal(fs.existsSync(replacement.file),false);
});
test('ensure launcher starts a hidden detached reader and subsequent calls reuse its lock',async t=>{
 const {root,folder}=fixture(t);let spawned=0,unref=false;
 const spawnChild=(exe,args,options)=>{
  spawned++;assert.equal(exe,process.execPath);assert.equal(args[1],'until_stopped');
  assert.equal(options.detached,true);assert.equal(options.windowsHide,true);assert.equal(options.stdio[0],'ignore');
  fs.writeFileSync(path.join(folder,'monitor.lock.json'),JSON.stringify({pid:789,mode:'until_stopped',token:'child',heartbeatAt:10}));
  return {pid:789,once(){},unref(){unref=true;}};
 };
 const first=await ensureMonitor({root,spawnChild,isAlive:pid=>pid===789,now:()=>20,sleep:async()=>{}});
 assert.equal(first.reused,false);assert.equal(unref,true);
 const second=await ensureMonitor({root,spawnChild,isAlive:pid=>pid===789,now:()=>25});
 assert.equal(second.reused,true);assert.equal(second.pid,789);assert.equal(spawned,1);
});
test('frame acquisition and decision observation sequences remain separate in notifications',async t=>{
 const {root}=fixture(t),old=base(),fresh=base(),logs=[];let now=0;
 old.continuation.revision=1;old.story.observationSeq=1;old.story.observationAt=100;
 fresh.continuation.revision=2;fresh.story.steps=2;fresh.story.observationSeq=1;fresh.story.observationAt=100;
 const source=readerFor([old,fresh]);
 await runMonitor({root,argument:'2',reader:source.reader,now:()=>now,sleep:async ms=>{now+=ms;},log:x=>logs.push(JSON.parse(x))});
 assert.equal(logs.length,2);assert.equal(logs[1].frameSeq,2);assert.equal(logs[1].decisionSeq,1);assert.equal(logs[1].observationAt,100);assert.equal(logs[1].seq,undefined);
});
