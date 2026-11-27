'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createTravelQuest}=require('../scripts/genshin/story/macros/travel-quest');
const grounding=require('../scripts/genshin/story/grounding');

const rows=distance=>[
 {text:'前去查看详情',box:[76,246,153,35]},
 {text:`${distance}m`,box:[80,281,49,19],source:'quest_distance_crop'},
];
const projected=()=>({ok:true,heading:90,positionSamples:[{x:100,y:200},{x:102,y:203}],
 source:'minimap_projection',samples:[{at:1000},{at:1100}]});
function harness(options={}){
 const state={clock:1000,deadline:1000000,cancelled:false,pathCalls:0,pending:false,
  positionCalls:0,orientationCalls:0,templateLoads:0,captures:0,frameDisposals:0,
  miniCalls:0,miniDisposals:0,diagnosticDisposals:0,events:[],routes:[],tokens:[],diagnosticCalls:[]};
 const manifest={source:'fixed-upstream-fixture',assets:[{file:'minimap-task.png',sha256:'fixture-only'}]};
 const diagnostics={observe(frame,config){
  state.diagnosticCalls.push(config);
  return {kind:config.kind,roi:config.roi,peaks:[{template:'quest-marker.png',score:0.91,status:'ok'}],
   candidates:[{x:960,y:210}],unique:{x:960,y:210},accepted:true,productionComplete:true};
 },dispose(){state.diagnosticDisposals++;state.events.push('diagnostics-dispose');}};
 let minimapDependencies;
 const deps={grounding,now:()=>state.clock,getDeadline:()=>state.deadline,
  sleep:async ms=>{state.clock+=ms;await options.onSleep?.(ms,state);},
  checkInput(){if(state.cancelled)throw Object.assign(Error('fixture cancellation'),{code:'STORY_FOCUS_LOST'});},
  keyDown:key=>state.events.push(['down',key]),
  keyUp:key=>{assert.equal(state.pending,false,'path must be joined before releasing keys');state.events.push(['up',key]);},
  moveMouseBy:(x,y)=>state.events.push(['turn',x,y]),middleButtonClick:()=>state.events.push('camera-reset'),
  captureGameRegion(){state.captures++;return {width:1920,height:1080,dispose(){state.frameDisposals++;},
   findMulti(){return {count:1,0:{x:950,y:200,width:20,height:20,matchScore:0.91}};}};},
  readTexts(){const distances=options.distances||[184,184];return rows(distances[Math.min(state.pathCalls,distances.length-1)]);},
  file:{readImageMatSync(){state.templateLoads++;return {dispose(){state.events.push('screen-template-dispose');}};},
   readTextSync(name){assert.equal(name,'minimap-candidates.source.json');return JSON.stringify(manifest);}},
  RecognitionObject:{templateMatch:()=>({})},
  genshin:{getPositionFromMap(...args){state.positionCalls++;state.events.push(['legacy-position',...args]);return {X:0,Y:0};},
   getCameraOrientation(){state.orientationCalls++;if(options.cameraError)throw options.cameraError;
    if(options.cancelAtCamera)state.cancelled=true;return options.cameraDegrees??0;}},
  projectMinimap:()=>{throw Error('projection should be owned by the minimap helper');},
  minimapRoi:require('../scripts/genshin/story/vision/minimap-bearing').minimapRoi,
  minimapTemplateNames:require('../scripts/genshin/story/vision/minimap-bearing').templateNames,
  createDiagnostics(received){assert.equal(received.file,deps.file);return diagnostics;},
  createMinimapBearing(received){minimapDependencies=received;return {
   async samplePair(stage){assert.equal(stage,'前去查看详情');state.miniCalls++;
    await options.onSample?.(state);
    if(options.sampleError)throw Object.assign(Error('sample cancelled'),{code:'SAMPLE_CANCELLED'});
    return options.miniResults?.[Math.min(state.miniCalls-1,options.miniResults.length-1)]||projected();},
   dispose(){state.miniDisposals++;state.events.push('minimap-dispose');},
  };},
  createCancellationTokenSource(){const cts={token:{},isCancellationRequested:false,
   cancelAfter(ms){this.budget=ms;},cancel(){this.isCancellationRequested=true;state.events.push('path-cancel');},
   dispose(){state.events.push('path-token-dispose');}};state.tokens.push(cts);return cts;},
  pathingScript:{async run(json,token){
   state.pending=true;state.events.push('path-start');state.routes.push(JSON.parse(json));state.pathCalls++;
   assert.equal(token,state.tokens.at(-1).token);await Promise.resolve();state.clock+=4000;
   if(options.pathTimeout)state.tokens.at(-1).isCancellationRequested=true;
   state.pending=false;state.events.push('path-end');await options.onPath?.(state);
   if(options.pathError)throw Error('path failed');
  }},
 };
 return {state,manifest,run:createTravelQuest(deps),get minimapDependencies(){return minimapDependencies;}};
}
function noScreenFallback(state){
 assert.equal(state.positionCalls,0);assert.equal(state.templateLoads,0);
 assert.equal(state.events.some(e=>Array.isArray(e)&&e[0]==='turn'),false);
 assert.equal(state.events.some(e=>Array.isArray(e)&&e[0]==='down'&&e[1]==='VK_V'),false);
 assert.equal(state.diagnosticCalls.some(c=>c.kind==='screen'),false);
}
function released(state){
 assert.equal(state.miniDisposals,1);assert.equal(state.diagnosticDisposals,1);
 assert.equal(state.captures,state.frameDisposals);
 assert.ok(state.events.some(e=>Array.isArray(e)&&e[0]==='up'&&e[1]==='VK_W'));
}
test('accepted minimap pair supplies position and heading without screen alignment or legacy position APIs',async()=>{
 const h=harness(),result=await h.run(7);
 noScreenFallback(h.state);assert.equal(h.state.pathCalls,1);
 assert.equal(h.minimapDependencies.diagnostics.observe instanceof Function,true);
 assert.equal(h.minimapDependencies.project instanceof Function,true);
 assert.deepEqual(result.legs[0].samples,[{x:100,y:200},{x:102,y:203}]);
 assert.deepEqual(result.legs[0].from,{x:102,y:203});assert.equal(result.legs[0].theta,90);
 assert.equal(result.legs[0].bearingSource,'minimap_projection');
 assert.equal(result.legs[0].cameraOrientation.degrees,0);
 assert.equal(result.legs[0].minimapNorthUpAssumed,false);
 const target=h.state.routes[0].positions[0];assert.ok(Math.abs(target.x-102)<1e-8);assert.ok(Math.abs(target.y-178)<1e-8);
 assert.equal(target.move_mode,'walk');assert.deepEqual(result.templateSet,h.manifest);
 assert.equal(result.bearings.length,0);assert.equal(result.minimapBearings.length,1);released(h.state);
});

