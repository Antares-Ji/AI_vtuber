'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {corroborateDistances}=require('../src/genshin/story-observation');
const {validateDecision}=require('../src/genshin/story-runtime');
const grounding=require('../scripts/genshin/story-main'),workers=require('../src/genshin/story-workers');
const texts=[{text:'CADPA',box:[1782,119,61,21]},{text:'适龄提示',box:[1768,137,87,29]},
 {text:'点击进入',box:[908,1005,103,32]},{text:'CNRELWin7.1.0_R48652077',box:[65,1038,533,29]}];
const raw={scene:'world',uncertain:false,summary:'云上古建筑群',visible_text:['点击进入'],navigation:{terrain:'open',movement:'standing',marker:'not_visible'}};
test('observed startup OCR overrides false world vision and routes to interaction with a usable entry action',()=>{
 const result=corroborateDistances(raw,texts);assert.equal(result.observation.scene,'login');
 assert.equal(workers.workerFor(result.observation),'interaction');assert.equal(grounding.movementStop(texts),'login');
 assert.throws(()=>validateDecision({action:{kind:'move',key:'W',ms:300}},{texts},raw),/点击进入/);
 assert.equal(validateDecision({action:{kind:'click_text',text:'点击进入'}},{texts},result.observation).action.text,'点击进入');
});
test('generic entry words without startup evidence do not relabel the scene; duplicate controls cannot click',()=>{
 assert.equal(grounding.loginPrompt([texts[2]]),null);
 assert.throws(()=>validateDecision({action:{kind:'click_text',text:'点击进入'}},{texts:[...texts,texts[2]]},raw),/重复/);
});
