const {test}=require('node:test'),assert=require('node:assert/strict');
const nav=require('../scripts/genshin/story/macros/continuous-navigation');
const g=require('../scripts/genshin/story/grounding');
const {validateDecision}=require('../src/genshin/story-runtime');
const stage=[{text:'收集木材',box:[80,250,160,30]}];
const f=[{text:'F',box:[1100,500,20,20]},{text:'法拉',box:[1140,500,100,20]}];
function fixture(rows=()=>stage, fail=false){
 let time=0,n=0;const events=[];
 const run=nav.create({grounding:g,read:()=>rows(n++),now:()=>time,sleep:async ms=>{time+=ms;},
  checkInput:()=>{if(fail&&time>=600)throw Error('focus lost');},keyDown:k=>events.push(['down',k,time]),keyUp:k=>events.push(['up',k,time])});
 return {run,events};
}
test('8-second local navigation holds once across 40 observations without model calls',async()=>{
 const h=fixture(),r=await h.run({key:'W',ms:8000});
 assert.equal(r.checks.length,40);assert.equal(r.movementMsSent,8000);assert.equal(h.events.length,2);
 assert.deepEqual(h.events.map(e=>e[0]),['down','up']);assert.equal(r.stopReason,'duration_budget');
});
test('new interaction/menu/stage interrupts continuously held movement',async()=>{
 for(const [rows,reason] of [[f,'interaction_prompt'],[[{text:'商城',box:[100,100,80,30]}],'menu'],[[{text:'和法拉对话',box:[80,250,160,30]}],'stage_changed']]){
  const h=fixture(n=>n<3?stage:rows),r=await h.run({key:'W',ms:8000});
  assert.equal(r.stopReason,reason);assert.equal(r.movementMsSent,600);assert.equal(h.events.at(-1)[0],'up');
 }
});
test('focus loss releases and propagates cancellation; missing stage never starts',async()=>{
 const h=fixture(undefined,true);await assert.rejects(h.run({key:'D',ms:8000}),/focus lost/);assert.equal(h.events.at(-1)[0],'up');
 const blank=fixture(()=>[]);assert.equal((await blank.run({key:'W',ms:8000})).stopReason,'stage_missing');assert.equal(blank.events.length,0);
});
test('distance increase and stall return to planner without continuing blind',async()=>{
 for(const [d,reason] of [[n=>20+n*3,'distance_increased'],[()=>20,'distance_stalled']]){
  const h=fixture(n=>[...stage,{text:d(n)+'m',box:[80,285,50,20]}]),r=await h.run({key:'W',ms:8000});
  assert.equal(r.stopReason,reason);assert.ok(r.movementMsSent<8000);
 }
});
test('native path monitor cancels on F and joins executor before returning',async()=>{
 let finish,cancelled=false,joined=false;
 const r=await nav.monitorPath({run:()=>new Promise(resolve=>{finish=()=>{joined=true;resolve();};}),
  cts:{cancel(){cancelled=true;finish();}},read:()=>f,checkInput(){},sleep:async()=>{},inspect:rows=>({stopReason:g.movementStop(rows)})});
 assert.equal(r.stopReason,'interaction_prompt');assert.ok(cancelled&&joined);
});
test('native path monitor failure cancels and joins rather than orphaning input',async()=>{
 let finish,joined=false;
 await assert.rejects(nav.monitorPath({run:()=>new Promise(resolve=>{finish=()=>{joined=true;resolve();};}),
  cts:{cancel(){finish();}},read:()=>stage,checkInput(){throw Error('expired');},sleep:async()=>{},inspect(){}}),/expired/);
 assert.ok(joined);
});
test('continuous validator rejects menus/unknown terrain/bad budgets, permits long open-world intent',()=>{
 const r={texts:stage},o={scene:'world',navigation:{terrain:'open'}},value={action:{kind:'navigate',key:'W',ms:8000}};
 assert.equal(validateDecision(value,r,o).action.ms,8000);
 for(const bad of [{scene:'menu',navigation:{terrain:'open'}},{scene:'world',navigation:{terrain:'unknown'}}])assert.throws(()=>validateDecision(value,r,bad));
 assert.throws(()=>validateDecision(value,{texts:[...stage,...f]},o));
 assert.throws(()=>validateDecision({action:{...value.action,ms:8001}},r,o));
});
test('leaving interaction requires exact current target and forces bounded handoff',()=>{
 const o={scene:'world'},r={texts:[...stage,...f]},v={action:{kind:'leave_interaction',key:'S',text:'法拉',ms:9000}};
 assert.equal(validateDecision(v,r,o).action.ms,400);
 assert.throws(()=>validateDecision(v,{texts:stage},o));assert.throws(()=>validateDecision({...v,action:{...v.action,text:'别的人'}},r,o));
 assert.throws(()=>validateDecision(v,r,{scene:'menu'}));
});
test('dialogue advances locally then returns before selecting an option',async()=>{
 let n=0,time=0;const keys=[];
 const result=await nav.advanceDialogue({grounding:g,read:()=>[{text:'自动',box:[80,80,50,20]},{text:'这是当前对话台词内容'+n++,box:[300,940,600,35]},...(n>3?[{text:'我明白了',box:[1200,500,180,35]}]:[])],
  now:()=>time,sleep:async ms=>{time+=ms;},checkInput(){},keyDown:k=>keys.push(k),keyUp(){}});
 assert.equal(result.stopReason,'options');assert.equal(keys.length,3);
});
test('dialogue never advances menu or unchanged subtitle forever',async()=>{
 let time=0;const args={grounding:g,now:()=>time,sleep:async ms=>{time+=ms;},checkInput(){},keyDown(){},keyUp(){}};
 const result=await nav.advanceDialogue({...args,read:()=>[{text:'自动',box:[80,80,50,20]},{text:'当前固定台词内容',box:[300,940,600,35]}]});
 assert.equal(result.stopReason,'subtitle_stalled');assert.equal(result.advances,3);
 const menu=await nav.advanceDialogue({...args,read:()=>[{text:'商城',box:[100,100,80,30]}]});assert.equal(menu.advances,0);
});
test('native CV detects position stall and releases held movement without a visual model',async()=>{
 let time=0;const keys=[];
 const run=nav.create({grounding:g,read:()=>stage,now:()=>time,sleep:async ms=>{time+=ms;},checkInput(){},keyDown:k=>keys.push(['down',k]),keyUp:k=>keys.push(['up',k]),position:()=>({x:10,y:20}),world:()=>true});
 const r=await run({key:'W',ms:8000});assert.equal(r.stopReason,'position_stalled');assert.equal(r.movementMsSent,1800);assert.equal(keys.at(-1)[0],'up');
});
test('valid CV route is offered before exploratory movement; failed direction cannot repeat',()=>{
 const rows=[...stage,{text:'80m',box:[80,285,50,20]}],o={scene:'world',navigation:{terrain:'unknown'},nativeVision:{source:'bettergi_native_cv',ui:'Main',motion:'Normal'}};
 const value={action:{kind:'navigate',key:'W',ms:8000}};
 assert.throws(()=>validateDecision(value,{texts:rows},o),/travel_quest/);
 const failed={seq:1,action:{kind:'navigate',key:'W'},detail:JSON.stringify({stopReason:'distance_increased'})};
 assert.throws(()=>validateDecision(value,{texts:stage,lastStep:failed},o),/上一相同方向/);
 assert.doesNotThrow(()=>validateDecision({...value,action:{...value.action,key:'S'}},{texts:stage,lastStep:failed},o));
});
test('local seeker changes a failing direction then keeps a decreasing direction without model calls',async()=>{
 let n=0;const keys=[];
 const r=await nav.seek({checkInput(){},navigate:async action=>{keys.push(action.key);n++;return {movementMsSent:800,stopReason:n===1?'distance_increased':n===4?'interaction_prompt':'duration_budget',progress:{stageBefore:'收集木材',stageAfter:'收集木材',distanceBefore:90,distanceAfter:80}};}});
 assert.deepEqual(keys,['W','S','S','S']);assert.equal(r.stopReason,'interaction_prompt');assert.equal(r.movementMsSent,3200);
});
test('local seeker exhausts four blocked directions and propagates cancellation without trying again',async()=>{
 const keys=[];const r=await nav.seek({checkInput(){},navigate:async a=>{keys.push(a.key);return {movementMsSent:0,stopReason:'position_stalled'};}});
 assert.deepEqual(keys,['W','S','A','D']);assert.equal(r.stopReason,'directions_exhausted');
 let count=0;await assert.rejects(nav.seek({checkInput(){throw Error('cancel');},navigate:async()=>{count++;}}),/cancel/);assert.equal(count,0);
});
test('departure handoff skips only the model-selected label in the same task stage',()=>{
 const d={text:'法拉',stage:'收集木材'};
 assert.equal(nav.departureStop([...stage,...f],g,d),null);
 assert.equal(nav.departureStop([...stage,...f],g,{...d,text:'烹饪'}),'interaction_prompt');
 assert.equal(nav.departureStop([...stage,...f],g,{...d,stage:'收集绳子'}),'interaction_prompt');
 assert.equal(nav.departureStop([{text:'商城',box:[100,100,80,30]}],g,d),'menu');
});
