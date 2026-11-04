const {test}=require('node:test'),assert=require('node:assert/strict');
const g=require('../scripts/genshin/story-main'),{validateDecision}=require('../src/genshin/story-runtime');
const rows=[{text:'返回「旗舰」休息',box:[75,246,230,33]},{text:'高处60m',box:[80,280,120,25]}];
test('native recovery hands only its confirmed same-stage departed prompt to subsequent tracking',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../scripts/genshin/story-main.js'),'utf8');
 for(const [stopReason,nextStage,expected] of [['returned','返回『旗舰」休息','克鲁切'],['focus_lost','返回「旗舰」休息',''],['returned','前往比赛场地','']]){
  let phase=0,ignored;
  const files=new Map([['command.json',JSON.stringify({id:'handoff-test',timeoutMs:600000})]]);
  const ctx={JSON,Date,Number,String,Math,Set,Error,
   file:{readTextSync:n=>files.get(n),writeImageSync(){},writeTextSync(n,v){files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);files.set('story-decision-'+r.seq+'.json',JSON.stringify({id:r.id,seq:r.seq,action:{kind:r.seq===1?'native_unstuck':r.seq===2?'native_track':'stop'}}));}}},
   captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose(){},findMulti:()=>({count:2,0:{text:phase?nextStage:rows[0].text,x:75,y:246,width:230,height:33},1:{text:'23m',x:80,y:280,width:120,height:25}})}),
   RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers(){}},log:{info(){}},sleep:async()=>{},keyUp(){},
   isGameActive:()=>true,ensureGameFocus:async()=>true,getOwnedSceneObservation:()=>JSON.stringify({source:'bettergi_native_cv',ui:'Main',motion:'Normal'}),
   getOwnedInteractionPrompt:()=>JSON.stringify(phase?null:{source:'bettergi_native_f_label',text:'克鲁切',count:1,anchor:[1103,523,32,32],box:[1218,523,285,32]}),
   CancellationTokenSource:class{token={};cancelAfter(){}cancel(){}dispose(){}},
   runOwnedQuestUnstuck:async()=>{phase=1;return JSON.stringify({kind:'bgi-native-unstuck',stopReason});},
   runOwnedQuestTrack:async(ms,label)=>{ignored=label;return JSON.stringify({kind:'bgi-native-track',stopReason:'returned'});}
  };
  await vm.runInNewContext(source,ctx);assert.equal(JSON.parse(files.get('receipt.json')).state,'returned');assert.equal(ignored,expected);
 }
});
test('repeated incidental F gets a departure alternative while named quest and collection targets remain eligible',()=>{
 const prompt={source:'bettergi_native_f_label',text:'克鲁切',count:1,box:[1218,523,285,32],anchor:[1103,523,32,32]};
 const request={texts:[...rows,prompt],interactionVisits:{'克鲁切':1}},o={scene:'world',uncertain:false};
 assert.throws(()=>validateDecision({action:{kind:'key',key:'F',text:'克鲁切'}},request,o),/非任务目标/);
 assert.equal(validateDecision({action:{kind:'leave_interaction',text:'克鲁切',key:'W'}},request,o).action.kind,'leave_interaction');
 assert.equal(g.repeatedIncidentalInteraction([{text:'和克鲁切对话',box:rows[0].box}],'克鲁切',request.interactionVisits),false);
 assert.equal(g.repeatedIncidentalInteraction([{text:'收集木材',box:rows[0].box}],'调查',{'调查':2}),false);
 assert.equal(g.repeatedIncidentalInteraction(rows,'休息',{'休息':1}),false);
});
test('native AutoPick resolves an OCR-missed F while ambiguous native prompts remain blocked',()=>{
 const p={source:'bettergi_native_f_label',text:'坐下',count:1,box:[1300,500,100,30],anchor:[1180,500,30,30]};
 const ocr=[{text:'0',box:p.anchor},{text:'坐下',box:p.box}];
 assert.equal(g.interaction(ocr).state,'absent');
 assert.equal(g.interaction([...ocr,p]).state,'unique');
 assert.equal(g.interaction([...ocr,p]).candidates[0].source,p.source);
 assert.equal(g.movementStop([...ocr,p]),'interaction_prompt');
 for(const bad of [{...p,count:2},{...p,text:''},{...p,anchor:null}])assert.equal(g.interaction([...ocr,bad]).state,'ambiguous');
 assert.equal(g.interaction([...ocr,p,p]).state,'ambiguous');
 assert.equal(g.interaction([...ocr,{...p,source:'model_guess'}]).state,'absent');
});
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
test('only independently observed same-stage progress renews native tracking budget',()=>{
 const {nativeTrackingProgress}=require('../src/genshin/story-memory');
 const previous={request:{id:'a',seq:1,texts:rows},decision:{action:{kind:'native_track'}}};
 const current={id:'a',capturedAt:3000,nativeVision:{source:'bettergi_native_cv',ui:'Main'},texts:[rows[0],{...rows[1],text:'高处52m'}],lastStep:{seq:1,finishedAt:2000,action:{kind:'native_track'},detail:JSON.stringify({kind:'bgi-native-track',stopReason:'returned'})}};
 assert.equal(nativeTrackingProgress(previous,current),true);
 for(const change of [{id:'other'},{capturedAt:1000},{texts:rows},{texts:[{...rows[0],text:'前往另一个地方'},current.texts[1]]},{lastStep:{...current.lastStep,seq:2}},{nativeVision:{source:'bettergi_native_cv',ui:'Unknown'}}])assert.equal(nativeTrackingProgress(previous,{...current,...change}),false);
});
test('native recovery requires repeated actual receipts and never counts duplicated plans',()=>{
 const {nativeRecoveryNeeded}=require('../src/genshin/story-memory');
 const receipt=seq=>({seq,action:{kind:'leave_interaction'},detail:JSON.stringify({kind:'leave_interaction',target:'克鲁切',movementMsSent:400})});
 assert.equal(nativeRecoveryNeeded([receipt(1),receipt(1)],'克鲁切'),false);
 assert.equal(nativeRecoveryNeeded([receipt(1),receipt(2)],'克鲁切'),true);
 assert.equal(nativeRecoveryNeeded([receipt(1),receipt(2)],'休息'),false);
 const request={texts:rows,capabilities:{nativeQuestUnstuck:true}};
 const observation={scene:'world',nativeVision:{source:'bettergi_native_cv',ui:'Main'},nativeRecovery:{available:true}};
 assert.equal(validateDecision({action:{kind:'native_unstuck'}},request,observation).action.kind,'native_unstuck');
 for(const o of [{...observation,scene:'menu'},{...observation,nativeRecovery:{available:false}}])assert.throws(()=>validateDecision({action:{kind:'native_unstuck'}},request,o));
 assert.throws(()=>validateDecision({action:{kind:'native_unstuck',key:'W'}},request,observation));
});
test('repeated invalid map coordinates block dependent navigation while native tracking remains eligible',()=>{
 const {mapPositionFailures}=require('../src/genshin/story-feedback-memory');
 const receipt=d=>({detail:JSON.stringify(d)});
 const bad=[receipt({kind:'continuous-navigation',stopReason:'position_unavailable'}),receipt({kind:'quest-seek',stopReason:'position_unstable'})];
 assert.equal(mapPositionFailures([...bad,receipt({kind:'bgi-native-track',stopReason:'returned'})]),2);
 assert.equal(mapPositionFailures([...bad,receipt({kind:'commission-route',stopReason:'route_complete',after:{x:1,y:2}})]),0);
 const request={texts:rows,capabilities:{nativeQuestTrack:true},nativeTrackAttempts:0,mapPositionFailures:2};
 const observation={scene:'world',nativeVision:{source:'bettergi_native_cv',ui:'Main'}};
 assert.equal(validateDecision({action:{kind:'native_track'}},request,observation).action.kind,'native_track');
 assert.throws(()=>validateDecision({action:{kind:'seek_quest'}},request,observation),/地图坐标/);
});
test('native tracking delegates to BGI once and disposes its cancellation source even when BGI throws',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../scripts/genshin/story-main.js'),'utf8');
 for(const fail of [false,true,'hudgone']){
  let omitHud=false;
  const files=new Map([['command.json',JSON.stringify({id:'native-test',timeoutMs:600000})]]),events=[];
  const ctx={JSON,Date,Number,String,Math,Set,Error,
   file:{readTextSync:n=>files.get(n),writeImageSync(){},writeTextSync(n,v){files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);files.set('story-decision-'+r.seq+'.json',JSON.stringify({id:r.id,seq:r.seq,action:{kind:r.seq===1?'native_track':'stop'}}));if(fail==='hudgone')omitHud=true;}}},
   captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose(){},findMulti:()=>({count:omitHud?1:2,0:{text:rows[0].text,x:75,y:246,width:230,height:33},1:{text:'高处60m',x:80,y:280,width:120,height:25}})}),
   RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers(){}},log:{info(){}},sleep:async()=>{},keyUp(){},
   isGameActive:()=>true,ensureGameFocus:async()=>true,getOwnedSceneObservation:()=>JSON.stringify({source:'bettergi_native_cv',ui:'Main',motion:'Normal'}),
   CancellationTokenSource:class{token={};cancelAfter(ms){assert.ok(ms<=60000);events.push('budget');}cancel(){events.push('cancel');}dispose(){events.push('dispose');}},
   runOwnedQuestTrack:async(ms,ignored,token)=>{assert.ok(ms<=60000);assert.equal(ignored,'');assert.ok(token);events.push('native');if(fail)throw Error('native test failure');return JSON.stringify({kind:'bgi-native-track',stopReason:'returned',verified:false});}
  };
  await vm.runInNewContext(source,ctx);
  assert.deepEqual(events,fail==='hudgone'?[]:['budget','native','cancel','dispose']);
  const receipt=JSON.parse(files.get('receipt.json'));assert.equal(receipt.state,fail===true?'error':'returned');
  if(fail!==true)assert.equal(JSON.parse(receipt.steps[0].detail).verified,false);
  if(fail==='hudgone'){const d=JSON.parse(receipt.steps[0].detail);assert.equal(d.stopReason,'hud_changed_or_missing');assert.equal(d.inputSent,false);}
 }
});
