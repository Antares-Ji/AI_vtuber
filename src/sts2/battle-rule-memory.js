'use strict';
// Rules are prior observations, not fresh numerical effects or target positions.
// Current OCR identity, upgrade suffix and cost must match; one battle only.
class BattleRuleMemory {
  constructor(){this.rules=new Map();this.conflicts=new Set();}
  clear(){this.rules.clear();this.conflicts.clear();}
  key(card){return JSON.stringify([card.name,card.cost]);}
  observe(view){
    for(const target of view.targets){
      const c=target.card;
      if(target.kind!=='card'||!c||c.rule_source==='battle_memory'||c.observedFrameId!==view.frameId||!Number.isInteger(c.cost)||c.cost<0||
         ['name','type','description'].some(k=>typeof c[k]!=='string'||!c[k].trim()||/未知|未读|看不清/.test(c[k])))continue;
      const key=this.key(c),prior=this.rules.get(key);
      if(prior&&(prior.type!==c.type||prior.description!==c.description)){this.rules.delete(key);this.conflicts.add(key);continue;}
      if(!this.conflicts.has(key))this.rules.set(key,{name:c.name,cost:c.cost,type:c.type,description:c.description,frame:view.frameId});
    }
  }
  apply(view){
    return {...view,targets:view.targets.map(t=>{
      const c=t.card;
      if(t.kind!=='card'||!c||c.observedFrameId===view.frameId||t.name_source!=='local_ocr'||
         !['local_vlm_ocr','cloud_vlm_local_ocr'].includes(t.cost_source)||!Number.isInteger(c.cost))return t;
      const known=this.rules.get(this.key(c));if(!known)return t;
      return {...t,card:{...c,type:known.type,description:known.description,observedFrameId:view.frameId,
        rule_source:'battle_memory',rules_observed_frame_id:known.frame,description_is_historical:true}};
    })};
  }
}
function reusableHoveredRules(view,hover,entry){
  if(!hover||entry?.decision?.kind!=='hover'||entry.preparationOnly!==true||entry.result?.status!=='awaiting_visual_review')return false;
  const old=entry.before?.targets?.find(t=>t.id===entry.decision.targetId)?.card;
  const matches=view.targets.filter(t=>t.kind==='card'&&t.card?.name===old?.name&&t.card?.cost===old?.cost&&Math.abs(t.point[0]/1000-hover[0])<.12);
  return matches.length===1&&matches[0].card.rule_source==='battle_memory';
}
module.exports={BattleRuleMemory,reusableHoveredRules};
