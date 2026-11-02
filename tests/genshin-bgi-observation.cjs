const {test}=require('node:test'),assert=require('node:assert/strict');
const {observe}=require('../src/genshin/bgi-observation');
test('current native CV classifies world/talk/map without a vision model or guessing open terrain',()=>{
 for(const [ui,scene] of [['Main','world'],['Talk','dialogue'],['BigMap','map']]){
  const o=observe({texts:[],nativeVision:{source:'bettergi_native_cv',ui,motion:'Normal'}});
  assert.equal(o.scene,scene);assert.equal(o.uncertain,false);assert.equal(o.navigation.terrain,'unknown');
 }
});
test('missing/foreign native evidence fails closed while OCR menu overrides world template',()=>{
 assert.equal(observe({texts:[]}).uncertain,true);
 assert.equal(observe({texts:[],nativeVision:{source:'other',ui:'Main'}}).uncertain,true);
 const o=observe({texts:[{text:'商城',box:[80,80,80,30]}],nativeVision:{source:'bettergi_native_cv',ui:'Main'}});
 assert.equal(o.scene,'menu');
});
test('combat objective alone cannot become combat evidence',()=>{
 const texts=[{text:'消灭所有魔物',box:[80,250,180,30]}],nativeVision={source:'bettergi_native_cv',ui:'Main'};
 assert.equal(observe({texts,nativeVision}).scene,'world');
 assert.equal(observe({texts:[...texts,{text:'Lv.80',box:[900,400,100,30]}],nativeVision}).scene,'combat');
});
test('adventurer handbook OCR is a closable menu even when native generic templates miss',()=>{
 const texts=['本周砺行进度','选择委托任务倾向地域','见闻','每日委托奖励'].map((text,i)=>({text,box:[300,i*100+100,200,30]}));
 assert.equal(observe({texts,nativeVision:{source:'bettergi_native_cv',ui:'Unknown'}}).scene,'menu');
});
