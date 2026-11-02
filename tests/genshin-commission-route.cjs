const {test}=require('node:test'),assert=require('node:assert/strict');
const macro=require('../scripts/genshin/story/macros/commission-route'),g=require('../scripts/genshin/story/grounding');
const catalog=require('../data/genshin-commission-routes.json');
const rows=[{text:'收集木材',box:[80,246,180,30]}];
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
 assert.ok(catalog.routes.every(r=>r.positions.every(p=>!p.action&&p.type!=='teleport'&&Number.isFinite(p.x)&&Number.isFinite(p.y))));
 assert.equal(macro.available(catalog,'别的任务','收集木材').length,0);
 assert.deepEqual(macro.available(catalog,'紧急修理','收集木材').map(r=>r.id),['urgent-wood-1','urgent-wood-2','urgent-wood-3']);
 assert.equal(macro.available(catalog,'紧急修理','将结实的木板交给法拉')[0].id,'urgent-npc');
});
test('wrong stage, far variant, or F blocks all native paths',async()=>{
 for(const opts of [{stage:[{text:'收集绳索',box:[80,246,180,30]}]},{point:{x:0,y:0}},{stage:[...rows,{text:'F',box:[1100,480,25,30]},{text:'调查',box:[1150,480,80,30]}]}]){
  const h=fixture(opts),r=await h.run('urgent-wood-1');assert.equal(h.paths.length,0);assert.notEqual(r.stopReason,'route_complete');
 }
});
test('route completion requires independently sampled arrival at every point; resumed state is source-bound',async()=>{
 const h=fixture(),r=await h.run('urgent-wood-1');assert.equal(r.stopReason,'route_complete');assert.equal(r.cursorAfter,4);assert.equal(r.verified,false);
 assert.equal(h.paths.length,4);assert.equal(h.events.at(-1),'dispose');
 const same=fixture();assert.equal((await same.run('urgent-wood-1',r.state)).cursorBefore,4);assert.equal(same.paths.length,0);
 const changed=fixture();assert.equal((await changed.run('urgent-wood-1',{...r.state,sha256:'wrong'})).cursorBefore,0);
});
test('silent path failure never advances cursor and interruption joins/disposes before returning',async()=>{
 const h=fixture({arrives:false}),r=await h.run('urgent-wood-1');assert.equal(r.stopReason,'arrival_unverified');assert.equal(r.cursorAfter,0);assert.equal(h.paths.length,1);
 const interrupted=fixture({arrives:false,stop:'interaction_prompt'}),i=await interrupted.run('urgent-wood-1');assert.equal(i.cursorAfter,0);assert.deepEqual(interrupted.events,['finished','cancel','dispose']);
});
test('node validator only accepts a matching route ID from the current BGI world',()=>{
 const {validateDecision}=require('../src/genshin/story-runtime');const request={texts:rows,focusQuest:'紧急修理'};
 const observation={scene:'world',nativeVision:{source:'bettergi_native_cv',ui:'Main'}};
 assert.equal(validateDecision({action:{kind:'quest_route',id:'urgent-wood-1'}},request,observation).action.id,'urgent-wood-1');
 for(const action of [{kind:'quest_route',id:'urgent-rope'},{kind:'quest_route',id:'urgent-wood-1',x:0}])assert.throws(()=>validateDecision({action},request,observation));
 assert.throws(()=>validateDecision({action:{kind:'quest_route',id:'urgent-wood-1'}},request,{scene:'dialogue'}));
});
