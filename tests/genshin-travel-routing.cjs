'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { validateDecision } = require('../src/genshin/story-runtime');
const world = {scene:'world',uncertain:false,navigation:{terrain:'open',marker:'center'}};
const texts = [
 {text:'前去查看详情',box:[78,248,149,29]},
 {text:'184m',box:[80,282,70,24],source:'quest_distance_crop'},
 {text:'184m',box:[925,400,70,24]}
];
test('model selects a travel intent without supplying geometry or duration',()=>{
 assert.deepEqual(validateDecision({action:{kind:'travel_quest'}},{texts},world).action,{kind:'travel_quest'});
 for(const extra of [{x:10,y:20},{dx:20},{ms:60000},{theta:90},{legs:6}])
  assert.throws(()=>validateDecision({action:{kind:'travel_quest',...extra}},{texts},world),/原生本地视觉/);
});
test('travel rejection retains an executable re-observation or menu recovery path',()=>{
 for(const observation of [{...world,scene:'menu'},{...world,uncertain:true}]){
  assert.throws(()=>validateDecision({action:{kind:'travel_quest'}},{texts},observation));
  assert.equal(validateDecision({action:{kind:'wait'}},{texts},observation).action.kind,'wait');
 }
 assert.equal(validateDecision({action:{kind:'key',key:'ESCAPE'}},{texts},{...world,scene:'menu'}).action.key,'ESCAPE');
});
test('current F, missing HUD and conflicting HUD distances reject travel',()=>{
 const f=[{text:'F',box:[1160,450,28,30]},{text:'冒险家',box:[1210,450,120,30]}];
 for(const rows of [[],[texts[2]],[...texts,...f],[...texts,{text:'84m',box:[80,283,60,24],source:'quest_distance_crop'}]])
  assert.throws(()=>validateDecision({action:{kind:'travel_quest'}},{texts:rows},world));
});
test('repeated failed travel needs actual recovery and retains bounded movement and inspection alternatives',()=>{
 const fail=seq=>({seq,action:{kind:'travel_quest'},detail:JSON.stringify({kind:'quest-travel',stopReason:'bearing_unavailable',progress:{distanceBefore:184,distanceAfter:184,stageBefore:'前去查看详情',stageAfter:'前去查看详情'}})});
 const request={texts,recentNativeSteps:[fail(1),{seq:2,action:{kind:'wait'},detail:''},fail(3),{seq:4,action:{kind:'reset_camera'},detail:''}]};
 assert.throws(()=>validateDecision({action:{kind:'travel_quest'}},request,world),/travel_recovery_required/);
 for(const action of [{kind:'move',key:'W',ms:400},{kind:'reset_camera'},{kind:'key',key:'J'},{kind:'stop'}])
  assert.deepEqual(validateDecision({action},request,world).action,action);
 request.recentNativeSteps.push({seq:5,action:{kind:'move',key:'W',ms:400},detail:JSON.stringify({movedMs:400})});
 assert.equal(validateDecision({action:{kind:'travel_quest'}},request,world).action.kind,'travel_quest');
});
