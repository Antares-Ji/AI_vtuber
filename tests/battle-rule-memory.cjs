const test=require('node:test'),assert=require('node:assert/strict');
const {BattleRuleMemory,reusableHoveredRules}=require('../src/sts2/battle-rule-memory');
const learned={scene:'battle',frameId:'first',targets:[{id:'old',kind:'card',point:[400,800],card:{name:'打击',cost:1,type:'攻击',description:'造成6点伤害。',observedFrameId:'first'}}]};
const current={scene:'battle',frameId:'second',targets:[{id:'new',kind:'card',name_source:'local_ocr',cost_source:'cloud_vlm_local_ocr',point:[700,800],card:{name:'打击',cost:1,type:null,description:null}}]};
test('rule memory preserves current identity, cost and position and labels old numerical text',()=>{
 const memory=new BattleRuleMemory();memory.observe(learned);const result=memory.apply(current).targets[0];
 assert.equal(result.id,'new');assert.deepEqual(result.point,[700,800]);assert.equal(result.card.cost,1);assert.equal(result.card.observedFrameId,'second');
 assert.equal(result.card.rules_observed_frame_id,'first');assert.equal(result.card.description_is_historical,true);
 for(const patch of [{name:'打击+'},{cost:0},{cost:null}]) {
  assert.equal(memory.apply({...current,targets:[{...current.targets[0],card:{...current.targets[0].card,...patch}}]}).targets[0].card.description,null);
 }
 assert.equal(memory.apply({...current,targets:[{...current.targets[0],name_source:'unknown'}]}).targets[0].card.description,null);
 memory.clear();assert.equal(memory.apply(current).targets[0].card.description,null);
});
test('conflicting same-name same-cost observed rules invalidate reuse for the battle',()=>{
 const memory=new BattleRuleMemory();memory.observe(learned);
 memory.observe({...learned,targets:[{...learned.targets[0],card:{...learned.targets[0].card,description:'造成9点伤害。'}}]});
 memory.observe(learned);assert.equal(memory.apply(current).targets[0].card.description,null);
});
test('explicit model inspection always re-reads; only automatic preparation may reuse rules',()=>{
 const memory=new BattleRuleMemory();memory.observe(learned);const v=memory.apply(current);
 const entry={before:learned,decision:{kind:'hover',targetId:'old'},result:{status:'awaiting_visual_review'}};
 assert.equal(reusableHoveredRules(v,[.7,.8],entry),false);
 assert.equal(reusableHoveredRules(v,[.7,.8],{...entry,preparationOnly:true}),true);
 assert.equal(reusableHoveredRules(v,[.1,.8],{...entry,preparationOnly:true}),false);
});
