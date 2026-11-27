const {test}=require('node:test'),assert=require('node:assert/strict');
const grounding=require('../scripts/genshin/story-main');
const {questStage}=require('../src/genshin/story-memory');
const observation=require('../src/genshin/story-observation');
const hud=(text='前去查看详情')=>({text,box:[78,252,295,29]});
const world={scene:'world',uncertain:false,summary:'当前大世界',visible_text:[]};
function menuTexts(title='紧急修理',control='停止追踪'){
 return [{text:'进行中',box:[100,70,120,30]},
  {text:'委托任务',box:[80,200,160,30]},
  {text:title,box:[800,120,300,35]},
  {text:title,box:[100,300,220,30]},
  {text:'任务总览',box:[1200,980,180,35]},
  {text:control,box:[1500,980,180,35]}];
}
function menuObservation(texts){return {scene:'menu',uncertain:false,questMenu:grounding.questMenu(texts)};}
test('quest instruction and persisted stage recognize 前去 together with existing HUD verbs',()=>{
 assert.equal(typeof grounding.questInstruction,'function');
 for(const text of ['前去查看详情','前往指定地点','返回「旗舰」休息','寻找任务目标','跟随骗子向导','尝试打开机关','抵达目标地点','与千岩军对话']){
  const row=hud(text);
  assert.deepEqual(grounding.questInstruction([row]),row,text);
  assert.equal(questStage([row]),text,text);
 }
});
test('right-side quest details and lower-screen text cannot become a left-upper HUD instruction',()=>{
 for(const box of [[800,252,295,29],[640,252,295,29],[78,540,295,29],[78,900,295,29]]){
  const row={text:'前去查看详情',box};
  assert.equal(grounding.questInstruction([row]),null,JSON.stringify(box));
  assert.equal(questStage([row]),null,JSON.stringify(box));
 }
 const left=hud(),right={text:'前去另一个地点',box:[800,252,295,29]};
 assert.deepEqual(grounding.questInstruction([right,left]),left);
 assert.equal(grounding.questInstruction([{text:'前去查看详情'}]),null);
});
test('前去 distance grounding needs unique agreeing HUD and world labels and never proves arrival',()=>{
 const texts=[hud(),{text:'387m',box:[86,286,45,20]},{text:'387m',box:[1220,234,45,20]}];
 const label=observation.questDistanceLabel(texts);
 assert.equal(label.meters,387);assert.equal(label.direction,'right');assert.equal(label.verified,false);
 assert.equal(observation.questDistanceLabel(texts.slice(0,2)),null);
 assert.equal(observation.questDistanceLabel([...texts.slice(0,2),{text:'38m',box:[1220,234,45,20]}]),null);
 assert.equal(observation.questDistanceLabel([...texts,{text:'387m',box:[800,400,45,20]}]),null);
 assert.equal(observation.questDistanceLabel([...texts,{text:'38m',box:[86,310,45,20]}]),null);
 assert.equal(observation.questDistanceLabel([{...hud(),box:[800,252,295,29]},...texts.slice(1)]),null);
});
test('selected quest menu with exactly one Stop Tracking control proves tracking remains enabled',()=>{
 assert.equal(typeof observation.trackingEvidence,'function');
 const texts=menuTexts();
 assert.equal(grounding.questMenu(texts).title,'紧急修理');
 assert.equal(observation.trackingEvidence(menuObservation(texts),texts,'紧急修理').state,'menu_tracking_enabled');
 const duplicate=[...texts,{text:'停止追踪',box:[1500,940,180,35]}];
 assert.equal(observation.trackingEvidence(menuObservation(duplicate),duplicate,'紧急修理').state,'unconfirmed');
});
test('selected quest Start Tracking and Track Target controls explicitly mean not tracking',()=>{
 for(const control of ['追踪目标','开始追踪']){
  const texts=menuTexts('紧急修理',control);
  assert.equal(observation.trackingEvidence(menuObservation(texts),texts,'紧急修理').state,'menu_not_tracking',control);
 }
});
test('another task title cannot borrow its Stop Tracking control as evidence for the anchored quest',()=>{
 const texts=menuTexts('古云有螭','停止追踪');
 assert.equal(observation.trackingEvidence(menuObservation(texts),texts,'紧急修理').state,'unconfirmed');
 const noLayout=[{text:'紧急修理'},{text:'停止追踪'}];
 assert.equal(observation.trackingEvidence({scene:'menu',uncertain:false},noLayout,'紧急修理').state,'unconfirmed');
});
test('current HUD instruction is tracking evidence only in the world scene, not menu detail or model prose',()=>{
 const texts=[hud(),{text:'387m',box:[86,286,45,20]}];
 assert.equal(observation.trackingEvidence(world,texts,'紧急修理').state,'current_hud_text');
 assert.equal(observation.trackingEvidence({scene:'menu',uncertain:false},texts,'紧急修理').state,'unconfirmed');
 assert.equal(observation.trackingEvidence(world,[{text:'前去查看详情',box:[800,252,295,29]}],'紧急修理').state,'unconfirmed');
 assert.equal(observation.trackingEvidence({...world,summary:'前去查看详情，387m',visible_text:['前去查看详情']},[],'紧急修理').state,'unconfirmed');
});
