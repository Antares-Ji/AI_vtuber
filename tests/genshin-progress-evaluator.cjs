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
