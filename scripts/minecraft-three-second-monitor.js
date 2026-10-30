'use strict';
// World sampling. All gameplay remains in the selected planner/executor.
const fs=require('node:fs'),path=require('node:path'),net=require('node:net');
const {controlRequest}=require('../src/minecraft/autonomy-loop');
const root=path.resolve(__dirname,'../logs');
const stateFile=path.join(root,'minecraft-three-second-monitor.json');
const evidenceFile=path.join(root,'minecraft-three-second-samples.jsonl');
const run=JSON.parse(fs.readFileSync(process.env.MC_RUN_FILE || path.join(root,'minecraft-forty-minute-run.json'),'utf8'));
const deadline=run.untilStopped === true ? Infinity : Date.parse(run.deadline);
if (!Number.isFinite(deadline) && deadline !== Infinity) throw Error('Invalid run deadline');
try { const old=JSON.parse(fs.readFileSync(stateFile,'utf8')); if(old.status==='running'){try{process.kill(old.pid,0);throw Error('Monitor already running')}catch(e){if(e.code!=='ESRCH')throw e}} } catch(e){if(e.code!=='ENOENT')throw e}
let previous=null,lastChange=Date.now(),lastFeedback=0,lastResult=null,stopping=false;
const save=value=>fs.writeFileSync(stateFile,JSON.stringify({pid:process.pid,deadline:run.deadline,...value},null,2));
const record=value=>fs.appendFileSync(evidenceFile,JSON.stringify({at:new Date().toISOString(),...value})+'\n');
const post=async(url,body)=>{const r=await fetch('http://127.0.0.1:3000'+url,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body),signal:AbortSignal.timeout(2500)});if(!r.ok)throw Error('HTTP '+r.status);return r.json()};
const portOpen=port=>new Promise(resolve=>{const s=net.connect({host:'127.0.0.1',port});s.setTimeout(1200);const done=value=>{s.destroy();resolve(value)};s.once('connect',()=>done(true));s.once('error',()=>done(false));s.once('timeout',()=>done(false));});
async function finish(reason){
  if(stopping)return;stopping=true;
  let stopped=reason==='user_stopped';
  if(!stopped)try{await post('/api/minecraft/loop',{enabled:false});stopped=true}catch(e){record({event:'stop_failed',error:e.message})}
  if(!stopped){stopping=false;save({status:'stop_retry',reason});setTimeout(()=>finish(reason),3000);return;}
  record({event:'monitor_finished',reason});save({status:'finished',reason,lastSample:previous});
}
async function sample(){
  const started=Date.now();if(started>=deadline)return finish('forty_minutes_elapsed');
  try{
    const loop=JSON.parse(fs.readFileSync(path.join(root,'minecraft-loop-state.json'),'utf8'));
    if(!loop.enabled)return finish('user_stopped');
    const monitoredPorts = [...new Set([3000,run.worldPort || 49729,...(run.provider === 'deepseek' ? [] : [11435])])];
    const [o,ports]=await Promise.all([controlRequest('/observe',undefined,AbortSignal.timeout(2200)),Promise.all(monitoredPorts.map(async port=>({port,open:await portOpen(port)})))]);
    const signature=JSON.stringify([o.position,o.inventory,o.health,o.activeTaskId,loop.lastResult?.taskId]);
    if(signature!==previous?.signature)lastChange=Date.now();
    const current={event:'sample',signature,position:o.position,inventory:o.inventory,health:o.health,food:o.food,connected:o.connected,busy:o.busy,task:o.activeTaskId,decision:loop.lastDecision,result:loop.lastResult?.status,error:loop.lastError,ports,unchangedSeconds:Math.floor((Date.now()-lastChange)/1000)};
    if(!previous||Date.now()-lastFeedback>=30000){const c=await controlRequest('/capabilities',undefined,AbortSignal.timeout(1500));current.capabilities={count:c.count,expanded:c.expanded};}
    record(current);previous=current;save({status:'running',sampledAt:new Date().toISOString(),samplesEveryMs:3000,lastSample:current});
    const failed=loop.lastResult && loop.lastResult.status!=='completed' && loop.lastResult.taskId!==lastResult;
    if(run.provider !== 'deepseek' && Date.now()-lastFeedback>=30000&&(failed||current.unchangedSeconds>=60)){
      const text=`监测事实：每3秒采样；当前连接${o.connected}，生命${o.health}饱食${o.food}，位置${JSON.stringify(o.position)}；任务${o.busy?'执行中':'空闲'}，最近动作${JSON.stringify(loop.lastDecision)}；结果${loop.lastResult?.status||'尚无'}，错误${String(loop.lastError||loop.lastResult?.error||'无').slice(0,140)}；状态未变化${current.unchangedSeconds}秒。请根据真实状态自行分析和调整下一步；由你规划并调用Mineflayer。`.slice(0,500);
      await post('/api/minecraft/chat',{text,influence:true,suggestionOnly:true});lastFeedback=Date.now();lastResult=loop.lastResult?.taskId;record({event:'qwen_fact_feedback',text});
    }
  }catch(e){record({event:'monitor_error',error:e.message});save({status:'running',error:e.message,sampledAt:new Date().toISOString()});}
  if(!stopping)setTimeout(sample,Math.max(0,3000-(Date.now()-started)));
}
save({status:'running',startedAt:new Date().toISOString()});sample();
