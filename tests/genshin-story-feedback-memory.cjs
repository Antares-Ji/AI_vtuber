const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {StoryFeedbackMemory,compactSteps,MAX_RECENT_STEPS}=require('../src/genshin/story-feedback-memory');
const grounding=require('../scripts/genshin/story-main');
const step=(seq,kind,detail={},extra={})=>({seq,action:{kind,...extra},detail:typeof detail==='string'?detail:JSON.stringify(detail),finishedAt:seq*100,verified:false});
const follow=seq=>step(seq,'follow_marker',{kind:'marker-follow',movedMs:0,stopReason:'marker_missing_or_ambiguous'});
const f=(seq,target='骗子向导')=>step(seq,'key',{kind:'interaction',target,sent:true,outcome:'prompt_unchanged'},{key:'F',text:target});
function fixture(t,options={}){const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-feedback-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return {root,memory:new StoryFeedbackMemory({root,quest:'神秘岛的传说',stage:'跟随骗子向导',...options})};}
test('cross-segment follow failures and unchanged F persist through forty waits and a restart',t=>{
 const {root,memory}=fixture(t);
 memory.merge({sessionId:'native-one',steps:[follow(1),follow(2),f(3)]});
 let s=memory.merge({sessionId:'native-two',steps:[f(1),...Array.from({length:40},(_,i)=>step(i+2,'wait'))]});
 assert.equal(s.navigationFeedback.failedFollows,2);assert.equal(s.navigationFeedback.blocked,true);
 assert.equal(grounding.interactionBlocked(s.recentNativeSteps,'骗子向导'),true);
 assert.ok(s.recentNativeSteps.length<=MAX_RECENT_STEPS);
 const loaded=new StoryFeedbackMemory({root,quest:'神秘岛的传说',stage:'跟随骗子向导'}).snapshot();
 assert.deepEqual(loaded,sWithoutAdded(s));
 assert.equal(loaded.stats.nativeReceipts,44);assert.equal(loaded.stats.unchangedInteractionReceipts,2);
});
function sWithoutAdded({added,...rest}){return rest;}
test('area search cursor survives receipt compaction and process restart, isolated by task stage',t=>{
 const {root,memory}=fixture(t);const state={version:1,stage:'跟随骗子向导',origin:{x:100,y:200},cursor:12};
 memory.merge({sessionId:'search',steps:[step(1,'search_area',{kind:'area-search',state}),...Array.from({length:40},(_,i)=>step(i+2,'wait'))]});
 const restored=new StoryFeedbackMemory({root,quest:'神秘岛的传说',stage:'跟随骗子向导'});
 assert.deepEqual(restored.snapshot().areaSearchState,state);
 restored.setContext({quest:'神秘岛的传说',stage:'收集绳索',confirmedStageChange:true});
 assert.equal(restored.snapshot().areaSearchState,null);
});
test('last-step and final receipts deduplicate by native session plus sequence and add the missing terminal step',t=>{
 const {memory}=fixture(t);
 assert.equal(memory.merge({sessionId:'segment-a',lastStep:follow(1)}).added,1);
 assert.equal(memory.merge({sessionId:'segment-a',steps:[follow(1),follow(2)]}).added,1);
 assert.equal(memory.merge({sessionId:'segment-a',steps:[follow(1),follow(2)]}).added,0);
 assert.equal(memory.merge({sessionId:'segment-b',lastStep:follow(1)}).added,1);
 assert.equal(memory.snapshot().navigationFeedback.failedFollows,3);
 assert.equal(memory.snapshot().stats.nativeReceipts,3);
});
test('late final receipts are replayed in native sequence order instead of arrival order',t=>{
 const {memory}=fixture(t);
 memory.merge({sessionId:'late',lastStep:step(2,'move',{movedMs:400})});
 const s=memory.merge({sessionId:'late',steps:[follow(1),step(2,'move',{movedMs:400}),follow(3)]});
 assert.equal(s.navigationFeedback.failedFollows,1);
 assert.equal(grounding.navigationFeedback(s.recentNativeSteps).failedFollows,1);
});
test('quest and confirmed stage boundaries isolate failures; truncated OCR keeps the current context',t=>{
 const {root,memory}=fixture(t,{stage:'前往指定地点引诱骗子露面'});
 memory.merge({sessionId:'a',steps:[follow(1),follow(2)]});
 let s=memory.setContext({stage:'前往指定地点引诱骗'});assert.equal(s.navigationFeedback.blocked,true);
 s=memory.setContext({stage:'跟随骗子向导'});assert.equal(s.navigationFeedback.blocked,true);
 s=memory.setContext({stage:'跟随骗子向导',confirmedStageChange:true});assert.equal(s.navigationFeedback.blocked,false);
 memory.merge({sessionId:'b',lastStep:f(1)});
 s=memory.setContext({quest:'另一项任务',stage:'跟随骗子向导'});assert.equal(s.stats.nativeReceipts,0);
 assert.equal(memory.merge({sessionId:'b',lastStep:f(1)}).added,0);
 const original=new StoryFeedbackMemory({root,quest:'神秘岛的传说',stage:'前往指定地点引诱骗'}).snapshot();
 assert.equal(original.navigationFeedback.blocked,true);
});
test('unknown stage is promoted without losing failures or duplicating final receipts',t=>{
 const {root,memory}=fixture(t,{stage:null});
 memory.merge({sessionId:'unknown',lastStep:follow(1)});
 assert.equal(memory.setContext({stage:'跟随骗子向导'}).navigationFeedback.failedFollows,1);
 const loaded=new StoryFeedbackMemory({root,quest:'神秘岛的传说',stage:'跟随骗子向导'});
 const s=loaded.merge({sessionId:'unknown',steps:[follow(1),follow(2)]});
 assert.equal(s.added,1);assert.equal(s.navigationFeedback.blocked,true);
 const anotherUnknown=new StoryFeedbackMemory({root,quest:'神秘岛的传说',stage:null});
 assert.equal(anotherUnknown.snapshot().stats.nativeReceipts,0);
 assert.notEqual(anotherUnknown.snapshot().contextId,s.contextId);
});
test('explicit clear retains receipt tombstones so delayed receipts cannot resurrect cleared failures',t=>{
 const {memory}=fixture(t);
 memory.merge({sessionId:'clear',steps:[follow(1),follow(2)]});
 assert.equal(memory.clear().stats.nativeReceipts,0);
 let s=memory.merge({sessionId:'clear',steps:[follow(1),follow(2)]});assert.equal(s.added,0);assert.equal(s.navigationFeedback.blocked,false);
 s=memory.merge({sessionId:'next',lastStep:follow(1)});assert.equal(s.navigationFeedback.failedFollows,1);
});
test('atomic JSON persists complete data without temporary files and unreadable state fails closed',t=>{
 const {root,memory}=fixture(t);memory.merge({sessionId:'disk',lastStep:follow(1)});
 const folder=path.join(root,'runtime/genshin');assert.deepEqual(fs.readdirSync(folder),['story-feedback-memory.json']);
 assert.equal(JSON.parse(fs.readFileSync(memory.file)).version,1);
 fs.writeFileSync(memory.file,'{broken');
 assert.throws(()=>new StoryFeedbackMemory({root,quest:'神秘岛的传说'}),/refusing to reset/);
 assert.equal(fs.readFileSync(memory.file,'utf8'),'{broken');
});
test('bounded compaction preserves one-strike state and recovery semantics for future actions',()=>{
 const sequences=[
  [follow(1),...Array.from({length:100},(_,i)=>step(i+2,'wait'))],
  [f(1),...Array.from({length:100},(_,i)=>step(i+2,'wait'))],
  [follow(1),follow(2),f(3),f(4)],
  [f(1,'甲目标'),f(2,'甲目标'),step(3,'turn'),f(4,'乙目标')],
  [follow(1),follow(2),step(3,'move',{movedMs:0}),step(4,'reset_camera')],
  [follow(1),follow(2),step(3,'move',{movedMs:400}),f(4)],
 ];
 for(const original of sequences){
  const compact=compactSteps(original);assert.ok(compact.length<=MAX_RECENT_STEPS);
  for(const future of [[],[follow(200)],[f(200)],[f(200,'甲目标')],[f(200,'乙目标')],[step(200,'move',{movedMs:400})],[step(200,'wait'),f(201)]]){
   assert.equal(grounding.navigationFeedback([...compact,...future]).blocked,grounding.navigationFeedback([...original,...future]).blocked);
   for(const target of ['骗子向导','甲目标','乙目标'])assert.equal(grounding.interactionBlocked([...compact,...future],target),grounding.interactionBlocked([...original,...future],target));
  }
 }
});
test('missing quest identity and invalid receipts cannot silently contaminate a different task',t=>{
 const {root,memory}=fixture(t);
 assert.throws(()=>new StoryFeedbackMemory({root,quest:''}));
 assert.throws(()=>memory.merge({sessionId:'',lastStep:follow(1)}));
 assert.throws(()=>memory.merge({sessionId:'bad',lastStep:{seq:1,action:{kind:'follow_marker'}}}));
 assert.equal(memory.snapshot().stats.nativeReceipts,0);
});
