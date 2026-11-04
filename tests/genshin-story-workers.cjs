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
test('image navigation retains bounded prior assessments and distinguishes tracking inputs from confirmation',()=>{
 const previousSteps=Array.from({length:5},(_,i)=>({capturedAt:i,cloudImageAssessment:{groundTrailVisible:false,nearObstacle:'墙'+i},decision:{action:{kind:'move',key:'W',ms:400}},observation:{travelQuest:{hud:{meters:20+i}}}}));
 const c={...context,previousSteps,observation:{...context.observation,trackingInputs:{refreshCount:2,menuOpenCount:0}}};
 const p=workers.prompt(c,{imageAssistance:true}),d=JSON.parse(p.input);
 assert.equal(d.recentImageObservations.length,3);assert.equal(d.recentImageObservations[0].capturedAt,2);
 assert.equal(d.recentImageObservations[2].execution,'check_recentNativeSteps_for_receipt');
 assert.equal(d.observation.trackingInputs.refreshCount,2);assert.match(p.instructions,/停止追踪表示已启用，不要点击它/);
 assert.equal(d.trackingReview.needed,true);
 const checked={...c,observation:{...c.observation,trackingInputs:{refreshCount:2,menuOpenCount:1}}};
 assert.equal(JSON.parse(workers.prompt(checked,{imageAssistance:true}).input).trackingReview,undefined);
 assert.equal(JSON.parse(workers.prompt(c).input).recentImageObservations,undefined);
});
test('native ready dialogue offers SPACE instead of waiting for already displayed subtitles',()=>{
 const p=workers.prompt({...context,observation:{scene:'dialogue',uncertain:false,nativeVision:{ui:'Talk'},dialogue:{subtitle:'应招的人？先填写表格吧。',options:[]}}});
 assert.match(p.instructions,/当前帧已经就绪/);assert.match(p.instructions,/原生有界对话宏/);
 const unknown=workers.prompt({...context,observation:{scene:'unknown',uncertain:true}});
 assert.ok(!unknown.instructions.includes('当前帧已经就绪'));
});
test('lost trail refresh needs two image observations and an elapsed native receipt, never a planned V',()=>{
 const c={...context,frameImage:{capturedAt:20000},previousSteps:[1,2].map(capturedAt=>({capturedAt,cloudImageAssessment:{groundTrailVisible:false}})),observation:{...context.observation,nativeVision:{ui:'Main',motion:'Normal'},trackingInputs:{lastRefreshAt:1000}}};
 assert.equal(JSON.parse(workers.prompt(c,{imageAssistance:true}).input).trackingRefresh.ageMs,19000);
 for(const change of [{frameImage:{capturedAt:12000}},{previousSteps:[c.previousSteps[0]]},{previousSteps:[c.previousSteps[0],{cloudImageAssessment:{groundTrailVisible:true}}]},{observation:{...c.observation,trackingInputs:{lastRefreshAt:null}}},{observation:{...c.observation,nativeVision:{motion:'Climb'}}}])
  assert.equal(JSON.parse(workers.prompt({...c,...change},{imageAssistance:true}).input).trackingRefresh,undefined);
});
test('image assistance keeps native Climb recovery while hiding failed marker priority',()=>{
 const p=workers.prompt({...context,observation:{...context.observation,nativeVision:{ui:'Main',motion:'Climb'},nativeTracking:{available:true},commissionRoutes:[{id:'entrance',recovery:true}]}},{imageAssistance:true});
 assert.match(p.instructions,/BGI原生CV确认当前正在攀爬/);assert.match(p.instructions,/key:"X"/);
 assert.ok(!p.instructions.includes('当前BGI原生近程任务追踪可用，优先选择'));
});
test('distant objectives preserve task-region evidence and offer catalog travel instead of waiting',()=>{
 const c={...context,questMemory:{quest:'任务甲',details:['任务甲','蒙德 清泉镇']},mapAreas:['清泉镇'],observation:{...context.observation,travelQuest:{ok:false,reason:'distance_out_of_range',hud:{meters:6000}}}};
 const p=workers.prompt(c),d=JSON.parse(p.input);
 assert.deepEqual(d.questDestination.details,c.questMemory.details);assert.equal(d.questMemory,undefined);
 assert.match(p.instructions,/不是需要等待/);assert.ok(d.availableIntents.includes('list_waypoints'));assert.ok(d.availableIntents.includes('teleport'));
 assert.ok(!workers.prompt(context).instructions.includes('当前HUD超过1500m'));
});
test('exhausted local search exposes recovery without offering the same empty search again',()=>{
 const g=require('../scripts/genshin/story-main'),runtime=require('../src/genshin/story-runtime');
 const failed={action:{kind:'seek_quest'},detail:JSON.stringify({kind:'quest-seek',stopReason:'directions_exhausted'})};
 const steps=[failed,{action:{kind:'wait'}}];assert.equal(g.seekFeedback(steps).exhausted,true);
 assert.equal(g.seekFeedback([...steps,{action:{kind:'turn'}}]).exhausted,false);
 const p=workers.prompt({...context,observation:{...context.observation,seekFeedback:g.seekFeedback(steps)}}),data=JSON.parse(p.input);
 assert.ok(!data.availableIntents.includes('seek_quest'));assert.ok(data.availableIntents.includes('turn'));assert.ok(data.availableIntents.includes('stop'));
 assert.throws(()=>runtime.validateDecision({action:{kind:'seek_quest'}},{recentNativeSteps:steps,texts:[]},context.observation),/四方向已耗尽/);
});
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
test('already visited incidental prompt offers departure, not repeated F or idle waiting',()=>{
 const texts=[{text:'返回「旗舰」休息',box:[75,246,230,33]},{source:'bettergi_native_f_label',text:'坐下',count:1,anchor:[1103,523,32,32],box:[1218,523,285,32]}];
 const o={...context.observation,interaction:{state:'unique',repeatedIncidental:true},nativeRecovery:{available:true}};
 const p=workers.prompt({...context,observation:o,texts},{imageAssistance:true}),d=JSON.parse(p.input);
 assert.deepEqual(d.availableIntents,['native_unstuck','stop','leave_interaction']);
 for(const kind of ['key','wait'])assert.throws(()=>workers.validateRole({action:{kind}},'interaction',d.availableIntents),/当前仅可选择/);
 assert.doesNotThrow(()=>workers.validateRole({action:{kind:'leave_interaction',key:'A',text:'坐下'}},'interaction',d.availableIntents));
 assert.ok(JSON.parse(workers.prompt({...context,observation:{...o,interaction:{state:'unique',repeatedIncidental:false}},texts}).input).availableIntents.includes('key'));
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
