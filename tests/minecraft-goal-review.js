const assert = require('node:assert/strict');
const { planSurvival, decisionMessages } = require('../src/minecraft/survival-planner');
(async () => {
  const state = { inventory: [{name:'wooden_pickaxe',count:1},{name:'wooden_pickaxe',count:1}] };
  assert.equal(JSON.parse(decisionMessages(state)[1].content).inventoryTotals.wooden_pickaxe,2);
  let review, tail;
  const chosen = {subgoal:'检查食物储备',reason:'需要确认补给',plan:[{action:'observe'}]};
  const action = await planSurvival(state,{currentSubgoal:'制作木镐',onReview:r=>review=r,onPlan:p=>tail=p,fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify(chosen)}}]})})});
  assert.deepEqual(action,{action:'observe'});
  assert.equal(review.subgoal,chosen.subgoal); assert.equal(review.source,'local-qwen'); assert.deepEqual(tail,[]);
  await assert.rejects(planSurvival(state,{onReview:()=>assert.fail('invalid review must not commit'),onPlan:()=>{},fetchImpl:async()=>({ok:true,json:async()=>({choices:[{message:{content:JSON.stringify({...chosen,plan:[{action:'give'}]})}}]})})}));
  console.log('PASS inventory aggregation and model-owned subgoal, invalid plan cannot commit review');
})().catch(e=>{console.error(e);process.exitCode=1;});
