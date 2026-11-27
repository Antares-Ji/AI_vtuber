'use strict';
// Read-only telemetry: no game input, window restore, model calls or POSTs.
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const ROOT=path.resolve(__dirname,'../..'),INTERVAL_MS=5000;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
function modeFrom(value='120'){
 if(value==='until_stopped')return {mode:value,count:Infinity};
 const count=Number(value);if(!Number.isInteger(count)||count<1)throw Error('Use a positive sample count or until_stopped');
 return {mode:'count',count};
}
function alive(pid){if(!Number.isInteger(pid)||pid<=0)return false;try{process.kill(pid,0);return true;}catch(error){return error.code==='EPERM';}}
function readLock(file){try{return JSON.parse(fs.readFileSync(file,'utf8'));}catch{return null;}}
function atomicWrite(file,value){
 const temp=file+'.'+process.pid+'.'+randomUUID()+'.tmp';
 try{fs.writeFileSync(temp,JSON.stringify(value,null,2),'utf8');fs.renameSync(temp,file);}finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
}
function acquireLock(folder,mode,{isAlive=alive,now=Date.now,pid=process.pid}={}){
 fs.mkdirSync(folder,{recursive:true});const file=path.join(folder,'monitor.lock.json');
 for(let attempt=0;attempt<3;attempt++){
  const record={pid,token:randomUUID(),mode,startedAt:now(),heartbeatAt:now()};
  try{const fd=fs.openSync(file,'wx');try{fs.writeFileSync(fd,JSON.stringify(record));}finally{fs.closeSync(fd);}return {owned:true,file,record};}
  catch(error){if(error.code!=='EEXIST')throw error;}
  const existing=readLock(file);
  if(existing&&isAlive(existing.pid))return {owned:false,file,record:existing};
  if(!existing){try{if(now()-fs.statSync(file).mtimeMs<30000)return {owned:false,file,record:null,pending:true};}catch(error){if(error.code==='ENOENT')continue;throw error;}}
  // A live owner is never replaced merely because its heartbeat is delayed.
  const again=readLock(file);if(JSON.stringify(again)!==JSON.stringify(existing))continue;
  try{fs.unlinkSync(file);}catch(error){if(error.code!=='ENOENT')throw error;}
 }
 throw Error('Could not acquire read-only monitor lock');
}
function releaseLock(lock){if(lock?.owned&&readLock(lock.file)?.token===lock.record.token)fs.unlinkSync(lock.file);}
async function read(url){const r=await fetch(url,{signal:AbortSignal.timeout(4000)});if(!r.ok)throw Error('HTTP '+r.status);return r.json();}
function cleanupStatus(status,vision,targetNativeId){
 const continuation=status?.continuation||{},bridge=status?.bridge||{},last=bridge.lastResult||{};
 const nativeId=targetNativeId||continuation.nativeId||
  (status?.story&&status.story.runId===continuation.runId?status.story.nativeId:null);
 const confirmed=Boolean(continuation.revoked&&nativeId&&last.id===nativeId&&last.inputReleased===true&&last.processStopped===true&&bridge.busy===false&&!bridge.active&&vision?.ready===true&&vision.busy===false&&!vision.error&&!['RUNNING','STOPPING'].includes(status?.run?.state));
 return {nativeId:nativeId||null,confirmed};
}
function changeKey(row){return JSON.stringify({
 available:row.statusAvailable,session:row.continuation?.sessionId,revision:row.continuation?.revision,
 run:row.run?.id,runState:row.run?.state,continuation:row.continuation?.status,reason:row.continuation?.reason,revoked:row.continuation?.revoked,
 nativeId:row.story?.nativeId,frameSeq:row.story?.steps,decisionSeq:row.story?.observationSeq,storyState:row.story?.state,scene:row.story?.scene,action:row.story?.decision?.action,
 bridgeBusy:row.bridge?.busy,bridgeActive:row.bridge?.active,receipt:row.bridge?.lastResult,
 vision:row.vision,alert:row.alert,error:row.error||row.story?.error||row.run?.error,cleanup:row.cleanup
});}
async function runMonitor({root=ROOT,argument='120',reader=read,sleep=delay,now=Date.now,log=console.log,isAlive=alive}={}){
 const config=modeFrom(argument),folder=path.join(root,'runtime/genshin/training-monitor');
 const lock=acquireLock(folder,config.mode,{isAlive,now});
 if(!lock.owned){const result={reused:true,pid:lock.record?.pid||null,pending:Boolean(lock.pending)};log(JSON.stringify(result));return result;}
 let prior='',sample=0,pendingCleanup=false,targetNativeId=null,revokedSession=null,lastRow=null;
 try{
  while(config.mode==='until_stopped'||sample<config.count||pendingCleanup){
   const started=now();sample++;
   const results=await Promise.allSettled([reader('http://127.0.0.1:3000/api/genshin/story/training-status'),reader('http://127.0.0.1:17646/health')]);
   const status=results[0].status==='fulfilled'?results[0].value:null;
   const vision=results[1].status==='fulfilled'?results[1].value:{error:String(results[1].reason?.message||results[1].reason)};
   const row={...(status||{}),sampledAt:now(),statusAvailable:Boolean(status),vision:{ready:vision.ready,busy:vision.busy,error:vision.error},frameAgeMs:status?.story?.lastFrameAt?Math.max(0,now()-status.story.lastFrameAt):null};
   if(!status)row.error=String(results[0].reason?.message||results[0].reason);
   if(status?.continuation?.revoked){
    const session=status.continuation.sessionId||status.continuation.runId||null;
    if(session!==revokedSession){revokedSession=session;targetNativeId=null;}
    const cleanup=cleanupStatus(status,vision,targetNativeId);targetNativeId=cleanup.nativeId;
    row.cleanup=cleanup;pendingCleanup=!cleanup.confirmed;
   }else if(status){pendingCleanup=false;targetNativeId=null;revokedSession=null;}
   row.alert=!status?'monitor_unavailable':row.cleanup?.confirmed?'stopped_clean':pendingCleanup?'waiting_for_cleanup':
    status.run?.state==='FAILED'||status.story?.state==='error'?'failure':vision.error?'vision_health_error':
    row.frameAgeMs>180000&&status.run?.state==='RUNNING'?'stale_frame':null;
   row.monitor={pid:process.pid,mode:config.mode,sample,intervalMs:INTERVAL_MS,state:row.cleanup?.confirmed?'stopped_clean':'monitoring'};
   const key=changeKey(row);
   if(key!==prior){fs.appendFileSync(path.join(folder,'events.jsonl'),JSON.stringify(row)+'\n');log(JSON.stringify({at:row.sampledAt,run:row.run?.id,state:row.run?.state,frameSeq:row.story?.steps,decisionSeq:row.story?.observationSeq,observationAt:row.story?.observationAt,scene:row.story?.scene,action:row.story?.decision?.action,reason:row.story?.decision?.reason,alert:row.alert,error:row.error||row.story?.error||row.run?.error,cleanup:row.cleanup}));prior=key;}
   atomicWrite(path.join(folder,'latest.json'),row);lastRow=row;
   if(readLock(lock.file)?.token!==lock.record.token)throw Error('Read-only monitor lost its ownership lock');
   lock.record.heartbeatAt=now();atomicWrite(lock.file,lock.record);
   if(row.cleanup?.confirmed)break;
   if(config.mode==='until_stopped'||sample<config.count||pendingCleanup)await sleep(Math.max(1,INTERVAL_MS-(now()-started)));
  }
  if(lastRow&&!lastRow.cleanup?.confirmed)atomicWrite(path.join(folder,'latest.json'),{...lastRow,monitor:{...lastRow.monitor,state:'sample_limit_reached'},monitorFinishedAt:now()});
  return {reused:false,pid:process.pid,samples:sample,reason:lastRow?.cleanup?.confirmed?'stopped_clean':'sample_limit_reached'};
 }finally{releaseLock(lock);}
}
module.exports={runMonitor,modeFrom,cleanupStatus,changeKey,acquireLock,releaseLock,readLock,alive,INTERVAL_MS};
if(require.main===module)runMonitor({argument:process.argv[2]||'120'}).catch(error=>{console.error(error.message);process.exitCode=1;});
