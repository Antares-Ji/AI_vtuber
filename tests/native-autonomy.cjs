const test = require('node:test');
const assert = require('node:assert/strict');
const { NativeAutonomy, observation, actionFor, attachInspectedCard, collapseRepeatedTargets, actionOptions, attachGroundedCard, plannerObservation, groundedMapObservation, attachPlayerFacts, nativePlanningOptions, inspectionContext } = require('../src/sts2/native-autonomy');
const { groundedCardHover } = require('../src/sts2/native-autonomy');
test('card hover rejects neighboring, ambiguous, missing and distant locator results',()=>{
  const current={scene:'battle',targets:[{id:'left',kind:'card',point:[380,845]},{id:'middle',kind:'card',point:[500,730]},{id:'right',kind:'card',point:[620,845]}]};
  assert.deepEqual(groundedCardHover(current,'left',{target_visible:true,target_center:[.359,.876]}),[.359,.876]);
  for(const result of [{target_visible:false,target_center:[.359,.876]},{target_visible:true,target_center:[.623,.875]},{target_visible:true,target_center:[.5,.95]},{target_visible:true,target_center:[.1,.5]},{target_visible:true,target_center:[NaN,.9]}])assert.throws(()=>groundedCardHover(current,'left',result),/手牌/);
});
test('OCR title hover uses a same-frame local API interior before sending native input',async()=>{
  let input, located=0;
  const current={...view,targets:[{...view.targets[0],name_source:'local_ocr',point:[378,845]},view.targets[1]]};
  const agent=new NativeAutonomy({pause:async()=>{},decide:async()=>({kind:'hover',targetId:'card'}),request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card'){
      if(body.target){located++;assert.equal(body.frameId,'fresh');assert.match(body.target,/打击/);return {parsed:{target_visible:true,target_center:[.359,.876]}};}
      return {parsed:visionFor(body,current)};
    }
    if(body.kind==='capture')return {id:'fresh',status:'captured_only'};
    input=body;return {id:'input',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:1});await agent.task;
  assert.equal(agent.state.stage,'step-limit');assert.equal(located,1);assert.deepEqual(input.to,[.359,.876]);assert.equal(input.frameId,'fresh');
});
test('native role planning enables bounded thinking and validates explicit overrides',()=>{
  assert.deepEqual(nativePlanningOptions({}),{thinking:{type:'enabled'},reasoning_effort:'high',max_tokens:4096});
  assert.deepEqual(nativePlanningOptions({STS2_NATIVE_THINKING:'disabled'}),{thinking:{type:'disabled'},max_tokens:1000});
  assert.equal(nativePlanningOptions({STS2_NATIVE_THINKING:'low',STS2_NATIVE_MAX_TOKENS:'8192'}).max_tokens,8192);
  for(const env of [{STS2_NATIVE_THINKING:'typo'},{STS2_NATIVE_MAX_TOKENS:'0'},{STS2_NATIVE_MAX_TOKENS:'999999'},{STS2_NATIVE_MAX_TOKENS:'NaN'},{STS2_NATIVE_MAX_TOKENS:'1000.5'}])assert.throws(()=>nativePlanningOptions(env),/STS2_NATIVE/);
});
const view = { scene:'battle',summary:'hand',frameId:'1',energy:1,targets:[{id:'card',kind:'card',label:'打击',point:[400,900],card:{name:'打击',cost:1,type:'攻击',description:'造成6点伤害。',observedFrameId:'1'}},{id:'enemy',kind:'enemy',label:'敌人',point:[700,500]}] };
const visionFor = (body, current=view) => body.mode==='energy' ? {energy:1} : body.mode==='battle' ? {...current,targets:current.targets.filter(t=>t.kind!=='card')} : body.mode==='hand' ? {...current,targets:current.targets.filter(t=>t.kind==='card')} : current;
const groundedMap=()=>({parsed:{scene:'map',targets:[{id:'N1',label:'问号',point:[410,509],grounding:'local_cv_qwen',directly_connected:true}],map_grounding:{source:'local_cv_qwen',marker_id:'R1',marker_point:[412,630]}},pixel_candidates:{red:[{id:'R1',point:[412,630]}],dark:[{id:'N1',point:[410,509]}]}});
test('inspection notes compare read rules without authorizing stale cards or exposing points',()=>{
  const previous={before:view,decision:{kind:'hover'},result:{status:'awaiting_visual_review'}};
  const current={...view,frameId:'2',targets:[{...view.targets[0],card:{name:'打击',cost:1}},view.targets[1]]};
  const notes=inspectionContext(current,[previous]);
  assert.equal(notes.referenceOnly,true);assert.equal(notes.cards.length,1);assert.equal(notes.hovers,1);
  assert.equal(notes.cards[0].seenFrameId,'1');assert.equal(notes.cards[0].point,undefined);assert.equal(notes.cards[0].observedFrameId,undefined);
  assert.throws(()=>actionFor({kind:'drag',fromId:'card',targetId:'enemy'},current),/本地视觉/);
  const wait={before:view,decision:{kind:'wait'},result:{status:'waited_without_input'}};
  assert.equal(inspectionContext(current,[previous,wait,{rejected:true}]).hovers,1);
});
test('inspection notes expire after gameplay input, changed energy or scene',()=>{
  const previous={before:view,decision:{kind:'hover'},result:{status:'awaiting_visual_review'}};
  for(const entry of [{...previous,decision:{kind:'drag'}},{...previous,decision:{kind:'click'}},{...previous,result:{status:'failed'}}])assert.equal(inspectionContext(view,[previous,entry]).cards.length,0);
  assert.equal(inspectionContext({...view,energy:0},[previous]).cards.length,0);
  assert.equal(inspectionContext({...view,scene:'reward'},[previous]).cards.length,0);
});
test('varying battle hovers cannot evade the inspection episode budget',async()=>{
  let captures=0,acted=0;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async()=>({kind:'hover',targetId:'card'}),request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card'){
      if(body.mode==='card')return {parsed:{uncertain:true,cards:[]}};
      const current={...view,summary:String(captures),targets:[{...view.targets[0],point:[400+captures,900],card:{name:'打击',cost:1}},view.targets[1]]};
      return {parsed:visionFor(body,current)};
    }
    if(body.kind==='capture')return {id:String(++captures),status:'captured_only'};
    acted++;return {id:'input',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:20});await agent.task;assert.equal(acted,12);assert.equal(agent.state.stage,'error');assert.match(agent.state.lastError,/十二次/);
});
test('player facts do not turn fractional energy or missing shield readings into block',()=>{
  const old={...view,summary:'玩家格挡2/3，卡牌获得5点格挡'};
  const result=attachPlayerFacts(old,{player:{hp:75,max_hp:80,block:'2/3'}});
  assert.deepEqual(result.player,{hp:75,max_hp:80,block:null});assert.doesNotMatch(result.summary,/2\/3|5点/);
  assert.equal(attachPlayerFacts(old,null).player.block,null);
  assert.deepEqual(attachPlayerFacts(old,{player:{hp:1,max_hp:null,block:null}}).player,{hp:null,max_hp:null,block:null});
  assert.deepEqual(attachPlayerFacts(old,{player:{hp:90,max_hp:80,block:0}}).player,{hp:null,max_hp:null,block:0});
});
test('hover HUD conflicts become unknown without inventing a previous or zero value',()=>{
  const previous={before:{scene:'battle',player:{hp:75,max_hp:80,block:5}},decision:{kind:'hover'},result:{status:'awaiting_visual_review'}};
  const result=attachPlayerFacts(view,{player:{hp:1,max_hp:1,block:0}},previous);
  assert.deepEqual(result.player,{hp:null,max_hp:null,block:null});
  assert.deepEqual(result.player_conflicts,['hp','max_hp','block']);
  assert.match(result.summary,/识别冲突/);
  assert.deepEqual(attachPlayerFacts(view,{player:{hp:75,max_hp:80,block:5}},previous).player,{hp:75,max_hp:80,block:5});
  for(const change of [{decision:{kind:'drag'}},{decision:{kind:'click'}},{rejected:true},{result:{status:'failed'}},{before:{scene:'reward',player:previous.before.player}}]) {
    assert.deepEqual(attachPlayerFacts(view,{player:{hp:70,max_hp:80,block:0}},{...previous,...change}).player,{hp:70,max_hp:80,block:0});
  }
  assert.deepEqual(attachPlayerFacts(view,{player:{hp:null,max_hp:null,block:null}},previous).player,{hp:null,max_hp:null,block:null});
});
test('hover conflicts are filtered before the next role API decision',async()=>{
  let plans=0,captures=0;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async(v)=>{
    if(++plans===1)return {kind:'hover',targetId:'card'};
    assert.deepEqual(v.player,{hp:null,max_hp:null,block:null});
    assert.deepEqual(v.player_conflicts,['hp','max_hp','block']);return {kind:'stop'};
  },request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true,playerSupport:true};
    if(route==='read-card'){
      if(body.mode==='player')return {parsed:{player:captures===1?{hp:75,max_hp:80,block:5}:{hp:1,max_hp:1,block:0}}};
      if(body.mode==='card')return {parsed:{uncertain:true,cards:[]}};
      return {parsed:visionFor(body)};
    }
    if(body.kind==='capture')return {id:String(++captures),status:'captured_only'};
    assert.equal(body.kind,'hover');return {id:'input',status:'awaiting_visual_review'};
  }});
  agent.start();await agent.task;assert.equal(plans,2);assert.equal(agent.state.stage,'finished');
});
test('enemy hover never authorizes expanded hand crops or card inspection',async()=>{
  let plans=0,handReads=0,cardReads=0;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async()=>++plans===1?{kind:'hover',targetId:'enemy'}:{kind:'stop'},request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card'){
      if(body.mode==='hand'){handReads++;assert.deepEqual(body.crop,[0,.72,1,1]);}
      if(body.mode==='card')cardReads++;
      return {parsed:visionFor(body)};
    }
    if(body.kind==='capture')return {id:String(plans),status:'captured_only'};
    assert.equal(body.kind,'hover');return {id:'input',status:'awaiting_visual_review'};
  }});
  agent.start();await agent.task;
  assert.equal(plans,2);assert.equal(handReads,2);assert.equal(cardReads,0);assert.equal(agent.state.stage,'finished');
});
test('player crop is read through the API and remains separate from energy before role planning',async()=>{
  let playerReads=0;
  const agent=new NativeAutonomy({decide:async(v)=>{
    assert.deepEqual(v.player,{hp:75,max_hp:80,block:null});assert.equal(v.energy,1);return {kind:'stop'};
  },request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true,playerSupport:true};
    if(route==='read-card'){
      if(body.mode==='player'){playerReads++;assert.deepEqual(body.crop,[0,.25,.45,.78]);return {parsed:{player:{hp:75,max_hp:80,block:null}}};}
      return {parsed:visionFor(body)};
    }
    assert.equal(body.kind,'capture');return {id:'1',status:'captured_only'};
  }});
  agent.start();await agent.task;assert.equal(playerReads,1);assert.equal(agent.state.stage,'finished');
});
test('grounded map requires selected IDs and coordinates to match current pixel evidence',()=>{
  assert.equal(groundedMapObservation(groundedMap()).targets[0].id,'N1');
  assert.equal(plannerObservation(groundedMap().parsed).map_grounding.marker_point,undefined);
  for(const mutate of [r=>{r.pixel_candidates.dark=[];},r=>{r.parsed.targets[0].point=[400,450];},r=>{r.parsed.targets[0].directly_connected=false;},r=>{r.parsed.map_grounding.marker_point=[400,500];}]) {
    const result=groundedMap();mutate(result);assert.throws(()=>groundedMapObservation(result),/地图/);
  }
});
test('map pixel and local-model API evidence lets the role choose a node and then observe a new room',async()=>{
  let captures=0,input;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async(v)=>v.scene==='map'?{kind:'click',targetId:'N1'}:{kind:'stop'},request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true,mapGroundingSupport:true};
    if(route==='read-card'){
      assert.equal(body.target,undefined);
      if(captures===2)return {parsed:{scene:'event',targets:[]}};
      return body.mode==='map-grounded'?groundedMap():{parsed:{scene:'map',targets:[]}};
    }
    if(body.kind==='capture')return {id:String(++captures),status:'captured_only'};
    input=body;return {id:'input',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:3});await agent.task;assert.equal(agent.state.stage,'finished');assert.equal(captures,2);assert.deepEqual(input.to,[.410,.509]);
});
test('a cleared room forwards its visible button without route-map node grounding',async()=>{
  const room={scene:'room',summary:'战后房间',targets:[{id:'forward',label:'前进',point:[850,700]}]};let input;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async(v)=>{assert.equal(v.scene,'room');return {kind:'click',targetId:'forward'};},request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card'){assert.equal(body.mode,'scene');return {parsed:room};}
    if(body.kind==='capture')return {id:'1',status:'captured_only'};
    input=body;return {id:'input',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:1});await agent.task;assert.equal(agent.state.stage,'step-limit');assert.deepEqual(input.to,[.85,.7]);
});
test('reward planning receives legal IDs without raw vision coordinate alternatives',()=>{
  const reward={scene:'reward',points:[['金币',436,379]],targets:[{id:'t1',label:'金币',point:[436,379]},{id:'t2',label:'退出游戏',point:[800,300]}]};
  const planned=plannerObservation(reward);
  assert.equal(planned.points,undefined);assert.equal(planned.targets[0].point,undefined);
  assert.deepEqual(actionOptions(reward).targets,[{targetId:'t1',label:'金币',allowed:['click','hover']}]);
  assert.deepEqual(actionFor({kind:'click',targetId:'t1'},reward),{kind:'click',to:[.436,.379]});
  assert.throws(()=>actionFor({kind:'click',targetId:'436,379'},reward),/不可用/);
});
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
test('zero energy keeps inspection and grounded end-turn but rejects unaffordable drags',async()=>{
  let input;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async(v)=>{
    assert.ok(v.targets.some(t=>t.id==='card'));
    assert.deepEqual(actionOptions(v).cards[0].allowed,['hover']);
    assert.throws(()=>actionFor({kind:'drag',fromId:'card',targetId:'enemy'},v),/本地视觉/);
    return {kind:'click',targetId:'end-turn'};
  },request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:body.mode==='energy'?{energy:0,maximum:3}:body.target?{target_visible:true,target_center:[.89,.82]}:visionFor(body)};
    if(body.kind==='capture')return {id:'1',status:'captured_only'};
    input=body;return {id:'2',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:1});await agent.task;assert.deepEqual(input.to,[.89,.82]);
});
test('zero energy allows a fresh fully-read zero-cost card through the full API loop',async()=>{
  let input;
  const free={...view,targets:[{...view.targets[0],card:{...view.targets[0].card,cost:0}},view.targets[1],{id:'old-end',kind:'button',label:'结束回合',point:[890,820]}]};
  const agent=new NativeAutonomy({pause:async()=>{},decide:async(v)=>{
    assert.equal(v.targets.filter(t=>t.kind==='button').length,1);
    assert.ok(actionOptions(v).cards[0].allowed.includes('drag'));
    return {kind:'drag',fromId:'card',targetId:'enemy'};
  },request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:body.mode==='energy'?{energy:0,maximum:3}:body.target?{target_visible:true,target_center:[.89,.82]}:visionFor(body,free)};
    if(body.kind==='capture')return {id:'1',status:'captured_only'};
    input=body;return {id:'2',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:1});await agent.task;assert.equal(input.kind,'drag');assert.deepEqual(input.to,[.7,.5]);
});
test('map action uses separately grounded point instead of scene estimate',async()=>{
  let input;
  const map={scene:'map',targets:[{id:'node',label:'中上敌人',point:[419,486]}]};
  const agent=new NativeAutonomy({pause:async()=>{},decide:async()=>({kind:'click',targetId:'node'}),request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:body.target?{target_visible:true,target_center:[.482,.536]}:map};
    if(body.kind==='capture')return {id:'1',status:'captured_only'};
    input=body;return {id:'2',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:1});await agent.task;assert.deepEqual(input.to,[.482,.536]);
});
test('map readers that disagree or cannot see the target never authorize input',async()=>{
  for(const located of [{target_visible:false,target_center:[.42,.48]},{target_visible:true,target_center:[.42,.9]}]) {
    let actions=0;
    const agent=new NativeAutonomy({pause:async()=>{},decide:async()=>({kind:'click',targetId:'node'}),request:async(route,body)=>{
      if(route==='vision-state')return {ready:true,sceneSupport:true};
      if(route==='read-card')return {parsed:body.target?located:{scene:'map',targets:[{id:'node',label:'敌人',point:[420,480]}]}};
      if(body.kind==='capture')return {id:'1',status:'captured_only'};
      actions++;return {id:'input',status:'awaiting_visual_review'};
    }});
    agent.start();await agent.task;assert.equal(actions,0);assert.equal(agent.state.stage,'error');
  }
});
test('alternating map hovers cannot escape the navigation budget or force a map close',async()=>{
  let captures=0,actions=0;
  const map={scene:'map',targets:[{id:'left',label:'左侧敌人',point:[300,500]},{id:'right',label:'右侧敌人',point:[600,500]}]};
  const agent=new NativeAutonomy({pause:async()=>{},decide:async(v)=>{
    assert.deepEqual(v.targets.map(t=>t.id),['left','right']);
    return {kind:'hover',targetId:captures%2?'left':'right'};
  },request:async(route,body)=>{
    if(route==='vision-state')return {ready:true,sceneSupport:true};
    if(route==='read-card')return {parsed:body.target?{target_visible:true,target_center:[captures%2?.3:.6,.5]}:{...map,summary:`不同措辞${captures}`}};
    if(body.kind==='capture')return {id:String(++captures),status:'captured_only'};
    actions++;return {id:'input',status:'awaiting_visual_review'};
  }});
  agent.start();await agent.task;assert.equal(actions,8);assert.equal(captures,9);assert.match(agent.state.lastError,/连续八次/);
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
