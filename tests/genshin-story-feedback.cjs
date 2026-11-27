const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const grounding=require('../scripts/genshin/story-main');
const {validateDecision}=require('../src/genshin/story-runtime');
const source=fs.readFileSync(require.resolve('../scripts/genshin/story-main'),'utf8');
const world={scene:'world',uncertain:false,navigation:{terrain:'open'}};
const prompt=[{text:'F',box:[1100,400,25,30]},{text:'骗子向导',box:[1160,400,130,30]}];
const dialogue=[{text:'派蒙',box:[926,856,71,36]},{text:'就是这里了，让我看看哪个像是骗子。',box:[706,913,495,29]}];
const hud=d=>[{text:'跟随骗子向导',box:[80,250,280,30]},{text:d+'m',box:[86,286,40,20]}];
const step=(kind,detail,extra={})=>({action:{kind,...extra},detail:JSON.stringify(detail)});
async function native(actions,read,{marker=null,distance=null,cancelF=false}={}){
 const files=new Map([['command.json',JSON.stringify({id:'feedback',timeoutMs:600000})]]);
 const state={seq:0,reads:0,moves:0,turns:0,f:0,resets:0,held:new Set(),inputs:[]};
 const ctx={JSON,Date,Number,String,Math,Set,Error,
  file:{readTextSync:n=>files.get(n),readImageMatSync:()=>({dispose(){}}),writeImageSync(){},writeTextSync(n,v){
   files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);state.seq=r.seq;files.set(`story-decision-${r.seq}.json`,JSON.stringify({id:r.id,seq:r.seq,action:actions[r.seq-1]||{kind:'stop'}}));}
  }},
  captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose(){},findMulti(ro){
   if(ro.kind==='template')return marker?{count:1,0:{x:marker[0]-10,y:marker[1]-10,width:20,height:20}}:{count:0};
   const crop=ro.w===130;
   const rows=(crop&&distance!==null?[{text:String(typeof distance==='function'?distance(state):distance)+'m',box:[900,450,40,20]}]:read(state)).map(t=>({text:t.text,x:t.box[0],y:t.box[1],width:t.box[2],height:t.box[3]}));
   if(!crop)state.reads++;return {count:rows.length,...rows};
  }}),
  RecognitionObject:{ocr:(x,y,w,h)=>({kind:'ocr',w,h}),templateMatch:()=>({kind:'template'})},dispatcher:{clearAllTriggers(){}},log:{info(){}},
  sleep:async()=>{if(cancelF&&state.held.has('VK_F'))throw Error('cancelled');},
  keyDown(k){state.held.add(k);state.inputs.push(k);if(k==='VK_W')state.moves++;if(k==='VK_F')state.f++;},keyUp:k=>state.held.delete(k),moveMouseBy(x,y){if(y===0)state.turns++;},middleButtonClick(){state.resets++;}
 };
 await vm.runInNewContext(source,Object.assign({ensureGameFocus:async()=>true,isGameActive:()=>true},ctx));
 return {...state,receipt:JSON.parse(files.get('receipt.json'))};
}
test('F requires an in-world unique anchor-label pair, rejects menus, ambiguity and consumption',()=>{
 const act={action:{kind:'key',key:'F'}};
 assert.equal(validateDecision(act,{texts:prompt},world).action.text,'骗子向导');
 for(const texts of [[],prompt.slice(1),[...prompt,{text:'另一个目标',box:[1160,403,160,30]}],[...prompt,...dialogue],prompt.map(t=>({...t,box:[t.box[0],100,t.box[2],t.box[3]]})),[prompt[0],{...prompt[1],text:'购买'}]])assert.throws(()=>validateDecision(act,{texts},world));
 assert.throws(()=>validateDecision(act,{texts:prompt},{...world,scene:'menu'}));
 assert.throws(()=>validateDecision({action:{kind:'key',key:'F',text:'旧目标'}},{texts:prompt},world));
 assert.equal(grounding.interaction([{text:'F',box:[1100,400,25,30]}]).state,'ambiguous');
});
test('native F rechecks a stale target and never treats disappearance as verified success',async()=>{
 for(const mode of ['changed','unchanged','dialogue','disappeared']){
  const r=await native([{kind:'key',key:'F',text:'骗子向导'}],s=>mode==='changed'&&s.seq?[]:s.f?mode==='dialogue'?dialogue:mode==='disappeared'?[]:prompt:prompt);
  assert.equal(r.f,mode==='changed'?0:1);assert.equal(r.held.size,0);
  const d=JSON.parse(r.receipt.steps[0].detail);
  assert.equal(d.verified,false);
  assert.equal(d.outcome,{changed:'target_changed_or_ambiguous',unchanged:'prompt_unchanged',dialogue:'scene_changed',disappeared:'prompt_changed_or_missing'}[mode]);
 }
});
test('F cancellation releases input and does not send a second press',async()=>{
 const r=await native([{kind:'key',key:'F',text:'骗子向导'}],()=>prompt,{cancelF:true});
 assert.equal(r.receipt.state,'error');assert.equal(r.f,1);assert.equal(r.held.size,0);
});
test('two unchanged F receipts block the third press across waits in both validators',async()=>{
 const f={kind:'key',key:'F',text:'骗子向导'};
 const r=await native([f,{kind:'wait'},f,f],()=>prompt);
 assert.equal(r.f,2);assert.equal(JSON.parse(r.receipt.steps[3].detail).outcome,'retry_limit');
 assert.throws(()=>validateDecision({action:f},{texts:prompt,recentNativeSteps:r.receipt.steps.slice(0,3)},world));
});
test('all movement modes yield to F or dialogue without pressing F automatically',async()=>{
 for(const action of [{kind:'move',key:'W',ms:600},{kind:'move',key:'W',ms:1600,areaSearch:true},{kind:'advance_quest',key:'W'},{kind:'follow_marker'}]){
  for(const cue of [prompt,dialogue]){
   const r=await native([action],s=>[...hud(30-s.moves),...(s.moves?cue:[])],{marker:[960,410]});
   assert.equal(r.moves,1);assert.equal(r.f,0);assert.equal(r.held.size,0);
   const d=JSON.parse(r.receipt.steps[0].detail);
   assert.equal(d.stopReason,cue===prompt?'interaction_prompt':'dialogue');
   if(action.kind==='follow_marker')assert.equal(r.resets,0);
  }
 }
 const immediate=await native([{kind:'move',key:'W',ms:600}],()=>prompt);
 assert.equal(immediate.moves,0);
});
test('stationary marker alignment stops after three ineffective turns; stalled distance stops walking',async()=>{
 const aligned=await native([{kind:'follow_marker'}],()=>[],{marker:[1300,410]});
 assert.equal(aligned.turns,3);assert.equal(aligned.moves,0);
 assert.equal(JSON.parse(aligned.receipt.steps[0].detail).stopReason,'alignment_stalled');
 const stalled=await native([{kind:'follow_marker'}],()=>[],{marker:[960,410],distance:30});
 assert.equal(stalled.moves,2);assert.equal(JSON.parse(stalled.receipt.steps[0].detail).stopReason,'distance_stalled');
 const away=await native([{kind:'follow_marker'}],()=>[],{marker:[960,410],distance:s=>30+3*s.moves});
 assert.equal(away.moves,1);assert.equal(JSON.parse(away.receipt.steps[0].detail).stopReason,'distance_increased');
});
test('failed marker sessions remain blocked across waits and camera turns, recover after movement',()=>{
 const failed=step('follow_marker',{movedMs:0,stopReason:'marker_missing_or_ambiguous'});
 const steps=[failed,step('wait',{}),failed,step('turn',{})];
 assert.equal(grounding.navigationFeedback(steps).blocked,true);
 assert.throws(()=>validateDecision({action:{kind:'follow_marker'}},{texts:[],recentNativeSteps:steps},world));
 assert.equal(grounding.navigationFeedback([...steps,step('move',{movedMs:400})]).blocked,false);
 assert.equal(grounding.navigationFeedback([...steps,step('move',{movedMs:0})]).blocked,true);
});
test('OCR stage truncation preserves waypoint attempts; a new stage needs two fresh readings',()=>{
 const {updateNavigationStage,navigationFromEvidence}=require('../src/genshin/story-memory');
 let s={stage:'前往指定地点引诱骗子露面',pending:null};
 for(const reading of ['前往指定地点引诱','前往指定地点引诱骗','前往指定地点引诱习','跟随']){
  s=updateNavigationStage(s,reading);assert.equal(s.changed,false);assert.equal(s.stage,'前往指定地点引诱骗子露面');
 }
 s=updateNavigationStage(s,'跟随骗子向导');assert.equal(s.changed,false);
 s=updateNavigationStage(s,'跟随骗子向导');assert.equal(s.changed,true);
 const row=(stage,id)=>({e:{decision:{quest:'任务',action:{kind:'teleport',id}},request:{texts:[{text:stage,box:[80,250,280,30]}]}}});
 const memory=navigationFromEvidence([row('前往指定地点引诱骗','1'),row('前往指定地点引诱骗子露面','2')],'任务');
 assert.deepEqual(memory.teleportAttempts,['1','2']);
});
