const {test}=require('node:test'),assert=require('node:assert/strict');
const macro=require('../scripts/genshin/story/macros/commission-route'),g=require('../scripts/genshin/story/grounding');
const catalog=require('../data/genshin-commission-routes.json');
const rows=[{text:'收集木材',box:[80,246,180,30]}];
test('one sourced entry recovery requires both native failures and an explicit model reentry choice',()=>{
 const route=catalog.routes.find(r=>r.id==='flagship-official-entry'),texts=[{text:'返回「旗舰」休息',box:[80,246,250,30]}],attempts=['flagship-entrance',route.id];
 const recovery={nativeUnstucks:2,nativeTrackingStalls:1,attempted:[]},states={[route.id]:{stage:texts[0].text,cursor:5,attempts:1}};
 const offered=rec=>macro.available(catalog,route.quest,texts[0].text,states,attempts,rec).find(r=>r.id===route.id);
 assert.equal(offered(recovery).reentry,true);assert.equal(offered(recovery).blocked,false);assert.equal(offered(recovery).completed,false);
 for(const rec of [{...recovery,nativeUnstucks:1},{...recovery,nativeTrackingStalls:0},{...recovery,attempted:[route.id]}])assert.equal(offered(rec).blocked,true);
 assert.equal(macro.reentryAllowed(route,[],recovery),false);
 const durableStates={...states,'flagship-entrance':{stage:texts[0].text,attempts:1}};
 assert.equal(macro.available(catalog,route.quest,texts[0].text,durableStates,[],recovery).find(r=>r.id===route.id).reentry,true,'durable actual route receipts remain evidence after the archive scan window');
 const request={texts,focusQuest:route.quest,teleportAttempts:attempts,commissionRouteStates:states,entryRecovery:recovery},observation={scene:'world',nativeVision:{source:'bettergi_native_cv',ui:'Main',motion:'Normal'}};
 const {validateDecision}=require('../src/genshin/story-runtime');
 assert.deepEqual(validateDecision({action:{kind:'quest_route',id:route.id,recover:true}},request,observation).action,{kind:'quest_route',id:route.id,recover:true});
 assert.throws(()=>validateDecision({action:{kind:'quest_route',id:route.id}},request,observation),/recover:true/);
 assert.throws(()=>validateDecision({action:{kind:'quest_route',id:route.id,recover:true}},request,{...observation,nativeVision:{...observation.nativeVision,motion:'Climb'}}),/普通运动/);
});
test('native reentry uses the original catalog path and cannot repeat after its durable reservation',async()=>{
 const route=catalog.routes.find(r=>r.id==='flagship-official-entry'),stage=[{text:'返回「旗舰」休息',box:[80,246,250,30]}],attempts=['flagship-entrance',route.id];
 let p=route.anchor;const paths=[];
 const run=macro.create({catalog,grounding:g,read:()=>stage,position:()=>p,sleep:async()=>{},now:()=>1000,checkInput(){},getDeadline:()=>200000,movementStop:g.movementStop,
  createCancellationTokenSource:()=>({token:{},cancelAfter(){},cancel(){},dispose(){}}),pathingScript:{async run(json){const r=JSON.parse(json);paths.push(r);p=r.positions.at(-1);}},monitorPath:async({run})=>{await run();return {stopReason:null};}});
 const options={reenter:true,attempts,recovery:{nativeUnstucks:2,nativeTrackingStalls:1,attempted:[]}};
 const r=await run(route.id,{attempts:1},options);assert.equal(r.reentry,true);assert.equal(r.stopReason,'route_complete');assert.deepEqual(paths[0].positions,route.positions);assert.equal(r.verified,false);
 const second=await run(route.id,r.state,{...options,recovery:{...options.recovery,attempted:[route.id]}});
 assert.equal(second.stopReason,'entry_recovery_unavailable');assert.equal(paths.length,1);
});
function fixture({stage=rows,point={x:-550,y:1957},arrives=true,stop=null}={}){
 let now=1000,p=point;const events=[],paths=[];
 const run=macro.create({catalog,grounding:g,read:()=>stage,position:()=>p,now:()=>now,sleep:async ms=>now+=ms,checkInput(){},getDeadline:()=>1000000,movementStop:g.movementStop,
  createCancellationTokenSource:()=>({token:{},cancelAfter(){},cancel(){events.push('cancel');},dispose(){events.push('dispose');}}),
  pathingScript:{async run(json){const path=JSON.parse(json);paths.push(path);now+=1000;if(arrives)p=path.positions[0];events.push('finished');}},
  monitorPath:async({run,inspect})=>{await run();return {stopReason:stop||inspect(stage).stopReason};}});
 return {run,paths,events};
}
test('catalog is a bounded sourced reference, strips all upstream executable actions and filters quest/stage',()=>{
 assert.equal(catalog.source.commit.length,40);
 assert.ok(catalog.routes.filter(r=>!r.mode).every(r=>r.positions.every(p=>!p.action&&p.type!=='teleport'&&Number.isFinite(p.x)&&Number.isFinite(p.y))));
 const entry=catalog.routes.find(r=>r.mode==='entry_recovery');assert.equal(entry.positions.filter(p=>p.type==='teleport').length,1);assert.ok(entry.positions.every(p=>!p.action||p.action==='stop_flying'));
 assert.equal(macro.available(catalog,'别的任务','收集木材').length,0);
 assert.deepEqual(macro.available(catalog,'紧急修理','收集木材').map(r=>r.id),['urgent-wood-1','urgent-wood-2','urgent-wood-3']);
 assert.equal(macro.available(catalog,'紧急修理','将结实的木板交给法拉')[0].id,'urgent-npc');
});
test('flagship reference keeps only upstream coordinates and independently checks the door arrival',async()=>{
 const route=catalog.routes.find(r=>r.id==='flagship-entrance'),stage=[{text:'返回「旗舰」休息',box:[80,246,250,30]}];
 assert.equal(route.sourceCommit,'64872afb5ad8f9c5931c31cbc055233b6716b513');assert.equal(route.positions.length,5);
 assert.ok(route.positions.every(p=>p.action===''&&!p.action_params));
 assert.equal(macro.available(catalog,route.quest,stage[0].text)[0].id,route.id);
 assert.equal(macro.available(catalog,route.quest,'参加淘汰赛').length,0);
 assert.equal(macro.available(catalog,route.quest,stage[0].text,{},[route.id])[0].blocked,true);
 let p=route.anchor;const paths=[];
 const run=macro.create({catalog,grounding:g,read:()=>stage,position:()=>p,sleep:async()=>{},now:()=>1000,checkInput(){},getDeadline:()=>200000,movementStop:g.movementStop,
 createCancellationTokenSource:()=>({token:{},cancelAfter(){},cancel(){},dispose(){}}),pathingScript:{async run(json){const r=JSON.parse(json);paths.push(r);p=r.positions.at(-1);}},monitorPath:async({run})=>{await run();return {stopReason:null};}});
 const result=await run(route.id);assert.equal(result.stopReason,'route_complete');assert.equal(result.sourceCommit,route.sourceCommit);assert.equal(result.verified,false);
 assert.deepEqual(paths[0].positions,route.positions);
 const memory=require('../src/genshin/story-memory').navigationFromEvidence([{e:{decision:{quest:route.quest,action:{kind:'quest_route',id:route.id}},request:{texts:stage}}}],route.quest);
 assert.deepEqual(memory.teleportAttempts,[route.id]);
});
test('wrong stage, far variant, or F blocks all native paths',async()=>{
 for(const opts of [{stage:[{text:'收集绳索',box:[80,246,180,30]}]},{point:{x:0,y:0}},{stage:[...rows,{text:'F',box:[1100,480,25,30]},{text:'调查',box:[1150,480,80,30]}]}]){
  const h=fixture(opts),r=await h.run('urgent-wood-1');assert.equal(h.paths.length,0);assert.notEqual(r.stopReason,'route_complete');
 }
});
test('route completion requires independently sampled arrival at every point; resumed state is source-bound',async()=>{
 const h=fixture(),r=await h.run('urgent-wood-1');assert.equal(r.stopReason,'route_complete');assert.equal(r.cursorAfter,4);assert.equal(r.verified,false);
 assert.equal(h.paths.length,3,'nearby transit point can be passed within its path tolerance');assert.equal(h.events.at(-1),'dispose');
 const same=fixture();assert.equal((await same.run('urgent-wood-1',r.state)).cursorBefore,4);assert.equal(same.paths.length,0);
 const changed=fixture();assert.equal((await changed.run('urgent-wood-1',{...r.state,sha256:'wrong'})).cursorBefore,0);
});
test('silent path failure never advances cursor and interruption joins/disposes before returning',async()=>{
 const h=fixture({arrives:false}),r=await h.run('urgent-wood-1');assert.equal(r.stopReason,'arrival_unverified');assert.equal(r.cursorAfter,0);assert.equal(h.paths.length,1);
 const interrupted=fixture({arrives:false,stop:'interaction_prompt'}),i=await interrupted.run('urgent-wood-1');assert.equal(i.cursorAfter,0);assert.deepEqual(interrupted.events,['finished','cancel','dispose']);
});
test('two failures at the same cursor disable that route while other collection candidates remain available',async()=>{
 const h=fixture({arrives:false}),first=await h.run('urgent-wood-1'),second=await h.run('urgent-wood-1',first.state);
 assert.equal(second.state.failures,2);
 const routes=macro.available(catalog,'紧急修理','收集木材',{'urgent-wood-1':second.state});
 assert.equal(routes[0].blocked,true);assert.equal(routes[1].blocked,false);
 assert.ok(routes.some(r=>r.id==='urgent-entry'&&r.recovery));
 const n=h.paths.length;assert.equal((await h.run('urgent-wood-1',second.state)).stopReason,'route_retry_limit');assert.equal(h.paths.length,n);
});
test('recovery follows the complete original flight route once and verifies its final CV position',async()=>{
 const route=catalog.routes.find(r=>r.id==='urgent-entry');let point={...route.anchor},time=0,paths=[];
 const run=macro.create({catalog,grounding:g,read:()=>rows,position:()=>point,sleep:async ms=>time+=ms,now:()=>time,checkInput(){},getDeadline:()=>200000,movementStop:g.movementStop,
  createCancellationTokenSource:()=>({token:{},cancelAfter(){},cancel(){},dispose(){}}),
  pathingScript:{async run(json){const p=JSON.parse(json);paths.push(p);point=p.positions.at(-1);}},monitorPath:async({run,inspect})=>{await run();assert.equal(inspect([]).stopReason,null,'teleport loading is expected');return {stopReason:null};}});
 const result=await run('urgent-entry');assert.equal(result.stopReason,'route_complete');assert.deepEqual(paths[0].positions,route.positions);assert.equal(result.state.attempts,1);
 assert.equal((await run('urgent-entry',result.state)).stopReason,'entry_already_attempted');assert.equal(paths.length,1);
});
test('node validator only accepts a matching route ID from the current BGI world',()=>{
 const {validateDecision}=require('../src/genshin/story-runtime');const request={texts:rows,focusQuest:'紧急修理'};
 const observation={scene:'world',nativeVision:{source:'bettergi_native_cv',ui:'Main'}};
 assert.equal(validateDecision({action:{kind:'quest_route',id:'urgent-wood-1'}},request,observation).action.id,'urgent-wood-1');
 for(const action of [{kind:'quest_route',id:'urgent-rope'},{kind:'quest_route',id:'urgent-wood-1',x:0}])assert.throws(()=>validateDecision({action},request,observation));
 assert.throws(()=>validateDecision({action:{kind:'quest_route',id:'urgent-wood-1'}},request,{scene:'dialogue'}));
});
test('entry attempt survives restart even if the native process never produced a final receipt',()=>{
 const memory=require('../src/genshin/story-memory').navigationFromEvidence([{e:{decision:{quest:'紧急修理',action:{kind:'quest_route',id:'urgent-entry'}},request:{texts:rows}}}],'紧急修理');
 assert.ok(memory.teleportAttempts.includes('urgent-entry'));
 const offered=macro.available(catalog,'紧急修理','收集木材',{},memory.teleportAttempts);assert.ok(offered.some(r=>r.id==='urgent-entry-continue'&&!r.blocked));
 const runtime=require('../src/genshin/story-runtime');assert.throws(()=>runtime.validateDecision({action:{kind:'quest_route',id:'urgent-entry'}},{texts:rows,focusQuest:'紧急修理',teleportAttempts:memory.teleportAttempts},{scene:'world'}),/不能重复传送/);
});
test('continuing an interrupted teleport cannot send another teleport or walk from an unverified entry location',async()=>{
 const route=catalog.routes.find(r=>r.id==='urgent-entry-continue');assert.ok(route.positions.every(p=>p.type!=='teleport'));
 const h=fixture({point:{x:-550,y:1957}});assert.equal((await h.run(route.id)).stopReason,'entry_start_unverified');assert.equal(h.paths.length,0);
});
test('exact preflight rejection releases only its own planned attempt across menu frames and restart',()=>{
 const {navigationFromEvidence,reconcileRouteAttempt}=require('../src/genshin/story-memory');
 const action={kind:'quest_route',id:'flagship-entrance'},quest='两次视线的交汇';
 const texts=[{text:'返回「旗舰」休息',box:[80,246,250,30]}];
 const lastStep={seq:1,action,detail:JSON.stringify({kind:'commission-route',id:action.id,points:[],stopReason:'stage_mismatch',verified:false})};
 const plan={e:{request:{id:'native-a',seq:1,texts},decision:{quest,action}}};
 const receipt={e:{request:{id:'native-a',seq:2,texts:[],lastStep},decision:{quest,action:{kind:'key',key:'ESCAPE'}}}};
 assert.deepEqual(navigationFromEvidence([receipt,plan],quest).teleportAttempts,[]);
 const retry={e:{request:{id:'native-a',seq:3,texts},decision:{quest,action}}};
 assert.deepEqual(navigationFromEvidence([retry,receipt,plan],quest).teleportAttempts,[action.id]);
 const attempted=new Set([action.id]),pending=new Map([[action.id,JSON.stringify(['native-a',3])]]);
 reconcileRouteAttempt(attempted,pending,'native-a',lastStep);assert.ok(attempted.has(action.id),'old receipt cannot clear later unreceipted attempt');
 reconcileRouteAttempt(attempted,pending,'native-b',{...lastStep,seq:3});assert.ok(attempted.has(action.id),'other session cannot clear attempt');
 reconcileRouteAttempt(attempted,pending,'native-a',{...lastStep,seq:3,detail:JSON.stringify({kind:'commission-route',id:action.id,points:[],stopReason:'stage_mismatch',pathStarted:true})});assert.ok(attempted.has(action.id));
 reconcileRouteAttempt(attempted,pending,'native-a',{...lastStep,seq:3});assert.equal(attempted.size,0);
});
test('loading text cannot cancel a BGI route; native Talk can, and continuation contains no teleport',async()=>{
 const route=catalog.routes.find(r=>r.id==='flagship-walk');
 assert.ok(route.positions.every(p=>p.type!=='teleport'&&!p.action));
 assert.equal(macro.available(catalog,route.quest,'返回「旗舰」休息').some(r=>r.id===route.id),false);
 assert.ok(macro.available(catalog,route.quest,'返回「旗舰」休息',{},[route.resumeFrom]).some(r=>r.id===route.id&&!r.blocked));
 const loading=[{text:'武器',box:[930,854,59,30]},{text:'等级达到上限时，需要进行突破才能继续提升等级。',box:[708,897,497,27]}];
 const observe=require('../src/genshin/bgi-observation').observe;
 const observation=observe({texts:loading,nativeVision:{source:'bettergi_native_cv',ui:'Unknown'}});
 assert.equal(observation.scene,'unknown');
 assert.equal(require('../src/genshin/story-observation').corroborateDistances(observation,loading).observation.scene,'unknown');
 let time=0,ui='Unknown',p=route.anchor;const stage=[{text:'返回「旗舰」休息',box:[80,246,250,30]}];
 const run=macro.create({catalog,grounding:g,read:()=>stage,nativeUi:()=>ui,position:()=>p,sleep:async()=>{},now:()=>time,checkInput(){},getDeadline:()=>200000,movementStop:g.movementStop,
 createCancellationTokenSource:()=>({token:{},cancelAfter(){},cancel(){},dispose(){}}),pathingScript:{async run(){p=route.positions.at(-1);}},monitorPath:async({run,inspect})=>{
  await run();time+=25000;assert.equal(inspect(loading).stopReason,null);ui='Talk';assert.equal(inspect(loading).stopReason,'dialogue');ui='Main';return {stopReason:null};
 }});
 assert.equal((await run(route.id)).stopReason,'route_complete');
});
test('quote-only HUD variants cannot reopen completed or already attempted flagship routes',()=>{
 const route=catalog.routes.find(r=>r.id==='flagship-walk'),stage='返回「旗舰」休息';
 const states={[route.id]:{id:route.id,stage,cursor:route.positions.length,attempts:1,sha256:route.sha256}};
 for(const variant of [stage,'返回『旗舰」休息','返回旗舰休息']){
  const found=macro.available(catalog,route.quest,variant,states,[route.resumeFrom]).find(r=>r.id===route.id);
  assert.equal(found.blocked,true);assert.equal(found.completed,true);
  const {validateDecision}=require('../src/genshin/story-runtime');
  assert.throws(()=>validateDecision({action:{kind:'quest_route',id:route.id}},{texts:[{text:variant,box:[80,246,250,30]}],focusQuest:route.quest,commissionRouteStates:states,teleportAttempts:[route.resumeFrom]},{scene:'world',nativeVision:{ui:'Main'}}));
 }
 assert.equal(macro.available(catalog,route.quest,'参加淘汰赛',states,[route.resumeFrom]).length,0);
});
