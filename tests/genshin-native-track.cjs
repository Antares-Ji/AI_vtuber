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
 for(const target of ['呼叫','上行','下行','开门']){
  assert.equal(g.repeatedIncidentalInteraction(rows,target,{[target]:2}),false);
  const prompt=[rows[0],{source:'bettergi_native_f_label',text:target,count:1,anchor:[1100,500,30,30],box:[1150,500,200,30]}];
  assert.doesNotThrow(()=>validateDecision({action:{kind:'key',key:'F',text:target}},{texts:prompt,interactionVisits:{[target]:2}},{scene:'world',uncertain:false}));
 }
 assert.equal(g.traversalTarget('呼叫某商人'),false);
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
test('image short-move recovery requires matched native inputs and independent unchanged HUD',()=>{
 const {movementStallEvidence}=require('../src/genshin/story-memory');
 const frame=(seq,meters=46)=>({id:'stalled',seq,capturedAt:seq*1000,texts:[rows[0],{...rows[1],text:`高处${meters}m`}],nativeVision:{ui:'Main',motion:'Normal'},lastStep:seq===1?null:{seq:seq-1,action:{kind:'move',key:'W',ms:400},finishedAt:seq*1000-100,detail:JSON.stringify({movedMs:400,verified:false})}});
 const history=[1,2,3].map(n=>({request:frame(n)})),current=frame(4);
 assert.equal(movementStallEvidence(history,current).stalled,true);
 for(const c of [{...current,id:'other'},{...current,lastStep:null},{...current,lastStep:{...current.lastStep,seq:1}},{...current,lastStep:{...current.lastStep,detail:'{"movedMs":0}'}},frame(4,40),{...current,nativeVision:{ui:'Main',motion:'Climb'}},{...current,capturedAt:1000000}])
  assert.equal(movementStallEvidence(history,c).stalled,false);
 assert.equal(movementStallEvidence(history.slice(1),current).stalled,false);
 const gradual=[frame(1,27),frame(2,26),frame(3,25)].map(request=>({request}));
 assert.equal(movementStallEvidence(gradual,frame(4,24)).stalled,false,'three one-metre gains are real cumulative progress');
 const detour=[frame(1,27),frame(2,28),frame(3,29)].map(request=>({request}));
 assert.equal(movementStallEvidence(detour,frame(4,30)).stalled,false,'a measurable detour is not a stationary character');
 const recovered={...current,lastStep:{...current.lastStep,action:{kind:'native_unstuck'}}};
 assert.equal(movementStallEvidence(history,recovered).stalled,false);
});
test('reacquired map coordinates must be fresh stable BGI samples and never just a success flag',()=>{
 const {freshMapPosition}=require('../src/genshin/story-memory');
 const r={capturedAt:20000,position:{source:'bettergi_minimap_cv',stable:true,samples:[{x:100,y:200,at:19500},{x:101,y:201,at:19800}]}};
 assert.equal(freshMapPosition(r),true);
 for(const p of [{...r.position,source:'model'},{...r.position,samples:[]},{...r.position,stable:false},{...r.position,samples:[r.position.samples[0],{x:200,y:300,at:19800}]},{...r.position,samples:r.position.samples.map(s=>({...s,at:10000}))},{...r.position,samples:r.position.samples.map(s=>({...s,at:21000}))}])assert.equal(freshMapPosition({...r,position:p}),false);
});
test('camera zoom is an explicit model choice and requires the BGI capability and world scene',()=>{
 const request={texts:rows,capabilities:{nativeCameraZoom:true}},observation={scene:'world'};
 assert.deepEqual(validateDecision({action:{kind:'reset_camera',zoomOut:true}},request,observation).action,{kind:'reset_camera',zoomOut:true});
 for(const [r,o,a] of [[{texts:rows},observation,{kind:'reset_camera',zoomOut:true}],[request,{scene:'menu'},{kind:'reset_camera',zoomOut:true}],[request,observation,{kind:'reset_camera',zoomOut:-6}]])assert.throws(()=>validateDecision({action:a},r,o));
 assert.deepEqual(validateDecision({action:{kind:'reset_camera'}},request,observation).action,{kind:'reset_camera'});
});
test('BGI zoom uses bounded native scroll only after fresh Main UI and releases input on refusal',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../scripts/genshin/story-main.js'),'utf8');
 for(const changed of [false,true]){
  let ui='Main';const events=[],files=new Map([['command.json',JSON.stringify({id:'camera-test',timeoutMs:600000})]]);
  const ctx={JSON,Date,Number,String,Math,Set,Error,
   file:{readTextSync:n=>files.get(n),writeImageSync(){},writeTextSync(n,v){files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);files.set('story-decision-'+r.seq+'.json',JSON.stringify({id:r.id,seq:r.seq,action:r.seq===1?{kind:'reset_camera',zoomOut:true}:{kind:'stop'}}));if(changed)ui='Talk';}}},
   captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose(){},findMulti:()=>({count:2,0:{text:rows[0].text,x:75,y:246,width:230,height:33},1:{text:'高处60m',x:80,y:280,width:120,height:25}})}),
   RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers(){}},log:{info(){}},sleep:async()=>{},keyUp:k=>events.push(['up',k]),
   isGameActive:()=>true,ensureGameFocus:async()=>true,getOwnedSceneObservation:()=>JSON.stringify({source:'bettergi_native_cv',ui,motion:'Normal'}),verticalScroll:n=>events.push(['scroll',n]),middleButtonClick:()=>events.push(['middle'])};
  await vm.runInNewContext(source,ctx);
  assert.deepEqual(events.filter(e=>e[0]!=='up'),changed?[]:[['scroll',-6],['middle']]);
  assert.ok(events.some(e=>e[0]==='up'&&e[1]==='VK_W'));
  const receipt=JSON.parse(files.get('receipt.json'));assert.equal(receipt.state,'returned');
  if(changed)assert.equal(JSON.parse(receipt.steps[0].detail).inputSent,false);
  if(!changed)assert.equal(JSON.parse(receipt.steps[0].detail).zoomOutSent,true);
 }
});
test('a Climb to Normal transition skips X and continues to a fresh observation',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../scripts/genshin/story-main.js'),'utf8');
 let motion='Climb';const requests=[],pressed=[],files=new Map([['command.json',JSON.stringify({id:'climb-transition',timeoutMs:600000})]]);
 const ctx={JSON,Date,Number,String,Math,Set,Error,
  file:{readTextSync:n=>files.get(n),writeImageSync(){},writeTextSync(n,v){files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);requests.push(r);files.set('story-decision-'+r.seq+'.json',JSON.stringify({id:r.id,seq:r.seq,action:r.seq===1?{kind:'key',key:'X'}:{kind:'stop'}}));motion='Normal';}}},
  captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose(){},findMulti:()=>({count:2,0:{text:rows[0].text,x:75,y:246,width:230,height:33},1:{text:'高处60m',x:80,y:280,width:120,height:25}})}),
  RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers(){}},log:{info(){}},sleep:async()=>{},keyDown:k=>pressed.push(k),keyUp(){},
  isGameActive:()=>true,ensureGameFocus:async()=>true,getOwnedSceneObservation:()=>JSON.stringify({source:'bettergi_native_cv',ui:'Main',motion})};
 await vm.runInNewContext(source,ctx);
 assert.deepEqual(pressed,[]);assert.equal(requests.length,2);assert.equal(requests[1].nativeVision.motion,'Normal');
 const receipt=JSON.parse(files.get('receipt.json'));assert.equal(receipt.state,'returned');assert.equal(JSON.parse(receipt.steps[0].detail).stopReason,'motion_changed');assert.equal(JSON.parse(receipt.steps[0].detail).inputSent,false);
});
test('camera-loop recovery counts executed same-stage turns and resets on movement or mismatched receipts',()=>{
 const {rotationLoopEvidence}=require('../src/genshin/story-memory');
 const frame=n=>({id:'camera',seq:n,capturedAt:n*1000,texts:rows,nativeVision:{ui:'Main',motion:'Normal'},lastStep:{seq:n-1,action:{kind:'turn',dx:200,dy:0},finishedAt:n*1000-100}});
 const history=[1,2,3,4].map(n=>({request:frame(n)})),current=frame(5);
 assert.equal(rotationLoopEvidence(history,current).repeated,true);
 for(const edit of [{id:'other'},{capturedAt:200000},{nativeVision:{ui:'Talk',motion:'Normal'}},{lastStep:{...current.lastStep,seq:1}},{lastStep:{...current.lastStep,action:{kind:'move'}}}])assert.equal(rotationLoopEvidence(history,{...current,...edit}).repeated,false);
 assert.equal(rotationLoopEvidence(history.slice(1),current).repeated,true);
 assert.equal(rotationLoopEvidence(history.slice(2),current).repeated,false);
 const idle={...frame(6),lastStep:{...frame(6).lastStep,action:{kind:'wait'}}};
 assert.equal(rotationLoopEvidence([...history,{request:current}],idle).repeated,true);
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
test('V tracking takes two BGI samples after release and keeps the final frame and input cleanup',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../scripts/genshin/story-main.js'),'utf8');
 let now=10000;const keys=new Set(),images=[],requests=[],files=new Map([['command.json',JSON.stringify({id:'burst-test',timeoutMs:600000})]]);
 const ctx={JSON,Date:{now:()=>now},Number,String,Math,Set,Error,
  file:{readTextSync:n=>files.get(n),writeImageSync(n){if(n.startsWith('tracking-'))assert.equal(keys.size,0);images.push(n);},writeTextSync(n,v){files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);requests.push(r);files.set('story-decision-'+r.seq+'.json',JSON.stringify({id:r.id,seq:r.seq,action:r.seq===1?{kind:'key',key:'V'}:{kind:'stop'}}));}}},
  captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose(){},findMulti:()=>({count:2,0:{text:rows[0].text,x:75,y:246,width:230,height:33},1:{text:'高处60m',x:80,y:280,width:120,height:25}})}),
  RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers(){}},log:{info(){}},sleep:async ms=>{now+=ms;},keyDown:k=>keys.add(k),keyUp:k=>keys.delete(k),
  isGameActive:()=>true,ensureGameFocus:async()=>true,getOwnedSceneObservation:()=>JSON.stringify({source:'bettergi_native_cv',ui:'Main',motion:'Normal'})};
 await vm.runInNewContext(source,ctx);
 const receipt=JSON.parse(files.get('receipt.json'));assert.equal(receipt.state,'returned');
 const d=JSON.parse(requests[1].lastStep.detail);assert.equal(d.inputSent,true);assert.equal(d.samples.length,2);
 assert.equal(d.samples[1].capturedAt-d.samples[0].capturedAt,1000);assert.ok(requests[1].capturedAt-d.samples[1].capturedAt>=1500);
 assert.ok(images.includes('tracking-1-500.png'));assert.ok(images.includes('tracking-1-1500.png'));assert.equal(keys.size,0);
});
test('turn receipts expose BGI yaw wraparound and preserve unavailable readings as null',async()=>{
 const fs=require('node:fs'),vm=require('node:vm'),source=fs.readFileSync(require.resolve('../scripts/genshin/story-main.js'),'utf8');
 for(const samples of [[355,5],[5,355],[NaN,undefined]]){
  const angles=[...samples],moves=[],requests=[],files=new Map([['command.json',JSON.stringify({id:'turn-yaw',timeoutMs:600000})]]);
  const ctx={JSON,Date,Number,String,Math,Set,Error,
   file:{readTextSync:n=>files.get(n),writeImageSync(){},writeTextSync(n,v){files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);requests.push(r);files.set('story-decision-'+r.seq+'.json',JSON.stringify({id:r.id,seq:r.seq,action:r.seq===1?{kind:'turn',dx:200,dy:0}:{kind:'stop'}}));}}},
   captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose(){},findMulti:()=>({count:2,0:{text:rows[0].text,x:75,y:246,width:230,height:33},1:{text:'高处60m',x:80,y:280,width:120,height:25}})}),
   RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers(){}},log:{info(){}},sleep:async()=>{},keyUp(){},
   isGameActive:()=>true,ensureGameFocus:async()=>true,getOwnedSceneObservation:()=>JSON.stringify({source:'bettergi_native_cv',ui:'Main',motion:'Normal'}),
   genshin:{getCameraOrientation:()=>angles.shift()},moveMouseBy:(x,y)=>moves.push([x,y])};
  await vm.runInNewContext(source,ctx);
  assert.deepEqual(moves,[[200,0]]);
  const d=JSON.parse(requests[1].lastStep.detail);
  assert.equal(d.kind,'camera-turn');assert.equal(d.inputSent,true);assert.equal(d.verified,false);
  assert.equal(d.cameraOrientation.source,'bettergi_native_cv');assert.equal(d.cameraOrientation.scope,'horizontal_yaw_only');
  assert.equal(d.cameraOrientation.deltaDegrees,Number.isFinite(samples[0])?(samples[0]===355?10:-10):null);
  if(!Number.isFinite(samples[0]))assert.equal(d.cameraOrientation.before,null);
  const {compactHistory}=require('../src/genshin/story-prompt');
  const history=compactHistory({nativeId:'turn-yaw',lastNativeStep:requests[1].lastStep});
  assert.deepEqual(history.recentNativeSteps[0].cameraOrientation,d.cameraOrientation);
 }
});
