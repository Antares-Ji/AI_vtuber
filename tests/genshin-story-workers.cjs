'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const workers=require('../src/genshin/story-workers'),provider=require('../src/genshin/model-provider');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-workers-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data/genshin.local.json'),'{"provider":"deepseek"}');
 return {root,env:{GENSHIN_DEEPSEEK_API_KEY:'test-key'}};
}
const context={goal:'只做当前任务',observation:{scene:'world',uncertain:false,navigation:{terrain:'open'},interaction:{state:'none'},summary:'冗长解说'},texts:[],mapAreas:[],waypoints:[]};
test('collection investigation keeps the guide and is handed to F instead of walking away',()=>{
 const texts=[{text:'收集木材',box:[75,246,153,33]},{text:'F',box:[1100,480,25,30]},{text:'调查',box:[1150,480,80,30]}];
 const g=require('../scripts/genshin/story-main'),guide=require('../src/genshin/story-guides').questGuide('紧急修理');
 const observation={...context.observation,interaction:g.interaction(texts),walkthroughReference:guide};
 assert.equal(workers.workerFor(observation),'interaction');
 const data=JSON.parse(workers.prompt({...context,texts,observation}).input);
 assert.equal(data.observation.walkthroughReference.kind,'external_walkthrough_not_live_evidence');
 assert.ok(!data.availableIntents.includes('leave_interaction'));
 assert.deepEqual(data.collectionInteraction.preferredAction,{kind:'key',key:'F',text:'调查'});
 const runtime=require('../src/genshin/story-runtime');
 assert.throws(()=>runtime.validateDecision({action:{kind:'leave_interaction',text:'调查',key:'W'}},{texts},observation),/不能直接离开/);
 assert.equal(runtime.validateDecision({action:{kind:'key',key:'F',text:'调查'}},{texts},observation).action.key,'F');
 assert.equal(g.collectionTarget(texts,'烹饪'),false);
});
test('routing reserves movement for world and hands unique F/dialogue/menu to interaction',()=>{
 assert.equal(workers.workerFor(context.observation),'movement');
 for(const o of [{scene:'dialogue'},{scene:'menu'},{scene:'combat'},{scene:'world',uncertain:true},{scene:'world',interaction:{state:'unique'}}])assert.equal(workers.workerFor(o),'interaction');
 assert.throws(()=>workers.validateRole({action:{kind:'choose_dialogue'}},'movement'));
 assert.throws(()=>workers.validateRole({action:{kind:'move'}},'interaction'));
});
test('both workers disable thinking, enforce separate output caps and optionally use separate DeepSeek models',async t=>{
 const options=fixture(t),seen=[];
 for(const role of ['movement','interaction']){
  const result=await workers.call(context,{...options,role,env:{...options.env,GENSHIN_MOVEMENT_MODEL:'move-test',GENSHIN_INTERACTION_MODEL:'interact-test'},fetchImpl:async(url,req)=>{
   const b=JSON.parse(req.body);seen.push(b);assert.equal(url,'https://api.deepseek.com/chat/completions');assert.deepEqual(b.thinking,{type:'disabled'});
   return {ok:true,json:async()=>({model:b.model,usage:{total_tokens:20},choices:[{finish_reason:'stop',message:{content:'{"action":{"kind":"wait"}}'}}]})};
  }});assert.equal(result.worker,role);
 }
 assert.deepEqual(seen.map(b=>b.max_tokens),[128,384]);assert.deepEqual(seen.map(b=>b.model),['move-test','interact-test']);
 assert.ok(seen.every(b=>!b.messages[0].content.includes('commentary')));
});
test('movement delegates continuous navigation and keeps fine adjustment bounded',()=>{
 assert.throws(()=>workers.validateRole({action:{kind:'move',key:'W',ms:8000}},'movement'),/navigate/);
 for(const ms of [80,200,400,600])assert.doesNotThrow(()=>workers.validateRole({action:{kind:'move',key:'W',ms}},'movement'));
 assert.doesNotThrow(()=>workers.validateRole({action:{kind:'navigate',key:'W',ms:8000}},'movement'));
 assert.ok(workers.prompt(context).instructions.includes('连续走最多180m'));
 assert.doesNotThrow(()=>workers.validateRole({action:{kind:'advance_quest',key:'W'}},'movement'));
});
test('worker requests omit narration, keep user goal, and use short structured cross-worker messages',()=>{
 const p=workers.prompt(context,{handoff:{from:'interaction',action:{kind:'teleport',id:'61'}}}),data=JSON.parse(p.input);
 assert.equal(data.goal,context.goal);assert.equal(data.observation.summary,undefined);assert.equal(data.handoff.from,'interaction');
 const value=workers.normalize({action:{kind:'wait'},reason:'x'.repeat(100),commentary:'长解说',quest:'错任务'},{focusQuest:'当前任务'});
 assert.equal(value.reason.length,24);assert.equal(value.commentary,'');assert.equal(value.quest,'当前任务');
});
test('truncated responses and provider failures cannot become actions or trigger provider fallback',async t=>{
 const options=fixture(t);let count=0;
 await assert.rejects(workers.call(context,{...options,fetchImpl:async()=>{count++;return {ok:true,json:async()=>({choices:[{finish_reason:'length',message:{content:'{"action":'}}]})};}}),/完整/);
 assert.equal(count,1);provider.selectProvider('openai',{dataRoot:options.root});
 await assert.rejects(workers.call(context,{...options,fetchImpl:()=>{throw Error('must not request');}}),/手动选择DeepSeek/);
});