test('camera diagnostics never replace projection heading and ordinary errors remain explicit',async()=>{
 for(const options of [{cameraDegrees:270},{cameraError:Error('camera unavailable')}]){
  const h=harness(options),result=await h.run(1);
  assert.equal(result.legs[0].theta,90);assert.equal(h.state.orientationCalls,1);
  assert.equal(result.legs[0].cameraOrientation.degrees,options.cameraError?null:270);
  if(options.cameraError)assert.equal(result.legs[0].cameraOrientation.error,'camera unavailable');
  assert.equal(h.state.pathCalls,1);
 }
});

test('cancellation during camera telemetry never starts a path or resets camera',async()=>{
 for(const options of [{cancelAtCamera:true},{cameraError:Object.assign(Error('cancelled'),{code:'STORY_CANCELLED'})}]){
  const h=harness(options),result=await h.run(1);
  assert.equal(result.stopReason,'native_error');assert.equal(h.state.pathCalls,0);
  assert.equal(h.state.events.includes('camera-reset'),false);released(h.state);
 }
});
test('minimap stop suppresses screen fallback and path even when ok is also present',async()=>{
 for(const reason of ['interaction_prompt','map','stage_changed','deadline']){
  const h=harness({miniResults:[{...projected(),stop:true,reason}]}),result=await h.run(1);
  assert.equal(result.stopReason,reason);assert.equal(h.state.pathCalls,0);noScreenFallback(h.state);
  assert.equal(h.state.events.includes('camera-reset'),false);released(h.state);
 }
});
test('minimap quality failure falls back to screen alignment and independent legacy map samples',async()=>{
 const h=harness({miniResults:[{ok:false,reason:'quality_failed'}]}),result=await h.run(1);
 assert.equal(h.state.pathCalls,1);assert.equal(h.state.positionCalls,2);assert.equal(h.state.orientationCalls,1);
 assert.equal(result.legs[0].bearingSource,'screen_camera');assert.deepEqual(result.legs[0].samples,[{x:0,y:0},{x:0,y:0}]);
 assert.equal(h.state.routes[0].positions[0].x,-25);assert.equal(h.state.routes[0].positions[0].y,0);
 assert.ok(h.state.events.some(e=>Array.isArray(e)&&e[0]==='turn'&&e[2]===7000));
 assert.ok(h.state.diagnosticCalls.some(c=>c.kind==='screen'&&c.productionThreshold===0.8));
 assert.ok(h.state.diagnosticCalls.some(c=>c.kind==='minimap'&&c.templateNames.includes('minimap-commission.png')));
 assert.equal(result.bearings[0][0].ncc.peaks[0].score,0.91);released(h.state);
});
test('cancellation or deadline after minimap observation prevents path and subsequent camera input',async()=>{
 for(const mode of ['cancel','deadline']){
  const h=harness({onSample(s){if(mode==='cancel')s.cancelled=true;else s.clock=s.deadline-1000;}}),result=await h.run(1);
  assert.equal(result.stopReason,mode==='cancel'?'native_error':'deadline');
  if(mode==='cancel')assert.equal(result.errorCode,'STORY_FOCUS_LOST');
  assert.equal(h.state.pathCalls,0);assert.equal(h.state.events.includes('camera-reset'),false);
  noScreenFallback(h.state);released(h.state);
 }
});
test('deadline during pre-path reset wait rejects a late PathExecutor call',async()=>{
 const h=harness({onSleep(ms,s){if(ms===200)s.clock=s.deadline-1000;}}),result=await h.run(1);
 assert.equal(result.stopReason,'deadline');assert.equal(h.state.pathCalls,0);
 assert.equal(h.state.events.filter(e=>e==='camera-reset').length,1);noScreenFallback(h.state);released(h.state);
});
test('minimap pair instability remains rejected before reset or path',async()=>{
 const h=harness({miniResults:[{...projected(),positionSamples:[{x:0,y:0},{x:11,y:0}]}]}),result=await h.run(1);
 assert.equal(result.stopReason,'position_unstable');assert.equal(h.state.pathCalls,0);
 assert.equal(h.state.events.includes('camera-reset'),false);noScreenFallback(h.state);released(h.state);
});
test('first minimap-directed leg must still reduce HUD distance by forty percent of its length',async()=>{
 const fail=harness({distances:[184,175,100]}),failed=await fail.run(1);
 assert.equal(failed.stopReason,'direction_unverified');assert.equal(fail.state.pathCalls,1);
 assert.equal(failed.legs[0].distanceDecrease,9);released(fail.state);
 const pass=harness({distances:[184,174],miniResults:[projected(),{ok:false,stop:true,reason:'interaction_prompt'}]}),passed=await pass.run(2);
 assert.equal(passed.stopReason,'interaction_prompt');assert.equal(pass.state.pathCalls,1);assert.equal(pass.state.miniCalls,2);
 assert.equal(passed.legs[0].distanceDecrease,10);assert.equal(passed.movedLegs,1);released(pass.state);
});
test('helper exceptions dispose both helpers and do not fall back or call path',async()=>{
 const h=harness({sampleError:true}),result=await h.run(1);
 assert.equal(result.stopReason,'native_error');assert.equal(result.errorCode,'SAMPLE_CANCELLED');
 assert.equal(h.state.pathCalls,0);noScreenFallback(h.state);released(h.state);
});
test('path cancellation and timeout join the current path, dispose helpers, and never start another leg',async()=>{
 for(const mode of ['cancel','timeout','error']){
  const h=harness({distances:[184,160],pathTimeout:mode==='timeout',pathError:mode==='error',
   onPath(s){if(mode==='cancel')s.cancelled=true;}}),result=await h.run(1);
  assert.equal(result.stopReason,mode==='timeout'?'leg_timeout':'native_error');assert.equal(h.state.pathCalls,1);
  assert.ok(h.state.events.indexOf('path-end')<h.state.events.indexOf('path-cancel'));
  assert.ok(h.state.events.indexOf('path-token-dispose')<h.state.events.indexOf('minimap-dispose'));
  assert.equal(result.movementMsSent,null);assert.equal(result.movementTelemetryComplete,false);
  noScreenFallback(h.state);released(h.state);
 }
});
