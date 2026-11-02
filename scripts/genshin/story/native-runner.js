if(typeof file==='undefined'&&typeof module!=='undefined'&&module.exports)module.exports=StoryGrounding;
// Owned BetterGI story session: model decisions are data, never executable JS.
else (async function(){
 const command=JSON.parse(file.readTextSync('command.json'));
 const receipt={id:command.id,operation:'story',state:'running',verified:false,startedAt:Date.now(),steps:[]};
 const sessionDeadline=receipt.startedAt+Math.max(30000,command.timeoutMs-90000);
 const save=()=>file.writeTextSync('receipt.json',JSON.stringify(receipt));
 const normalize=s=>String(s||'').replace(/\s/g,'');
 let activeInput=null,observationDelayMs=400;
 const inputKinds=new Set(['key','click_text','choose_dialogue','follow_marker','reset_camera','advance_quest','travel_quest','turn','teleport','move','fight']);
 function inputFailure(code,message){
  const error=Error(message);error.code=code;
  if(activeInput){activeInput.errorCode=code;activeInput.failedAt=Date.now();}
  return error;
 }
 function checkDeadline(){
  if(!activeInput||Date.now()>=activeInput.deadlineAt||Date.now()>=sessionDeadline)throw inputFailure('STORY_INPUT_EXPIRED','剧情输入期限已过，未继续发送输入');
 }
 function readGameFocus(){
  if(typeof isGameActive==='undefined')throw inputFailure('STORY_FOCUS_API_MISSING','原生焦点校验API不可用，未发送输入');
  // ClearScript host delegates can be callable objects rather than JS functions.
  try{return isGameActive()===true;}
  catch(error){throw inputFailure('STORY_FOCUS_API_ERROR','原生焦点校验失败：'+String(error.message||error).slice(0,160));}
 }
 function checkInput(){
  checkDeadline();
  const active=readGameFocus();
  activeInput.after=active;activeInput.checkedAt=Date.now();
  checkDeadline();
  if(!active)throw inputFailure('STORY_FOCUS_LOST','游戏不再位于前台，已停止后续输入');
  activeInput.inputChecks++;activeInput.lastInputAt=Date.now();
 }
 const guardedKeyDown=key=>{checkInput();keyDown(key);};
 const guardedMoveMouseBy=(x,y)=>{checkInput();moveMouseBy(x,y);};
 const guardedMiddleButtonClick=()=>{checkInput();middleButtonClick();};
 async function beginInput(seq,action,deadlineAt){
  activeInput={seq,action:action.kind,deadlineAt,startedAt:Date.now(),before:null,after:null,inputChecks:0};
  receipt.pendingInput=activeInput;save();
  checkDeadline();
  if(typeof ensureGameFocus==='undefined'||typeof isGameActive==='undefined')throw inputFailure('STORY_FOCUS_API_MISSING','原生焦点校验API不可用，未发送输入');
  activeInput.before=readGameFocus();
  // This timeout includes focus acquisition; a late completion never authorizes input.
  const timeout=Math.min(1500,deadlineAt-Date.now(),sessionDeadline-Date.now());
  const acquire=(async()=>{try{return await ensureGameFocus();}catch(error){throw inputFailure('STORY_FOCUS_API_ERROR','原生焦点获取失败：'+String(error.message||error).slice(0,160));}})();
  const focused=await Promise.race([acquire,(async()=>{await sleep(timeout);return null;})()]);
  activeInput.focusFinishedAt=Date.now();activeInput.ensureResult=focused;
  checkDeadline();
  activeInput.after=readGameFocus();
  if(focused!==true||!activeInput.after)throw inputFailure(focused===null?'STORY_FOCUS_TIMEOUT':'STORY_FOCUS_FAILED','无法确认游戏前台焦点，未发送输入');
  save();
 }
 const travelQuest=StoryTravel.createTravelQuest({
  grounding:StoryGrounding,captureGameRegion,readTexts,sleep,now:()=>Date.now(),checkInput,
  keyDown:guardedKeyDown,keyUp:key=>keyUp(key),moveMouseBy:guardedMoveMouseBy,middleButtonClick:guardedMiddleButtonClick,
  genshin:typeof genshin==='undefined'?null:genshin,
  pathingScript:typeof pathingScript==='undefined'?null:pathingScript,
  RecognitionObject,file,getDeadline:()=>Math.min(activeInput?.deadlineAt||sessionDeadline,sessionDeadline),
  createDiagnostics:StoryTemplateDiagnostics.createTemplateDiagnostics,
  createMinimapBearing:StoryMinimapBearing.createMinimapBearing,
  minimapRoi:StoryMinimapBearing.minimapRoi,
  minimapTemplateNames:StoryMinimapBearing.templateNames,
  projectMinimap:typeof getOwnedMinimapProjection==='undefined'?undefined:(frame,x,y)=>getOwnedMinimapProjection(frame.srcMat,x,y),
  createCancellationTokenSource:()=>new CancellationTokenSource()
 });
 async function followMarker(seq){
  const templates=[];
  const trace=[];let missing=0,movedMs=0,stopReason='iteration_budget',lastMarker=null,lastTurn=false,staleTurns=0,lastMoveDistance=null,stalledMoves=0;
  try{
   const first=captureGameRegion();let initialStop;
   try{initialStop=StoryGrounding.movementStop(readTexts(first));}finally{first.dispose();}
   if(initialStop)return JSON.stringify({kind:'marker-follow',trace:[{stopCue:initialStop}],movedMs:0,stopReason:initialStop,cameraReset:false,verified:false});
   const recognizers=['quest-marker.png','quest-marker-blue.png'].map(name=>{
    const template=file.readImageMatSync(name);templates.push(template);
    const ro=RecognitionObject.templateMatch(template,300,0,1320,1080);ro.threshold=0.8;ro.maxMatchCount=2;
    return {name,ro};
   });
   // Match BetterGI AutoTrackTask's overhead-camera precondition; tracking
   // points projected onto the ground can be outside a horizontal camera.
   guardedMoveMouseBy(0,7000);await sleep(400);
   guardedKeyDown('VK_V');try{await sleep(80);}finally{keyUp('VK_V');}await sleep(3000);
   // Rear targets may consume six frames in rotation alone. Give alignment
   // and movement separate room, while still recapturing before every input.
   for(let n=0;n<12;n++){
    const cap=captureGameRegion();let marker=null,distance=null,matches=0;
    let diagnosticImage=null,stopCue=null;
    try{
     stopCue=StoryGrounding.movementStop(readTexts(cap));
     if(stopCue){trace.push({stopCue});stopReason=stopCue;break;}
     const candidates=[];
     for(const item of recognizers){
      const found=cap.findMulti(item.ro);
      for(let i=0;i<found.count;i++){
       const candidate={x:found[i].x+found[i].width/2,y:found[i].y+found[i].height/2,templates:[item.name]};
       const same=candidates.find(p=>Math.abs(p.x-candidate.x)<=14&&Math.abs(p.y-candidate.y)<=14);
       if(same)same.templates.push(item.name);else candidates.push(candidate);
      }
     }
     matches=candidates.length;
     if(n===0||matches!==1&&missing===0){
      diagnosticImage='marker-'+seq+'-'+n+'.png';
      file.writeImageSync(diagnosticImage,cap.srcMat);
     }
     if(candidates.length===1){
      marker=candidates[0];
      const left=Math.max(0,Math.min(1790,Math.round(marker.x-65))),top=Math.max(0,Math.min(1035,Math.round(marker.y+18)));
      const words=cap.findMulti(RecognitionObject.ocr(left,top,130,45));
      for(let i=0;i<words.count;i++){const match=String(words[i].text||'').match(/^(\d+)\s*m$/i);if(match)distance=Number(match[1]);}
     }
    }finally{cap.dispose();}
    trace.push({marker,distance,matches,diagnosticImage});
    if(!marker){if(++missing>=2){stopReason='marker_missing_or_ambiguous';break;}await sleep(250);continue;}
    missing=0;if(distance!==null&&distance<=4){stopReason='near_label';break;}
    // A turn that does not change the grounded marker is not progress.
    staleTurns=lastTurn&&lastMarker&&Math.abs(marker.x-lastMarker.x)<8&&Math.abs(marker.y-lastMarker.y)<8?staleTurns+1:0;
    if(staleTurns>=3){stopReason='alignment_stalled';break;}
    if(!lastTurn&&lastMoveDistance!==null&&distance!==null){
     if(distance>lastMoveDistance+2){stopReason='distance_increased';break;}
     stalledMoves=distance>=lastMoveDistance?stalledMoves+1:0;
     if(stalledMoves>=2){stopReason='distance_stalled';break;}
    }
    lastMarker=marker;lastTurn=true;
    const dx=marker.x-960;
    if(Math.abs(dx)>80){guardedMoveMouseBy(Math.round(Math.max(-400,Math.min(400,dx*0.6))),0);await sleep(250);continue;}
    if(marker.y>=540){guardedMoveMouseBy(300,0);await sleep(250);continue;}
    lastTurn=false;lastMoveDistance=distance;
    const duration=distance!==null&&distance<10?200:500;
    guardedKeyDown('VK_W');try{await sleep(duration);movedMs+=duration;}finally{keyUp('VK_W');}
    await sleep(150);
   }
   // Restore the normal camera before the slower scene reader sees the frame.
   // Do not send this click from finally: cancellation must only release input.
   const cameraReset=!['map','menu','dialogue','interaction_prompt'].includes(stopReason);
   if(cameraReset){guardedMiddleButtonClick();await sleep(600);}
   return JSON.stringify({kind:'marker-follow',trace,movedMs,stopReason,cameraReset,verified:false});
  }finally{keyUp('VK_W');keyUp('VK_V');for(const template of templates)template.dispose();}
 }
 function readTexts(frame){
  const found=frame.findMulti(RecognitionObject.ocr(0,0,frame.width,frame.height)),texts=[];
  for(let i=0;i<found.count&&texts.length<90;i++)if(found[i].text)texts.push({id:'text-'+i,text:String(found[i].text).slice(0,150),box:[found[i].x,found[i].y,found[i].width,found[i].height]});
  // Re-read the small distance line under a quest instruction. Full-frame OCR
  // can omit this line; derive the crop from current OCR, never a model guess.
  const instruction=StoryGrounding.questInstruction(texts);
  if(instruction){
   const [x,y,w,h]=instruction.box,top=Math.round(y+h),left=Math.max(0,Math.round(x-8));
   const small=frame.findMulti(RecognitionObject.ocr(left,top,Math.min(300,frame.width-left),Math.min(65,frame.height-top)));
   for(let i=0;i<small.count&&texts.length<100;i++)if(/^\s*\d{1,6}\s*(m|米)\s*$/i.test(String(small[i].text||''))||/已到达任务区域|在此区域内搜索目标/.test(String(small[i].text||'')))texts.push({id:'distance-'+i,source:'quest_distance_crop',text:String(small[i].text),box:[small[i].x,small[i].y,small[i].width,small[i].height]});
  }
  return texts;
 }
 function questHud(texts){
  if(texts.some(t=>/任务专注模式|队伍配置|商城/.test(t.text)))return null;
  const instruction=StoryGrounding.questInstruction(texts);
  if(!instruction)return null;
  const [x,y,w,h]=instruction.box;
  const nearby=texts.filter(t=>t.box[0]>=x-30&&t.box[0]<x+Math.min(w,220)&&t.box[1]>=y+h-8&&t.box[1]<y+h+85);
  const focused=nearby.filter(t=>t.source==='quest_distance_crop');
  const values=[...new Set((focused.length?focused:nearby).flatMap(t=>{const m=String(t.text).match(/^\s*(\d{1,5})\s*(?:m|米)\s*$/i);return m?[Number(m[1])]:[];}))];
  return values.length===1?{stage:instruction.text,distance:values[0]}:null;
 }
 async function advanceQuest(key,seq){
  if(!['W','A','S','D'].includes(key))throw Error('无效的本地距离反馈移动按键');
  let stopReason=null;
  const read=()=>{const frame=captureGameRegion();try{const texts=readTexts(frame);stopReason=StoryGrounding.movementStop(texts);return stopReason?null:questHud(texts);}finally{frame.dispose();}};
  let before=read(),stalled=0;const trace=[];
  if(!before||before.distance<=5||before.distance>150)return JSON.stringify({kind:'quest-advance',trace,stopReason,reason:'当前任务距离不可用或需要交互',verified:false});
  try{
   for(let n=0;n<8;n++){
    guardedKeyDown('VK_'+key);try{await sleep(400);}finally{keyUp('VK_'+key);}await sleep(180);
    const after=read();trace.push({before,after});
    if(!after||after.stage!==before.stage||Math.abs(after.distance-before.distance)>8||after.distance>before.distance||after.distance<=5)break;
    stalled=after.distance===before.distance?stalled+1:0;
    if(stalled>=2)break;
    before=after;
   }
   return JSON.stringify({kind:'quest-advance',trace,stopReason,verified:false});
  }finally{keyUp('VK_'+key);}
 }
 async function interact(action,priorSteps){
  const read=()=>{const cap=captureGameRegion();try{return readTexts(cap);}finally{cap.dispose();}};
  const before=StoryGrounding.interaction(read());
  const result={kind:'interaction',target:action.text||'',sent:false,outcome:'target_changed_or_ambiguous',verified:false};
  if(before.state!=='unique'||normalize(before.candidates[0].text)!==normalize(action.text))return JSON.stringify(result);
  if(/购买|兑换|创世结晶|原石|解锁|祈愿|充值/.test(action.text))return JSON.stringify({...result,outcome:'unsupported_target'});
  if(StoryGrounding.interactionBlocked(priorSteps,action.text))return JSON.stringify({...result,outcome:'retry_limit'});
  guardedKeyDown('VK_F');try{await sleep(80);result.sent=true;}finally{keyUp('VK_F');}
  await sleep(700);
  const afterTexts=read(),after=StoryGrounding.interaction(afterTexts),scene=StoryGrounding.sceneCue(afterTexts);
  result.outcome=scene?'scene_changed':after.state==='unique'&&normalize(after.candidates[0].text)===normalize(action.text)?'prompt_unchanged':'prompt_changed_or_missing';
  result.observedScene=scene;return JSON.stringify(result);
 }
 dispatcher.clearAllTriggers();save();
 try{
  const first=captureGameRegion();try{file.writeImageSync('before.png',first.srcMat);}finally{first.dispose();}
  for(let seq=1;seq<=40&&Date.now()<sessionDeadline;seq++){
   await sleep(observationDelayMs);
   const position=await StoryPostActionPosition.sample({lastStep:receipt.steps.slice(-1)[0],genshin:typeof genshin==='undefined'?null:genshin,sleep,deadline:sessionDeadline});
   const captureStartedAt=Date.now();
   const frame=captureGameRegion();let texts;
   try{texts=readTexts(frame);file.writeImageSync('story-'+seq+'.png',frame.srcMat);}finally{frame.dispose();}
   const capturedAt=captureStartedAt,decisionDeadline=Math.min(capturedAt+120000,sessionDeadline);
   const request={id:command.id,seq,capturedAt,deadlineAt:decisionDeadline,image:'story-'+seq+'.png',texts,position,lastStep:receipt.steps.slice(-1)[0]||null};
   file.writeTextSync('story-request.json',JSON.stringify(request));
   log.info('AI-VTuber剧情：等待模型决策，步骤 '+seq);
   let decision=null;const deadline=decisionDeadline;
   while(Date.now()<deadline){
    try{const value=JSON.parse(file.readTextSync('story-decision-'+seq+'.json'));if(value.id===command.id&&value.seq===seq){decision=value;break;}}catch{}
    await sleep(250);
   }
   if(!decision&&Date.now()>=sessionDeadline){receipt.note='剧情分段时间已到，保留进度等待续跑';receipt.endReason='segment_budget';break;}
   if(!decision)throw Error('剧情模型决策等待超时；未继续发送输入');
   const action=decision.action;let detail='';
   const priorSteps=Array.isArray(decision.feedbackSteps)?decision.feedbackSteps:receipt.steps;
   if(!action||Date.now()>=request.deadlineAt)throw Error('无效或过期的剧情动作');
   // Only the director can select the bounded fast cadence, never a free delay.
   observationDelayMs=decision.nextObservationDelayMs===100?100:400;
   log.info('AI-VTuber剧情：执行 '+action.kind+' '+(action.text||action.key||''));
   if(action.kind==='stop'){receipt.note=decision.reason;receipt.endReason='model_stop';break;}
   activeInput=null;
   if(inputKinds.has(action.kind))await beginInput(seq,action,request.deadlineAt);
   if(!['wait','click_text','complete_quest'].includes(action.kind)){
    const guard=captureGameRegion();let recovery;
    try{const freshTexts=readTexts(guard);recovery=StoryGrounding.recoveryPrompt(freshTexts)||StoryGrounding.loginPrompt(freshTexts);}finally{guard.dispose();}
    if(recovery)throw Error('执行前出现复苏提示，未发送大世界输入');
   }
   if(action.kind==='key'){
    if(!['J','M','ESCAPE','F','V','SPACE'].includes(action.key))throw Error('不允许的剧情按键');
    if(action.key==='F')detail=await interact(action,priorSteps);
    else {const key=action.key==='ESCAPE'?'VK_ESCAPE':action.key==='SPACE'?'VK_SPACE':'VK_'+action.key;
    guardedKeyDown(key);try{await sleep(80);}finally{keyUp(key);}await sleep(700);}
   }else if(action.kind==='click_text'){
    if(typeof action.text!=='string'||action.text.length<2||action.text.length>150||!texts.some(t=>normalize(t.text)===normalize(action.text)))throw Error('文本不在本轮OCR中');
    const fresh=captureGameRegion();
    try{
     const found=fresh.findMulti(RecognitionObject.ocr(0,0,fresh.width,fresh.height));let matches=[];const rows=[];
     for(let i=0;i<found.count;i++){rows.push({text:found[i].text,box:[found[i].x,found[i].y,found[i].width,found[i].height]});if(normalize(found[i].text)===normalize(action.text))matches.push(found[i]);}
     if(StoryGrounding.recoveryPrompt(texts)&&!StoryGrounding.recoveryPrompt(rows))matches=[];
     if(StoryGrounding.loginPrompt(texts)&&!StoryGrounding.loginPrompt(rows))matches=[];
     if(action.focusQuest){
      const menu=StoryGrounding.questMenu(rows);
      if(normalize(action.text)==='停止追踪')matches=[];
      if(!menu||menu.entries.some(t=>normalize(t.text)===normalize(action.text))&&normalize(action.text)!==normalize(action.focusQuest)||/^(追踪目标|开始追踪|停止追踪)$/.test(normalize(action.text))&&normalize(menu.title)!==normalize(action.focusQuest))matches=[];
     if(menu?.listIncomplete&&!menu.controls.some(t=>normalize(t.text)===normalize(action.text)))matches=[];
     }
     if(action.scope!==undefined){
      if(action.scope!=='quest_list')throw Error('未知文本定位区域');
     const menu=StoryGrounding.questMenu(rows);
     if(!menu||menu.listIncomplete)matches=[];
      else matches=matches.filter(t=>t.x<650&&t.y>=100&&t.y<980&&t.width>30);
     }
     if(matches.length!==1)detail='目标文字变化或存在歧义，本步未点击';
     else {checkInput();matches[0].click();detail='已点击本地OCR重新确认的文字';await sleep(700);}
    }finally{fresh.dispose();}
   }else if(action.kind==='choose_dialogue'){
    const cap=captureGameRegion();
    try{
     const found=cap.findMulti(RecognitionObject.ocr(0,0,cap.width,cap.height)),items=[];
     for(let i=0;i<found.count;i++)items.push(found[i]);
     const subtitle=items.some(t=>t.x>100&&t.x<1600&&t.y>=890&&t.y<1015&&t.width>180&&String(t.text).length>=8&&/[\u4e00-\u9fff]/.test(t.text));
     const cue=items.some(t=>t.x>650&&t.x<1150&&t.y>=800&&t.y<910&&t.width<250&&/[\u4e00-\u9fff]/.test(t.text)||/^自动(?:播放)?$/.test(t.text)&&t.y<150);
     const matches=items.filter(t=>t.x>1080&&t.x<1800&&t.y>250&&t.y<850&&t.width>30&&normalize(t.text)===normalize(action.text));
     if(subtitle&&cue&&matches.length===1){checkInput();matches[0].click();detail='已复核对话布局及唯一回复选项并点击';await sleep(700);}
     else detail='对话布局或回复选项变化，本步未点击';
    }finally{cap.dispose();}
   }else if(action.kind==='wait'){await sleep(2000);}
   else if(action.kind==='complete_quest'){detail=JSON.stringify({kind:'completion_acknowledgement',quest:action.quest,inputSent:false,source:'server_ocr_evidence',verified:false});}
   else if(action.kind==='list_waypoints'){detail='查询地图目录：'+action.area;}
   else if(action.kind==='travel_quest'){detail=JSON.stringify(await travelQuest(seq,{recentNativeSteps:priorSteps}));}
   else if(action.kind==='follow_marker'){detail=StoryGrounding.navigationFeedback(priorSteps).blocked?JSON.stringify({kind:'marker-follow',movedMs:0,stopReason:'retry_limit',verified:false}):await followMarker(seq);}
   else if(action.kind==='reset_camera'){guardedMiddleButtonClick();await sleep(600);detail='镜头复位输入已发送，等待下一帧核对';}
   else if(action.kind==='advance_quest'){detail=await advanceQuest(action.key,seq);}
   else if(action.kind==='turn'){
    if(!Number.isInteger(action.dx)||!Number.isInteger(action.dy)||Math.abs(action.dx)>600||Math.abs(action.dy)>250)throw Error('无效的有界镜头转动');
    guardedMoveMouseBy(action.dx,action.dy);await sleep(400);
   }
   else if(action.kind==='teleport'){
    if(typeof action.id!=='string'||!Number.isFinite(action.x)||!Number.isFinite(action.y)||Math.abs(action.x)>30000||Math.abs(action.y)>30000)throw Error('无效的目录传送点');
    // BetterGI owns internal teleport/fight inputs; this script can guard their entry only.
    checkInput();
    try{await genshin.tp(action.x,action.y,true);detail='BetterGI传送调用返回，等待下一帧核对';}
    catch(error){detail='BetterGI传送失败：'+String(error.message||error).slice(0,200);}
   }
   else if(action.kind==='move'){
    if(!['W','A','S','D'].includes(action.key)||!Number.isInteger(action.ms)||action.ms<80||action.ms>(action.areaSearch===true?1600:600))throw Error('无效的短移动');
    let movedMs=0,stopReason=null;const stage=StoryGrounding.questInstruction(texts)?.text;
    while(movedMs<action.ms){
     const cap=captureGameRegion();let fresh;try{fresh=readTexts(cap);}finally{cap.dispose();}
     stopReason=StoryGrounding.movementStop(fresh);
     if(stopReason)break;
     if(action.areaSearch&&(!stage||!fresh.some(t=>t.text===stage))){stopReason='stage_changed_or_missing';break;}
     const duration=Math.min(400,action.ms-movedMs);
     guardedKeyDown('VK_'+action.key);try{await sleep(duration);}finally{keyUp('VK_'+action.key);}movedMs+=duration;
     if(movedMs<action.ms)await sleep(150);
    }
    detail=JSON.stringify({movedMs,stopReason,areaSearch:action.areaSearch===true,verified:false});
   }else if(action.kind==='fight'){checkInput();await dispatcher.runTask(new SoloTask('AutoFight'));}
   else throw Error('未知剧情动作');
   if(activeInput){activeInput.after=readGameFocus();activeInput.finishedAt=Date.now();}
   receipt.steps.push({seq,action,detail,focus:activeInput,finishedAt:Date.now(),verified:false});
   delete receipt.pendingInput;save();
  }
  receipt.state='returned';receipt.endReason=receipt.endReason||(Date.now()>=sessionDeadline?'segment_budget':'step_limit');
 }catch(error){receipt.state='error';receipt.error=String(error.message||error).slice(0,500);receipt.errorCode=error.code||null;}
 finally{
  // Releases are always allowed, including after focus loss or deadline expiry.
  for(const key of ['VK_W','VK_A','VK_S','VK_D','VK_F','VK_V','VK_J','VK_M','VK_ESCAPE','VK_SPACE'])try{keyUp(key);}catch{}
  try{dispatcher.clearAllTriggers();}catch(error){receipt.cleanupError=String(error.message||error).slice(0,200);}
  try{const last=captureGameRegion();try{file.writeImageSync('after.png',last.srcMat);}finally{last.dispose();}}
  catch(error){receipt.captureError=String(error.message||error).slice(0,200);}
  receipt.finishedAt=Date.now();save();
 }
})();
