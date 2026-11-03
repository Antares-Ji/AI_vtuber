'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {StoryFeedbackMemory,compactSteps,MAX_RECENT_STEPS}=require('../src/genshin/story-feedback-memory');
const grounding=require('../scripts/genshin/story-main');
const step=(seq,kind,detail={})=>({seq,action:{kind},detail:JSON.stringify(detail),finishedAt:seq*100,verified:false});
const failed=seq=>step(seq,'travel_quest',{kind:'quest-travel',stopReason:'bearing_unavailable',movedLegs:0,
 progress:{distanceBefore:184,distanceAfter:184,stageBefore:'前去查看详情',stageAfter:'前去查看详情'}});
const gained=seq=>step(seq,'travel_quest',{kind:'quest-travel',stopReason:'leg_budget',movedLegs:1,
 progress:{distanceBefore:184,distanceAfter:154,stageBefore:'前去查看详情',stageAfter:'前去查看详情'}});
test('compaction preserves exhausted seeker across waits and its actual turn reset',()=>{
 const exhausted=step(1,'seek_quest',{stopReason:'directions_exhausted'}),waits=Array.from({length:30},(_,i)=>step(i+2,'wait'));
 assert.equal(grounding.seekFeedback(compactSteps([exhausted,...waits])).exhausted,true);
 assert.equal(grounding.seekFeedback(compactSteps([exhausted,...waits,step(40,'turn')])).exhausted,false);
});
function fixture(t,stage='前去查看详情'){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-travel-memory-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 return {root,memory:new StoryFeedbackMemory({root,quest:'紧急修理',stage})};
}
test('two travel failures remain blocked across wait, turn, reset, native segments and reload',t=>{
 const {root,memory}=fixture(t);
 memory.merge({sessionId:'one',steps:[failed(1),step(2,'wait'),step(3,'turn')]});
 const result=memory.merge({sessionId:'two',steps:[step(1,'reset_camera'),failed(2),step(3,'wait')]});
 assert.equal(result.travelFeedback.failedTravels,2);assert.equal(result.travelFeedback.blocked,true);
 assert.equal(result.stats.travelFailureReceipts,2);
 assert.equal(grounding.travelFeedback(result.recentNativeSteps).blocked,true);
 const restored=new StoryFeedbackMemory({root,quest:'紧急修理',stage:'前去查看详情'}).snapshot();
 assert.deepEqual(restored.travelFeedback,result.travelFeedback);assert.equal(restored.stats.nativeReceipts,6);
});
test('lastStep plus final receipt deduplicates while adding the missing final travel failure',t=>{
 const {memory}=fixture(t);
 memory.merge({sessionId:'one',lastStep:failed(1)});
 let result=memory.merge({sessionId:'one',steps:[failed(1),failed(2)]});
 assert.equal(result.added,1);assert.equal(result.travelFeedback.blocked,true);
 result=memory.merge({sessionId:'one',steps:[failed(1),failed(2)]});
 assert.equal(result.added,0);assert.equal(result.stats.nativeReceipts,2);assert.equal(result.stats.travelFailureReceipts,2);
});
test('actual movement and same-stage travel progress reset failures; zero movement does not',t=>{
 for(const recovery of [step(3,'move',{movedMs:400}),gained(3)]){
  const {memory}=fixture(t);memory.merge({sessionId:'one',steps:[failed(1),failed(2)]});
  const result=memory.merge({sessionId:'one',lastStep:recovery});
  assert.equal(result.travelFeedback.failedTravels,0);assert.equal(result.travelFeedback.blocked,false);
  assert.equal(grounding.travelFeedback(result.recentNativeSteps).blocked,false);
  assert.equal(memory.merge({sessionId:'two',lastStep:failed(1)}).travelFeedback.failedTravels,1);
 }
 const {memory}=fixture(t);memory.merge({sessionId:'one',steps:[failed(1),failed(2),step(3,'move',{movedMs:0})]});
 assert.equal(memory.snapshot().travelFeedback.blocked,true);
});
test('only confirmed task-stage changes isolate travel failures; stage promotion preserves them',t=>{
 const {memory}=fixture(t,null);memory.merge({sessionId:'one',steps:[failed(1),failed(2)]});
 assert.equal(memory.setContext({stage:'前去查看详情'}).travelFeedback.blocked,true);
 assert.equal(memory.setContext({stage:'与凯瑟琳对话'}).travelFeedback.blocked,true);
 const fresh=memory.setContext({stage:'与凯瑟琳对话',confirmedStageChange:true});
 assert.equal(fresh.travelFeedback.blocked,false);assert.equal(fresh.stats.nativeReceipts,0);
 const late=memory.merge({sessionId:'one',steps:[failed(1),failed(2)]});
 assert.equal(late.added,0);assert.equal(late.travelFeedback.blocked,false);
});
test('compaction retains one- and two-failure travel state and future recovery semantics',()=>{
 const waits=Array.from({length:80},(_,i)=>step(i+10,['wait','turn','reset_camera'][i%3]));
 const cases=[[failed(1),...waits],[failed(1),...waits,failed(100)],
  [failed(1),failed(2),step(3,'move',{movedMs:0}),...waits],
  [failed(1),failed(2),gained(3),...waits,failed(100)]];
 for(const original of cases){
  const compact=compactSteps(original);assert.ok(compact.length<=MAX_RECENT_STEPS);
  for(const future of [[],[failed(200)],[step(200,'move',{movedMs:400})],[gained(200)],[step(200,'wait'),failed(201)]]){
   const a=grounding.travelFeedback([...original,...future]),b=grounding.travelFeedback([...compact,...future]);
   assert.equal(Math.min(2,a.failedTravels),Math.min(2,b.failedTravels));assert.equal(a.blocked,b.blocked);
  }
 }
});
test('existing version-one ledger loads without migration or lost receipts',t=>{
 const {root,memory}=fixture(t);memory.merge({sessionId:'old',steps:[failed(1),failed(2)]});
 const before=JSON.parse(fs.readFileSync(memory.file,'utf8'));
 assert.equal(before.version,1);assert.equal(before.events.length,2);
 // The on-disk format has no computed travel fields; old receipts are enough.
 assert.equal(before.travelFeedback,undefined);
 const restored=new StoryFeedbackMemory({root,quest:'紧急修理',stage:'前去查看详情'}).snapshot();
 assert.equal(restored.travelFeedback.blocked,true);assert.equal(restored.stats.travelFailureReceipts,2);
 assert.deepEqual(JSON.parse(fs.readFileSync(memory.file,'utf8')).events,before.events);
});
test('late final receipts are ordered by native sequence before deciding whether movement reset failures',t=>{
 const {memory}=fixture(t);
 memory.merge({sessionId:'one',lastStep:step(3,'move',{movedMs:400})});
 const result=memory.merge({sessionId:'one',steps:[failed(1),failed(2),step(3,'move',{movedMs:400}),failed(4)]});
 assert.equal(result.travelFeedback.failedTravels,1);assert.equal(result.travelFeedback.blocked,false);
 assert.equal(grounding.travelFeedback(result.recentNativeSteps).failedTravels,1);
});
