const {test}=require('node:test'),assert=require('node:assert/strict');
const grounding=require('../scripts/genshin/story/grounding');
test('commission dialogue and collection stages use their own HUD distance only',()=>{
 for(const text of ['和法拉对话','与法拉对话','收集木板','将结实的木板交给法拉','收集绳子','将绳子交给法拉']){
  const rows=[{text,box:[76,246,210,30]},{text:'19m',box:[80,280,40,20],source:'quest_distance_crop'},{text:'7m',box:[1400,400,40,20]}];
  assert.equal(grounding.questHud(rows).meters,19);
  assert.equal(grounding.questHud(rows).stage,text);
  assert.equal(grounding.questInstruction([{text,box:[900,850,240,28]}]),null);
 }
});
