const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeAutonomy, observation, actionFor } = require('../src/sts2/native-autonomy');
const view = { scene:'battle',summary:'hand',targets:[{id:'card',label:'打击',point:[400,900]},{id:'enemy',label:'敌人',point:[700,500]}] };
test('zero energy offers grounded end-turn instead of unaffordable cards',async()=>{
  let input;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async(v)=>{
    assert.deepEqual(v.targets.map(t=>t.id),['end-turn']);
    return {kind:'click',targetId:'end-turn'};
  },request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:body.mode==='energy'?{energy:0,maximum:3}:body.target?{target_center:[.89,.82]}:view};
    if(body.kind==='capture')return {id:'1',status:'captured_only'};
    input=body;return {id:'2',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:1});await agent.task;assert.deepEqual(input.to,[.89,.82]);
});
test('map action uses separately grounded point instead of scene estimate',async()=>{
  let input;
  const map={scene:'map',targets:[{id:'node',label:'中上敌人',point:[419,486]}]};
  const agent=new NativeAutonomy({pause:async()=>{},decide:async()=>({kind:'click',targetId:'node'}),request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:body.target?{target_center:[.482,.536]}:map};
    if(body.kind==='capture')return {id:'1',status:'captured_only'};
    input=body;return {id:'2',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:1});await agent.task;assert.deepEqual(input.to,[.482,.536]);
});
test('invalid visual JSON is retried before any decision or input',async()=>{
  let reads=0,plans=0;
  const agent=new NativeAutonomy({decide:async()=>{plans++;return {kind:'stop'};},request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:body.mode==='energy'?{energy:1}:++reads===1?null:view};
    assert.equal(body.kind,'capture');return {id:'1',status:'captured_only'};
  }});
  agent.start();await agent.task;assert.equal(reads,2);assert.equal(plans,1);assert.equal(agent.state.stage,'finished');
});
test('startup focus failure retries screenshots only and recovers',async()=>{
  let captures=0,actions=0;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async()=>({kind:'click',targetId:'card'}),request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:view};
    if(body.kind==='capture') { if(++captures<3)throw Error('Game lost foreground; input stopped');return {id:'1',status:'captured_only'}; }
    actions++;throw Error('Game lost foreground; input stopped');
  }});
  agent.start();await agent.task;
  assert.equal(captures,3);assert.equal(actions,1);assert.equal(agent.state.stage,'error');
});
test('persistent startup focus failure is bounded and sends no game actions',async()=>{
  let captures=0;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async()=>{throw Error('must not plan');},request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    assert.equal(body.kind,'capture');captures++;throw Error('Game lost foreground; input stopped');
  }});
  agent.start();await agent.task;assert.equal(captures,5);assert.match(agent.state.lastError,/未发送游戏操作/);
});
test('only grounded targets can execute', () => {
  observation(view);
  assert.deepEqual(actionFor({kind:'drag',fromId:'card',targetId:'enemy'},view),{kind:'drag',from:[.4,.9],to:[.7,.5]});
  assert.throws(()=>actionFor({kind:'click',targetId:'invented'},view));
  assert.throws(()=>observation({...view,targets:[{id:'a',label:'x',point:[1001,0]}]}));
  assert.throws(()=>observation({...view,targets:[{id:'a',label:'x',point:[500,500]},{id:'b',label:'y',point:[500,500]}]}),/重复/);
  assert.throws(()=>actionFor({kind:'click',targetId:'x'},{scene:'menu',targets:[{id:'x',label:'放弃冒险',point:[1,1]}]}));
});
test('background loop observes again after input and stops at ending', async () => {
  let captures=0; const actions=[]; let calls=0;
  const agent=new NativeAutonomy({persona:()=>({id:'role'}),pause:async()=>{},decide:async(v,h)=>{calls++;if(v.scene==='terminal'){assert.equal(h.length,1);return {kind:'stop'};}return {kind:'drag',fromId:'card',targetId:'enemy'};},request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed: captures===1 ? view : {scene:'terminal',targets:[]}};
    if(body.kind==='capture'){captures++;return {id:String(captures),status:'captured_only'};}
    actions.push(body);return {id:'action',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:5});assert.throws(()=>agent.start());await agent.task;
  assert.equal(actions.length,1);assert.equal(captures,2);assert.equal(calls,2);assert.equal(agent.state.stage,'finished');assert.equal(agent.state.running,false);
});
test('stop during planner wait does not execute planned input', async()=>{
  let release;let acted=false;
  const agent=new NativeAutonomy({decide:()=>new Promise(r=>{release=r;}),request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:view};
    if(body.kind==='capture')return {id:'1',status:'captured_only'};
    acted=true;
  }});
  agent.start();while(!release)await new Promise(r=>setImmediate(r));agent.stop();release({kind:'click',targetId:'card'});await agent.task;assert.equal(acted,false);assert.equal(agent.state.stage,'stopped');
});
test('repeated unchanged actions stop before a third execution',async()=>{
  let acted=0;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async()=>({kind:'click',targetId:'card'}),request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:view};
    if(body.kind==='capture')return {id:'1',status:'captured_only'};
    acted++;return {id:'2',status:'awaiting_visual_review'};
  }});
  agent.start();await agent.task;assert.equal(acted,2);assert.equal(agent.state.stage,'error');
});
