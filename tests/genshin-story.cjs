const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const {validateDecision,decideWithRepair}=require('../src/genshin/story-runtime');
const request={texts:[{text:'前往任务地点'},{text:'开始追踪'}]};
const scene={scene:'world',uncertain:false};
test('resume keeps the model-selected quest detail panel, not unrelated quest list names',()=>{
 const {questFromEvidence}=require('../src/genshin/story-memory');
 const e={decision:{quest:'当前任务'},request:{texts:[{text:'任务专注模式'},{text:'当前任务',box:[800,120,200,40]},{text:'纳塔「流泉之众」',box:[800,170,200,30]},{text:'另一个任务',box:[100,200,200,30]}]},at:1};
 const memory=questFromEvidence(e,'test-evidence');assert.equal(memory.quest,'当前任务');assert.ok(memory.details.includes('纳塔「流泉之众」'));assert.ok(!memory.details.includes('另一个任务'));
 assert.equal(questFromEvidence({...e,decision:{quest:'另一个任务'}},'test-evidence'),null);
});
test('story navigation is accepted only as bounded local evidence tied to this frame',()=>{
 const {validateObservation}=require('../src/genshin/observe');
 const nav={marker:'not_visible',terrain:'open',movement:'standing',evidence:'未见世界标记，前方平地'};
 const v={source_image:'frame.png',mode:'genshin-story',model:'local-test',verification:'unverified_local_model_output',parsed:{...scene,summary:'角色站立',visible_text:[],navigation:nav}};
 assert.equal(validateObservation(v,'frame.png').navigation.marker,'not_visible');
 assert.throws(()=>validateObservation(v,'other.png'));
 assert.throws(()=>validateObservation({...v,parsed:{...v.parsed,navigation:{...nav,marker:'invented'}}},'frame.png'));
});
test('unsupported VLM distance changes cannot be presented as OCR corroborated progress',()=>{
 const {corroborateDistances}=require('../src/genshin/story-observation');
 const o={scene:'world',uncertain:false,summary:'目标142m，仍在前方',visible_text:['前往指定地点','12m']};
 const checked=corroborateDistances(o,[{text:'112m'}]);
 assert.deepEqual(checked.distanceEvidence.meters,[112]);
 assert.deepEqual(checked.distanceEvidence.unsupportedModelMeters,[12,142]);
 assert.ok(!checked.observation.summary.includes('142m'));
 assert.ok(!checked.observation.visible_text.includes('12m'));
 assert.equal(corroborateDistances(o,[]).distanceEvidence.status,'unknown');
 assert.deepEqual(corroborateDistances({...o,visible_text:['112m'],summary:'距离112m'},[{text:'112 m'}]).distanceEvidence.unsupportedModelMeters,[]);
});
test('task menu OCR corrects a false world classification and disables movement',()=>{
 const {corroborateDistances}=require('../src/genshin/story-observation');
 const o={scene:'world',uncertain:false,summary:'任务界面',visible_text:[],navigation:{marker:'center',terrain:'open',movement:'standing',evidence:'任务详情'}};
 const texts=[{text:'任务专注模式'},{text:'进行中'},{text:'神秘岛的传说'}];
 const fixed=corroborateDistances(o,texts);
 assert.equal(fixed.observation.scene,'menu');assert.equal(fixed.observation.navigation.marker,'not_visible');
 assert.throws(()=>validateDecision({action:{kind:'move',key:'W',ms:600}},{texts},fixed.observation));
 assert.equal(validateDecision({action:{kind:'key',key:'ESCAPE'}},{texts},fixed.observation).action.key,'ESCAPE');
 assert.equal(corroborateDistances(o,[{text:'神秘岛的传说'}]).observation.scene,'world');
});
test('conflicting and abruptly truncated OCR distances cannot become arrival evidence',()=>{
 const {corroborateDistances}=require('../src/genshin/story-observation');
 const o={...scene,summary:'目标6m',visible_text:['6m']};
 const conflict=corroborateDistances(o,[{text:'6m'},{text:'61m'}]);
 assert.equal(conflict.distanceEvidence.status,'conflicting_ocr');
 assert.deepEqual(conflict.distanceEvidence.meters,[]);
 assert.ok(!conflict.observation.summary.includes('6m'));
 const previous={observation:scene,decision:{action:{kind:'turn'}},distanceEvidence:{meters:[61]}};
 const jump=corroborateDistances(o,[{text:'6m'}],previous);
 assert.equal(jump.distanceEvidence.status,'unconfirmed_distance_jump');
 const confirmed=corroborateDistances(o,[{text:'6m'}],{...previous,distanceEvidence:jump.distanceEvidence});
 assert.deepEqual(confirmed.distanceEvidence.meters,[6]);
 assert.deepEqual(corroborateDistances(o,[{text:'6m'}],{...previous,decision:{action:{kind:'teleport'}}}).distanceEvidence.meters,[6]);
});
test('world quest distance grounding requires a unique label agreeing with current HUD',()=>{
 const {questDistanceLabel,corroborateDistances}=require('../src/genshin/story-observation');
 const texts=[{text:'前往指定地点',box:[78,252,295,29]},{text:'58m',box:[86,286,37,17]},{text:'58m',box:[1220,234,31,15]}];
 assert.equal(questDistanceLabel(texts).direction,'right');
 assert.equal(questDistanceLabel(texts.slice(0,2)),null);
 assert.equal(questDistanceLabel([...texts,{text:'58m',box:[800,400,30,20]}]),null);
 assert.equal(questDistanceLabel([...texts.slice(0,2),{text:'80m',box:[1220,234,31,15]}]),null);
 assert.equal(corroborateDistances({...scene,summary:'无标记',visible_text:[],navigation:{marker:'not_visible',terrain:'water'}},texts).observation.navigation.marker,'right');
 assert.equal(corroborateDistances({scene:'menu',uncertain:false,summary:'菜单',visible_text:[]},texts).observation.questDistanceLabel,undefined);
});
test('navigation memory keeps attempted waypoints across restarts for the current quest stage',()=>{
 const {navigationFromEvidence}=require('../src/genshin/story-memory');
 const row=(stage,kind,id,quest='任务A')=>({e:{request:{texts:[{text:stage,box:[80,250,300,30]}]},observation:scene,decision:{quest,action:{kind,id}}}});
 const rows=[row('前往新地点','move'),row('前往新地点','teleport','1254'),row('寻找旧目标','teleport','300'),row('前往新地点','teleport','400','任务B')];
 const memory=navigationFromEvidence(rows,'任务A');
 assert.equal(memory.stage,'前往新地点');assert.deepEqual(memory.teleportAttempts,['1254']);
 assert.throws(()=>validateDecision({action:{kind:'teleport',id:'1254'}},{texts:[],waypoints:[{id:'1254',x:1,y:2}],teleportAttempts:memory.teleportAttempts},scene));
});
test('teleport uses catalog coordinates, rejects invented IDs and ignores model coordinates',()=>{
 const r={...request,mapAreas:['清泉镇'],waypoints:[{id:'5',x:-874.22,y:1993.73}]};
 assert.deepEqual(validateDecision({action:{kind:'teleport',id:'5',x:999,y:999}},r,scene).action,{kind:'teleport',id:'5',x:-874.22,y:1993.73});
 assert.throws(()=>validateDecision({action:{kind:'teleport',id:'unknown'}},r,scene));
 assert.throws(()=>validateDecision({action:{kind:'teleport',id:'5'}},{...r,teleportAttempts:['5']},scene));
 assert.throws(()=>validateDecision({action:{kind:'list_waypoints',area:'unknown'}},r,scene));
 assert.throws(()=>validateDecision({action:{kind:'list_waypoints',area:'清泉镇'}},r,scene));
 assert.equal(validateDecision({action:{kind:'list_waypoints',area:'清泉镇'}},{...r,texts:[{text:'蒙德·清泉镇'}]},scene).action.area,'清泉镇');
 assert.throws(()=>validateDecision({action:{kind:'teleport',id:'5'}},r,{scene:'dialogue',uncertain:false}));
});
test('invalid model text is corrected or yields a fresh observation without executing it',async()=>{
 const signal=new AbortController().signal;let calls=0;
 const result=await decideWithRepair(async errors=>{calls++;return {text:JSON.stringify({action:errors.length?{kind:'key',key:'ESCAPE'}:{kind:'click_text',text:'不存在'}}),provider:'test'};},request,scene,signal);
 assert.equal(calls,2);assert.equal(result.decision.action.key,'ESCAPE');assert.equal(result.rejected.length,1);
 const failed=await decideWithRepair(async()=>({text:'invalid JSON'}),request,scene,signal);
 assert.equal(failed.decision.action.kind,'wait');assert.equal(failed.rejected.length,2);
 assert.throws(()=>validateDecision({action:{kind:'click_text',text:'重复'}},{texts:[{text:'重复'},{text:'重复'}]},scene));
});
test('story decisions use observed text and bounded actions; raw coordinates and arbitrary keys are not executed',()=>{
 assert.deepEqual(validateDecision({action:{kind:'click_text',text:'开始追踪',x:1,y:2}},request,scene).action,{kind:'click_text',text:'开始追踪'});
 for(const action of [{kind:'click_text',text:'不存在'},{kind:'key',key:'DELETE'},{kind:'move',key:'W',ms:10000},{kind:'fight'}])assert.throws(()=>validateDecision({action},request,scene));
 assert.throws(()=>validateDecision({action:{kind:'key',key:'J'}},request,{...scene,uncertain:true}));
 assert.throws(()=>validateDecision({action:{kind:'move',key:'W',ms:200}},request,{scene:'menu',uncertain:false}));
 assert.throws(()=>validateDecision({action:{kind:'turn',dx:601,dy:0}},request,scene));
 assert.throws(()=>validateDecision({action:{kind:'turn',dx:200,dy:0}},request,{scene:'menu',uncertain:false}));
 assert.deepEqual(validateDecision({action:{kind:'turn',dx:-300,dy:0}},request,scene).action,{kind:'turn',dx:-300,dy:0});
 assert.throws(()=>validateDecision({action:{kind:'turn',dx:-300,dy:0}},{...request,recentActions:[{kind:'turn'},{kind:'turn'},{kind:'turn'}]},{...scene,navigation:{marker:'not_visible'}}));
});
test('BGI story session rechecks text before clicking and retains one execution process for multiple steps',async()=>{
 const files=new Map(),inputs=[];let clicks=0;
 const command={id:'test',operation:'story',timeoutMs:600000};files.set('command.json',JSON.stringify(command));
 const context={JSON,Date,Number,String,Error,
  file:{readTextSync:name=>{if(!files.has(name))throw Error('not ready');return files.get(name);},writeTextSync:(name,value)=>{
   files.set(name,value);
   if(name==='story-request.json'){
    const r=JSON.parse(value),action=r.seq===1?{kind:'key',key:'J'}:r.seq===2?{kind:'click_text',text:'开始追踪'}:{kind:'stop'};
    files.set(`story-decision-${r.seq}.json`,JSON.stringify({id:r.id,seq:r.seq,action}));
   }
  },writeImageSync:()=>{}},
  captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose:()=>{},findMulti:()=>({count:1,0:{text:'开始追踪',click:()=>clicks++}})}),
  RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers:()=>{}},log:{info:()=>{}},sleep:async()=>{},
  keyDown:key=>inputs.push(['down',key]),keyUp:key=>inputs.push(['up',key])};
 await vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/genshin/story-main.js'),'utf8'),Object.assign({ensureGameFocus:async()=>true,isGameActive:()=>true},context));
 assert.deepEqual(inputs.slice(0,2),[['down','VK_J'],['up','VK_J']]);
 assert.ok(inputs.slice(2).every(([kind])=>kind==='up'),'final cleanup only releases keys');assert.equal(clicks,1);
 const receipt=JSON.parse(files.get('receipt.json'));assert.equal(receipt.state,'returned');assert.equal(receipt.steps.length,2);assert.equal(receipt.verified,false);
});
test('marker following stops on missing markers and releases held keys on movement failure',async()=>{
 const source=fs.readFileSync(require.resolve('../scripts/genshin/story-main.js'),'utf8');
 for(const failMovement of [false,true]){
  const files=new Map([['command.json',JSON.stringify({id:'follow',timeoutMs:600000})]]),inputs=[];let disposed=false,resets=0;
  const context={JSON,Date,Number,String,Math,Error,
   file:{readTextSync:n=>files.get(n),readImageMatSync:()=>({dispose:()=>{disposed=true;}}),writeImageSync:()=>{},writeTextSync:(n,v)=>{
    files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);files.set(`story-decision-${r.seq}.json`,JSON.stringify({id:r.id,seq:r.seq,action:{kind:r.seq===1?'follow_marker':'stop'}}));}
   }},
   captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose:()=>{},findMulti:ro=>ro.kind==='template'&&failMovement?{count:1,0:{x:950,y:400,width:20,height:20}}:{count:0}}),
   RecognitionObject:{ocr:()=>({kind:'ocr'}),templateMatch:()=>({kind:'template'})},dispatcher:{clearAllTriggers:()=>{}},log:{info:()=>{}},
   sleep:async ms=>{if(failMovement&&ms===500)throw Error('cancelled');},keyDown:k=>inputs.push(['down',k]),keyUp:k=>inputs.push(['up',k]),moveMouseBy:()=>{},middleButtonClick:()=>resets++};
  await vm.runInNewContext(source,Object.assign({ensureGameFocus:async()=>true,isGameActive:()=>true},context));
  assert.equal(disposed,true);assert.ok(inputs.some(([a,k])=>a==='up'&&k==='VK_W'));
  assert.equal(resets,failMovement?0:1);
  if(!failMovement)assert.ok(!inputs.some(([a,k])=>a==='down'&&k==='VK_W'));
  else assert.equal(JSON.parse(files.get('receipt.json')).state,'error');
 }
});
test('blue-only tracking works, overlapping templates merge and distinct targets prevent movement',async()=>{
 const source=fs.readFileSync(require.resolve('../scripts/genshin/story-main.js'),'utf8');
 for(const mode of ['blue','overlap','ambiguous','rear']){
  const files=new Map([['command.json',JSON.stringify({id:mode,timeoutMs:600000})]]);
  let moves=0,disposed=0,templateReads=0;const inputs=[];
  const ctx={JSON,Date,Number,String,Math,Set,Error,
   file:{readTextSync:n=>files.get(n),readImageMatSync:name=>({name,dispose:()=>disposed++}),writeImageSync:()=>{},writeTextSync:(n,v)=>{files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);files.set(`story-decision-${r.seq}.json`,JSON.stringify({id:r.id,seq:r.seq,action:{kind:r.seq===1?'follow_marker':'stop'}}));}}},
   captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose:()=>{},findMulti:ro=>{
    if(ro.kind!=='template')return {count:0};
    const frame=Math.floor(templateReads++/2);
    // Six real alignment positions previously exhausted the whole loop.
    if(mode==='rear'&&frame<6){const p=[[1156,818],[1248,794],[1385,736],[1550,457],[1331,240],[1163,187]][frame];return {count:1,0:{x:p[0]-10,y:p[1]-10,width:20,height:20}};}
    const blue=ro.name.includes('blue');if(mode==='blue'&&!blue)return {count:0};
    return {count:1,0:{x:mode==='ambiguous'&&!blue?600:950,y:400,width:20,height:20}};
   }}),
   RecognitionObject:{ocr:()=>({kind:'ocr'}),templateMatch:t=>({kind:'template',name:t.name})},dispatcher:{clearAllTriggers:()=>{}},log:{info:()=>{}},
   sleep:async()=>{},keyDown:k=>{inputs.push(k);if(k==='VK_W')moves++;},keyUp:()=>{},moveMouseBy:()=>{},middleButtonClick:()=>{}};
  await vm.runInNewContext(source,Object.assign({ensureGameFocus:async()=>true,isGameActive:()=>true},ctx));
  assert.equal(disposed,2);assert.equal(moves,mode==='ambiguous'?0:mode==='rear'?6:12);
  const receipt=JSON.parse(files.get('receipt.json'));assert.equal(receipt.state,'returned');
  const detail=JSON.parse(receipt.steps[0].detail),trace=detail.trace;
  assert.equal(detail.movedMs,mode==='ambiguous'?0:mode==='rear'?3000:6000);
  assert.equal(detail.stopReason,mode==='ambiguous'?'marker_missing_or_ambiguous':'iteration_budget');
  assert.equal(trace[0].matches,mode==='ambiguous'?2:1);
  if(mode==='blue')assert.deepEqual(trace[0].marker.templates,['quest-marker-blue.png']);
 }
});
test('local quest advance stops on increasing, stalled, missing or discontinuous distance and releases input',async()=>{
 const source=fs.readFileSync(require.resolve('../scripts/genshin/story-main.js'),'utf8');
 for(const [distances,expected] of [[[30,28,26,24,22,20,18,16,14],8],[[30,30,30],2],[[30,31],1],[[30,null],1],[[30,6],1]]){
  const files=new Map([['command.json',JSON.stringify({id:'advance',timeoutMs:600000})]]);let moves=0,held=false;
  const ctx={JSON,Date,Number,String,Math,Set,Error,
   file:{readTextSync:n=>files.get(n),writeImageSync:()=>{},writeTextSync:(n,v)=>{files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);files.set(`story-decision-${r.seq}.json`,JSON.stringify({id:r.id,seq:r.seq,action:r.seq===1?{kind:'advance_quest',key:'W'}:{kind:'stop'}}));}}},
   captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose:()=>{},findMulti:()=>{const d=distances[Math.min(moves,distances.length-1)];return d===null?{count:0}:{count:2,0:{text:'前往目标地点',x:80,y:250,width:280,height:30},1:{text:d+'m',x:86,y:286,width:40,height:20}};}}),
   RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers:()=>{}},log:{info:()=>{}},
   sleep:async ms=>{if(held&&ms===400)moves++;},keyDown:()=>{held=true;},keyUp:()=>{held=false;}};
  await vm.runInNewContext(source,Object.assign({ensureGameFocus:async()=>true,isGameActive:()=>true},ctx));
  assert.equal(moves,expected);assert.equal(held,false);assert.equal(JSON.parse(files.get('receipt.json')).state,'returned');
 }
 const good={...scene,navigation:{terrain:'open'}};
 assert.equal(validateDecision({action:{kind:'advance_quest',key:'W'}},{texts:[],distanceEvidence:{meters:[60]}},good).action.kind,'advance_quest');
 assert.throws(()=>validateDecision({action:{kind:'advance_quest',key:'W'}},{texts:[],distanceEvidence:{meters:[]}},good));
 assert.throws(()=>validateDecision({action:{kind:'advance_quest',key:'W'}},{texts:[],distanceEvidence:{meters:[60]}},{...good,navigation:{terrain:'wall'}}));
});
test('quest search area enables bounded exploration without requiring a distance or nonexistent marker',()=>{
 const {corroborateDistances}=require('../src/genshin/story-observation');
 const observed=corroborateDistances({...scene,summary:'区域搜索',visible_text:['已到达任务区域'],navigation:{terrain:'open',marker:'not_visible'}},[]).observation;
 assert.equal(observed.questArea.state,'search_area');assert.equal(observed.questArea.source,'local_vision');
 assert.deepEqual(validateDecision({action:{kind:'move',key:'W',ms:1600}},request,observed).action,{kind:'move',key:'W',ms:1600,areaSearch:true});
 assert.throws(()=>validateDecision({action:{kind:'follow_marker'}},request,observed));
 assert.throws(()=>validateDecision({action:{kind:'move',key:'W',ms:1600}},request,{...observed,navigation:{terrain:'wall'}}));
 const menu=corroborateDistances(observed,[{text:'商城'},{text:'队伍配置'},{text:'世界等级'}]).observation;
 assert.equal(menu.scene,'menu');assert.throws(()=>validateDecision({action:{kind:'move',key:'W',ms:1600}},request,menu));
});
test('native story segment exits cleanly before watchdog budget when a decision is still pending',async()=>{
 let now=0;const files=new Map([['command.json',JSON.stringify({id:'deadline',timeoutMs:90000})]]);
 const ctx={JSON,Date:{now:()=>now},Number,String,Math,Set,Error,
  file:{readTextSync:n=>files.get(n),writeImageSync:()=>{},writeTextSync:(n,v)=>files.set(n,v)},
  captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose:()=>{},findMulti:()=>({count:0})}),
  RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers:()=>{}},log:{info:()=>{}},sleep:async ms=>{now+=ms;},keyDown:()=>{throw Error('unexpected input');},keyUp:()=>{}};
 await vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/genshin/story-main.js'),'utf8'),Object.assign({ensureGameFocus:async()=>true,isGameActive:()=>true},ctx));
 const r=JSON.parse(files.get('receipt.json'));assert.equal(r.state,'returned');assert.ok(r.note.includes('分段'));assert.ok(now<90000);
});
test('network latency misread as meters cannot become quest distance; following tasks retain HUD grounding',()=>{
 const {corroborateDistances,questDistanceLabel}=require('../src/genshin/story-observation');
 const observation={...scene,summary:'24m',visible_text:['24m']};
 const ping={text:'24m',box:[1804,83,81,21]};
 const rejected=corroborateDistances(observation,[ping]);
 assert.deepEqual(rejected.distanceEvidence.meters,[]);
 assert.ok(!rejected.observation.summary.includes('24m'));
 const texts=[ping,{text:'跟随骗子向导',box:[78,252,147,29]},{text:'30m',source:'quest_distance_crop',box:[82,284,45,22]},{text:'30m',box:[980,400,45,22]}];
 assert.deepEqual(corroborateDistances(observation,texts).distanceEvidence.meters,[30]);
 assert.equal(questDistanceLabel(texts).direction,'center');
});
test('dialogue OCR distinguishes a same-named reply from the speaker and prevents repeated space',async()=>{
 const {corroborateDistances}=require('../src/genshin/story-observation');
 const texts=[{text:'派蒙',box:[1281,784,131,42]},{text:'派蒙',box:[926,856,71,36]},{text:'就是这里了，让我看看哪个像是骗子。',box:[706,913,495,29]}];
 const observed=corroborateDistances({...scene,summary:'误标世界',visible_text:[]},texts).observation;
 assert.equal(observed.scene,'dialogue');assert.equal(observed.dialogue.options.length,1);
 assert.equal(validateDecision({action:{kind:'choose_dialogue',text:'派蒙'}},{texts},observed).action.kind,'choose_dialogue');
 assert.throws(()=>validateDecision({action:{kind:'key',key:'SPACE'}},{texts},observed));
 assert.throws(()=>validateDecision({action:{kind:'move',key:'W',ms:400}},{texts},observed));
 assert.throws(()=>validateDecision({action:{kind:'choose_dialogue',text:'不存在'}},{texts},observed));
 for(const changed of [false,true]){
  const files=new Map([['command.json',JSON.stringify({id:'dialogue',timeoutMs:600000})]]);let clicks=0,reads=0;
  const ctx={JSON,Date,Number,String,Math,Set,Error,
   file:{readTextSync:n=>files.get(n),writeImageSync:()=>{},writeTextSync:(n,v)=>{files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);files.set(`story-decision-${r.seq}.json`,JSON.stringify({id:r.id,seq:r.seq,action:r.seq===1?{kind:'choose_dialogue',text:'派蒙'}:{kind:'stop'}}));}}},
   captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose:()=>{},findMulti:()=>{reads++;if(changed&&reads>=2)return {count:0};const rows=texts.map((t,i)=>({text:t.text,x:t.box[0],y:t.box[1],width:t.box[2],height:t.box[3],click:()=>{assert.equal(i,0);clicks++;}}));return {count:rows.length,...rows};}}),
   RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers:()=>{}},log:{info:()=>{}},sleep:async()=>{}};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/genshin/story-main.js'),'utf8'),Object.assign({ensureGameFocus:async()=>true,isGameActive:()=>true},ctx));
  assert.equal(clicks,changed?0:1);
 }
});
