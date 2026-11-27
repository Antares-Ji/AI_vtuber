const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const grounding=require('../scripts/genshin/story-main');
const {corroborateDistances}=require('../src/genshin/story-observation');
const {validateDecision}=require('../src/genshin/story-runtime');
const {questFromEvidence}=require('../src/genshin/story-memory');
// Recorded OCR geometry from native story c68ff4af..., step 7. No screenshot or UID.
const rows=[{text:'进行中',box:[140,32,77,31]},{text:'紧急修理',box:[872,119,143,43]},{text:'蒙德 苍风高地',box:[876,170,167,28]},{text:'委托任务',box:[188,451,103,28]},{text:'紧急修理',box:[170,500,103,29]},{text:'世界任务',box:[184,854,109,34]},{text:'任务总览',box:[244,1001,121,36]},{text:'追踪目标',box:[1612,1001,121,36]}];
const world={scene:'world',uncertain:false,summary:'任务界面',visible_text:[],navigation:{terrain:'open',marker:'not_visible'}};
// Native 0d57f0f5..., steps 21/25: left header/category missing, right detail intact.
// Keep recorded OCR text/geometry; omit account information and unrelated rows.
const detailFixtures=[[874,121,139,37],[872,119,143,43]].map(box=>[
 {text:'紧急修理',box},{text:' 蒙德 苍风高地',box:[876,170,167,28]},
 {text:'前去查看详情',box:[924,252,153,29]},
 {text:'法拉正准备运货去醉汉峡附近，向路过的商队兜售货物，但是货车却被丘丘人袭击，货',box:[876,314,895,28]},
 {text:'物和他自己都陷入了危险的境地…',box:[874,343,363,27]},
 {text:'商城',box:[172,443,45,23]},{text:'モ任务',box:[222,447,73,36]},
 {text:'修理',box:[220,495,57,37]},{text:'界任务',box:[228,854,67,34]},
 {text:'任务总览',box:[244,1001,121,36]},{text:'停止追踪',box:[1612,1001,121,36]}
]);
test('recorded partial task lists expose only complete right-hand quest detail',()=>{
 for(const texts of detailFixtures){
  const menu=grounding.questMenu(texts);
  assert.equal(menu.title,'紧急修理');assert.equal(menu.listIncomplete,true);
  assert.deepEqual(menu.entries,[]);assert.deepEqual(menu.controls.map(t=>t.text),['停止追踪']);
  assert.equal(grounding.movementStop(texts),'menu');
  const scene=corroborateDistances(world,texts).observation;
  assert.equal(scene.scene,'menu');assert.equal(scene.questMenu.listIncomplete,true);
  assert.throws(()=>validateDecision({action:{kind:'follow_marker'}},{texts},scene));
  assert.throws(()=>validateDecision({action:{kind:'click_text',text:'修理',scope:'quest_list'}},{texts,focusQuest:'紧急修理'},scene));
  assert.throws(()=>validateDecision({action:{kind:'click_text',text:'修理'}},{texts,focusQuest:'紧急修理'},scene));
 }
});
test('partial detail needs unique title/control, stage and two distinct body rows',()=>{
 const fixture=detailFixtures[0];
 for(const texts of [
  fixture.filter(t=>t.text!=='前去查看详情'),
  fixture.filter(t=>t.text!=='停止追踪'),
  fixture.filter(t=>t.box[1]!==343),
  fixture.filter(t=>t.box[1]!==343).concat(fixture.find(t=>t.box[1]===314)),
  [...fixture,{text:'另一任务',box:[1100,121,139,37]}],
  [...fixture,{text:'开始追踪',box:[1450,1001,121,36]}],
  fixture.map(t=>t.text==='停止追踪'?{...t,box:[200,1001,121,36]}:t)
 ])assert.equal(grounding.questMenu(texts),null);
});
test('recorded new task menu is grounded without legacy focus-mode text',()=>{
 const result=corroborateDistances(world,rows).observation;
 assert.equal(result.scene,'menu');assert.equal(result.questMenu.title,'紧急修理');
 assert.equal(grounding.movementStop(rows),'menu');
 assert.throws(()=>validateDecision({action:{kind:'follow_marker'}},{texts:rows},result));
 const memory=questFromEvidence({request:{texts:rows},decision:{quest:'紧急修理'},at:1},'fixture');
 assert.equal(memory.quest,'紧急修理');assert.ok(memory.details.includes('蒙德 苍风高地'));
 assert.equal(grounding.questMenu(rows.filter(t=>!['任务总览','追踪目标'].includes(t.text))),null);
 assert.equal(grounding.questMenu([{text:'追踪目标',box:[1612,1001,121,36]}]),null);
 const distances=grounding.questMenu([...rows,{text:'845m',box:[170,532,57,23]},{text:'固若金汤',box:[176,766,101,29]},{text:'224m',box:[170,793,62,29]}]).entries;
 assert.equal(distances.find(t=>t.text==='紧急修理').distanceMeters,845);assert.equal(distances.find(t=>t.text==='固若金汤').distanceMeters,224);
});
test('task-list scope separates detail title but never resolves multiple list matches',()=>{
 const scene=corroborateDistances(world,rows).observation,action={kind:'click_text',text:'紧急修理',scope:'quest_list'};
 assert.deepEqual(validateDecision({action},{texts:rows},scene).action,action);
 assert.throws(()=>validateDecision({action:{kind:'click_text',text:'紧急修理'}},{texts:rows},scene));
 assert.throws(()=>validateDecision({action},{texts:[...rows,{text:'紧急修理',box:[170,600,103,29]}]},scene));
 assert.throws(()=>validateDecision({action},{texts:rows},world));
 assert.throws(()=>validateDecision({action:{...action,scope:'anything'}},{texts:rows},scene));
});
test('pinned quest rejects refresh-by-switch and tracking a different detail panel',()=>{
 const other={text:'古云有「螭」',box:[170,700,150,29]},texts=[...rows,other];
 const request={texts,focusQuest:'紧急修理'},scene=corroborateDistances(world,texts).observation;
 assert.throws(()=>validateDecision({quest:'紧急修理',action:{kind:'click_text',text:other.text,scope:'quest_list'}},request,scene));
 assert.throws(()=>validateDecision({quest:other.text,action:{kind:'wait'}},request,scene));
 assert.equal(validateDecision({quest:'紧急修理',action:{kind:'click_text',text:'紧急修理',scope:'quest_list'}},request,scene).action.focusQuest,'紧急修理');
 assert.equal(validateDecision({action:{kind:'click_text',text:'追踪目标'}},request,scene).action.focusQuest,'紧急修理');
 const changed=texts.map(t=>t.box[0]===872?{...t,text:other.text}:t);
 assert.throws(()=>validateDecision({action:{kind:'click_text',text:'追踪目标'}},{...request,texts:changed},corroborateDistances(world,changed).observation));
 assert.throws(()=>validateDecision({action:{kind:'complete_quest',quest:'紧急修理'}},request,scene));
 const complete=[{text:'任务完成',box:[800,200,200,50]},{text:'紧急修理',box:[800,260,200,40]}];
 assert.equal(validateDecision({action:{kind:'complete_quest',quest:'紧急修理'}},{focusQuest:'紧急修理',texts:complete},world).action.kind,'complete_quest');
});
test('native scoped click rechecks menu layout and selects only the list entry',async()=>{
 for(const changed of ['none','world','duplicate']){
  let seq=0,clicks=0;const files=new Map([['command.json',JSON.stringify({id:'menu',timeoutMs:600000})]]);
  const context={JSON,Date,Number,String,Math,Set,Error,
   file:{readTextSync:n=>files.get(n),writeImageSync(){},writeTextSync(n,v){files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);seq=r.seq;files.set(`story-decision-${seq}.json`,JSON.stringify({id:r.id,seq,action:seq===1?{kind:'click_text',text:'紧急修理',scope:'quest_list'}:{kind:'stop'}}));}}},
   captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose(){},findMulti(){const items=seq&&changed==='world'?[]:seq&&changed==='duplicate'?[...rows,{text:'紧急修理',box:[170,600,103,29]}]:rows;return {count:items.length,...items.map(t=>({text:t.text,x:t.box[0],y:t.box[1],width:t.box[2],height:t.box[3],click(){assert.equal(t.box[0],170);clicks++;}}))};}}),
   RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers(){}},log:{info(){}},sleep:async()=>{}};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/genshin/story-main'),'utf8'),Object.assign({ensureGameFocus:async()=>true,isGameActive:()=>true},context));
  assert.equal(clicks,changed==='none'?1:0);assert.equal(JSON.parse(files.get('receipt.json')).state,'returned');
 }
});
test('native pinned tracking click refuses a late change to another quest',async()=>{
 for(const changed of [false,true]){
  let seq=0,clicks=0;const files=new Map([['command.json',JSON.stringify({id:'pin',timeoutMs:600000})]]);
  const context={JSON,Date,Number,String,Math,Set,Error,
   file:{readTextSync:n=>files.get(n),writeImageSync(){},writeTextSync(n,v){files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);seq=r.seq;files.set(`story-decision-${seq}.json`,JSON.stringify({id:r.id,seq,action:seq===1?{kind:'click_text',text:'追踪目标',focusQuest:'紧急修理'}:{kind:'stop'}}));}}},
   captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose(){},findMulti(){const items=rows.map(t=>seq&&changed&&t.box[0]===872?{...t,text:'古云有「螭」'}:t);return {count:items.length,...items.map(t=>({text:t.text,x:t.box[0],y:t.box[1],width:t.box[2],height:t.box[3],click(){clicks++;}}))};}}),
   RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers(){}},log:{info(){}},sleep:async()=>{}};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/genshin/story-main'),'utf8'),Object.assign({ensureGameFocus:async()=>true,isGameActive:()=>true},context));
  assert.equal(clicks,changed?0:1);
 }
});
test('native refuses scoped and unscoped clicks on incomplete task-list rows',async()=>{
 for(const scope of [undefined,'quest_list']){
  let clicks=0;const files=new Map([['command.json',JSON.stringify({id:'partial',timeoutMs:600000})]]);
  const context={JSON,Date,Number,String,Math,Set,Error,
   file:{readTextSync:n=>files.get(n),writeImageSync(){},writeTextSync(n,v){files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);files.set(`story-decision-${r.seq}.json`,JSON.stringify({id:r.id,seq:r.seq,action:r.seq===1?{kind:'click_text',text:'修理',scope,focusQuest:'紧急修理'}:{kind:'stop'}}));}}},
   captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose(){},findMulti(){const items=detailFixtures[0];return {count:items.length,...items.map(t=>({text:t.text,x:t.box[0],y:t.box[1],width:t.box[2],height:t.box[3],click(){clicks++;}}))};}}),
   RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers(){}},log:{info(){}},sleep:async()=>{},ensureGameFocus:async()=>true,isGameActive:()=>true};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/genshin/story-main'),'utf8'),context);
  assert.equal(clicks,0);assert.equal(JSON.parse(files.get('receipt.json')).state,'returned');
 }
});
