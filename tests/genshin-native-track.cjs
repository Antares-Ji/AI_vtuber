const {test}=require('node:test'),assert=require('node:assert/strict');
const g=require('../scripts/genshin/story-main'),{validateDecision}=require('../src/genshin/story-runtime');
const rows=[{text:'返回「旗舰」休息',box:[75,246,230,33]},{text:'高处60m',box:[80,280,120,25]}];
test('elevated HUD distance remains associated with its instruction and retains elevation',()=>{
 assert.equal(g.questHud(rows).meters,60);assert.equal(g.questHud(rows).elevation,'高处');
 assert.equal(g.questHud([rows[0],{...rows[1],box:[1200,600,120,25]}]),null);
 assert.equal(g.questHud([...rows,{text:'50m',box:[80,285,100,25]}]),null);
});
test('native near tracking requires current BGI UI, near HUD, actual capability and remaining budget',()=>{
 const request={texts:rows,capabilities:{nativeQuestTrack:true},nativeTrackAttempts:0};
 const observation={scene:'world',nativeVision:{source:'bettergi_native_cv',ui:'Main'}};
 assert.equal(validateDecision({action:{kind:'native_track'}},request,observation).action.kind,'native_track');
 for(const r of [{...request,capabilities:{}},{...request,nativeTrackAttempts:2},{...request,texts:[rows[0],{...rows[1],text:'高处160m'}]}])assert.throws(()=>validateDecision({action:{kind:'native_track'}},r,observation));
 assert.throws(()=>validateDecision({action:{kind:'native_track',x:10}},request,observation));
 assert.throws(()=>validateDecision({action:{kind:'native_track'}},request,{...observation,scene:'menu'}));
});
