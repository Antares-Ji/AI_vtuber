'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {buildStoryPrompt,STORY_INSTRUCTIONS}=require('../src/genshin/story-prompt');
function receipt(seq,{id='native-a',reason='bearing_unavailable',at=seq*1000}={}){
 return {nativeId:id,seq,action:{kind:'travel_quest'},finishedAt:at,verified:false,
  detail:JSON.stringify({kind:'quest-travel',stopReason:reason,progress:{distanceBefore:186,distanceAfter:184,stageBefore:'前去查看详情',stageAfter:'前去查看详情'},
   movedLegs:0,movementMsSent:null,movementTelemetryComplete:false,legs:[{from:{x:1,y:2},to:{x:3,y:4}}]})};
}
function observation(){return {scene:'world',uncertain:false,summary:'当前任务指令可见',
 navigation:{marker:'not_visible',terrain:'open',movement:'standing'},
 interaction:{state:'unique',candidates:[{text:'凯瑟琳',box:[1170,500,100,30]}],rule:'只在当前唯一F提示交互'},
 navigationFeedback:{blocked:true,failedFollows:2,rule:'不重复模板'},
 taskFocus:{quest:'紧急修理',completionEvidence:null,rule:'不得换任务'},
 trackingEvidence:{state:'menu_tracking_enabled',selectedQuest:'紧急修理',hudStage:'前去查看详情'},
 travelQuest:{ok:true,hud:{meters:184,stage:'前去查看详情'}},
 availableNavigationAction:'重复导航说明'};}
function context(){return {goal:'继续当前任务',nativeId:'native-a',observation:observation(),
 texts:[{id:'text-1',text:'前去查看详情',box:[75,246,153,33]},{id:'text-2',text:'184m',box:[80,280,70,25]}],
 distanceEvidence:{meters:[184],rawMeters:[184],status:'ocr_read_not_arrival_proof',rule:'重复距离规则'},
 questMemory:{quest:'紧急修理',details:['紧急修理','蒙德'],verification:'historical_bettergi_ocr_recheck_current_step',source:'archive/step.json'},
 navigationMemory:{stage:'前去查看详情',teleportAttempts:['61'],verification:'historical_attempts_not_arrival',previousSteps:[],rule:'不重复传送'},
 mapAreas:['蒙德','璃月','清泉镇'],waypoints:[],previousSteps:[],additionalActions:'旧规则：长距离先锚点，不用宏'};}
function freezeDeep(x){if(x&&typeof x==='object'){Object.freeze(x);Object.values(x).forEach(freezeDeep);}return x;}

