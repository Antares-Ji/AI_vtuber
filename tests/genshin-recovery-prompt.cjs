const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const grounding=require('../scripts/genshin/story-main');
const {corroborateDistances}=require('../src/genshin/story-observation');
const {validateDecision}=require('../src/genshin/story-runtime');
// Native 76659c55..., step 2: OCR evidence, not a simulated game outcome.
const rows=[{text:'严寒',box:[872,395,175,90]},{text:'在寒冷环境下，要关注「严寒」的积累。',box:[722,530,463,29]},{text:'复苏',box:[944,963,65,39]}];
const world={scene:'world',uncertain:false,summary:'寒冷环境提示',visible_text:[],navigation:{terrain:'open',marker:'not_visible'}};
test('recorded revival prompt overrides world and blocks gameplay inputs',()=>{
 const result=corroborateDistances(world,rows);
 assert.equal(result.sceneEvidence,'bettergi_recovery_layout');
 assert.equal(result.observation.scene,'menu');
 assert.equal(result.observation.recoveryPrompt.title,'严寒');
 assert.equal(grounding.movementStop(rows),'menu');
 assert.equal(grounding.interaction(rows).state,'not_world');
 for(const action of [{kind:'move',key:'W',ms:300},{kind:'key',key:'F'},{kind:'key',key:'ESCAPE'},{kind:'follow_marker'},{kind:'reset_camera'}])assert.throws(()=>validateDecision({action},{texts:rows},result.observation));
 const action={kind:'click_text',text:'复苏'};
 assert.deepEqual(validateDecision({action},{texts:rows},result.observation).action,action);
 assert.throws(()=>validateDecision({action:{kind:'click_text',text:'确认'}},{texts:rows},result.observation));
});
test('recovery classification requires button, title and explanation layout',()=>{
 for(let i=0;i<rows.length;i++)assert.equal(grounding.recoveryPrompt(rows.filter((_,n)=>n!==i)),null);
 assert.equal(grounding.recoveryPrompt([{text:'复苏',box:[100,200,80,30]},...rows.slice(0,2)]),null);
 assert.equal(grounding.recoveryPrompt([...rows,rows[2]]),null);
 const uncertain=corroborateDistances({...world,uncertain:true},rows).observation;
 assert.throws(()=>validateDecision({action:{kind:'click_text',text:'复苏'}},{texts:rows},uncertain));
});
test('recorded loading tip title is not promoted to a dialogue speaker',()=>{
 const texts=[{text:'护盾',box:[928,854,61,32]},{text:'如果希望保护自己的护盾能更加牢固，就需要「护盾强效」。',box:[684,897,539,27]},{text:'取决于不同的人的护盾强效，同一个护盾在庇护不同的角色时，牢固程度也会不同。',box:[578,925,755,27]}];
 for(const scene of ['loading','menu']){
  const result=corroborateDistances({...world,scene,summary:'护盾机制说明界面'},texts).observation;
  assert.equal(result.scene,scene);assert.equal(result.dialogue,undefined);
 }
});
test('native executor rechecks recovery layout before clicks and rejects late world input',async()=>{
 for(const scenario of ['click','changed','late']){
  let seq=0,clicks=0,keys=0;const files=new Map([['command.json',JSON.stringify({id:'recovery',timeoutMs:600000})]]);
  const context={JSON,Date,Number,String,Math,Set,Error,
   file:{readTextSync:n=>files.get(n),writeImageSync(){},writeTextSync(n,v){files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);seq=r.seq;files.set(`story-decision-${seq}.json`,JSON.stringify({id:r.id,seq,action:seq===1?(scenario==='late'?{kind:'key',key:'V'}:{kind:'click_text',text:'复苏'}):{kind:'stop'}}));}}},
   captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose(){},findMulti(){const items=seq&&scenario==='changed'?[rows[2]]:!seq&&scenario==='late'?[]:rows;return {count:items.length,...items.map(t=>({text:t.text,x:t.box[0],y:t.box[1],width:t.box[2],height:t.box[3],click(){clicks++;}}))};}}),
   RecognitionObject:{ocr:()=>({})},keyDown(){keys++;},keyUp(){},dispatcher:{clearAllTriggers(){}},log:{info(){},error(){}},sleep:async()=>{}};
  await vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/genshin/story-main'),'utf8'),Object.assign({ensureGameFocus:async()=>true,isGameActive:()=>true},context));
  assert.equal(keys,0);assert.equal(clicks,scenario==='click'?1:0);
  assert.equal(JSON.parse(files.get('receipt.json')).state,scenario==='late'?'error':'returned');
 }
});
