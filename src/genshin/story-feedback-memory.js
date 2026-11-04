'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const grounding=require('../../scripts/genshin/story-main');
const {compatibleStage}=require('./story-memory');
const MAX_RECENT_STEPS=16;
const normal=value=>String(value||'').replace(/\s/g,'');
const stageKey=value=>normal(value).replace(/[「」『』“”‘’"']/g,'');
const clone=value=>JSON.parse(JSON.stringify(value));
function parseDetail(step){try{return JSON.parse(step.detail);}catch{return null;}}
function mapPositionFailures(steps){
 let failures=0;
 for(const s of steps){const d=parseDetail(s);if(!d)continue;
  if(['position_unavailable','position_unstable'].includes(d.stopReason))failures++;
  else if(d.kind==='commission-route'&&d.stopReason==='route_complete'&&Number.isFinite(d.after?.x)&&Number.isFinite(d.after?.y))failures=0;
  else if(d.kind==='continuous-navigation'&&d.movementMsSent>0&&['duration_budget','near_distance'].includes(d.stopReason))failures=0;
 }
 return failures;
}
function interactionTargets(steps){return [...new Set(steps.map(parseDetail).filter(d=>d?.kind==='interaction'&&typeof d.target==='string').map(d=>normal(d.target)).filter(Boolean))];}
// Preserve both the zero/one/two failure state and the blocking state. Testing
// a hypothetical second receipt is a pure predicate probe, never an input or a
// receipt persisted to the evidence ledger.
function signature(steps,targets=interactionTargets(steps)){
 const interactions=targets.flatMap(target=>{
  const blocked=grounding.interactionBlocked(steps,target);
  const probe={action:{kind:'key',key:'F',text:target},detail:JSON.stringify({kind:'interaction',target,sent:true,outcome:'prompt_unchanged'})};
  const count=blocked?2:grounding.interactionBlocked([...steps,probe],target)?1:0;
  return count?[[target,count]]:[];
 }).sort((a,b)=>a[0].localeCompare(b[0]));
 return JSON.stringify({follow:Math.min(2,grounding.navigationFeedback(steps).failedFollows),
  travel:Math.min(2,grounding.travelFeedback(steps).failedTravels),seek:grounding.seekFeedback(steps).exhausted,interactions});
}
function compactSteps(steps){
 let recent=[];
 for(const step of steps){
  recent.push(step);
  const targets=interactionTargets(recent),wanted=signature(recent,targets);
  for(let i=0;i<recent.length;){
   const without=recent.filter((_,index)=>index!==i);
   if(signature(without,targets)===wanted)recent=without;else i++;
  }
  // With the shared grounding FSM, navigation, travel and interaction failure
  // witnesses survive. Refuse an incompatible rule change rather than silently
  // dropping old failures at an arbitrary history boundary.
  if(recent.length>MAX_RECENT_STEPS)throw Error('Story feedback cannot be compacted without losing retry state');
 }
 return clone(recent);
}
function identity(quest,stage){return createHash('sha256').update(JSON.stringify([normal(quest),normal(stage)])).digest('hex');}
function validQuest(quest){if(typeof quest!=='string'||!normal(quest)||quest.length>500)throw Error('Feedback memory requires an explicit stable quest identity');return quest.trim();}
function validStage(stage){if(stage===undefined||stage===null||stage==='')return null;if(typeof stage!=='string'||stage.length>500)throw Error('Invalid feedback stage');return stage.trim()||null;}
function cleanStep(step){
 if(!step||!Number.isInteger(step.seq)||step.seq<1||step.seq>100000||typeof step.action?.kind!=='string')throw Error('Invalid native feedback receipt');
 if(typeof step.detail!=='string'||step.detail.length>100000)throw Error('Invalid native feedback detail');
 return {seq:step.seq,action:clone(step.action),detail:step.detail,finishedAt:Number.isFinite(step.finishedAt)?step.finishedAt:null,verified:false};
}
class StoryFeedbackMemory{
 constructor({root,quest,stage=null,file}={}){
  if(!root&&!file)throw Error('Feedback memory requires a root or file');
  this.file=file||path.join(root,'runtime/genshin/story-feedback-memory.json');
  this.quest=validQuest(quest);this.stage=validStage(stage);this.contextId=null;
  this._load();this._select(this.quest,this.stage);this._save();
 }
 _load(){
  if(!fs.existsSync(this.file)){this.data={version:1,contexts:[],sessions:[],events:[]};return;}
  let data;try{data=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{throw Error('Story feedback memory is unreadable; refusing to reset retry state');}
  if(data?.version!==1||!Array.isArray(data.contexts)||!Array.isArray(data.sessions)||!Array.isArray(data.events))throw Error('Unsupported story feedback memory');
  this.data=data;
 }
 _save(){
  fs.mkdirSync(path.dirname(this.file),{recursive:true});
  const temp=this.file+'.'+process.pid+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temp,JSON.stringify(this.data,null,2),'utf8');fs.renameSync(temp,this.file);}
  finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
 }
 _select(quest,stage){
  const sameQuest=this.data.contexts.filter(c=>normal(c.quest)===normal(quest));
  let context=sameQuest.find(c=>stageKey(c.stage)===stageKey(stage));
  const compatible=stage?sameQuest.filter(c=>c.stage&&compatibleStage(c.stage,stage)):[];
  if(!context&&compatible.length===1)context=compatible[0];
  if(!context){context={id:identity(quest,stage),quest,stage,createdAt:Date.now()};this.data.contexts.push(context);}
  this.contextId=context.id;this.quest=context.quest;this.stage=context.stage;
  return context;
 }
 setContext({quest=this.quest,stage=this.stage,confirmedStageChange=false}={}){
  quest=validQuest(quest);stage=validStage(stage);this._load();
  const previous=this.data.contexts.find(c=>c.id===this.contextId);
  if(normal(quest)!==normal(this.quest)){this._select(quest,stage);this._save();return this.snapshot();}
  if(previous&&!previous.stage&&stage){
   // First usable stage names the existing unknown-stage bucket. Its native
   // receipts keep their identity, so a final receipt cannot count them twice.
   const existing=this.data.contexts.find(c=>c.id!==previous.id&&normal(c.quest)===normal(quest)&&normal(c.stage)===normal(stage));
   if(existing){for(const e of this.data.events)if(e.contextId===previous.id)e.contextId=existing.id;this.data.contexts=this.data.contexts.filter(c=>c.id!==previous.id);this.contextId=existing.id;this.stage=existing.stage;}
   else {
    const oldId=previous.id;previous.id=identity(quest,stage);previous.stage=stage;
    for(const e of this.data.events)if(e.contextId===oldId)e.contextId=previous.id;
    this.contextId=previous.id;this.stage=stage;
   }
  }else if(previous&&stage&&compatibleStage(previous.stage,stage)){
   if(stage.length>String(previous.stage).length){previous.stage=stage;this.stage=stage;}
  }else if(confirmedStageChange&&stage){this._select(quest,stage);}
  // Missing or unconfirmed OCR changes never clear existing retry state.
  this._save();return this.snapshot();
 }
 merge({sessionId,lastStep,steps=[]}={}){
  if(typeof sessionId!=='string'||!sessionId||sessionId.length>128)throw Error('Feedback requires the native story session id');
  if(!Array.isArray(steps))throw Error('Native receipt steps must be an array');
  const additions=[...steps,...(lastStep?[lastStep]:[])].map(cleanStep).sort((a,b)=>a.seq-b.seq);
  this._load();this._select(this.quest,this.stage);
  let session=this.data.sessions.find(s=>s.id===sessionId);
  if(!session){session={id:sessionId,order:this.data.sessions.length,seen:[]};this.data.sessions.push(session);}
  const seen=new Set(session.seen);let added=0;
  for(const step of additions){
   if(seen.has(step.seq))continue;
   seen.add(step.seq);this.data.events.push({sessionId,contextId:this.contextId,step});added++;
  }
  session.seen=[...seen].sort((a,b)=>a-b);
  this._save();return {...this.snapshot(),added};
 }
 snapshot(){
  const order=new Map(this.data.sessions.map(s=>[s.id,s.order]));
  // Older versions created separate buckets for OCR quote variants. Read all
  // exact canonical aliases without deleting or rewriting the native ledger.
  const contextIds=new Set(this.data.contexts.filter(c=>normal(c.quest)===normal(this.quest)&&stageKey(c.stage)===stageKey(this.stage)).map(c=>c.id));
  const events=this.data.events.filter(e=>contextIds.has(e.contextId)).sort((a,b)=>order.get(a.sessionId)-order.get(b.sessionId)||a.step.seq-b.step.seq);
  const steps=events.map(e=>e.step),recentNativeSteps=compactSteps(steps);
  const interactionVisits={};
  for(const d of steps.map(parseDetail))if(d?.kind==='interaction'&&d.sent===true&&normal(d.target))
   interactionVisits[normal(d.target)]=(interactionVisits[normal(d.target)]||0)+1;
  const refreshes=steps.filter(s=>s.action.kind==='key'&&s.action.key==='V'&&parseDetail(s)?.kind==='quest_tracking_refresh'&&parseDetail(s)?.inputSent===true);
  const menuOpens=steps.filter(s=>s.action.kind==='key'&&s.action.key==='J'&&Number.isFinite(s.finishedAt));
  const state=JSON.parse(signature(steps));
  const search=steps.map(parseDetail).filter(d=>d?.kind==='area-search'&&d.state?.version===1).at(-1);
  const commissionRouteStates={};for(const d of steps.map(parseDetail))if(d?.kind==='commission-route'&&d.state?.id){
   const previous=commissionRouteStates[d.state.id];
   if(d.state.id.startsWith('urgent-entry')&&d.stopReason==='route_complete')for(const key of Object.keys(commissionRouteStates))delete commissionRouteStates[key];
   const failures=d.state.failures??(['path_timeout','arrival_unverified'].includes(d.stopReason)?(previous?.cursor===d.state.cursor?previous.failures||0:0)+1:0);
   commissionRouteStates[d.state.id]={...d.state,failures};
  }
  return {quest:this.quest,stage:this.stage,contextId:this.contextId,recentNativeSteps,
   mapPositionFailures:mapPositionFailures(steps),
   nativeTrackingStalls:steps.map(parseDetail).filter(d=>d?.kind==='bgi-native-track'&&d.stopReason==='native_stalled_after_recovery').length,
   interactionVisits,
   trackingInputs:{source:'native_receipts_not_tracking_confirmation',refreshCount:refreshes.length,lastRefreshAt:refreshes.at(-1)?.finishedAt||null,menuOpenCount:menuOpens.length,lastMenuOpenAt:menuOpens.at(-1)?.finishedAt||null},
   areaSearchState:search?.state||null,
   commissionRouteStates,
   navigationFeedback:grounding.navigationFeedback(steps),travelFeedback:grounding.travelFeedback(steps),
   interactionFeedback:state.interactions.map(([target,attemptsLowerBound])=>({target,attemptsLowerBound,blocked:attemptsLowerBound>=2})),
   stats:{nativeReceipts:steps.length,
    followFailureReceipts:steps.filter(s=>s.action.kind==='follow_marker'&&grounding.navigationFeedback([s]).failedFollows>0).length,
    travelFailureReceipts:steps.filter(s=>s.action.kind==='travel_quest'&&grounding.travelFeedback([s]).failedTravels>0).length,
    unchangedInteractionReceipts:steps.filter(s=>{const d=parseDetail(s);return d?.kind==='interaction'&&d.sent===true&&d.outcome==='prompt_unchanged';}).length},
   verification:'native_receipts_not_game_success'};
 }
 clear({quest=this.quest,stage=this.stage,allStages=false}={}){
  quest=validQuest(quest);stage=validStage(stage);this._load();
  const ids=new Set(this.data.contexts.filter(c=>normal(c.quest)===normal(quest)&&(allStages||stageKey(c.stage)===stageKey(stage))).map(c=>c.id));
  this.data.events=this.data.events.filter(e=>!ids.has(e.contextId));
  // Keep session+seq tombstones: a delayed final receipt must not resurrect
  // explicitly cleared failures, or be attributed to a different quest.
  this._save();return this.snapshot();
 }
}
module.exports={StoryFeedbackMemory,compactSteps,MAX_RECENT_STEPS,mapPositionFailures};