test('projection preserves current safety facts and OCR without mutating validator input',()=>{
 const c=context(),before=JSON.stringify(c);freezeDeep(c);
 const result=buildStoryPrompt(c),p=JSON.parse(result.input);
 assert.equal(JSON.stringify(c),before);
 assert.deepEqual(p.texts,c.texts);assert.equal(p.observation.scene,'world');assert.equal(p.observation.uncertain,false);
 assert.deepEqual(p.observation.interaction.candidates,c.observation.interaction.candidates);
 assert.equal(p.observation.interaction.state,'unique');assert.equal(p.observation.navigationFeedback.blocked,true);
 assert.equal(p.observation.taskFocus.quest,'紧急修理');assert.equal(p.observation.taskFocus.completionEvidence,null);
 assert.equal(p.observation.trackingEvidence.state,'menu_tracking_enabled');assert.equal(p.observation.travelQuest.ok,true);
 assert.deepEqual(p.distanceEvidence.meters,[184]);assert.deepEqual(p.navigationMemory.teleportAttempts,['61']);
 assert.equal(p.observation.interaction.rule,undefined);assert.equal(p.additionalActions,undefined);
 assert.equal(p.observation.availableNavigationAction,undefined);assert.equal(p.navigationMemory.previousSteps,undefined);
 assert.equal(p.questMemory.source,undefined);
});
test('system instructions are stable and use macro-first with an explicit failure recovery path',()=>{
 const a=buildStoryPrompt(context()),b=buildStoryPrompt({...context(),observation:{scene:'map'},goal:'另一目标'});
 assert.equal(a.instructions,b.instructions);assert.equal(a.instructions,STORY_INSTRUCTIONS);
 for(const text of ['travelQuest.ok=true','bearing_unavailable','不能因ok仍为true就原样重复','stop说明问题','completionEvidence','不要购买','validationErrors'])assert.ok(a.instructions.includes(text));
 assert.equal(a.input.includes('旧规则'),false);
});
test('merged native history is deduplicated and limited to the latest three actual receipts',()=>{
 const c=context();c.navigationMemory.previousSteps=[1,2,3].map(seq=>({nativeId:'native-a',seq:seq+1,lastStep:receipt(seq),observation:observation()}));
 c.previousSteps=[2,3,4].map(seq=>({nativeId:'native-a',seq:seq+1,lastStep:receipt(seq),observation:observation()}));
 c.lastNativeStep=receipt(4);
 const p=JSON.parse(buildStoryPrompt(c).input);
 assert.deepEqual(p.recentNativeSteps.map(s=>s.seq),[2,3,4]);
 assert.equal(p.recentNativeSteps[2].stopReason,'bearing_unavailable');
 assert.deepEqual(p.recentNativeSteps[2].progress,{distanceBefore:186,distanceAfter:184,stageBefore:'前去查看详情',stageAfter:'前去查看详情'});
 assert.equal(p.recentNativeSteps[2].movementMsSent,null);assert.equal(p.recentNativeSteps[2].movementTelemetryComplete,false);
 assert.equal(p.recentNativeSteps[2].legs,undefined);assert.equal(p.recentNativeSteps[2].legCount,1);
 assert.equal(p.recentNativeSteps.some(s=>s.observation||s.rule),false);
});
test('equal seq values from different native sessions remain distinct',()=>{
 const c=context();c.previousSteps=['native-a','native-b'].map(id=>({nativeId:id,lastStep:receipt(1,{id,at:1000})}));
 assert.equal(JSON.parse(buildStoryPrompt(c).input).recentNativeSteps.length,2);
});
test('legacy history and current copy deduplicate only with matching timestamp, seq and action',()=>{
 const c=context(),old=receipt(1);delete old.nativeId;
 c.navigationMemory.previousSteps=[{lastStep:old}];c.lastNativeStep=receipt(1);
 const p=JSON.parse(buildStoryPrompt(c).input);assert.equal(p.recentNativeSteps.length,1);assert.equal(p.recentNativeSteps[0].nativeId,'native-a');
 old.finishedAt=999;assert.equal(JSON.parse(buildStoryPrompt(c).input).recentNativeSteps.length,2);
});
test('planned actions are never presented as completed native execution',()=>{
 const c=context();c.previousSteps=[{nativeId:'native-a',seq:2,decision:{action:{kind:'travel_quest'},reason:'准备赶路'},lastStep:receipt(1)}];
 const p=JSON.parse(buildStoryPrompt(c).input);
 assert.equal(p.recentNativeSteps[0].seq,1);assert.equal(p.recentDecisions[0].seq,2);
 assert.equal(p.recentDecisions[0].execution,'not_confirmed_by_receipt');
 c.lastNativeStep=receipt(2);assert.equal(JSON.parse(buildStoryPrompt(c).input).recentDecisions.length,0);
});
test('unlocated regions do not send a whole catalog; selected-area waypoints remain intact',()=>{
 const c=context();c.questMemory=null;c.mapAreas=Array.from({length:279},(_,i)=>`区域${i}`);
 let p=JSON.parse(buildStoryPrompt(c).input);assert.deepEqual(p.mapAreas,[]);
 c.mapAreas=['蒙德','璃月','清泉镇'];c.observedAreas=['清泉镇'];c.selectedArea='蒙德';
 c.waypoints=[{id:'61',areas:['蒙德'],name:'锚点',x:10,y:20}];
 p=JSON.parse(buildStoryPrompt(c).input);assert.deepEqual(p.mapAreas,['蒙德','清泉镇']);assert.deepEqual(p.waypoints,c.waypoints);
 assert.deepEqual(c.mapAreas,['蒙德','璃月','清泉镇'],'validator keeps its full catalog');
});
test('modal, dialogue and unknown facts survive without their repeated rule strings',()=>{
 const c=context();c.observation={scene:'menu',uncertain:true,recoveryPrompt:{title:'严寒',controls:[{text:'复苏',box:[900,950,70,40]}],rule:'只按当前按钮'},
  dialogue:{options:[{text:'取消',box:[730,737,67,38]}],availableAction:'逐字选择'},
  questMenu:{listIncomplete:true,title:'紧急修理',entries:[],controls:[{text:'停止追踪'}],availableAction:'不要猜列表'}};
 const p=JSON.parse(buildStoryPrompt(c).input);
 assert.equal(p.observation.uncertain,true);assert.equal(p.observation.recoveryPrompt.controls[0].text,'复苏');
 assert.equal(p.observation.dialogue.options[0].text,'取消');assert.equal(p.observation.questMenu.listIncomplete,true);
 assert.equal(p.observation.questMenu.controls[0].text,'停止追踪');
});
test('repair keeps rejected action and exact validation error without duplicating usage or full response',()=>{
 const rejected=[{text:JSON.stringify({action:{kind:'key',key:'F'},reason:'长解释'.repeat(500)}),error:'F交互需要当前唯一目标',usage:{total_tokens:12000}},
  {text:'invalid'.repeat(100),error:'JSON无效'}];
 const errors=JSON.parse(buildStoryPrompt(context(),{rejected}).input).validationErrors;
 assert.deepEqual(errors[0].action,{kind:'key',key:'F'});assert.equal(errors[0].error,'F交互需要当前唯一目标');
 assert.equal(errors[0].usage,undefined);assert.equal(errors[0].text,undefined);assert.equal(errors[1].invalidResponse.length,180);
});
test('representative archived dual-history shape shrinks without truncating current facts',()=>{
 // Replays the archived payload structure: five cross-segment observations plus
 // five local observations, each carrying the same lengthy instruction fields.
 const c=context(),obs=observation();obs.interaction.rule='重复说明，仅当前证据有效。'.repeat(50);
 c.mapAreas=Array.from({length:279},(_,i)=>`区域${i}`);
 c.previousSteps=Array.from({length:5},(_,i)=>({nativeId:'native-a',seq:i+1,observation:obs,lastStep:receipt(i+1)}));
 c.navigationMemory.previousSteps=c.previousSteps;
 const result=buildStoryPrompt(c);
 assert.ok(result.input.length<JSON.stringify(c).length*0.35);
 assert.deepEqual(JSON.parse(result.input).texts,c.texts);
});
