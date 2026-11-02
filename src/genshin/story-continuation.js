'use strict';
const {randomUUID}=require('node:crypto');
function transientFailure(run){
 if(run?.state!=='FAILED'||!run.finishedAt)return false;
 const error=String(run.error||'');
 if(/402|401|403|余额|权限|permission|unauthori[sz]ed|forbidden|PROVIDER_INSUFFICIENT_BALANCE|PROVIDER_AUTH|model.stop|模型.*停/i.test(error))return false;
 return /STORY_FRAME_TIMEOUT|VISION_READ_FAILED|ECONNRESET|ECONNREFUSED|ETIMEDOUT|fetch failed|socket hang up|TimeoutError|aborted due to timeout|DeepSeek HTTP (502|503|504)|剧情本地视觉读取失败/i.test(error);
}
const revokedReasons=new Set(['user_stop','replaced_goal','disconnected','provider_changed']);
class StoryContinuation {
 constructor({host,ready,cleanup=async()=>false,evidence=()=>null,store=null,onStarted=()=>{},clock=Date.now,timer=true}){
  Object.assign(this,{host,ready,cleanup,evidence,store,onStarted,clock});this.state={active:false,reason:'not_started'};this.revision=0;this.checking=false;
  const saved=store?.read();
  if(saved){this.goal=saved.goal;this.state={...saved,active:false};if(saved.active&&!saved.revoked)this.state=store.update(saved,{active:false,status:'awaiting_resume',reason:'restart_resume_required'});}
  if(timer){this.timer=setInterval(()=>{void this.tick();},1000);this.timer.unref();}
 }
 persist(patch){
  if(this.store&&this.state.sessionId)this.state=this.store.update(this.state,patch);
  else this.state={...this.state,...patch,revision:(this.state.revision||0)+1};
  return this.snapshot();
 }
 current(token){
  if(token!==this.revision)return false;
  if(!this.store||!this.state.sessionId)return true;
  const saved=this.store.read();
  if(saved?.sessionId===this.state.sessionId&&saved.revision===this.state.revision)return true;
  this.revision++;this.state={...(saved||this.state),active:false};return false;
 }
 begin(goal,run,{enabled=true,durationMs=7200000,mode='bounded'}={}){
  if(!['bounded','until_stopped'].includes(mode))throw Error('Unknown story continuation mode');
  if(typeof goal!=='string'||!goal.trim()||!run?.id)throw Error('Training goal and initial run are required');
  if(mode==='bounded'&&(!Number.isInteger(durationMs)||durationMs<1))throw Error('Invalid continuation duration');
  this.revision++;this.goal=goal;
  const startedAt=this.clock();
  const value={active:enabled,status:enabled?'running':'paused',goal,mode,runId:run.id,segments:1,recoveryAttempts:0,revoked:false,startedAt,until:mode==='until_stopped'?null:startedAt+durationMs,reason:enabled?'running':'single_segment'};
  this.state=this.store?this.store.create(value):{...value,sessionId:randomUUID(),revision:(this.state.revision||0)+1};return this.snapshot();
 }
 stop(reason='user_stop'){
  this.revision++;
  const patch={active:false,status:revokedReasons.has(reason)?'stopped':'halted',reason,revoked:this.state.revoked===true||revokedReasons.has(reason),stoppedAt:!this.state.active&&Number.isFinite(this.state.stoppedAt)?this.state.stoppedAt:this.clock()};
  try{return this.persist(patch);}catch(error){
   if(error.code==='TRAINING_SESSION_CONFLICT'&&revokedReasons.has(reason)){
    const saved=this.store?.read();
    if(saved?.sessionId===this.state.sessionId){
     this.state=saved;
     try{return this.persist(patch);}catch(retryError){error=retryError;}
    }
   }
   // Never let a checkpoint I/O error prevent the caller from stopping the
   // actual host run. Surface the persistence failure and fail locally closed.
   this.state={...this.state,...patch,persistenceError:String(error.message).slice(0,200)};return this.snapshot();
  }
 }
 snapshot(){return {...this.state};}
 checkProgress(progress){
  if(!progress?.stage||!Number.isFinite(progress.at))return false;
  const old=this.state.progressBudget;
  if(old&&progress.at<=old.lastAt)return false;
  const distance=Number.isFinite(progress.distance)?progress.distance:null;
  const improved=old&&distance!==null&&old.distance!==null&&distance<=old.distance-5;
  const reset=!old||old.stage!==progress.stage||improved;
  const next=reset?{stage:progress.stage,since:progress.at,distance,lastAt:progress.at}:{...old,lastAt:progress.at};
  this.persist({progressBudget:next});
  return progress.at-next.since>=15*60000;
 }
 recordNative(nativeId){
  if(this.state.revoked||!this.state.sessionId||this.state.nativeId===nativeId)return this.snapshot();
  if(typeof nativeId!=='string'||!/^[0-9a-f-]{36}$/i.test(nativeId))throw Error('Invalid native training job ID');
  return this.persist({nativeId});
 }
 startSegment(){
  const next=this.host.start({skill:'genshin:story',allowLive:true,args:{goal:this.goal},timeoutMs:740000});
  try{this.persist({runId:next.id,nativeId:null,segments:this.state.segments+1,reason:'running',continuedAt:this.clock()});this.onStarted(next,this.goal);return next;}
  catch(error){this.host.stop?.(next.id,'TRAINING_CHECKPOINT_FAILED');throw error;}
 }
 dispose(){clearInterval(this.timer);if(this.state.active)this.stop('host_disposed');else this.revision++;}
 async resume({sessionId,revision}){
  if(this.checking)throw Error('Training state check is already in progress');
  const saved=this.store?.read()||this.state;
  if(saved.sessionId!==sessionId||saved.revision!==revision)throw Object.assign(Error('Genshin training session changed; reload its state'),{code:'TRAINING_SESSION_CONFLICT'});
  if(saved.revoked)throw Error('Training session was stopped; start a new explicit session');
  if(saved.active||this.host.closing)throw Error('Training session is active or host is closing');
  if(saved.mode==='bounded'&&this.clock()>=saved.until)throw Error('Training continuation window ended; start a new session');
  const previous=this.host.status(saved.runId);
  if(previous&&['RUNNING','STOPPING'].includes(previous.state))throw Error('Previous training segment has not finished');
  this.state={...saved};this.goal=saved.goal;this.revision++;const token=this.revision;this.checking=true;
  try{
   if(!await this.cleanup(previous,saved)||!await this.ready())throw Error('Training resume requires confirmed input cleanup and idle vision');
   if(!this.current(token)||this.state.revoked||this.host.closing)throw Error('Training resume was revoked while checking readiness');
   // Reserve ownership before starting input. A newer persisted stop wins.
   const pausedMs=Number.isFinite(saved.stoppedAt)?Math.max(0,this.clock()-saved.stoppedAt):0;
   this.persist({active:true,status:'running',reason:'resuming',resumedAt:this.clock(),...(saved.progressBudget?{progressBudget:{...saved.progressBudget,since:saved.progressBudget.since+pausedMs}}:{})});
   return this.startSegment();
  }catch(error){if(this.current(token)&&this.state.active)this.stop('resume_failed');throw error;}
  finally{this.checking=false;}
 }
 async tick(){
  if(this.checking||!this.state.active)return;
  this.checking=true;const token=this.revision;
  try{
   if(!this.current(token))return;
   if(this.host.closing)return this.stop('host_closing');
   if(this.state.mode!=='until_stopped'&&this.clock()>=this.state.until)return this.stop('continuation_window_ended');
   const run=this.host.status(this.state.runId);
   if(!run)return this.stop('run_missing');
   const observed=this.evidence(run)||{};
   if(observed.nativeId&&observed.nativeId!==this.state.nativeId)this.recordNative(observed.nativeId);
   if(this.checkProgress(observed.progress)){
    this.stop('stage_no_progress_budget');
    if(['RUNNING','STOPPING'].includes(run.state))this.host.stop?.(run.id,'stage_no_progress_budget');
    return;
   }
   if(['RUNNING','STOPPING'].includes(run.state))return;
   const execution=run.result?.execution,receipt=execution?.receipt,recovery=transientFailure({...run,error:String(run.error||'')+' '+String(observed.errorCode||'')});
   if(recovery){
    if(this.state.recoveryAttempts>=1)return this.stop('transient_recovery_exhausted');
    const cleaned=await this.cleanup(run,this.snapshot());
    if(!this.current(token)||!this.state.active)return;
    if(!cleaned)return this.stop('cleanup_unconfirmed');
   }else{
    if(!['UNVERIFIED','VERIFIED'].includes(run.state)||!run.finishedAt)return this.stop('segment_failed_or_interrupted');
    if(execution?.state!=='returned'||receipt?.state!=='returned'||!['segment_budget','step_limit'].includes(receipt.endReason))return this.stop(receipt?.endReason==='model_stop'?'model_stop':'not_a_segment_boundary');
    if(execution.inputReleased!==true||execution.processStopped!==true)return this.stop('cleanup_unconfirmed');
   }
   this.persist({reason:'checking_idle'});
   let idle=false;
   try{idle=await this.ready();}catch(error){
    if(!this.current(token)||!this.state.active)return;
    if(this.state.recoveryAttempts>=1)return this.stop('transient_recovery_exhausted');
    this.persist({reason:'waiting_for_idle_health',recoveryAttempts:this.state.recoveryAttempts+1});return;
   }
   if(!this.current(token)||!this.state.active||this.host.closing)return;
   if(!idle)return;
   this.persist({reason:recovery?'recovering_transient':'starting_segment',recoveryAttempts:this.state.recoveryAttempts+(recovery?1:0)});
   this.startSegment();
  }catch(error){
   if(error.code==='TRAINING_SESSION_CONFLICT'){this.revision++;this.state={...(this.store?.read()||this.state),active:false};}
   else if(this.current(token))this.stop('continuation_error: '+String(error.message).slice(0,180));
  }finally{this.checking=false;}
 }
}
module.exports={StoryContinuation,transientFailure};
