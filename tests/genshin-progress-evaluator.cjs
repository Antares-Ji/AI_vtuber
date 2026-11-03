'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {evaluate,movedMs,hudReading,frameTokens}=require('../scripts/genshin/progress-evaluator.cjs');
function step(seq,kind='travel_quest',extra={}){
 return {seq,action:{kind},finishedAt:seq*1000+500,detail:JSON.stringify(kind==='travel_quest'?{
  kind:'quest-travel',progress:{distanceBefore:500,distanceAfter:100,stageBefore:'前去查看详情',stageAfter:'前去查看详情'},
  legs:[{pathDurationMs:2000,durationMs:2000,returned:true}],movedLegs:1,
  movementMsSent:null,movementTelemetryComplete:false,stopReason:'leg_budget',...extra}:extra)};
}
function frame(seq,meters=500,{id='native-a',task='任务甲',stage='前去查看详情',scene='world',lastStep=null,trainingSessionId='training-a'}={}){
 return {at:seq*1000+100,trainingSessionId,request:{id,seq,capturedAt:seq*1000,focusQuest:task,lastStep,
  texts:[{text:stage,box:[75,246,153,33]},{text:`${meters}m`,box:[80,280,70,25]}]},
  observation:{scene,uncertain:false,trackingEvidence:{selectedQuest:task,hudStage:stage}},
  distanceEvidence:{meters:[999]},decision:{action:{kind:'travel_quest'}},modelCalls:[{usage:{total_tokens:1000}}]};
}
function threeCalls(){return [frame(1,500),frame(2,460,{lastStep:step(1)}),frame(3,450,{lastStep:step(2)}),frame(4,410,{lastStep:step(3)})];}
test('whole catalog path time counts once without inventing movement, arrival, or preflight execution',()=>{
 const first=step(1,'quest_route',{kind:'commission-route',pathStarted:true,points:[],durationMs:65460,stopReason:'dialogue'});
 const preflight=step(2,'quest_route',{kind:'commission-route',pathStarted:false,points:[],stopReason:'stage_mismatch'});
 const r=evaluate([frame(1),frame(2,500,{lastStep:first}),frame(3,500,{lastStep:preflight})],4000);
 assert.equal(r.nativePathLegs,1);assert.equal(r.pathDurationMs,65460);assert.equal(r.movementMsSent,0);
 assert.equal(r.movementTelemetryComplete,false);assert.equal(r.progress.verifiedCompletions,0);assert.equal(r.travelQuest.passed,false);
});
test('stage transitions prevent distance-only no-progress warnings and expose window token cost',()=>{
 const rows=Array.from({length:10},(_,i)=>frame(i+1,1,{stage:i<3?'收集木材':'将木板交给法拉'}));
 const r=evaluate(rows,11000);assert.equal(r.progress.observedStageTransitions,1);
 assert.equal(r.progress.tokensPerStageTransition,10000);assert.equal(r.progress.stages[0].tokensSincePreviousBoundary,3000);
 assert.equal(r.progress.tokensPerVerifiedCompletion,null);assert.ok(!r.alerts.some(a=>a.code==='NO_PROGRESS'));
});
test('changing tasks or OCR truncation cannot count as a stage transition',()=>{
 const rows=[frame(1,10,{stage:'前去查看详情'}),frame(2,10,{stage:'前去查看详情附近'}),frame(3,10,{task:'任务乙',stage:'收集绳索'})];
 assert.equal(evaluate(rows,4000).progress.observedStageTransitions,0);
});
test('combat HUD stages participate in task progress without claiming a kill',()=>{
 const r=evaluate([frame(1,2,{stage:'和法拉对话'}),frame(2,2,{stage:'消灭所有魔物',scene:'combat'})],3000);
 assert.equal(r.progress.observedStageTransitions,1);assert.equal(r.progress.verifiedCompletions,0);
});
test('completion KPI deduplicates BGI banners and rejects model-only completion',()=>{
 const rows=[frame(1),frame(2),frame(3)];
 for(const r of rows.slice(1)){r.request.texts=[{text:'任务甲'},{text:'任务完成'}];r.observation.visionSource='bettergi_native_cv_ocr';}
 const p=evaluate(rows,4000).progress;assert.equal(p.verifiedCompletions,1);assert.equal(p.tokensPerVerifiedCompletion,3000);
 for(const r of rows)r.observation.visionSource='model';assert.equal(evaluate(rows,4000).progress.verifiedCompletions,0);
});
test('only the latest same-quest BGI completion evidence overrides no-progress heuristics',()=>{
 const last=frame(10,0);last.observation.visionSource='bettergi_native_cv_ocr';
 last.request.texts=[{text:'任务甲',box:[78,248,120,30]},{text:'任务完成',box:[78,284,120,35]},{text:'委托完成',box:[800,200,200,50]}];
 const earlier=Array.from({length:9},(_,i)=>frame(i+1,0));
 const r=evaluate([...earlier,last],1000000);assert.equal(r.verdict,'completed');assert.equal(r.alerts.length,0);assert.equal(r.travelQuest.passed,false);
 assert.notEqual(evaluate([last,frame(11,50)],12000).verdict,'completed','a past completion is not current state');
 const other=structuredClone(last);other.request.focusQuest='任务乙';assert.notEqual(evaluate([other],12000).verdict,'completed');
 const model=structuredClone(last);model.observation.visionSource='model_claim';assert.notEqual(evaluate([model],12000).verdict,'completed');
});

