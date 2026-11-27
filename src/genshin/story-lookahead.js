'use strict';
const grounding=require('../../scripts/genshin/story-main');
const clone=v=>JSON.parse(JSON.stringify(v));
const normal=v=>String(v||'').replace(/\s/g,'');
const finite=Number.isFinite;
function contractFor({decision,prediction,request,observation}){
 const a=decision.action,hud=grounding.questHud(request.texts);
 if(!request.focusQuest||!hud||observation.uncertain)return null;
 const common={scene:'world',quest:request.focusQuest,stage:hud.stage,maxAgeMs:120000};
 if(a.kind==='teleport'&&finite(a.x)&&finite(a.y))
  return {...common,kind:'position',target:{x:a.x,y:a.y},radius:12};
 const nativeWorld=observation.nativeVision?.source==='bettergi_native_cv'&&observation.nativeVision.ui==='Main'&&observation.nativeVision.motion==='Normal';
 if(!['move','advance_quest','travel_quest','navigate'].includes(a.kind)||observation.scene!=='world'||
    !(observation.navigation?.terrain==='open'||nativeWorld)||observation.interaction?.state==='unique')return null;
 if(!prediction||!finite(prediction.distance)||!finite(prediction.tolerance)||
    prediction.tolerance<1||prediction.tolerance>3||prediction.distance<0)return null;
 const maxDelta=['move','navigate'].includes(a.kind)?Math.max(4,a.ms/1000*12):a.kind==='advance_quest'?40:360;
 if(Math.abs(prediction.distance-hud.meters)>maxDelta)return null;
 return {...common,kind:'distance',distance:prediction.distance,tolerance:prediction.tolerance,
  terrain:observation.navigation.terrain,movement:observation.navigation.movement,
  marker:observation.navigation.marker,nativeMotion:nativeWorld?'Normal':null};
}
function verify(contract,entry,request,observation,now=Date.now()){
 const no=reason=>({ok:false,reason});
 if(!contract)return no('no_verifiable_prediction');
 const previous=request.lastStep;
 if(request.id!==entry.nativeId||request.seq!==entry.seq+1||previous?.seq!==entry.seq||
    JSON.stringify(previous.action)!==JSON.stringify(entry.action))return no('receipt_identity_mismatch');
 if(!finite(request.capturedAt)||!finite(previous.finishedAt)||request.capturedAt<previous.finishedAt||
    now-request.capturedAt>30000||now-entry.createdAt>contract.maxAgeMs)return no('stale_prediction_or_frame');
 if(previous.focus?.after===false||previous.focus?.errorCode||previous.error)return no('action_failed');
 let detail;try{detail=typeof previous.detail==='string'?JSON.parse(previous.detail):previous.detail;}catch{}
 if(entry.action.kind==='move'&&detail?.movedMs!==entry.action.ms)return no('move_incomplete');
 if(['advance_quest','travel_quest','navigate'].includes(entry.action.kind)&&
    (!detail||/unavailable|unverified|unstable|missing|error|limit|deadline|increase|stall|no_progress|cancel|lost/i.test(detail.stopReason||'')))return no('macro_not_verified');
 if(observation.uncertain||observation.scene!==contract.scene||
    observation.interaction?.state==='unique'||grounding.movementStop(request.texts))return no('scene_or_interaction_changed');
 const hud=grounding.questHud(request.texts);
 if(normal(request.focusQuest)!==normal(contract.quest)||!hud||normal(hud.stage)!==normal(contract.stage))return no('task_or_stage_changed');
 if(contract.kind==='position'){
  const p=request.position;
  if(!p||p.source!=='bettergi_minimap_cv'||p.stable!==true||!Array.isArray(p.samples)||p.samples.length!==2)
   return no('position_unverified');
  if(p.samples.some(s=>!finite(s.x)||!finite(s.y)||!finite(s.at)||Math.abs(request.capturedAt-s.at)>5000))return no('position_stale');
  if(Math.hypot(p.samples[0].x-p.samples[1].x,p.samples[0].y-p.samples[1].y)>10)return no('position_unstable');
  if(p.samples.some(s=>Math.hypot(s.x-contract.target.x,s.y-contract.target.y)>contract.radius))return no('position_mismatch');
 }else{
  if(contract.nativeMotion&&(observation.nativeVision?.ui!=='Main'||observation.nativeVision.motion!==contract.nativeMotion||observation.nativeVision.source!=='bettergi_native_cv'))return no('native_motion_changed');
  if(Math.abs(hud.meters-contract.distance)>contract.tolerance)return no('distance_mismatch');
  if(observation.navigation?.terrain!==contract.terrain||observation.navigation?.movement!==contract.movement||
     observation.navigation?.marker!==contract.marker)return no('navigation_state_changed');
 }
 return {ok:true,reason:'fresh_observation_matches_prediction'};
}
function projectedContext(context,contract,action){
 // Never retain old OCR/interaction targets as if observed at the destination.
 const next=clone(context);
 next.texts=[];next.previousSteps=[];next.lastNativeStep=null;
 next.observation={scene:'world',uncertain:false,taskFocus:{quest:contract.quest},
  interaction:{state:'none',candidates:[]},navigation:contract.kind==='distance'?clone(context.observation.navigation):{terrain:'unknown',movement:'unknown',marker:'not_visible'},
  travelQuest:{ok:true,hypothetical:true,requiresFreshValidation:true}};
 next.distanceEvidence={meters:contract.kind==='distance'?[contract.distance]:[],status:'prediction_not_observation'};
 next.navigationMemory={stage:contract.stage,teleportAttempts:[...(context.navigationMemory?.teleportAttempts||[]),...(action.kind==='teleport'?[action.id]:[])]};
 return next;
}
class StoryLookahead{
 constructor({signal,onEvidence=()=>{},clock=Date.now}={}){
  this.signal=signal;this.onEvidence=onEvidence;this.clock=clock;this.pending=null;this.lastCheck=null;this.tasks=new Set();
 }
 start({decision,prediction,request,observation,context,plan,onResult=()=>{}}){
  this.discard('replaced');
  const contract=contractFor({decision,prediction,request,observation});
  if(!contract||this.signal?.aborted)return false;
  const controller=new AbortController();
  const signal=this.signal?AbortSignal.any([this.signal,controller.signal,AbortSignal.timeout(25000)]):AbortSignal.any([controller.signal,AbortSignal.timeout(25000)]);
  const entry={nativeId:request.id,seq:request.seq,createdAt:this.clock(),action:clone(decision.action),contract,controller,settled:false};
  this.pending=entry;
  const forecast={basis:'hypothetical_post_action',parent:{nativeId:entry.nativeId,seq:entry.seq,action:entry.action},expected:contract};
  entry.done=Promise.resolve().then(()=>{signal.throwIfAborted();entry.called=true;return plan(projectedContext(context,contract,decision.action),forecast,signal);})
   .then(answer=>{entry.answer=answer;try{entry.value=JSON.parse(answer.text);}catch{entry.error='invalid_json';}})
   .catch(error=>{entry.error=error.code||error.name||'prefetch_failed';entry.answer={provider:error.provider||'deepseek',worker:'movement',model:error.model||null,usage:error.usage||null,error:entry.error};})
   .finally(()=>{entry.settled=true;if(entry.called)onResult(entry.answer);this.onEvidence({nativeId:entry.nativeId,seq:entry.seq,createdAt:entry.createdAt,finishedAt:this.clock(),
     forecast,provider:entry.answer?.provider,model:entry.answer?.model,usage:entry.answer?.usage||null,error:entry.error||null,disposition:entry.disposition||'ready'});});
  this.tasks.add(entry.done);
  entry.done.then(()=>this.tasks.delete(entry.done),()=>this.tasks.delete(entry.done));
  return true;
 }
 consume({request,observation,validate}){
  const entry=this.pending;this.pending=null;
  if(!entry){this.lastCheck={ok:false,reason:'no_prefetch'};return null;}
  const fail=reason=>{entry.disposition=reason;entry.controller.abort();this.lastCheck={ok:false,reason};return null;};
  if(this.signal?.aborted)return fail('cancelled');
  if(!entry.settled)return fail('prefetch_not_ready'); // Never wait for speculation.
  if(entry.error||!entry.value)return fail(entry.error||'prefetch_invalid');
  const check=verify(entry.contract,entry,request,observation,this.clock());
  if(!check.ok)return fail(check.reason);
  try{
   // New frame validation resolves targets again and applies current feedback.
   const decision=validate(entry.value,request,observation);
   if(!['move','turn','reset_camera','travel_quest','advance_quest','follow_marker'].includes(decision.action.kind))return fail('non_actionable_prediction');
   entry.disposition='consumed';this.lastCheck=check;
   return {decision,answer:{...entry.answer,usage:null},rejected:[],calls:[],
    prediction:entry.value.prediction,lookahead:{...check,parentSeq:entry.seq,chargedToSeq:entry.seq}};
  }catch{return fail('current_frame_validation_failed');}
 }
 discard(reason='cancelled'){
  const entry=this.pending;if(!entry)return;
  this.pending=null;entry.disposition=reason;entry.controller.abort();
 }
 async close(){this.discard('session_finished');await Promise.allSettled([...this.tasks]);}
}
module.exports={StoryLookahead,contractFor,verify,projectedContext};
