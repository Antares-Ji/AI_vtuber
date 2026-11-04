'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {StoryLookahead,contractFor,verify,projectedContext}=require('../src/genshin/story-lookahead');
const workers=require('../src/genshin/story-workers');
const {validateDecision}=require('../src/genshin/story-runtime');
const {frameTokens}=require('../scripts/genshin/progress-evaluator.cjs');
const position=require('../scripts/genshin/story/vision/post-action-position');
const clone=v=>JSON.parse(JSON.stringify(v));
function fixture(){
 const now=Date.now(),texts=[{text:'前去查看详情',box:[75,246,153,33]},{text:'100m',box:[80,280,70,25]}];
 const request={id:'native-a',seq:1,capturedAt:now-1000,deadlineAt:now+10000,focusQuest:'紧急修理',texts};
 const observation={scene:'world',uncertain:false,interaction:{state:'none',candidates:[]},navigation:{terrain:'open',movement:'standing',marker:'center'}};
 const decision={action:{kind:'move',key:'W',ms:400},reason:'短移',quest:request.focusQuest};
 const prediction={distance:98,tolerance:1};
 const context={goal:'保持当前任务',observation,questMemory:{quest:request.focusQuest},texts,distanceEvidence:{meters:[100]},mapAreas:[],waypoints:[],navigationMemory:{stage:'前去查看详情',teleportAttempts:[]}};
 const after={...clone(request),seq:2,capturedAt:now,texts:[texts[0],{...texts[1],text:'98m'}],
  lastStep:{seq:1,action:decision.action,finishedAt:now-200,detail:JSON.stringify({movedMs:400,stopReason:'duration_complete'}),focus:{after:true}}};
 const entry={nativeId:request.id,seq:1,action:decision.action,createdAt:now-500};
 const validate=(v,r,o)=>validateDecision(workers.normalize(v,r),r,o);
 return {now,request,observation,decision,prediction,context,after,entry,validate};
}
test('distance forecast is narrow, grounded in the current action, and never inferred without a prediction',()=>{
 const f=fixture();assert.equal(contractFor(f).distance,98);
 for(const prediction of [null,{distance:0,tolerance:1},{distance:98,tolerance:99},{distance:NaN,tolerance:1}])assert.equal(contractFor({...f,prediction}),null);
 assert.equal(contractFor({...f,observation:{...f.observation,navigation:{terrain:'water'}}}),null);
});
test('matching fresh next-frame HUD, task, terrain and full movement receipt authorizes reuse',()=>{
 const f=fixture();assert.equal(verify(contractFor(f),f.entry,f.after,f.observation,f.now).ok,true);
});
test('wrong position/state/task, failed input and stale or unrelated receipts all discard the plan',()=>{
 const f=fixture(),c=contractFor(f);
 const cases=[
  [r=>{r.id='another'},'receipt_identity_mismatch'],
  [r=>{r.seq=3},'receipt_identity_mismatch'],
  [r=>{r.lastStep.action={kind:'wait'}},'receipt_identity_mismatch'],
  [r=>{r.capturedAt=r.lastStep.finishedAt-1},'stale_prediction_or_frame'],
  [r=>{r.lastStep.focus.after=false},'action_failed'],
  [r=>{r.lastStep.detail='{"movedMs":0}'},'move_incomplete'],
  [r=>{r.focusQuest='其他任务'},'task_or_stage_changed'],
  [r=>{r.texts[0].text='寻找新的目标'},'task_or_stage_changed'],
  [r=>{r.texts[1].text='120m'},'distance_mismatch']
 ];
 for(const [change,reason] of cases){const r=clone(f.after);change(r);assert.equal(verify(c,f.entry,r,f.observation,f.now).reason,reason);}
 for(const observation of [{...f.observation,scene:'dialogue'},{...f.observation,uncertain:true},{...f.observation,interaction:{state:'unique'}}])
  assert.equal(verify(c,f.entry,f.after,observation,f.now).ok,false);
 assert.equal(verify(c,f.entry,f.after,{...f.observation,navigation:{...f.observation.navigation,terrain:'wall'}},f.now).reason,'navigation_state_changed');
});
test('teleport return alone cannot validate arrival; two fresh stable CV positions near catalog point are required',()=>{
 const f=fixture();f.decision.action={kind:'teleport',id:'61',x:20,y:30};f.entry.action=f.decision.action;f.after.lastStep.action=f.decision.action;
 const c=contractFor(f);assert.equal(c.kind,'position');
 assert.equal(verify(c,f.entry,f.after,f.observation,f.now).reason,'position_unverified');
 f.after.position={source:'bettergi_minimap_cv',stable:true,samples:[{x:21,y:29,at:f.now-300},{x:21,y:29,at:f.now-100}]};
 assert.equal(verify(c,f.entry,f.after,f.observation,f.now).ok,true);
 f.after.position.samples.forEach(p=>p.x=200);assert.equal(verify(c,f.entry,f.after,f.observation,f.now).reason,'position_mismatch');
 f.after.position.samples[0].x=21;assert.equal(verify(c,f.entry,f.after,f.observation,f.now).reason,'position_unstable');
 f.after.position.samples.forEach(p=>{p.x=21;p.at=f.now-10000;});assert.equal(verify(c,f.entry,f.after,f.observation,f.now).reason,'position_stale');
});
test('projected context removes old OCR and interactions and labels estimated distance as prediction',()=>{
 const f=fixture();f.context.observation.interaction={state:'unique',candidates:[{text:'旧NPC'}]};
 const next=projectedContext(f.context,{kind:'distance',quest:'紧急修理',stage:'前去查看详情',distance:98},f.decision.action);
 assert.deepEqual(next.texts,[]);assert.deepEqual(next.observation.interaction.candidates,[]);
 assert.equal(next.distanceEvidence.status,'prediction_not_observation');assert.equal(next.observation.travelQuest.hypothetical,true);
 assert.equal(f.context.texts.length,2);
});
test('planning starts before the action receipt arrives, and a ready candidate still passes the fresh validator once',async()=>{
 const f=fixture(),abort=new AbortController(),records=[],charged=[];let started=false;
 const queue=new StoryLookahead({signal:abort.signal,onEvidence:r=>records.push(r)});
 queue.start({...f,plan:async(context,forecast)=>{started=true;assert.equal(forecast.parent.seq,1);return {text:'{"action":{"kind":"move","key":"W","ms":400}}',provider:'deepseek',model:'test',usage:{total_tokens:100}};},onResult:a=>charged.push(a)});
 assert.equal(f.request.lastStep,undefined);await queue.pending.done;assert.equal(started,true);
 const cached=queue.consume({request:f.after,observation:f.observation,validate:f.validate});
 assert.equal(cached.decision.action.kind,'move');assert.equal(cached.answer.usage,null);assert.deepEqual(cached.calls,[]);
 assert.equal(charged.length,1);assert.equal(records.length,1);assert.equal(queue.consume({request:f.after,observation:f.observation,validate:f.validate}),null);
 await queue.close();
});
test('mismatched forecast and a current validator rejection both force fresh planning',async()=>{
 for(const mode of ['mismatch','validator']){
  const f=fixture(),queue=new StoryLookahead();queue.start({...f,plan:async()=>({text:'{"action":{"kind":"move","key":"W","ms":400}}'})});await queue.pending.done;
  if(mode==='mismatch')f.after.texts[1].text='111m';
  assert.equal(queue.consume({request:f.after,observation:f.observation,validate:mode==='validator'?()=>{throw Error('new F');}:f.validate}),null);
  assert.equal(queue.lastCheck.reason,mode==='mismatch'?'distance_mismatch':'current_frame_validation_failed');await queue.close();
 }
});
test('unfinished speculation is aborted immediately instead of delaying the next foreground decision',async()=>{
 const f=fixture(),queue=new StoryLookahead();let aborted=false;
 queue.start({...f,plan:(c,p,signal)=>new Promise((resolve,reject)=>signal.addEventListener('abort',()=>{aborted=true;reject(signal.reason);},{once:true}))});
 await Promise.resolve();assert.equal(queue.consume({request:f.after,observation:f.observation,validate:f.validate}),null);
 assert.equal(queue.lastCheck.reason,'prefetch_not_ready');await queue.close();assert.equal(aborted,true);
});
test('late responses from replaced work never authorize input, while their token usage remains recorded',async()=>{
 const f=fixture(),queue=new StoryLookahead();let release,charged=0;
 queue.start({...f,plan:()=>new Promise(resolve=>{release=resolve;}),onResult:()=>charged++});await Promise.resolve();queue.discard('task_changed');
 release({text:'{"action":{"kind":"move","key":"W","ms":400}}',usage:{total_tokens:60}});await queue.close();
 assert.equal(charged,1);assert.equal(queue.pending,null);
});
test('parent cancellation and malformed speculative output cannot leave runnable work',async()=>{
 const f=fixture(),abort=new AbortController(),queue=new StoryLookahead({signal:abort.signal});
 queue.start({...f,plan:async()=>({text:'broken'})});await queue.pending.done;
 assert.equal(queue.consume({request:f.after,observation:f.observation,validate:f.validate}),null);assert.equal(queue.lastCheck.reason,'invalid_json');
 queue.start({...f,plan:async()=>({text:'{"action":{"kind":"wait"}}'})});await queue.pending.done;abort.abort();
 assert.equal(queue.consume({request:f.after,observation:f.observation,validate:f.validate}),null);await queue.close();
});
test('prefetch usage is charged on its origin even on rejection, and reuse costs zero new tokens',()=>{
 assert.equal(frameTokens({modelCalls:[{usage:{total_tokens:100}},{phase:'lookahead',usage:{total_tokens:80}}]}).total,180);
 assert.deepEqual(frameTokens({modelCalls:[],usage:null,pipeline:{lookahead:{ok:true}}}),{total:0,complete:true});
});
test('a speculative wait cannot stall a matching frame, and cancelled billing stays explicitly unknown',async()=>{
 const f=fixture(),queue=new StoryLookahead(),charges=[];
 queue.start({...f,plan:async()=>({text:'{"action":{"kind":"wait"}}',usage:{total_tokens:20}})});await queue.pending.done;
 assert.equal(queue.consume({request:f.after,observation:f.observation,validate:f.validate}),null);assert.equal(queue.lastCheck.reason,'non_actionable_prediction');
 queue.start({...f,plan:async()=>{throw Object.assign(Error('request aborted'),{name:'AbortError'});},onResult:answer=>charges.push(answer)});await queue.pending.done;
 assert.equal(charges.length,1);assert.equal(charges[0].usage,null);assert.equal(frameTokens({modelCalls:charges}).complete,false);await queue.close();
});
test('post-transition CV uses two uncached samples; ordinary actions never invoke position API',async()=>{
 let calls=0,now=100;
 const deps={lastStep:{action:{kind:'move'}},genshin:{getPositionFromMap:(map,cache)=>{calls++;assert.equal(map,'Teyvat');assert.equal(cache,0);return {X:10,Y:20};}},sleep:async ms=>{now+=ms;},now:()=>now,deadline:10000};
 assert.equal(await position.sample(deps),null);assert.equal(calls,0);
 const result=await position.sample({...deps,lastStep:{action:{kind:'teleport'}}});assert.equal(result.stable,true);assert.equal(calls,2);assert.equal(result.samples.length,2);
 for(const lastStep of [{action:{kind:'native_unstuck'},detail:JSON.stringify({kind:'bgi-native-unstuck',durationMs:2700})},{action:{kind:'key',key:'F'},detail:JSON.stringify({kind:'interaction',target:'上行',sent:true,outcome:'prompt_changed_or_missing'})}])assert.equal((await position.sample({...deps,lastStep})).stable,true);
 for(const target of ['坐下','克鲁切'])assert.equal(await position.sample({...deps,lastStep:{action:{kind:'key',key:'F'},detail:JSON.stringify({kind:'interaction',target,sent:true,outcome:'prompt_changed_or_missing'})}}),null);
 const failed=await position.sample({...deps,lastStep:{action:{kind:'teleport'}},genshin:{getPositionFromMap:()=>{throw Error('not in world');}}});assert.equal(failed.stable,false);
});
