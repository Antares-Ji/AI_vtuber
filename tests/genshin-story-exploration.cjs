const test=require('node:test'),assert=require('node:assert/strict');
const {frame,summarize,entries}=require('../src/genshin/story-exploration');
const now=1000000,scope={sessionId:'s',quest:'两次视线的交汇',stage:'返回「旗舰」休息',now};
function evidence(n,meters,elevation='高处'){
 return {trainingSessionId:'s',provider:'deepseek',imageAssistance:{seq:n},cloudImageAssessment:{groundTrailVisible:false,groundTrail:'未见',nearObstacle:'墙',openPassage:'门廊'+n},
  request:{id:'native',seq:n,capturedAt:now-600000+n*30001,focusQuest:scope.quest,nativeVision:{source:'bettergi_native_cv',ui:'Main'},texts:[{text:scope.stage,box:[75,246,240,33]},{text:elevation+meters+'m',box:[80,280,120,25]}]},observation:{scene:'world'}};
}
test('exploration survives segment boundaries and keeps closest approaches separate by elevation',()=>{
 const frames=[frame(evidence(1,6)),frame(evidence(2,18,'低处')),...Array.from({length:8},(_,i)=>frame(evidence(i+3,30+i)))];
 const first=summarize(frames,scope);
 assert.equal(first.closestByElevation.length,2);assert.equal(first.recentCheckpoints.length,6);
 assert.deepEqual(first.closestByElevation.map(f=>f.hud.meters),[6,18]);
 const next=frame(evidence(12,33));next.nativeId='next-native';next.seq=1;
 const resumed=summarize([...entries(first),next],scope);
 assert.equal(resumed.closestByElevation[0].hud.meters,6);assert.equal(resumed.recentCheckpoints.at(-1).nativeId,'next-native');
 assert.match(resumed.limitation,/不是到达/);
});
test('different sessions, tasks, stages, future and stale frames never supply exploration context',()=>{
 const f=frame(evidence(1,6));
 for(const edit of [{sessionId:'other'},{quest:'其他任务'},{stage:'参加抽签'},{at:now+1},{at:now-7200001}])assert.equal(summarize([{...f,...edit}],scope),null);
 assert.equal(summarize([f],{...scope,sessionId:null}),null);
 const quoted={...f,stage:'返回『旗舰」休息'};assert.ok(summarize([quoted],scope));
 assert.equal(summarize([f,f],scope).recentCheckpoints.length,1);
});
test('historical landmarks require actual image-assisted DeepSeek and BGI evidence',()=>{
 const e=evidence(1,6);
 for(const edit of [{provider:'codex-direct'},{imageAssistance:null},{cloudImageAssessment:null},{trainingSessionId:null},{observation:{scene:'menu'}},{request:{...e.request,nativeVision:{source:'other',ui:'Main'}}}])assert.equal(frame({...e,...edit}),null);
 const f=frame({...e,cloudImageAssessment:{...e.cloudImageAssessment,openPassage:'x'.repeat(1000)}});
 assert.equal(f.seenByDeepSeek.openPassage.length,100);assert.equal(f.hud.elevation,'高处');
 assert.equal('action' in f,false);assert.equal('position' in f,false);
});
