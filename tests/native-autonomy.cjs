const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeAutonomy, observation, actionFor, attachInspectedCard, collapseRepeatedTargets, actionOptions, attachGroundedCard } = require('../src/sts2/native-autonomy');
const view = { scene:'battle',summary:'hand',frameId:'1',energy:1,targets:[{id:'card',kind:'card',label:'打击',point:[400,900],card:{name:'打击',cost:1,type:'攻击',description:'造成6点伤害。',observedFrameId:'1'}},{id:'enemy',kind:'enemy',label:'敌人',point:[700,500]}] };
const visionFor = (body, current=view) => body.mode==='energy' ? {energy:1} : body.mode==='battle' ? {...current,targets:current.targets.filter(t=>t.kind!=='card')} : body.mode==='hand' ? {...current,targets:current.targets.filter(t=>t.kind==='card')} : current;
test('an omitted lifted card needs complete current OCR and separate nearby visible grounding',()=>{
  const current={...view,targets:[view.targets[1]]};
  const parsed={uncertain:false,cards:[{name:'预备打击',cost:1,type:'攻击',description:'造成7点伤害。在本回合内获得2点力量。'}]};
  const located={target_visible:true,target_center:[.4,.65]};
  const grounded=attachGroundedCard(current,parsed,[.4,.9],located);
  assert.deepEqual(actionFor({kind:'drag',fromId:'inspected-1',targetId:'enemy'},grounded),{kind:'drag',from:[.4,.65],to:[.7,.5]});
  for(const wrong of [{...located,target_visible:false},{...located,target_center:[.8,.65]},{...located,target_center:[.4,.2]},{...located,target_center:[NaN,.65]}])assert.equal(attachGroundedCard(current,parsed,[.4,.9],wrong),current);
  assert.equal(attachGroundedCard(current,{...parsed,uncertain:true},[.4,.9],located),current);
});
test('planner options expose only currently affordable fully observed drag destinations',()=>{
  assert.deepEqual(actionOptions(view).cards[0].destinations,[{targetId:'enemy',label:'敌人'}]);
  assert.deepEqual(actionOptions({...view,energy:0}).cards[0].allowed,['hover']);
  assert.deepEqual(actionOptions({...view,frameId:'different'}).cards[0].destinations,[]);
});
test('the autonomous API loop grounds an expanded card omitted by the hand reader before dragging',async()=>{
  let captures=0,plans=0,groundings=0;const sent=[];
  const parsed={uncertain:false,cards:[{name:'打击',cost:1,type:'攻击',description:'造成6点伤害。'}]};
  const agent=new NativeAutonomy({pause:async()=>{},decide:async(current)=>{
    if(++plans===1)return {kind:'hover',targetId:'card'};
    assert.equal(current.targets.find(t=>t.id==='inspected-2').card.observedFrameId,'2');
    return {kind:'drag',fromId:'inspected-2',targetId:'enemy'};
  },request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card'){
      if(body.target){groundings++;return {parsed:{target_visible:true,target_center:[.4,.65]}};}
      if(body.mode==='card')return {parsed};
      if(body.mode==='hand' && captures===2)return {parsed:{scene:'battle',targets:[]}};
      return {parsed:visionFor(body)};
    }
    if(body.kind==='capture')return {id:String(++captures),status:'captured_only'};
    sent.push(body.kind);return {id:'input',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:2});await agent.task;
  assert.deepEqual(sent,['hover','drag']);assert.equal(groundings,1);assert.equal(agent.state.stage,'step-limit');
});
test('identical repeated target facts collapse but conflicting shared coordinates remain invalid',()=>{
  const enemy=view.targets[1];
  const value={...view,targets:[enemy,{...enemy,id:'duplicate'}]};
  const clean=observation(collapseRepeatedTargets(value));assert.deepEqual(clean.targets,[enemy]);assert.equal(clean.repeatedTargetsCollapsed,1);
  value.targets[1]={...enemy,id:'different',label:'不同目标'};
  assert.throws(()=>observation(collapseRepeatedTargets(value)),/重复/);
});
test('zero energy offers grounded end-turn instead of unaffordable cards',async()=>{
  let input;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async(v)=>{
    assert.deepEqual(v.targets.map(t=>t.id),['end-turn']);
    return {kind:'click',targetId:'end-turn'};
  },request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:body.mode==='energy'?{energy:0,maximum:3}:body.target?{target_center:[.89,.82]}:visionFor(body)};
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
    if(route==='read-card')return {parsed:body.mode==='scene' && ++reads===1?null:visionFor(body)};
    assert.equal(body.kind,'capture');return {id:'1',status:'captured_only'};
  }});
  agent.start();await agent.task;assert.equal(reads,2);assert.equal(plans,1);assert.equal(agent.state.stage,'finished');
});
test('startup focus failure retries screenshots only and recovers',async()=>{
  let captures=0,actions=0;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async()=>({kind:'hover',targetId:'card'}),request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:visionFor(body)};
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
    if(route==='read-card')return {parsed: captures===1 ? visionFor(body) : {scene:'terminal',targets:[]}};
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
    if(route==='read-card')return {parsed:visionFor(body)};
    if(body.kind==='capture')return {id:'1',status:'captured_only'};
    acted=true;
  }});
  agent.start();while(!release)await new Promise(r=>setImmediate(r));agent.stop();release({kind:'click',targetId:'card'});await agent.task;assert.equal(acted,false);assert.equal(agent.state.stage,'stopped');
});
test('repeated unchanged actions stop before a third execution',async()=>{
  let acted=0;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async()=>({kind:'click',targetId:'enemy'}),request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:visionFor(body)};
    if(body.kind==='capture')return {id:'1',status:'captured_only'};
    acted++;return {id:'2',status:'awaiting_visual_review'};
  }});
  agent.start();await agent.task;assert.equal(acted,2);assert.equal(agent.state.stage,'error');
});
test('wait feedback reaches the next API plan and never emits native input',async()=>{
  let plans=0;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async(v,h)=>{
    if(++plans===1)return {kind:'wait'};
    assert.equal(h.at(-1).result.status,'waited_without_input');return {kind:'stop'};
  },request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:visionFor(body)};
    assert.equal(body.kind,'capture');return {id:'1',status:'captured_only'};
  }});
  agent.start();await agent.task;assert.equal(plans,2);assert.equal(agent.state.stage,'finished');
});
test('an unknown or stale card cannot be dragged based on model guesses',()=>{
  for(const card of [{name:'手牌4',cost:0},{...view.targets[0].card,observedFrameId:'old'},{...view.targets[0].card,cost:2},{...view.targets[0].card,type:'未知'},{...view.targets[0].card,description:'看不清'}]) {
    const current={...view,targets:[{...view.targets[0],card},view.targets[1]]};
    assert.throws(()=>actionFor({kind:'drag',fromId:'card',targetId:'enemy'},current),/本地视觉/);
    assert.deepEqual(actionFor({kind:'hover',targetId:'card'},current),{kind:'hover',to:[.4,.9]});
  }
  assert.throws(()=>actionFor({kind:'click',targetId:'card'},view),/drag/);
  assert.throws(()=>actionFor({kind:'drag',fromId:'card',targetId:'card'},view),/终点/);
});
test('invalid hand observations retry locally and never reach a planner or input if still invalid',async()=>{
  let handReads=0,plans=0;
  const agent=new NativeAutonomy({decide:async()=>{plans++;throw Error('must not plan');},request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card') { if(body.mode==='hand'){handReads++;return {parsed:null,normalization_error:'Invalid model point'};}return {parsed:visionFor(body)}; }
    assert.equal(body.kind,'capture');return {id:'1',status:'captured_only'};
  }});
  agent.start();await agent.task;assert.equal(handReads,2);assert.equal(plans,0);assert.match(agent.state.lastError,/hand/);
});
test('only unambiguous fresh expanded OCR matching the hovered hand authorizes a card',()=>{
  const current={...view,frameId:'new',targets:[{...view.targets[0],card:{name:'打击',cost:1}},view.targets[1]]};
  const parsed={uncertain:false,cards:[{name:'打击',cost:1,type:'攻击',description:'造成6点伤害。'}]};
  assert.equal(attachInspectedCard(current,parsed,[.4,.9]).targets[0].card.observedFrameId,'new');
  const lifted={...current,targets:[{...current.targets[0],point:[400,650]},current.targets[1]]};
  assert.equal(attachInspectedCard(lifted,parsed,[.4,.9]).targets[0].card.observedFrameId,'new');
  const ambiguous={...lifted,targets:[...lifted.targets,{...lifted.targets[0],id:'other',point:[405,700]}]};
  assert.equal(attachInspectedCard(ambiguous,parsed,[.4,.9]).targets[0].card.observedFrameId,undefined);
  for(const p of [{...parsed,uncertain:true},{...parsed,cards:[...parsed.cards,...parsed.cards]},{uncertain:false,cards:[{...parsed.cards[0],cost:0}]}]) {
    assert.equal(attachInspectedCard(current,p,[.4,.9]).targets[0].card.observedFrameId,undefined);
  }
});
test('a rejected model guess replans through the API before sending only the valid hover',async()=>{
  let decisions=0;const sent=[];
  const unknown={...view,targets:[{...view.targets[0],card:{name:null,cost:null}},view.targets[1]]};
  const agent=new NativeAutonomy({pause:async()=>{},decide:async(v,h)=>{
    if(++decisions===1)return {kind:'drag',fromId:'card',targetId:'enemy'};
    assert.equal(h.at(-1).rejected,true);return {kind:'hover',targetId:'card'};
  },request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:visionFor(body,unknown)};
    if(body.kind==='capture')return {id:'1',status:'captured_only'};
    sent.push(body.kind);return {id:'2',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:1});await agent.task;assert.deepEqual(sent,['hover']);assert.equal(decisions,2);
  const finished=agent.state.stage;agent.stop();assert.equal(agent.state.stage,finished);
});
