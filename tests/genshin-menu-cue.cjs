'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {corroborateDistances}=require('../src/genshin/story-observation');
const {interaction,movementStop}=require('../scripts/genshin/story-main');
const {validateDecision}=require('../src/genshin/story-runtime');
const world={scene:'world',uncertain:false,summary:'森林草地',visible_text:[],navigation:{terrain:'open',marker:'not_visible'}};
// Labels recorded in e2b6... steps 12/13. Incomplete menu OCR is not world evidence.
const partial=['商城','图鉴','背包','冒险之证','官方社区'].map(text=>({text}));
test('partial menu evidence agrees with native world-action guard',()=>{
 const result=corroborateDistances(world,partial);
 assert.equal(result.observation.scene,'menu');
 assert.equal(result.sceneEvidence,'bettergi_partial_menu_text');
 assert.equal(result.observation.navigation.terrain,'unknown');
 assert.equal(result.observation.questMenu,undefined);
 assert.equal(movementStop(partial),'menu');
 assert.equal(interaction(partial).state,'not_world');
 assert.throws(()=>validateDecision({action:{kind:'follow_marker'}},{texts:partial},result.observation));
});
test('a world frame without menu cues retains the local observation',()=>{
 const result=corroborateDistances(world,[{text:'前去查看详情',box:[78,248,149,29]}]);
 assert.equal(result.observation.scene,'world');
 assert.equal(result.sceneEvidence,'local_model');
});
