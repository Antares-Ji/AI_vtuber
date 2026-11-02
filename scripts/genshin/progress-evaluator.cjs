'use strict';
// Read-only evidence evaluation: native returns and elapsed time are not arrival.
const fs=require('node:fs'),path=require('node:path'),grounding=require('./story-main');
const root=path.resolve(__dirname,'../..'),base=path.join(root,'runtime/genshin');
const normal=v=>String(v||'').replace(/\s/g,''),finite=v=>typeof v==='number'&&Number.isFinite(v);
const readJson=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return null;}};
const detail=s=>{try{return typeof s?.detail==='string'?JSON.parse(s.detail):s?.detail||null;}catch{return null;}};
const nativeId=r=>r.request?.id||r.nativeId||null,frameTime=r=>r.request?.capturedAt??r.at;
const frameKey=r=>nativeId(r)&&Number.isInteger(r.request?.seq)?`${nativeId(r)}:${r.request.seq}`:null;
const quest=r=>r.request?.focusQuest||r.observation?.taskFocus?.quest||r.observation?.trackingEvidence?.selectedQuest||null;

function loadFrames(from=0){
 const rows=[],dir=path.join(base,'story');
 if(!fs.existsSync(dir))return rows;
 for(const d of fs.readdirSync(dir,{withFileTypes:true}).filter(d=>d.isDirectory())){
  for(const n of fs.readdirSync(path.join(dir,d.name)).filter(n=>/^step-\d+\.json$/.test(n))){
   const r=readJson(path.join(dir,d.name,n));if(r&&frameTime(r)>=from)rows.push(r);
  }
 }
 return rows;
}
function selectFrames(input,o){
 const unique=new Map(),ids=o.nativeIds?new Set(o.nativeIds):null;
 for(const [i,r] of input.entries()){
  if(!r||frameTime(r)<(o.sessionStartedAt||0)||ids&&!ids.has(nativeId(r)))continue;
  const trainingId=r.trainingSessionId||r.request?.trainingSessionId;
  if(o.trainingSessionId&&trainingId&&trainingId!==o.trainingSessionId)continue;
  const key=frameKey(r)||`legacy:${i}`,old=unique.get(key);
  if(!old||(r.at||0)>=(old.at||0))unique.set(key,r);
 }
 return [...unique.values()].sort((a,b)=>frameTime(a)-frameTime(b));
}
// Full-frame distanceEvidence may contain menu rows, world labels or ping.
// Only a task instruction and its adjacent OCR distance count as task HUD.
function hudReading(r){
 if(r.observation?.scene!=='world'||r.observation?.uncertain===true)return null;
 const texts=r.request?.texts||[],instruction=grounding.questInstruction(texts),task=quest(r);
 if(!instruction||!normal(task))return null;
 const [x,y,w,h]=instruction.box;
 const nearby=texts.filter(t=>Array.isArray(t.box)&&t.box.length===4&&t.box.every(Number.isFinite)&&
  t.box[0]>=x-30&&t.box[0]<x+Math.min(w,220)&&t.box[1]>=y+h-8&&t.box[1]<y+h+85);
 const cropped=nearby.filter(t=>t.source==='quest_distance_crop');
 const meters=[...new Set((cropped.length?cropped:nearby).flatMap(t=>{
  const m=String(t.text).match(/^\s*(\d{1,5})\s*(?:m|米)\s*$/i);return m?[Number(m[1])]:[];
 }))];
 if(meters.length!==1)return null;
 return {task,stage:instruction.text,meters:meters[0],at:frameTime(r),
  context:JSON.stringify([normal(task),normal(instruction.text)]),source:'task_hud_ocr'};
}
// Explicit receipt counters only; trace length and wall time are not key time.
function movedMs(s){
 const d=detail(s);
 if(finite(d?.movementMsSent)&&d.movementMsSent>=0)return d.movementMsSent;
 if(['move','follow_marker'].includes(s?.action?.kind)&&finite(d?.movedMs)&&d.movedMs>=0)return d.movedMs;
 return 0;
}
function ledgerEntries(l){
 if(!l)return [];
 if(Array.isArray(l))return l.flatMap(ledgerEntries);
 if(Array.isArray(l.events))return l.events.map(e=>({nativeId:e.nativeId||e.sessionId,step:e.step}));
 if(l.receipt)return ledgerEntries(l.receipt);
 if(Array.isArray(l.steps))return l.steps.map(step=>({nativeId:l.nativeId||l.id||l.sessionId,step}));
 return l.step?[{nativeId:l.nativeId||l.sessionId,step:l.step}]:[];
}
function mergeReceipts(rows,o={}){
 const ids=new Set(o.nativeIds||rows.map(nativeId).filter(Boolean)),steps=new Map();
 function add(id,step,source){
  if(!id||!ids.has(id)||!Number.isInteger(step?.seq)||!step.action?.kind)return;
  if(finite(step.finishedAt)&&step.finishedAt<(o.sessionStartedAt||0))return;
  const key=`${id}:${step.seq}`;
  // Compact ledger fills the final tail; live frames retain richer diagnostics.
  if(!steps.has(key)||source==='frame')steps.set(key,{nativeId:id,step,source,key});
 }
 for(const e of ledgerEntries(o.receiptLedger))add(e.nativeId,e.step,'ledger');
 for(const r of rows)add(nativeId(r),r.request?.lastStep,'frame');
 return [...steps.values()].sort((a,b)=>(a.step.finishedAt||0)-(b.step.finishedAt||0)||a.nativeId.localeCompare(b.nativeId)||a.step.seq-b.step.seq);
}
function frameTokens(r){
 let calls;
 if(Array.isArray(r.modelCalls)&&(r.modelCalls.length||r.pipeline?.lookahead?.ok===true))calls=r.modelCalls;
 else {
  calls=[...(r.rejected||[])];const last=calls.at(-1);
  const repeated=r.decision?.action?.kind==='wait'&&last?.usage&&JSON.stringify(last.usage)===JSON.stringify(r.usage);
  if(!repeated)calls.push(r);
 }
 const known=calls.filter(c=>finite(c.usage?.total_tokens)&&c.usage.total_tokens>=0);
 return {total:known.reduce((s,c)=>s+c.usage.total_tokens,0),complete:known.length===calls.length&&(calls.length>0||r.pipeline?.lookahead?.ok===true)};
}
function median(values){
 if(!values.length)return null;
 const s=[...values].sort((a,b)=>a-b),m=Math.floor(s.length/2);return s.length%2?s[m]:(s[m-1]+s[m])/2;
}
function travelEvaluation(rows,receipts){
 const beforeByKey=new Map(rows.filter(frameKey).map(r=>[frameKey(r),r]));
 const calls=receipts.filter(e=>e.step.action.kind==='travel_quest'||detail(e.step)?.kind==='quest-travel').map(e=>{
  const d=detail(e.step)||{},pre=beforeByKey.get(e.key),before=pre&&hudReading(pre);
  const post=rows.find(r=>nativeId(r)===e.nativeId&&r.request?.lastStep?.seq===e.step.seq&&r.request?.seq>e.step.seq&&
   finite(e.step.finishedAt)&&finite(r.request?.capturedAt)&&r.request.capturedAt>e.step.finishedAt);
  const after=post&&hudReading(post);
  let reason=!before?'before_hud_missing':!post?'independent_after_frame_missing':!after?'after_hud_missing':before.context!==after.context?'task_or_stage_changed':null;
  const teleported=d.teleported===true||d.teleport?.attempted===true||(Array.isArray(d.legs)&&d.legs.some(l=>l.kind==='teleport'));
  const gain=reason?null:before.meters-after.meters;
  return {nativeId:e.nativeId,seq:e.step.seq,finishedAt:e.step.finishedAt||null,source:e.source,
   before:before||null,after:after||null,distanceGained:gain,independentFrameVerified:reason===null,
   qualifies:reason===null&&gain>=30,reason,teleported,stopReason:d.stopReason||null,movedLegs:d.movedLegs??null,
   nativeProgress:d.progress||{distanceBefore:d.distanceBefore??null,distanceAfter:d.distanceAfter??null,stageBefore:d.stageBefore??null,stageAfter:d.stageAfter??null}};
 });
 // Latest three actual calls, including failures and calls without a post-frame.
 const recent=calls.slice(-3),successes=recent.filter(c=>c.qualifies).length;
 return {calls:calls.length,recentCalls:recent,qualifyingCalls:successes,passed:recent.length===3&&successes>=2,
  requiredCalls:3,requiredQualifyingCalls:2,minimumDistanceGained:30,verification:'independent_same_task_stage_hud_after_exact_native_receipt'};
}
function evaluate(input,now=Date.now(),o={}){
 const rows=selectFrames(input,o),receipts=mergeReceipts(rows,o),recent=o.recent||12;
 const costs=rows.map(frameTokens),tokens=costs.reduce((s,c)=>s+c.total,0);
 const scenes={},actions={},executedActions={};let moved=0,fSent=0,rejected=0,pathDurationMs=0,nativePathLegs=0,telemetryComplete=true;
 for(const r of rows){
  const sc=r.observation?.scene||'unknown';scenes[sc]=(scenes[sc]||0)+1;
  const k=r.decision?.action?.kind||'none';actions[k]=(actions[k]||0)+1;rejected+=(r.rejected||[]).length;
 }
 for(const {step} of receipts){
  const d=detail(step)||{},kind=step.action.kind;executedActions[kind]=(executedActions[kind]||0)+1;
  moved+=movedMs(step);if(d.kind==='interaction'&&d.sent===true)fSent++;
  if(d.kind==='quest-travel'||kind==='travel_quest'){
   const legs=Array.isArray(d.legs)?d.legs:[];nativePathLegs+=legs.length;
   pathDurationMs+=legs.reduce((s,l)=>s+(finite(l.pathDurationMs)&&l.pathDurationMs>=0?l.pathDurationMs:0),0);
   if(d.movementTelemetryComplete!==true||!finite(d.movementMsSent))telemetryComplete=false;
  }
  if(kind==='advance_quest'&&!finite(d.movementMsSent))telemetryComplete=false;
  if(d.kind==='area-search'){
   const points=Array.isArray(d.points)?d.points:[];nativePathLegs+=points.length;
   pathDurationMs+=points.reduce((s,p)=>s+(finite(p.durationMs)?p.durationMs:0),0);telemetryComplete=false;
  }
 }
 const readings=rows.map(hudReading).filter(Boolean),stages=[];
 for(const r of readings)if(stages.at(-1)!==r.stage)stages.push(r.stage);
 const tail=rows.slice(-recent),tailReadings=tail.map(hudReading).filter(Boolean),comparable=[];
 for(let i=tailReadings.length-1;i>=0;i--){if(comparable.length&&tailReadings[i].context!==comparable[0].context)break;comparable.unshift(tailReadings[i]);}
 const gain=comparable.length>=2?comparable[0].meters-comparable.at(-1).meters:null;
 const tailNonWorld=tail.filter(r=>r.observation?.scene!=='world').length;
 const menuCount=tail.filter(r=>['menu','map','login','loading'].includes(r.observation?.scene)).length;
 let repeat=0,maxRepeat=0,prev=null;
 for(const r of tail){const a=JSON.stringify(r.decision?.action||null);repeat=a===prev?repeat+1:1;maxRepeat=Math.max(maxRepeat,repeat);prev=a;}
 const tailTokens=tail.reduce((s,r)=>s+frameTokens(r).total,0),alerts=[];
 if(rows.length&&now-(rows.at(-1).at||frameTime(rows.at(-1)))>600000)alerts.push({code:'NO_NEW_FRAMES',msg:'超过10分钟没有新帧'});
 if(tail.length>=6&&menuCount/tail.length>0.6)alerts.push({code:'MENU_LOOP',msg:`最近${tail.length}帧有${menuCount}帧处于菜单、地图或加载界面`});
 if(maxRepeat>=4)alerts.push({code:'REPEATED_ACTION',msg:`同一动作连续重复${maxRepeat}次`});
 if(tail.length>=8&&gain!==null&&gain<5)alerts.push({code:'NO_PROGRESS',msg:`最近同任务阶段HUD距离仅下降${gain}m`});
 if(tailTokens>150000&&(gain===null||gain<5))alerts.push({code:'TOKEN_BURN',msg:`最近窗口消耗${tailTokens}tokens但无独立可测进展`});
 const verdict=!rows.length||alerts.some(a=>a.code==='NO_NEW_FRAMES')?'idle':gain!==null&&gain>=5?'progressing':alerts.length?'stalled':'unclear';
 const last=readings.at(-1),same=[];
 for(let i=readings.length-1;i>=0&&readings[i].context===last?.context;i--)same.unshift(readings[i]);
 return {at:now,frames:rows.length,from:rows[0]?.at||null,to:rows.at(-1)?.at||null,
  performance:require('../../src/genshin/story-performance').performance(rows,receipts,now),
  decisionSources:{deepseekFrames:rows.filter(r=>r.provider==='deepseek').length,directFrames:rows.filter(r=>r.provider==='director').length},
  identityScope:o.nativeIds?'explicit_native_ids':o.trainingSessionId&&rows.every(r=>(r.trainingSessionId||r.request?.trainingSessionId)===o.trainingSessionId)?'training_session_id':'time_window_and_observed_native_ids',
  tokens,tokensPerFrame:rows.length?Math.round(tokens/rows.length):0,tokensPerFrameMedian:median(costs.filter(c=>c.complete).map(c=>c.total)),tokenFramesIncomplete:costs.filter(c=>!c.complete).length,
  scenes,actions,executedActions,rejectedDecisions:rejected,nativeReceipts:receipts.length,movementMsSent:moved,movementTelemetryComplete:telemetryComplete,
  pathDurationMs,nativePathLegs,fInteractionsSent:fSent,
  distance:{first:same[0]?.meters??null,last:last?.meters??null,min:same.length?Math.min(...same.map(r=>r.meters)):null,readings:readings.length,
   task:last?.task??null,stage:last?.stage??null,source:'task_hud_ocr'},
  stages,recentWindow:{frames:tail.length,nonWorld:tailNonWorld,menuFrames:menuCount,maxRepeat,tokens:tailTokens,distanceGained:gain,
   comparableReadings:comparable.length,stages:[...new Set(tailReadings.map(r=>r.stage))]},
  travelQuest:travelEvaluation(rows,receipts),verdict,alerts,
  limitation:'只累计显式原生移动计数；PathExecutor按键时长未知，pathDurationMs仅墙钟耗时。HUD距离必须同任务阶段；宏内部progress单列，不代替独立后帧，也不证明任务完成。历史无trainingSessionId时仅按时间窗和已观察nativeId限定。'};
}
module.exports={evaluate,movedMs,hudReading,mergeReceipts,frameTokens};
if(require.main===module){
 const args=process.argv.slice(2),opt=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:null;};
 const session=readJson(path.join(base,'training-session.json')),windowMin=Number(opt('--minutes'))||null;
 const from=windowMin?Date.now()-windowMin*60000:(session?.startedAt||0);
 const report={sessionId:session?.sessionId||null,sessionState:session?.revoked?'stopped':session?.status||'unknown',
  ...evaluate(loadFrames(from),Date.now(),{sessionStartedAt:from,trainingSessionId:session?.sessionId,
   receiptLedger:readJson(path.join(base,'story-feedback-memory.json')),recent:Number(opt('--recent'))||12})};
 fs.writeFileSync(path.join(base,'progress-evaluation.json'),JSON.stringify(report,null,2));
 const d=report.distance;
 console.log(`[${report.verdict}] 会话${report.sessionState} 帧${report.frames} token${report.tokens} 已报告移动${report.movementMsSent}ms${report.movementTelemetryComplete?'':'（遥测不完整）'} Path调用${report.pathDurationMs}ms/${report.nativePathLegs}段 F${report.fInteractionsSent} HUD距离${d.first??'-'}→${d.last??'-'}m token中位数${report.tokensPerFrameMedian??'未知'} P0:${report.travelQuest.passed?'通过':'未通过'}`);
 for(const a of report.alerts)console.log(`  ! ${a.code}: ${a.msg}`);
}