test('frames and receipts deduplicate by native id and seq; final ledger fills tail',()=>{
 const s1=step(1,'move',{movedMs:400}),s2=step(2,'key',{kind:'interaction',sent:true});
 const rows=[frame(1),frame(2,490,{lastStep:s1}),frame(2,490,{lastStep:s1})];
 const ledger={contexts:[],events:[{sessionId:'native-a',step:s1},{sessionId:'native-a',step:s2},{sessionId:'foreign-native',step:step(1,'move',{movedMs:9000})}]};
 const r=evaluate(rows,3000,{receiptLedger:ledger});
 assert.equal(r.frames,2);assert.equal(r.tokens,2000);assert.equal(r.nativeReceipts,2);
 assert.equal(r.movementMsSent,400);assert.equal(r.fInteractionsSent,1);
 assert.equal(r.executedActions.key,1);
});
test('same seq in another native session is distinct and training filters isolate runs',()=>{
 const rows=[frame(1),frame(1,500,{id:'native-b'}),frame(2,450,{lastStep:step(1)}),frame(2,450,{id:'native-b',lastStep:step(1),trainingSessionId:'other-training'})];
 const r=evaluate(rows,4000,{nativeIds:['native-a'],trainingSessionId:'training-a',sessionStartedAt:1000});
 assert.equal(r.frames,2);assert.equal(r.nativeReceipts,1);assert.equal(r.identityScope,'explicit_native_ids');
 assert.equal(evaluate(rows,4000,{trainingSessionId:'training-a'}).frames,3);
 assert.equal(evaluate(rows,4000,{sessionStartedAt:2000}).frames,2);
});
test('final wrapped native receipt is accepted even without a following frame',()=>{
 const r=evaluate([frame(1)],3000,{receiptLedger:{id:'native-a',receipt:{id:'native-a',steps:[step(1)]}}});
 assert.equal(r.nativeReceipts,1);assert.equal(r.travelQuest.calls,1);
 assert.equal(r.travelQuest.recentCalls[0].reason,'independent_after_frame_missing');
 assert.equal(r.travelQuest.recentCalls[0].nativeProgress.distanceAfter,100);
 assert.equal(r.travelQuest.passed,false);
});
test('distance uses unique adjacent HUD OCR, never a full-frame distance alone',()=>{
 const row=frame(1,120);assert.equal(hudReading(row).meters,120);
 row.request.texts[1].box=[1000,500,70,25];assert.equal(hudReading(row),null);
 row.request.texts.push({text:'120m',box:[80,280,70,25]},{text:'20m',box:[85,285,70,25]});
 assert.equal(hudReading(row),null);
 row.request.texts.push({text:'120m',box:[80,280,70,25],source:'quest_distance_crop'});
 assert.equal(hudReading(row).meters,120);
 row.observation.scene='map';assert.equal(hudReading(row),null);
});
test('task or stage changes cannot manufacture distance progress',()=>{
 for(const change of [{task:'任务乙'},{stage:'前往其他地点'}]){
  const rows=[frame(1,500),frame(2,10,{lastStep:step(1),...change})];
  const r=evaluate(rows,3000);
  assert.equal(r.recentWindow.distanceGained,null);assert.notEqual(r.verdict,'progressing');
  assert.equal(r.travelQuest.recentCalls[0].reason,'task_or_stage_changed');
 }
});
test('latest three actual macros need two independently observed reductions of 30m',()=>{
 const r=evaluate(threeCalls(),5000);
 assert.equal(r.travelQuest.calls,3);assert.equal(r.travelQuest.qualifyingCalls,2);
 assert.deepEqual(r.travelQuest.recentCalls.map(c=>c.distanceGained),[40,10,40]);
 assert.equal(r.travelQuest.passed,true);
});
test('a final unverified call participates in the latest three instead of cherry-picking successes',()=>{
 const r=evaluate(threeCalls(),6000,{receiptLedger:{events:[{sessionId:'native-a',step:step(4)}]}});
 assert.equal(r.travelQuest.calls,4);assert.equal(r.travelQuest.qualifyingCalls,1);
 assert.equal(r.travelQuest.passed,false);assert.equal(r.travelQuest.recentCalls[2].reason,'independent_after_frame_missing');
});
test('before-action capture and unrelated native or seq cannot serve as independent after evidence',()=>{
 for(const mutate of [r=>{r.request.capturedAt=1500;},r=>{r.request.id='other';},r=>{r.request.lastStep.seq=9;}]){
  const rows=[frame(1),frame(2,400,{lastStep:step(1)})];mutate(rows[1]);
  const r=evaluate(rows,4000,{receiptLedger:{id:'native-a',steps:[step(1)]}});
  const call=r.travelQuest.recentCalls.find(c=>c.nativeId==='native-a'&&c.seq===1);
  assert.equal(call.reason,'independent_after_frame_missing');assert.equal(call.qualifies,false);
 }
});
test('PathExecutor duration never becomes movement milliseconds or verified arrival',()=>{
 const r=evaluate(threeCalls(),5000);
 assert.equal(r.pathDurationMs,6000);assert.equal(r.nativePathLegs,3);
 assert.equal(r.movementMsSent,0);assert.equal(r.movementTelemetryComplete,false);
 assert.equal(movedMs(step(1,'advance_quest',{trace:[{},{}]})),0);
 assert.equal(movedMs(step(1,'move',{movedMs:400})),400);
});
test('tokens are summed per frame including repair calls before computing median',()=>{
 const rows=[frame(1),frame(2),frame(3)];
 rows[0].modelCalls=[{usage:{total_tokens:1000}},{usage:{total_tokens:3000}}];
 rows[1].modelCalls=[{usage:{total_tokens:2000}}];rows[2].modelCalls=[{usage:{total_tokens:10000}}];
 const r=evaluate(rows,4000);
 assert.equal(r.tokens,16000);assert.equal(r.tokensPerFrameMedian,4000);assert.equal(r.tokensPerFrame,5333);
 assert.equal(r.tokenFramesIncomplete,0);
});
test('legacy repair usage is retained and missing usage is reported rather than treated as zero-cost',()=>{
 const r={usage:{total_tokens:2000},rejected:[{usage:{total_tokens:1000}}],decision:{action:{kind:'key'}}};
 assert.equal(frameTokens(r).total,3000);
 assert.equal(frameTokens({...r,usage:{total_tokens:1000},decision:{action:{kind:'wait'}}}).total,1000);
 assert.equal(evaluate([{at:1000,decision:{action:{kind:'wait'}}}],2000).tokenFramesIncomplete,1);
});
test('dialogue and combat are not mislabeled MENU_LOOP',()=>{
 for(const scene of ['dialogue','dialog','combat']){
  const rows=Array.from({length:8},(_,i)=>frame(i+1,500,{scene}));
  assert.equal(evaluate(rows,10000).alerts.some(a=>a.code==='MENU_LOOP'),false);
 }
 const rows=Array.from({length:8},(_,i)=>frame(i+1,500,{scene:'menu'}));
 assert.equal(evaluate(rows,10000).alerts.some(a=>a.code==='MENU_LOOP'),true);
});
test('old evaluate(rows, now) call and empty reports remain supported',()=>{
 const r=evaluate([],1000);assert.equal(r.frames,0);assert.equal(r.verdict,'idle');
 assert.equal(r.tokensPerFrameMedian,null);assert.equal(r.travelQuest.passed,false);
});
