'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const bridge=require('./bridge'),{respond}=require('./model-provider');
const waypointCatalog=require('./story-waypoints'),{installation}=require('./installation');
const {corroborateDistances,trackingEvidence}=require('./story-observation');
const StoryTravel=require('../../scripts/genshin/story/macros/travel-quest');
const {readQuestMemory,questFromEvidence,questStage,readNavigationMemory,updateNavigationStage,reconcileRouteAttempt,nativeTrackingProgress,nativeRecoveryNeeded}=require('./story-memory');
const {questGuide}=require('./story-guides');
const grounding=require('../../scripts/genshin/story-main');
const {frameBudget}=require('./story-deadline');
const {buildStoryPrompt}=require('./story-prompt');
const {StoryFeedbackMemory}=require('./story-feedback-memory');
const {StoryQuestFocus,completionEvidence}=require('./story-quest-focus');
const workers=require('./story-workers');
const commissionRoutes=require('../../scripts/genshin/story/macros/commission-route');
const commissionCatalog=require('../../data/genshin-commission-routes.json');
const {StoryLookahead}=require('./story-lookahead');
let latest=null,events=[];
function snapshot(){return latest;}
function commentary(after=0){return events.find(event=>event.at>after)||null;}
function commentaryReceipt(id,phase,audioEnabled,consumer='legacy'){
 const event=events.find(e=>e.id===id);if(!event||!['started','ended','failed'].includes(phase))throw Error('无效的剧情解说回执');
 event.playback={phase,audioEnabled:audioEnabled===true,at:Date.now()};
 const source=['obs','console'].includes(consumer)?consumer:'legacy';
 event.playbacks={...event.playbacks,[source]:event.playback};
 if(latest){latest.commentaryPlayback={id,consumer:source,...event.playback};latest.commentaryPlaybacks={id,...event.playbacks};}
 return event.playback;
}
function validateDecision(value,request,observation){
 const a=value?.action;
 if(!a||!['key','click_text','choose_dialogue','wait','stop','move','fight','list_waypoints','teleport','follow_marker','turn','reset_camera','advance_quest','travel_quest','complete_quest','leave_interaction','navigate','seek_quest','search_area','quest_route','native_track','native_unstuck'].includes(a.kind))throw Error('剧情动作格式无效');
 const action={kind:a.kind};
 if(a.kind==='native_unstuck'&&(!request.capabilities?.nativeQuestUnstuck||!observation.nativeRecovery?.available||observation.scene!=='world'||observation.nativeVision?.ui!=='Main'||Object.keys(a).some(k=>k!=='kind')))throw Error('BGI脱困需要主界面及当前重复卡点回执，不接受坐标或任意输入');
 if(a.kind==='native_track'){
  const hud=grounding.questHud(request.texts),cv=observation.nativeVision;
  if(!request.capabilities?.nativeQuestTrack||request.nativeTrackAttempts>=2||observation.scene!=='world'||cv?.source!=='bettergi_native_cv'||cv.ui!=='Main'||!hud||hud.meters<4||hud.meters>150||grounding.movementStop(request.texts)||Object.keys(a).some(k=>k!=='kind'))throw Error('BGI原生近程追踪需要当前主界面、4–150米任务提示、可用接口及剩余尝试，不接受自定坐标');
 }
 if(a.kind==='quest_route'){
  if(a.id.startsWith('urgent-entry')&&request.teleportAttempts?.includes(a.id))throw Error('本阶段已经尝试过入口恢复，不能重复传送或重复恢复');
  const routes=commissionRoutes.available(commissionCatalog,request.focusQuest,grounding.questInstruction(request.texts)?.text,request.commissionRouteStates,request.teleportAttempts);
  if(observation.scene!=='world'||observation.nativeVision?.source!=='bettergi_native_cv'||observation.nativeVision.ui!=='Main'||!routes.some(r=>r.id===a.id&&!r.completed&&!r.blocked)||Object.keys(a).some(k=>!['kind','id'].includes(k)))throw Error('任务目录路线需要当前BGI世界、同任务阶段及未完成且未连续失败的目录id；不能输出自定坐标');
  if(grounding.movementStop(request.texts))throw Error('先处理当前F交互或界面，再运行任务目录路线');
  action.id=a.id;
 }
 if(observation.uncertain&&!['wait','stop'].includes(a.kind))throw Error('场景不确定，只能重新观察');
 const startup=grounding.loginPrompt(request.texts);
 if(startup&&!['wait','stop'].includes(a.kind)&&!(a.kind==='click_text'&&startup.controls.some(t=>t.text===a.text)))
  throw Error('当前是启动界面；使用click_text选择当前唯一“点击进入”，或wait/stop，不能移动');
 if(grounding.recoveryPrompt(request.texts)&&!['click_text','wait','stop'].includes(a.kind))throw Error('当前是复苏提示界面；依据当前OCR按钮决策，不能发送大世界按键或导航动作');
 if(request.focusQuest&&value.quest&&value.quest!==request.focusQuest)throw Error('当前任务固定为'+request.focusQuest+'；查看另一项详情不代表任务完成或允许换任务');
 if(a.kind==='travel_quest'){
  if(request.capabilities?.minimapProjection===false)throw Error('原生方位API未部署，改用当前可用的navigate/advance_quest或核对任务');
  if(Object.keys(a).some(k=>k!=='kind'))throw Error('travel_quest只接收意图，方向与坐标必须由原生本地视觉计算');
  const gate=StoryTravel.eligibility({texts:request.texts,scene:observation.scene,uncertain:observation.uncertain,recentNativeSteps:request.recentNativeSteps},grounding);
  if(!gate.ok)throw Error('当前不能原生前往任务点：'+gate.reason+'；请依据当前界面选择交互、对话、返回世界或重新观察');
 }
 if(a.kind==='complete_quest'){
  if(!request.focusQuest||a.quest!==request.focusQuest||!completionEvidence(request.texts,request.focusQuest))throw Error('完成确认必须有当前OCR唯一任务完成文字及同一任务名，不能凭模型推测或菜单标题');
  action.quest=a.quest;
 }
 if(a.kind==='key'){
  if(!['J','M','ESCAPE','F','V','SPACE','X'].includes(a.key))throw Error('不支持的剧情按键');
  if(a.key==='X'&&(observation.scene!=='world'||observation.nativeVision?.source!=='bettergi_native_cv'||observation.nativeVision.motion!=='Climb'))throw Error('X脱离攀爬需要当前BGI原生Climb证据');
  if(a.key==='SPACE'&&observation.scene==='dialogue'&&observation.dialogue?.options?.length)throw Error('当前有回复选项，空格不能代替选择；使用choose_dialogue选择dialogue.options中的文字');
  if(a.key==='V'&&request.recentActions?.slice(-2).length===2&&request.recentActions.slice(-2).every(a=>a.kind==='key'&&a.key==='V'))throw Error('连续两次V没有产生有效导航，改用follow_marker或依据当前界面恢复，不能反复按V');
  action.key=a.key;
  if(a.key==='F'){
   const prompt=grounding.interaction(request.texts);
   if(observation.scene!=='world'||prompt.state!=='unique')throw Error('F交互需要当前大世界唯一的F标识和相邻目标文字；不能盲按');
   const target=prompt.candidates[0].text;
   if(a.text!==undefined&&a.text!==target)throw Error('F交互目标与当前OCR文字不一致');
   if(/购买|兑换|创世结晶|原石|解锁|祈愿|充值/.test(target))throw Error('当前剧情不执行消费或解锁交互');
   if(grounding.interactionBlocked(request.recentNativeSteps,target))throw Error('同一F目标两次没有界面变化，请重新定位或停止，不能连续盲按');
   action.text=target;
  }
 }
 if(a.kind==='click_text'){
  if(typeof a.text!=='string'||a.text.length<2||!request.texts.some(t=>t.text===a.text))throw Error('模型选择了OCR中不存在的文字');
  let candidates=request.texts;
  const currentMenu=grounding.questMenu(request.texts);
  if(request.focusQuest&&currentMenu){
   if(currentMenu.listIncomplete&&!currentMenu.controls.some(t=>t.text===a.text))throw Error('当前仅确认任务详情，左侧列表识别不完整；不能依据残缺文字切换任务');
   if(a.text==='停止追踪')throw Error('当前任务需要保持追踪；停止追踪会取消指引，不能用来刷新或重新确认');
   if(currentMenu.entries.some(t=>t.text===a.text)&&a.text!==request.focusQuest)throw Error('不能用切换其他任务来刷新列表；保持'+request.focusQuest+'，同名详情与列表可使用scope:quest_list区分');
   if(/^(追踪目标|开始追踪|停止追踪)$/.test(a.text)&&currentMenu.title!==request.focusQuest)throw Error('当前详情不是正在继续的'+request.focusQuest+'，不能更改另一项任务的追踪');
   action.focusQuest=request.focusQuest;
  }
  if(a.scope!==undefined){
   const menu=grounding.questMenu(request.texts);
   if(a.scope!=='quest_list'||!menu||observation.scene!=='menu')throw Error('任务列表定位需要当前OCR确认的任务菜单');
   candidates=menu.entries;action.scope='quest_list';
  }
  if(candidates.filter(t=>t.text.replace(/\s/g,'')===a.text.replace(/\s/g,'')).length!==1)throw Error('目标文字重复，不能唯一定位；任务菜单可用scope:quest_list限定左侧任务列表，同一区域仍重复则不能点击');
  if(/购买|兑换|创世结晶|原石|解锁|祈愿|充值/.test(a.text))throw Error('当前剧情会话不执行消费或解锁');
  action.text=a.text;
 }
 if(a.kind==='choose_dialogue'){
  if(observation.scene!=='dialogue'||typeof a.text!=='string'||observation.dialogue?.options?.filter(t=>t.text===a.text).length!==1)throw Error('必须选择当前OCR对话选项区域中的唯一文字');
  if(/创世结晶|原石|充值|祈愿/.test(a.text))throw Error('当前剧情不执行付费或抽取选项');
  action.text=a.text;
 }
 if(a.kind==='move'){
  const areaSearch=observation.scene==='world'&&observation.navigation?.terrain==='open'&&observation.questArea?.state==='search_area';
  if(!['world','combat'].includes(observation.scene)||!['W','A','S','D'].includes(a.key)||!Number.isInteger(a.ms)||a.ms<80||a.ms>(areaSearch?1600:600))throw Error('无效的剧情短移动');
  action.key=a.key;action.ms=a.ms;
  if(a.ms>600)action.areaSearch=true;
 }
 if(a.kind==='navigate'){
  const route=StoryTravel.eligibility({texts:request.texts,scene:observation.scene,uncertain:observation.uncertain,recentNativeSteps:request.recentNativeSteps},grounding);
  if(route.ok&&route.feedback.failedTravels===0&&request.capabilities?.minimapProjection!==false)throw Error('当前已有任务距离且原生CV寻路可用，请选择{kind:"travel_quest"}让BGI定位并修正方向；不能反复按同一方向盲走');
  const previous=request.lastStep;let previousDetail;try{previousDetail=JSON.parse(previous?.detail);}catch{}
  if(previous?.action?.kind==='navigate'&&previous.action.key===a.key&&/distance_increased|distance_stalled|position_stalled/.test(previousDetail?.stopReason||''))throw Error('上一相同方向已反增距离或卡住；改用travel_quest，或选择其他方向/有据转向，不能重复原方向');
  const nativeWorld=observation.nativeVision?.source==='bettergi_native_cv'&&observation.nativeVision.ui==='Main'&&observation.nativeVision.motion==='Normal';
  if(observation.scene!=='world'||!(observation.navigation?.terrain==='open'||nativeWorld)||!grounding.questInstruction(request.texts)
    ||!['W','A','S','D'].includes(a.key)||!Number.isInteger(a.ms)||a.ms<400||a.ms>8000)throw Error('连续导航需要当前开阔世界、任务阶段及400–8000ms预算；未知地形使用短移或重新观察');
  Object.assign(action,{key:a.key,ms:a.ms});
 }
 if(a.kind==='seek_quest'){
  if(grounding.seekFeedback(request.recentNativeSteps||[request.lastStep].filter(Boolean)).exhausted)throw Error('本地四方向已耗尽；先有界turn改变视角或选择目录路线/传送，无法恢复则stop，不能重复seek_quest');
  const hud=grounding.questHud(request.texts),cv=observation.nativeVision;
  if(observation.scene!=='world'||cv?.source!=='bettergi_native_cv'||cv.ui!=='Main'||cv.motion!=='Normal'||!hud||hud.meters<=5||hud.meters>300||grounding.movementStop(request.texts))throw Error('seek_quest需要BGI原生大世界、普通运动状态及5–300m当前任务HUD；菜单先返回世界，未知场景重新观察');
 }
 if(a.kind==='search_area'){
  if(observation.scene!=='world'||observation.questArea?.state!=='search_area'||observation.nativeVision?.source!=='bettergi_native_cv'||grounding.movementStop(request.texts))throw Error('区域搜索需要当前BGI世界及已到达任务区域OCR；先处理交互或前往任务区域');
 }
 if(a.kind==='leave_interaction'){
  const p=grounding.interaction(request.texts);
  if(grounding.collectionTarget(request.texts,a.text))throw Error('当前收集阶段的调查/木板候选不能直接离开；选择唯一F交互后重新核验HUD');
  if(observation.scene!=='world'||p.state!=='unique'||p.candidates[0].text!==a.text||!['W','A','S','D'].includes(a.key))throw Error('离开交互需要当前唯一目标及明确方向');
  Object.assign(action,{text:a.text,key:a.key,ms:400});
 }
 if(a.kind==='advance_quest'){
  const nativeWorld=observation.nativeVision?.source==='bettergi_native_cv'&&observation.nativeVision.ui==='Main'&&observation.nativeVision.motion==='Normal';
  if(observation.scene!=='world'||!(observation.navigation?.terrain==='open'||nativeWorld)||!['W','A','S','D'].includes(a.key)||request.distanceEvidence?.meters?.length!==1||request.distanceEvidence.meters[0]>150)throw Error('距离反馈行走需要当前大世界原生CV确认及唯一的近距离任务OCR；否则使用短移重新观察');
  action.key=a.key;
 }
 if(a.kind==='fight'&&observation.scene!=='combat')throw Error('没有当前战斗观察，不启动战斗');
 if(a.kind==='follow_marker'&&observation.scene!=='world')throw Error('任务标记跟随只能在大世界执行');
 if(a.kind==='follow_marker'&&grounding.navigationFeedback(request.recentNativeSteps).blocked)throw Error('原生追踪连续两轮没有有效进展；请依据新观察短移恢复或重新核对任务，不能重复失败模板');
 if(['follow_marker','advance_quest','move','navigate'].includes(a.kind)&&grounding.movementStop(request.texts))throw Error('当前OCR出现交互、菜单或对话，先处理当前界面再移动');
 if(a.kind==='follow_marker'&&observation.questArea?.state==='search_area'&&observation.navigation?.marker==='not_visible')throw Error('当前已经到搜索区域，无精确标记时不能重复赶路模板；按当前地形探索移动或转镜寻找NPC/交互提示，区域搜索不要求数字距离');
 if(a.kind==='reset_camera'&&observation.scene!=='world')throw Error('镜头复位只能在大世界执行');
 if(a.kind==='turn'){
  if(observation.scene!=='world'||!Number.isInteger(a.dx)||!Number.isInteger(a.dy)||Math.abs(a.dx)>600||Math.abs(a.dy)>250)throw Error('无效的有界镜头转动');
  if(observation.navigation?.marker==='not_visible'&&request.recentActions?.length>=3&&request.recentActions.slice(-3).every(a=>a.kind==='turn'))throw Error('已连续转镜头三次仍未找到标记，不能继续原地旋转；依据地形短时探索，或打开任务/地图重新确认指引');
  action.dx=a.dx;action.dy=a.dy;
 }
 if(a.kind==='list_waypoints'){
  if(!request.mapAreas?.includes(a.area))throw Error('区域不在BetterGI地图目录中');
  const normalize=s=>String(s).replace(/[「」\s]/g,'');
  if(!request.texts.some(t=>normalize(t.text).includes(normalize(a.area)))&&!request.observedAreas?.includes(a.area))throw Error('地名没有任务或地图OCR依据；请先读取任务详情或地图，不能凭环境猜地名');
  action.area=a.area;
 }
 if(a.kind==='teleport'){
  const target=request.waypoints?.find(p=>p.id===a.id);
  if(!target||!['world','menu','map'].includes(observation.scene))throw Error('传送目标必须来自本轮BetterGI锚点目录');
  if(request.teleportAttempts?.includes(a.id))throw Error('本轮已尝试该锚点，不能反复传回原地；改用原生追踪或短时探索并观察');
  Object.assign(action,{id:target.id,x:target.x,y:target.y});
 }
 return {action,reason:String(value.reason||'').slice(0,400),commentary:String(value.commentary||'').slice(0,120),quest:String(value.quest||'').slice(0,150)};
}
async function decideWithRepair(call,request,observation,signal,budget=null,validator=validateDecision){
 const rejected=[],calls=[];
 for(let attempt=0;attempt<2;attempt++){
  budget?.check();
  if(attempt&&budget&&budget.remaining()<15000)break;
  const answer=await call(rejected);signal.throwIfAborted();
  calls.push({provider:answer.provider,model:answer.model,usage:answer.usage||null,worker:answer.worker,requestPolicy:answer.requestPolicy,latencyMs:answer.latencyMs,reasoningTokens:answer.reasoningTokens});
  budget?.check();
  try{const value=JSON.parse(answer.text);return {decision:validator(value,request,observation),prediction:value.prediction,answer,rejected,calls};}
  catch(error){rejected.push({text:answer.text,error:error.message,provider:answer.provider,model:answer.model,usage:answer.usage||null});}
 }
 return {decision:{action:{kind:'wait'},reason:'决策未通过校验或剩余预算不足，重新采集画面：'+rejected.at(-1).error,commentary:'这个操作目标还没核对上，我重新看一下当前界面。',quest:''},answer:rejected.at(-1),rejected,calls};
}
async function runStory(goal,{root,env,signal,reportProgress=()=>{},runId,direct=false}){
 const folder=path.join(root,'runtime/genshin/story',randomUUID());fs.mkdirSync(folder,{recursive:true});
 const fast=!direct&&env?.GENSHIN_STORY_PIPELINE!=='legacy'&&require('./model-provider').settings({dataRoot:root,env}).provider==='deepseek';
 let handoff=null;
 const lookahead=new StoryLookahead({signal,onEvidence:record=>fs.writeFileSync(path.join(folder,`prefetch-${record.seq}.json`),JSON.stringify(record,null,2))});
 const history=[],observedAreas=new Set(),points=waypointCatalog.loadWaypoints(installation({root,env}).directory);let selectedArea='';
 latest={state:'connecting',runId,goal,folder,startedAt:Date.now(),steps:0,verified:false};
 await bridge.start({root,signal});
 const checkpointFile=path.join(root,'runtime/genshin/training-session.json');
 const saved=fs.existsSync(checkpointFile)?JSON.parse(fs.readFileSync(checkpointFile,'utf8')):null;
 const checkpoint=saved?.runId===runId?saved:null;
 const focus=new StoryQuestFocus({root,sessionId:checkpoint?.sessionId||runId,startedAt:checkpoint?.startedAt||Date.now(),initialMemory:readQuestMemory(root)});
 let questMemory=focus.snapshot().memory;
 const navigationMemory=readNavigationMemory(root,questMemory?.quest);
 let navigationStage=navigationMemory.stage;
 let stageState={stage:navigationStage,pending:null};
 const feedback=new StoryFeedbackMemory({root,quest:questMemory?.quest||goal,stage:navigationStage});
 const teleportAttempts=new Set(navigationMemory.teleportAttempts);
 let nativeTrackAttempts=0,nativeUnstuckAttempts=0;
 const routeAttemptKeys=new Map(navigationMemory.routeAttemptKeys);
 for(const area of waypointCatalog.areas(points))if(questMemory?.details.some(t=>t.replace(/[「」\s]/g,'').includes(area.replace(/[「」\s]/g,''))))observedAreas.add(area);
 try{
  const execution=await bridge.execute({operation:'story',timeoutMs:600000},{signal,reportProgress,
   onStoryFrame:async(request,source)=>{
    const budget=frameBudget(request,signal);
    latest={...latest,state:'observing',nativeId:request.id,lastFrameAt:request.capturedAt,lastNativeStep:request.lastStep,steps:request.seq,capabilities:request.capabilities};
    try{
    budget.check();
    if(!Array.isArray(request.texts)||request.texts.length>100||Date.now()-request.capturedAt>15000)throw Error('剧情观察已过期或格式无效');
    request.mapAreas=waypointCatalog.areas(points);request.waypoints=waypointCatalog.select(points,selectedArea);
    for(const area of request.mapAreas)if(request.texts.some(t=>String(t.text).replace(/[「」\s]/g,'').includes(area.replace(/[「」\s]/g,''))))observedAreas.add(area);
    request.observedAreas=[...observedAreas];
    request.recentActions=history.slice(-3).map(e=>e.decision.action);
    request.focusQuest=questMemory?.quest||null;
    feedback.merge({sessionId:request.id,lastStep:request.lastStep});
    reconcileRouteAttempt(teleportAttempts,routeAttemptKeys,request.id,request.lastStep);
    if(nativeTrackingProgress(history.at(-1),request))nativeTrackAttempts=0;
    const currentStage=questStage(request.texts);
    stageState=updateNavigationStage(stageState,currentStage);
    if(stageState.changed){teleportAttempts.clear();routeAttemptKeys.clear();nativeTrackAttempts=0;nativeUnstuckAttempts=0;}
    navigationStage=stageState.stage;
    feedback.setContext({quest:questMemory?.quest||goal,stage:navigationStage,confirmedStageChange:stageState.changed});
    const savedFeedback=feedback.snapshot();
    request.recentNativeSteps=savedFeedback.recentNativeSteps;
    request.areaSearchState=savedFeedback.areaSearchState;
    request.commissionRouteStates=savedFeedback.commissionRouteStates;
    latest.taskStage=navigationStage;
    request.teleportAttempts=[...teleportAttempts];
    request.nativeTrackAttempts=nativeTrackAttempts;
    reportProgress('story-observing',`剧情步骤${request.seq}：BetterGI 原生 CV/OCR 观察`);
    const frameDir=path.join(root,'runtime/genshin/observations',randomUUID());fs.mkdirSync(frameDir,{recursive:true});
    const image=path.join(frameDir,'frame.png');fs.copyFileSync(source,image);
    const hash=createHash('sha256').update(fs.readFileSync(image)).digest('hex');
    const rawObservation=require('./bgi-observation').observe(request),observationError=null;
    const vision={record:null,provider:'bettergi',source:'native_cv_ocr'};
    const {observation,distanceEvidence,sceneEvidence}=corroborateDistances(rawObservation,request.texts,history.at(-1));
    observation.sceneEvidence=sceneEvidence==='local_model'?'bettergi_native_cv_ocr':sceneEvidence;
    distanceEvidence.rule='只有meters中的值可作为本轮距离读数；rawMeters及texts内的距离可能漏字。右上角网络延迟（例如24ms误读24m）不是任务距离，已排除。conflicting_ocr或unconfirmed_distance_jump时不得宣称距离、接近或到达，需重新观察。';
    request.distanceEvidence=distanceEvidence;
    observation.interaction=grounding.interaction(request.texts);
    if(observation.recoveryPrompt)observation.recoveryPrompt.rule='当前OCR显示复苏提示及原因说明，不是普通大世界环境提示。controls是当前可见文字按钮，可由模型选择click_text并由原生OCR重新定位；也可wait或stop。不能据此推断全部角色状态，不能宣称已经复苏，必须在下一帧核对界面变化。';
    observation.interaction.rule='仅state=unique时可选择key:F，text使用candidates里的目标文字。执行前重新OCR复核；回执sent只证明按键发送，scene_changed或提示消失也不等于任务完成。多目标或识别不到F时先重新观察定位。';
    if(observation.questMenu)observation.questMenu.availableAction='这是任务菜单，不是大世界。右侧title是已选任务，不表示已经追踪；controls给出当前追踪按钮。entries.distanceMeters只属于对应列表行，null表示未关联；禁止拿别的任务距离或全屏最小距离判断所选任务远近。需要选择左侧条目时使用{kind:"click_text",text:entries中逐字一致文字,scope:"quest_list"}，可区分同名详情标题；左侧仍有重复文字则不可唯一定位。右侧追踪按钮使用普通click_text逐字选择。';
    if(observation.questMenu?.listIncomplete)observation.questMenu.availableAction+='本帧仅确认右侧详情，列表标题/分类识别不完整，entries为空不是没有任务。不能依据左侧残字选任务；若当前title正是保持任务且控件为停止追踪，则已经追踪，不要再寻找任务入口或反复点击任务。';
    observation.navigationFeedback=grounding.navigationFeedback(request.recentNativeSteps);
    observation.seekFeedback=grounding.seekFeedback(request.recentNativeSteps);
    observation.taskFocus={quest:request.focusQuest,completionEvidence:request.focusQuest?completionEvidence(request.texts,request.focusQuest):null,rule:'当前任务在本训练会话内保持。不能为刷新列表、绕过文字重复或跟标失败切换其他任务。如当前详情误停另一项，核对当前菜单中原任务条目，允许scope:quest_list定位同名列表；不要追踪另一项。只有这里completionEvidence非空时才可由模型选择{kind:"complete_quest",quest:当前任务名}记录当前OCR完成证据，这一步不发送输入；之后才能自主选择下一项已接取任务。没有完成证据就保持当前任务或stop说明问题。'};
    observation.trackingEvidence=trackingEvidence(observation,request.texts,questMemory?.quest);
    observation.travelQuest=StoryTravel.eligibility({texts:request.texts,scene:observation.scene,uncertain:observation.uncertain,recentNativeSteps:request.recentNativeSteps},grounding);
    const nearHud=grounding.questHud(request.texts);
    observation.nativeTracking={available:request.capabilities?.nativeQuestTrack===true&&nativeTrackAttempts<2&&observation.scene==='world'&&observation.nativeVision?.ui==='Main'&&nearHud?.meters>=4&&nearHud.meters<=150&&!grounding.movementStop(request.texts),attempts:nativeTrackAttempts,source:'BetterGI.AutoTrackTask',rule:'BGI自带近程任务追踪，限时30秒，本地模板识别追踪点；可用于室内，无需大地图坐标。返回后重新观察，不把调用当到达。'};
    const localReceipts=[...history.map(e=>e.request.lastStep),request.lastStep].filter(Boolean);
    const blockedTarget=observation.interaction?.state==='unique'?observation.interaction.candidates[0].text:null;
    observation.nativeRecovery={available:request.capabilities?.nativeQuestUnstuck===true&&nativeUnstuckAttempts<2&&observation.scene==='world'&&observation.nativeVision?.ui==='Main'&&Boolean(nearHud)&&nativeRecoveryNeeded(localReceipts,blockedTarget)&&!(blockedTarget&&grounding.collectionTarget(request.texts,blockedTarget)),attempts:nativeUnstuckAttempts,source:'BetterGI.TrapEscaper.RotateAndMove',target:blockedTarget,rule:'重复离开同一NPC仍卡住或两次原生追踪受阻，可调用BGI原生脱困（有界后退/侧移/跳跃，包含原生脱离动作）；之后重新识别，不重复W空转。'};
    if(request.capabilities?.minimapProjection===false)observation.travelQuest={...observation.travelQuest,ok:false,reason:'projection_api_unavailable'};
    observation.navigationFeedback.rule='blocked=true时不能继续follow_marker；必须依据当前地形选择有界恢复或停止。转向不变、距离不降均会提前返回，不把动作次数当作进展。';
    observation.frameEvidence={seq:request.seq,capturedAt:request.capturedAt,ageMs:Date.now()-request.capturedAt,previousActionFinishedAt:request.lastStep?.finishedAt||null,rule:'这是上一动作完成后新采集的画面，已完成本地识别；不是等待中的观察。不要仅为等待新画面反复wait。'};
    if(observation.questArea)observation.questArea.availableAction='world/open且当前任务阶段明确时，navigate连续持键400–8000ms，本地反复OCR检查F、菜单、阶段和距离，出现变化即释放返回。只有近目标微调使用move。';
    if(observation.dialogue)observation.dialogue.availableAction='这是当前帧OCR确认的对话。options不为空时选择{kind:"choose_dialogue",text:options中逐字一致的文字}；执行器只在回复选项区域复核并点击，因此可区分同名说话人与回复。不要重复按SPACE；没有选项时才用SPACE推进台词。';
    observation.walkthroughReference=questGuide(questMemory?.quest);
    observation.commissionRoutes=commissionRoutes.available(commissionCatalog,request.focusQuest,grounding.questInstruction(request.texts)?.text,request.commissionRouteStates,request.teleportAttempts);
    observation.availableNavigationAction='优先travel_quest的原生CV坐标寻路。无精确坐标但terrain=open且方向有依据时选择navigate(key:W/A/S/D,ms:400–8000)，持续持键、本地OCR反馈，不逐小步调用模型；有唯一≤150m任务距离也可advance_quest。阶段、F提示、菜单、距离反增或停滞即停。navigate没有全局避障能力；未知地形仅move微调。';
    request.navigationMemory={...navigationMemory,stage:navigationStage,teleportAttempts:request.teleportAttempts,rule:'同阶段已尝试过的锚点不得因服务重启而重复传送。历史结果不证明当前场景，仍须读取新帧。'};
    if(observation.questDistanceLabel)observation.questDistanceLabel.rule='当前帧本地OCR定位的场景距离标签与左上任务读数一致，可用于有界转向；目标居中且前方可走可move，无需再用失效的图标模板。box不是鼠标点击目标，不能证明沿途无障碍。';
    if(createHash('sha256').update(fs.readFileSync(image)).digest('hex')!==hash)throw Error('剧情截图发生变化');
    reportProgress('story-deciding',`步骤${request.seq}：${direct?'等待导演直接指令':fast?'快速决策':'模型决策'}`);
    latest={...latest,state:'deciding'};
    const context={goal,questMemory,navigationMemory:request.navigationMemory,
     observation,distanceEvidence,texts:request.texts,mapAreas:request.mapAreas,
     observedAreas:request.observedAreas,selectedArea,waypoints:request.waypoints,nativeId:request.id,
     previousSteps:history.slice(-3).map(e=>({nativeId:e.request.id,seq:e.request.seq,
      observation:e.observation,decision:e.decision,lastStep:e.request.lastStep})),lastNativeStep:request.lastStep};
    const role=workers.workerFor(observation);
    const fastValidate=(value,r,o)=>{workers.validateRole(value,role);return validateDecision(workers.normalize(value,r),r,o);};
    const cached=fast?lookahead.consume({request,observation,validate:fastValidate}):null;
    const repaired=direct?await require('./direct-control').wait({request,observation,context,validate:validateDecision,signal:budget.signal()}):cached || (fast ?
     await decideWithRepair(rejected=>workers.call(context,{root,env,signal:budget.signal(20000),role,rejected,handoff}),request,observation,signal,budget,fastValidate) : await decideWithRepair(rejected=>{
     const prompt=buildStoryPrompt(context,{rejected});
     return respond(prompt.input,{dataRoot:root,env,signal:budget.signal(),instructions:prompt.instructions,
     schema:{type:'object',required:['action','reason','commentary','quest'],properties:{action:{type:'object'},reason:{type:'string'},commentary:{type:'string'},quest:{type:'string'}}}});},request,observation,signal,budget));
    signal.throwIfAborted();
    const {decision,answer,rejected}=repaired;
    if(decision.action.kind==='native_track')nativeTrackAttempts++;
    if(decision.action.kind==='native_unstuck'){nativeUnstuckAttempts++;nativeTrackAttempts=0;}
    if(fast){decision.commentary='';decision.reason=decision.reason.slice(0,24);}
    if(decision.action.kind==='list_waypoints')selectedArea=decision.action.area;
    if(decision.action.kind==='teleport'||decision.action.kind==='quest_route'&&commissionCatalog.routes.find(r=>r.id===decision.action.id)?.positions.some(p=>p.type==='teleport')){
     teleportAttempts.add(decision.action.id);routeAttemptKeys.set(decision.action.id,JSON.stringify([request.id,request.seq]));
    }
    const evidence={trainingSessionId:checkpoint?.sessionId||null,request,observation,rawObservation,observationError,visionRecord:vision.record,distanceEvidence,decision,rejected,provider:answer.provider,model:answer.model,usage:answer.usage||null,modelCalls:repaired.calls,
     pipeline:fast?{role,thinking:'disabled',maxOutputTokens:workers.profile(role,env).maxOutputTokens,lookahead:repaired.lookahead||lookahead.lastCheck}:null,
     image,sha256:hash,at:Date.now(),verified:false};
    fs.writeFileSync(path.join(folder,`step-${request.seq}.json`),JSON.stringify(evidence,null,2));
    if(decision.action.kind==='complete_quest'){
     const completed=focus.acknowledgeCompletion({id:request.id,seq:request.seq,texts:request.texts});
     if(!completed.acknowledged)throw Error('任务完成证据未存入当前训练会话，未撤销任务保持');
     questMemory=null;
     navigationStage=null;stageState={stage:null,pending:null};teleportAttempts.clear();routeAttemptKeys.clear();observedAreas.clear();selectedArea='';
    }else{
     const memory=questFromEvidence(evidence,path.join(folder,`step-${request.seq}.json`));
     if(memory){focus.select(memory);questMemory=focus.snapshot().memory;}
    }
    history.push(evidence);
    latest={...latest,state:'executing',goal,folder,steps:request.seq,observationSeq:request.seq,observationAt:request.capturedAt,observation,decision,provider:answer.provider,model:answer.model,usage:answer.usage||null,pipeline:evidence.pipeline,error:null,errorCode:null,verified:false};
    if(decision.commentary){events.push({id:randomUUID(),at:Date.now(),text:decision.commentary,seq:request.seq,provider:answer.provider,model:answer.model});events=events.slice(-30);}
    reportProgress('story-executing',`步骤${request.seq}：${decision.action.kind}`);
    if(fast){
     handoff={from:role,state:'planned_not_observed',action:decision.action,quest:request.focusQuest,stage:navigationStage};
     lookahead.start({decision,prediction:repaired.prediction,request,observation,context,
      plan:(projected,forecast,prefetchSignal)=>workers.call(projected,{root,env,signal:prefetchSignal,role:'movement',handoff,forecast}),
      onResult:prefetchAnswer=>{
       // Charge speculative calls to their originating frame even when discarded.
       evidence.modelCalls.push({phase:'lookahead',worker:prefetchAnswer.worker,provider:prefetchAnswer.provider,model:prefetchAnswer.model,usage:prefetchAnswer.usage,requestPolicy:prefetchAnswer.requestPolicy,latencyMs:prefetchAnswer.latencyMs,reasoningTokens:prefetchAnswer.reasoningTokens,error:prefetchAnswer.error});
       fs.writeFileSync(path.join(folder,`step-${request.seq}.json`),JSON.stringify(evidence,null,2));
      }});
    }
    return {...decision,feedbackSteps:request.recentNativeSteps,areaSearchState:request.areaSearchState,commissionRouteStates:request.commissionRouteStates,nextObservationDelayMs:fast&&role==='movement'?100:400};
    }catch(error){
     signal.throwIfAborted();
     if(budget.expired()||error.code==='STORY_FRAME_TIMEOUT'){
      if(Date.now()>=budget.nativeDeadline)throw budget.error();
      const decision={action:{kind:'wait'},reason:'本帧超时，重新观察',commentary:fast?'':'这一帧处理超时，我重新确认当前画面。',quest:''};
      const evidence={trainingSessionId:checkpoint?.sessionId||null,request,decision,error:budget.error().message,errorCode:'STORY_FRAME_TIMEOUT',at:Date.now(),verified:false};
      fs.writeFileSync(path.join(folder,`step-${request.seq}.json`),JSON.stringify(evidence,null,2));
      latest={...latest,state:'executing',decision,error:evidence.error};return decision;
     }
     throw error;
    }
   }});
  latest={...latest,state:'returned',execution};return {...latest,history,verified:false};
 }catch(error){latest={...latest,state:signal.aborted?'stopped':'error',error:error.message,errorCode:error.code,execution:error.receipt||null,finishedAt:Date.now()};throw error;}
 finally{await lookahead.close();const receipt=latest?.execution?.receipt;if(receipt?.id)feedback.merge({sessionId:receipt.id,steps:receipt.steps||[]});}
}
module.exports={runStory,validateDecision,decideWithRepair,snapshot,commentary,commentaryReceipt};
