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
test('movement uses short steps and gives an executable shorter alternative instead of long blind motion',()=>{
 assert.throws(()=>workers.validateRole({action:{kind:'move',key:'W',ms:600}},'movement'),/ms:400/);
 for(const ms of [80,200,400])assert.doesNotThrow(()=>workers.validateRole({action:{kind:'move',key:'W',ms}},'movement'));
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
