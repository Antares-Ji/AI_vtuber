'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const bridge=require('./bridge'),{respond}=require('./model-provider'),{validateObservation}=require('./observe');
const waypointCatalog=require('./story-waypoints'),{installation}=require('./installation');
const {corroborateDistances,trackingEvidence}=require('./story-observation');
const StoryTravel=require('../../scripts/genshin/story/macros/travel-quest');
const {readQuestMemory,questFromEvidence,questStage,readNavigationMemory,updateNavigationStage}=require('./story-memory');
const {questGuide}=require('./story-guides');
const grounding=require('../../scripts/genshin/story-main');
const {frameBudget}=require('./story-deadline');
const {StoryFeedbackMemory}=require('./story-feedback-memory');
const {StoryQuestFocus,completionEvidence}=require('./story-quest-focus');
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
 if(!a||!['key','click_text','choose_dialogue','wait','stop','move','fight','list_waypoints','teleport','follow_marker','turn','reset_camera','advance_quest','travel_quest','complete_quest'].includes(a.kind))throw Error('剧情动作格式无效');
 const action={kind:a.kind};
 if(observation.uncertain&&!['wait','stop'].includes(a.kind))throw Error('场景不确定，只能重新观察');
 if(grounding.recoveryPrompt(request.texts)&&!['click_text','wait','stop'].includes(a.kind))throw Error('当前是复苏提示界面；依据当前OCR按钮决策，不能发送大世界按键或导航动作');
 if(request.focusQuest&&value.quest&&value.quest!==request.focusQuest)throw Error('当前任务固定为'+request.focusQuest+'；查看另一项详情不代表任务完成或允许换任务');
 if(a.kind==='travel_quest'){
  if(Object.keys(a).some(k=>k!=='kind'))throw Error('travel_quest只接收意图，方向与坐标必须由原生本地视觉计算');
  const gate=StoryTravel.eligibility({texts:request.texts,scene:observation.scene,uncertain:observation.uncertain},grounding);
  if(!gate.ok)throw Error('当前不能原生前往任务点：'+gate.reason+'；请依据当前界面选择交互、对话、返回世界或重新观察');
 }
 if(a.kind==='complete_quest'){
  if(!request.focusQuest||a.quest!==request.focusQuest||!completionEvidence(request.texts,request.focusQuest))throw Error('完成确认必须有当前OCR唯一任务完成文字及同一任务名，不能凭模型推测或菜单标题');
  action.quest=a.quest;
 }
 if(a.kind==='key'){
  if(!['J','M','ESCAPE','F','V','SPACE'].includes(a.key))throw Error('不支持的剧情按键');
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
 if(a.kind==='advance_quest'){
  if(observation.scene!=='world'||observation.navigation?.terrain!=='open'||!['W','A','S','D'].includes(a.key)||request.distanceEvidence?.meters?.length!==1||request.distanceEvidence.meters[0]>150)throw Error('距离反馈行走需要当前大世界开阔地形和唯一的近距离任务OCR；否则使用短移重新观察');
  action.key=a.key;
 }
 if(a.kind==='fight'&&observation.scene!=='combat')throw Error('没有当前战斗观察，不启动战斗');
 if(a.kind==='follow_marker'&&observation.scene!=='world')throw Error('任务标记跟随只能在大世界执行');
 if(a.kind==='follow_marker'&&grounding.navigationFeedback(request.recentNativeSteps).blocked)throw Error('原生追踪连续两轮没有有效进展；请依据新观察短移恢复或重新核对任务，不能重复失败模板');
 if(['follow_marker','advance_quest','move'].includes(a.kind)&&grounding.movementStop(request.texts))throw Error('当前OCR出现交互、菜单或对话，先处理当前界面再移动');
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
async function decideWithRepair(call,request,observation,signal,budget=null){
 const rejected=[],calls=[];
 for(let attempt=0;attempt<2;attempt++){
  budget?.check();
  if(attempt&&budget&&budget.remaining()<15000)break;
  const answer=await call(rejected);signal.throwIfAborted();
  calls.push({provider:answer.provider,model:answer.model,usage:answer.usage||null});
  budget?.check();
  try{return {decision:validateDecision(JSON.parse(answer.text),request,observation),answer,rejected,calls};}
  catch(error){rejected.push({text:answer.text,error:error.message,provider:answer.provider,model:answer.model,usage:answer.usage||null});}
 }
 return {decision:{action:{kind:'wait'},reason:'决策未通过校验或剩余预算不足，重新采集画面：'+rejected.at(-1).error,commentary:'这个操作目标还没核对上，我重新看一下当前界面。',quest:''},answer:rejected.at(-1),rejected,calls};
}
async function runStory(goal,{root,env,signal,reportProgress=()=>{},runId}){
 const folder=path.join(root,'runtime/genshin/story',randomUUID());fs.mkdirSync(folder,{recursive:true});
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
 for(const area of waypointCatalog.areas(points))if(questMemory?.details.some(t=>t.replace(/[「」\s]/g,'').includes(area.replace(/[「」\s]/g,''))))observedAreas.add(area);
 try{
  const execution=await bridge.execute({operation:'story',timeoutMs:600000},{signal,reportProgress,
   onStoryFrame:async(request,source)=>{
    const budget=frameBudget(request,signal);
    latest={...latest,state:'observing',nativeId:request.id,lastFrameAt:request.capturedAt,lastNativeStep:request.lastStep,steps:request.seq};
    try{
    budget.check();
    if(!Array.isArray(request.texts)||request.texts.length>100||Date.now()-request.capturedAt>15000)throw Error('剧情观察已过期或格式无效');
    request.mapAreas=waypointCatalog.areas(points);request.waypoints=waypointCatalog.select(points,selectedArea);
    for(const area of request.mapAreas)if(request.texts.some(t=>String(t.text).replace(/[「」\s]/g,'').includes(area.replace(/[「」\s]/g,''))))observedAreas.add(area);
    request.observedAreas=[...observedAreas];
    request.recentActions=history.slice(-3).map(e=>e.decision.action);
    request.focusQuest=questMemory?.quest||null;
    feedback.merge({sessionId:request.id,lastStep:request.lastStep});
    const currentStage=questStage(request.texts);
    stageState=updateNavigationStage(stageState,currentStage);
    if(stageState.changed)teleportAttempts.clear();
    navigationStage=stageState.stage;
    feedback.setContext({quest:questMemory?.quest||goal,stage:navigationStage,confirmedStageChange:stageState.changed});
    request.recentNativeSteps=feedback.snapshot().recentNativeSteps;
    request.teleportAttempts=[...teleportAttempts];
    reportProgress('story-observing',`剧情步骤${request.seq}：BetterGI OCR已返回，本地视觉核对场景`);
    const frameDir=path.join(root,'runtime/genshin/observations',randomUUID());fs.mkdirSync(frameDir,{recursive:true});
    const image=path.join(frameDir,'frame.png');fs.copyFileSync(source,image);
    const hash=createHash('sha256').update(fs.readFileSync(image)).digest('hex');
    const response=await fetch('http://127.0.0.1:17646/read',{method:'POST',headers:{'content-type':'application/json'},
     body:JSON.stringify({mode:'genshin-story',image}),signal:budget.signal(90000)});
    if(!response.ok)throw Object.assign(Error('剧情本地视觉读取失败'),{code:'VISION_READ_FAILED'});
    const vision=await response.json();let rawObservation,observationError=null;
    try{rawObservation=validateObservation(vision,image);}
    catch(error){
     // A malformed read is not evidence for gameplay, but need not terminate
     // the persistent BGI session. The model may only wait/stop, then recapture.
     observationError=error.message;
     rawObservation={scene:'unknown',summary:'本轮视觉格式无效，需重新观察',visible_text:[],uncertain:true,navigation:{marker:'not_visible',terrain:'unknown',movement:'unknown',evidence:'无有效导航观察'}};
    }
    const {observation,distanceEvidence,sceneEvidence}=corroborateDistances(rawObservation,request.texts,history.at(-1));
    observation.sceneEvidence=sceneEvidence;
    distanceEvidence.rule='只有meters中的值可作为本轮距离读数；rawMeters及texts内的距离可能漏字。右上角网络延迟（例如24ms误读24m）不是任务距离，已排除。conflicting_ocr或unconfirmed_distance_jump时不得宣称距离、接近或到达，需重新观察。';
    request.distanceEvidence=distanceEvidence;
    observation.interaction=grounding.interaction(request.texts);
    if(observation.recoveryPrompt)observation.recoveryPrompt.rule='当前OCR显示复苏提示及原因说明，不是普通大世界环境提示。controls是当前可见文字按钮，可由模型选择click_text并由原生OCR重新定位；也可wait或stop。不能据此推断全部角色状态，不能宣称已经复苏，必须在下一帧核对界面变化。';
    observation.interaction.rule='仅state=unique时可选择key:F，text使用candidates里的目标文字。执行前重新OCR复核；回执sent只证明按键发送，scene_changed或提示消失也不等于任务完成。多目标或识别不到F时先重新观察定位。';
    if(observation.questMenu)observation.questMenu.availableAction='这是任务菜单，不是大世界。右侧title是已选任务，不表示已经追踪；controls给出当前追踪按钮。entries.distanceMeters只属于对应列表行，null表示未关联；禁止拿别的任务距离或全屏最小距离判断所选任务远近。需要选择左侧条目时使用{kind:"click_text",text:entries中逐字一致文字,scope:"quest_list"}，可区分同名详情标题；左侧仍有重复文字则不可唯一定位。右侧追踪按钮使用普通click_text逐字选择。';
    if(observation.questMenu?.listIncomplete)observation.questMenu.availableAction+='本帧仅确认右侧详情，列表标题/分类识别不完整，entries为空不是没有任务。不能依据左侧残字选任务；若当前title正是保持任务且控件为停止追踪，则已经追踪，不要再寻找任务入口或反复点击任务。';
    observation.navigationFeedback=grounding.navigationFeedback(request.recentNativeSteps);
    observation.taskFocus={quest:request.focusQuest,completionEvidence:request.focusQuest?completionEvidence(request.texts,request.focusQuest):null,rule:'当前任务在本训练会话内保持。不能为刷新列表、绕过文字重复或跟标失败切换其他任务。如当前详情误停另一项，核对当前菜单中原任务条目，允许scope:quest_list定位同名列表；不要追踪另一项。只有这里completionEvidence非空时才可由模型选择{kind:"complete_quest",quest:当前任务名}记录当前OCR完成证据，这一步不发送输入；之后才能自主选择下一项已接取任务。没有完成证据就保持当前任务或stop说明问题。'};
    observation.trackingEvidence=trackingEvidence(observation,request.texts,questMemory?.quest);
    observation.travelQuest=StoryTravel.eligibility({texts:request.texts,scene:observation.scene,uncertain:observation.uncertain},grounding);
    observation.navigationFeedback.rule='blocked=true时不能继续follow_marker；必须依据当前地形选择有界恢复或停止。转向不变、距离不降均会提前返回，不把动作次数当作进展。';
    observation.frameEvidence={seq:request.seq,capturedAt:request.capturedAt,ageMs:Date.now()-request.capturedAt,previousActionFinishedAt:request.lastStep?.finishedAt||null,rule:'这是上一动作完成后新采集的画面，已完成本地识别；不是等待中的观察。不要仅为等待新画面反复wait。'};
    if(observation.questArea)observation.questArea.availableAction='在world/open的搜索区，move允许80到1600ms，每400ms释放并重新检查OCR；用于没有精确标记时探索当前可走区域。出现F交互提示、菜单、对话或任务文字变化则停止并重新观察。';
    if(observation.dialogue)observation.dialogue.availableAction='这是当前帧OCR确认的对话。options不为空时选择{kind:"choose_dialogue",text:options中逐字一致的文字}；执行器只在回复选项区域复核并点击，因此可区分同名说话人与回复。不要重复按SPACE；没有选项时才用SPACE推进台词。';
    observation.walkthroughReference=questGuide(questMemory?.quest);
    observation.availableNavigationAction='若当前任务方向已有依据、terrain=open且distanceEvidence.meters有唯一小于150m的读数，可选择{kind:"advance_quest",key:"W"或"A"或"S"或"D"}。BetterGI每移动400ms便用本地OCR复读距离，最多8段；距离增大、两段不变、任务变化或读数消失立即返回。连续短移方向已正确时优先此动作，避免每走400ms等待整轮模型。不能用它证明到达，也不能避障。';
    request.navigationMemory={...navigationMemory,stage:navigationStage,teleportAttempts:request.teleportAttempts,rule:'同阶段已尝试过的锚点不得因服务重启而重复传送。历史结果不证明当前场景，仍须读取新帧。'};
    if(observation.questDistanceLabel)observation.questDistanceLabel.rule='当前帧本地OCR定位的场景距离标签与左上任务读数一致，可用于有界转向；目标居中且前方可走可move，无需再用失效的图标模板。box不是鼠标点击目标，不能证明沿途无障碍。';
    if(createHash('sha256').update(fs.readFileSync(image)).digest('hex')!==hash)throw Error('剧情截图发生变化');
    reportProgress('story-deciding',`剧情步骤${request.seq}：DeepSeek根据当前任务文字规划下一步`);
    latest={...latest,state:'deciding'};
    const context={goal,questMemory,navigationMemory:request.navigationMemory,observation,distanceEvidence,texts:request.texts,mapAreas:request.mapAreas,waypoints:request.waypoints,additionalActions:'可以按M打开地图。长距离不要靠短步盲走。先从任务详情读取目标地名，再用{kind:"list_waypoints",area:mapAreas中的区域名}查询BetterGI内置锚点目录；下一轮可用{kind:"teleport",id:waypoints中id}让BetterGI按目录坐标操作地图传送。目录不代表已解锁，返回后必须重新核对画面和距离；失败时不要无限重试同一锚点。',previousSteps:history.slice(-5).map(e=>({observation:e.observation,decision:e.decision,lastStep:e.request.lastStep})),lastNativeStep:request.lastStep};
    context.additionalActions+='另允许无输入的{kind:"complete_quest",quest:observation.taskFocus.quest}，仅在taskFocus.completionEvidence非空时确认该任务完成；这是选择下一任务前的证据记录步骤。';
    context.additionalActions+='优先使用意图{kind:"travel_quest"}：当observation.travelQuest.ok为true时，由原生闭环定位任务方向、独立测量地图位置、分段寻路并核对HUD进展。不要把可用的travel_quest拆成反复turn/move/follow_marker，也不要先查询锚点目录。宏找不到方位或发现无进展会返回证据；返回不代表到达。此意图不得输出任何坐标或时长。';
    const repaired=await decideWithRepair(rejected=>respond(JSON.stringify({...context,validationErrors:rejected,instructionForRetry:'如有校验错误，必须纠正；按钮文字只能从当前texts逐字复制，不能使用之前画面或自己补全的文字。无法定位就wait重新观察。'}),{dataRoot:root,env,signal:budget.signal(),
     instructions:'你是原神剧情任务代理和中文主播。用户要求从当前任务列表自主选择一个已接取、可进行的传说/剧情任务，优先有追踪指引、找人、区域搜索的任务，按任务指示推进。questMemory来自此前任务详情的本地OCR，保留任务名称、阶段和地区，但须以当前画面核对阶段变化，不要凭名称猜别的地区。若恢复上下文已确认任务，保留该任务，禁止因为一两个按钮无变化就换任务。首次没有所选任务时可按J选择；已有任务但当前追踪未确认时，也可按J核对并恢复同一任务的追踪，不要将打开任务菜单等同于换任务。菜单上的M可能无效，可ESCAPE返回大世界；停止追踪会取消目标，不是开始按钮。所有观察均为本地视觉/OCR，不能编造坐标或完成状态。返回单个JSON：action、reason、commentary、quest。action允许context.additionalActions声明的地图操作，以及：{kind:"key",key:"J"或"M"或"ESCAPE"或"F"或"V"或"SPACE"}；{kind:"click_text",text:OCR列表中逐字一致的唯一文字}；{kind:"wait"}；{kind:"stop"}；{kind:"move",key:"W"或"A"或"S"或"D",ms:80到600整数}；{kind:"fight"}。点击前本地OCR会再次核对。J打开任务列表，V为游戏追踪提示，F交互，SPACE推进对话；菜单先用实际OCR文本操作。只有combat场景可fight。移动必须依据当前可见地形或目标方位，每次有界短移后重新观察。navigation是专门的本地导航观察：marker为实际世界标记方向；terrain描述人物前方；movement为站立/攀爬/游泳。没有世界标记时先尝试follow_marker原生追踪（含俯视角、V、模板定位），不要无限转圈或重复打开任务菜单。模板不可用时可选择一次80到600ms的探索move再观察，理由明确是探索，不能宣称在靠近目标。水域不是禁止行动的理由，原神可以游泳；允许短时移动或SPACE跳跃探索，并观察体力/攀爬/地形。墙体与落差要逐步处理，允许短时试探和退回，不能因没有完美路线而一直不执行。标记居中且地面可走时可move；模板连续匹配失败应使用导航观察决定恢复，不继续调用同一失败模板。禁止假装已到达。剧情对话和解谜逐步处理，不能连续盲按。允许{kind:"list_waypoints",area:mapAreas中的区域名}查询BetterGI锚点目录，允许{kind:"teleport",id:waypoints中的id}由BetterGI自己打开地图、定位并尝试传送，模型不能输出坐标。锚点目录存在时不必等待OCR出现传送文字才调用teleport；它是完整原生操作。目标已在150m内时优先原生follow_marker或探索短移，不要重复传送同一锚点。长距离目标优先查询对应地名的锚点并尝试传送；目录不能证明解锁，返回后核对距离。大世界允许{kind:"reset_camera"}点击鼠标中键恢复正常视角，不移动角色；若镜头一直俯视、人物/水面难辨，可先复位再观察。大世界允许{kind:"follow_marker"}：BetterGI用本地模板重新定位任务标记、短时转向行走；匹配失败自动返回。此操作不能避障，若没有距离下降或爬墙，重新判断恢复方式，不连续盲走。大世界允许{kind:"turn",dx:-600到600整数,dy:-250到250整数}短时转动镜头再观察。dx正向右，负向左；dy正向下。任务标记未见时优先follow_marker找原生追踪点，也可转动镜头重新寻找；模板失败后可做短时探索move，不要反复等待同一静止画面。依据新观察确认地形再决定move，禁止把仅有左上角任务文字说成标记可见。其他无文字图标不能随意点击。不要购买、解锁或花原石。每步commentary是一句自然的第一人称主播解说，只说当前观察、准备做什么或有证据的结果，不能把准备说成完成。reason写诊断理由，quest填写已从界面确认选中的任务名，否则为空。distanceEvidence是本轮BetterGI OCR的独立距离核对，unknown时不得声称具体距离、变近、到达；不能沿用历史视觉模型读出的距离。texts里的box为本地OCR定位的像素矩形，不是场景任务图标。禁止只凭环境风格猜测地名再传送，须在任务/地图文字中找到对应区域。已传送接近任务后先依据目标方位短时移动，不要因模板失败就换地区。如果世界目标标记在画面边缘，可有界转镜头；若当前观察明确目标在前方且有可走的路，可move短移再观察。若同一动作两次没有界面变化，换可验证的恢复步骤或stop说明问题，别无限重复。',
     schema:{type:'object',required:['action','reason','commentary','quest'],properties:{action:{type:'object'},reason:{type:'string'},commentary:{type:'string'},quest:{type:'string'}}}}),request,observation,signal,budget);
    signal.throwIfAborted();
    const {decision,answer,rejected}=repaired;
    if(decision.action.kind==='list_waypoints')selectedArea=decision.action.area;
    if(decision.action.kind==='teleport')teleportAttempts.add(decision.action.id);
    const evidence={trainingSessionId:checkpoint?.sessionId||null,request,observation,rawObservation,observationError,visionRecord:vision.record,distanceEvidence,decision,rejected,provider:answer.provider,model:answer.model,usage:answer.usage||null,modelCalls:repaired.calls,image,sha256:hash,at:Date.now(),verified:false};
    fs.writeFileSync(path.join(folder,`step-${request.seq}.json`),JSON.stringify(evidence,null,2));
    if(decision.action.kind==='complete_quest'){
     const completed=focus.acknowledgeCompletion({id:request.id,seq:request.seq,texts:request.texts});
     if(!completed.acknowledged)throw Error('任务完成证据未存入当前训练会话，未撤销任务保持');
     questMemory=null;
     navigationStage=null;stageState={stage:null,pending:null};teleportAttempts.clear();observedAreas.clear();selectedArea='';
    }else{
     const memory=questFromEvidence(evidence,path.join(folder,`step-${request.seq}.json`));
     if(memory){focus.select(memory);questMemory=focus.snapshot().memory;}
    }
    history.push(evidence);
    latest={...latest,state:'executing',goal,folder,steps:request.seq,observationSeq:request.seq,observationAt:request.capturedAt,observation,decision,provider:answer.provider,model:answer.model,usage:answer.usage||null,error:null,errorCode:null,verified:false};
    if(decision.commentary){events.push({id:randomUUID(),at:Date.now(),text:decision.commentary,seq:request.seq,provider:answer.provider,model:answer.model});events=events.slice(-30);}
    reportProgress('story-executing',`剧情步骤${request.seq}：${decision.reason}`);
    return {...decision,feedbackSteps:request.recentNativeSteps};
    }catch(error){
     signal.throwIfAborted();
     if(budget.expired()||error.code==='STORY_FRAME_TIMEOUT'){
      if(Date.now()>=budget.nativeDeadline)throw budget.error();
      const decision={action:{kind:'wait'},reason:'本帧识别与决策预算耗尽，重新采集画面；没有执行迟到动作',commentary:'这一帧处理超时，我重新确认当前画面。',quest:''};
      const evidence={trainingSessionId:checkpoint?.sessionId||null,request,decision,error:budget.error().message,errorCode:'STORY_FRAME_TIMEOUT',at:Date.now(),verified:false};
      fs.writeFileSync(path.join(folder,`step-${request.seq}.json`),JSON.stringify(evidence,null,2));
      latest={...latest,state:'executing',decision,error:evidence.error};return decision;
     }
     throw error;
    }
   }});
  latest={...latest,state:'returned',execution};return {...latest,history,verified:false};
 }catch(error){latest={...latest,state:signal.aborted?'stopped':'error',error:error.message,errorCode:error.code,execution:error.receipt||null,finishedAt:Date.now()};throw error;}
 finally{const receipt=latest?.execution?.receipt;if(receipt?.id)feedback.merge({sessionId:receipt.id,steps:receipt.steps||[]});}
}
module.exports={runStory,validateDecision,decideWithRepair,snapshot,commentary,commentaryReceipt};
