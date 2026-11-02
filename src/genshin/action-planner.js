'use strict';
const {respond}=require('./model-provider');
const bridge=require('./bridge');
const {inspect}=require('./installation');
const {routeCandidates,validLocation}=require('./route-candidates');
const {readPolicy,eligibleEnemies,eligibleRoutes,recentScouts,recordScout}=require('./combat-policy');
const {recordRouteAttempt,withRouteHistory}=require('./route-memory');
async function planCommand(goal,{observation,routes,enemyScan=null,policy=null,location=null,locationAttempted=false,executionHistory=[],...options}) {
  if(typeof goal!=='string'||!goal.trim()||goal.length>1000)throw Error('目标需要 1–1000 字');
  if(!observation||observation.uncertain)throw Error('本地视觉无法确认当前场景，已停止；请保持游戏画面清晰可见后重试');
  const menu=['menu','map','dialog'].includes(observation.scene);
  const world=['world','combat'].includes(observation.scene);
  // Bind "current" to an encounter noun, not to unrelated phrases elsewhere
  // in a long goal ("判断当前状态，然后自动战斗" used to remove every route).
  const currentFight=world&&eligibleEnemies(enemyScan,policy)&&/(?:当前|眼前|这一波)(?:的|这一波|这场|所有){0,2}(?:敌人|敌方|怪物|目标|战斗|战场)/.test(goal);
  // User's standing instruction is to revive first after full-party defeat;
  // it persists when a subsequent goal only says "continue attacking".
  // Defeat tips have variable titles (e.g. 小心机关). The visible revive
  // button is the cue; BetterGI still confirms its native modal template.
  const revive=menu&&observation.visible_text?.some(text=>text.trim()==='复苏');
  // A world HUD is also visible during encounters. Do not remove the combat
  // capability from a kill request merely because the scene label is world;
  // the model must use the actual observation to choose fight versus travel.
  const tasks=policy?(world&&eligibleEnemies(enemyScan,policy)?['AutoFight']:[]):bridge.TASKS.filter(task=>task!=='AutoFight'||observation.scene==='combat'||currentFight||world&&/击杀|打怪|攻击/.test(goal));
  routes=eligibleRoutes(routes,policy);
  if(policy)goal+='\n持久战斗要求：'+JSON.stringify({policy,enemyScan,instructions:'只在本地enemyScan明确为火/水史莱姆且没有可见其他敌人时选择AutoFight。未知不能当作安全。候选路线均为observe-first，只寻路不自动战斗，到达会重新观察。可选择路线继续寻找，不能宣称路线名字证明敌人元素或周边安全；不返回已报告混战的旧点。'});
  let allowedOperations=revive?['path','stop']:menu?['dismiss_menu','stop']:world?['task','path',...(!locationAttempted&&/最近|定位/.test(goal)?['locate']:[]),'stop']:observation.scene==='loading'?['wait','stop']:['stop'];
  if(policy&&world&&routes.length&&!eligibleEnemies(enemyScan,policy))allowedOperations=['path'];
  if(policy&&world&&eligibleEnemies(enemyScan,policy))allowedOperations=['task'];
  if(/击杀/.test(goal))goal+='\n执行上下文：击杀为首要目标；参考routes.encounterNotes中已有实战反馈，不反复重试已多次倒下的地点。这里没有敌人类型硬筛选。当地已有战斗时直接AutoFight；没有目标或需恢复时由你选择更有把握的已安装路线。';
  if(executionHistory.length)goal+='\n本轮已执行记录（接口返回不等于击杀）：'+JSON.stringify(executionHistory.slice(-3))+'。尚无击杀核验。结合最新观察继续原目标；不要将大世界HUD或暂时看不到怪物当作任务成功。';
  if(routes.some(route=>route.recentExecutions?.length))goal+='\n候选路线recentExecutions是跨任务保存的真实接口记录，包含时间。优先参考近期失败，避免无理由反复重试；历史失败不代表永久不可达，returned-unverified不代表清场或拾取成功。结合最新观察由你选择下一步。';
  // Only installed route IDs are candidates, never model-generated filesystem paths.
  const answer=await respond(JSON.stringify({goal,observation,location,locationAttempted,allowedOperations,tasks:world?tasks:[],routes:currentFight?[]:world||revive?routes:[],currentFightContext:currentFight?'用户明确指出正在眼前这一波战斗并要求继续攻击。本地视觉已确认大世界/战斗界面，允许选择AutoFight，由BetterGI本地视觉索敌并执行已有队伍策略。本轮不再传送、不选讨伐路线。':null,reviveContext:revive?'用户已明确要求点击复苏，本地识别为全队死亡复苏界面。此时不要ESC取消。BetterGI PathExecutor在执行已安装路线前会用内置视觉ClickIfInReviveModal点击复苏，随后恢复生命并继续路线。请选择给定讨伐路线以启动这项内置恢复；没有当前位置时不得声称最近。':null}),{...options,
    instructions:'寻敌目标：附近没有敌人但提供了hunting讨伐路线时，应继续寻找而非直接停止。要求最近时，先选locate取得BetterGI小地图CV坐标，再选distanceToFirstFight最小的合适路线；这是最近的已知路线点，不代表全地图最近或敌人仍存活。定位失败且最近无法保证时才说明限制。path会按路线传送、移动并执行首个战斗点，然后重新观察。你是原神导演的单步任务决策API。用户的大世界任务应先恢复到大世界再执行。成就、背包、角色、派蒙等菜单或地图界面可选择dismiss_menu：原生输入只按一次ESC返回上一级，随后系统会重新观察并让你决定下一步，最多返回4层。不要仅因在菜单而停止。加载场景选择wait等待后重观察，最多3次，不发送按键；dialog对话框、复苏角色或交易/退出确认弹窗也可用dismiss_menu取消回退；它只按ESC关闭/取消，绝不点击确认或消耗道具。不要只因是弹窗就要求用户手动处理。需要登录验证、无法确定则stop。只选allowedOperations。world/combat时选择给定路线或独立任务。AutoFight只用于当前附近明确可见的敌人，不具备搜索全地图最近怪物的能力；没有坐标或匹配路线时不得伪称知道最近敌人。不能以NPC代替敌人。只能用给定task或routeId，不编造位置、不输出代码。reason用中文说明。不相关的task/routeId填空字符串。返回JSON。',
    schema:{type:'object',additionalProperties:false,required:['operation','task','routeId','reason'],properties:{operation:{type:'string',enum:allowedOperations},task:{type:'string'},routeId:{type:'string'},reason:{type:'string'}}}});
  let value;try{value=JSON.parse(answer.text);}catch{throw Error('决策API没有返回有效JSON');}
  // Optional empty fields and verbose explanations must not prevent a valid
  // bounded action. Only these four fields ever reach the executor.
  if(value&&typeof value==='object'&&!Array.isArray(value))value={operation:value.operation,task:value.task??'',routeId:value.routeId??'',reason:typeof value.reason==='string'?value.reason.slice(0,500):value.reason};
  if(!value||Object.keys(value).sort().join(',')!=='operation,reason,routeId,task'||typeof value.reason!=='string'||value.reason.length>500||typeof value.task!=='string'||typeof value.routeId!=='string')throw Error('决策API返回了无效字段');
  if(!allowedOperations.includes(value.operation))throw Error('模型选择了当前场景不允许的动作');
  if(['stop','dismiss_menu','wait','locate'].includes(value.operation)) {
    if(value.task!==''||value.routeId!=='')throw Error('返回或停止动作不能携带任务或路线');
    return {decision:value,provider:answer.provider,model:answer.model,usage:answer.usage};
  }
  if(value.operation==='path'&&(currentFight||!routes.some(r=>r.id===value.routeId)||value.task!==''))throw Error('模型选择了未提供的路线');
  if(value.operation==='task'&&(value.routeId!==''||!tasks.includes(value.task)))throw Error('模型选择了当前观察未允许的任务；没有敌对战斗证据时不能原地攻击');
  bridge.validate(value.operation==='path'?{operation:'path',routeId:value.routeId}:{operation:value.operation,task:value.task});
  return {decision:value,provider:answer.provider,model:answer.model,usage:answer.usage};
}
async function runGoal(goal,{root,env,signal,reportProgress=()=>{},services={}}) {
  const observe=services.observe||require('./bridge-observe').observe;
  const decide=services.decide||planCommand;
  const execute=services.execute||((command,options)=>bridge.execute(command,options));
  const startedAt=Date.now();let combatRounds=0;const executionHistory=[],visitedRoutes=new Set();
  const before=await observe({root,signal,reportProgress});
  let current=before;const recovery=[];let menuReturns=0,waits=0,location=null,locationAttempted=false;
  const policy=services.policy!==undefined?services.policy:root?readPolicy(root):null;
  const scouted=new Set(policy?recentScouts(root).map(x=>x.routeId):[]);let scoutCount=0;
  const routes=services.routes||inspect({root,env}).routes;
  const remember=(routeId,receipt,errorCode=null,errorMessage='')=>{
    try{recordRouteAttempt(root,{routeId,receipt,errorCode,errorMessage});}
    catch{reportProgress('memory-warning','路线记录暂时无法保存；当前任务仍继续，不能依赖跨任务历史');}
  };
  while(true) {
    signal.throwIfAborted();
    reportProgress('deciding',`已观察${current.observation.scene}界面，所选模型正在决定${recovery.length?'恢复后的下一步':'本轮动作'}`);
    let candidates=routeCandidates(goal,eligibleRoutes(routes,policy).filter(r=>!scouted.has(r.id)&&!visitedRoutes.has(r.id)),location,{scouting:Boolean(policy)});
    try{candidates=withRouteHistory(candidates,root);}catch{reportProgress('memory-warning','无法读取路线历史；保留当前观察与本轮执行记录');}
    const plan=await decide(goal,{observation:current.observation,enemyScan:current.enemyScan,policy,routes:candidates,location,locationAttempted,executionHistory,dataRoot:root,env,signal});
    signal.throwIfAborted();
    if(plan.decision.operation==='stop')return {...plan,executed:executionHistory.length>0,before,current,recovery,location,verified:false};
    if(plan.decision.operation==='locate') {
      if(locationAttempted||!['world','combat'].includes(current.observation.scene))throw Error('当前阶段不能重复定位');
      locationAttempted=true;
      reportProgress('locating','模型请求 BetterGI 小地图视觉定位，随后按距离排列已安装的讨伐路线');
      const receipt=await execute({operation:'locate',timeoutMs:60000},{signal});
      signal.throwIfAborted();
      if(!receipt.inputReleased||!receipt.processStopped||receipt.state!=='returned'||!validLocation(receipt.receipt?.location))throw Error('小地图没有返回新鲜、有效的定位；不会编造最近敌人位置');
      location=receipt.receipt.location;
      current=await observe({root,signal,reportProgress});
      continue;
    }
    if(plan.decision.operation==='wait') {
      if(current.observation.scene!=='loading'||current.observation.uncertain)throw Error('只有已确认的加载界面允许等待恢复');
      if(waits>=3)throw Error('已等待并重新观察3次，仍未进入大世界；请检查游戏登录或网络状态，原目标已保留');
      reportProgress('recovering',`等待游戏加载（${++waits}/3）：${plan.decision.reason}；随后重新观察`);
      await (services.wait||((signal)=>require('node:timers/promises').setTimeout(3000,null,{signal})))(signal);
      const next=await observe({root,signal,reportProgress});
      recovery.push({...plan,from:current.observation,to:next.observation});current=next;continue;
    }
    if(plan.decision.operation==='dismiss_menu') {
      if(menuReturns>=4)throw Error('已逐层返回4次，仍未确认大世界；停止继续按键，请查看当前界面');
      if(current.observation.uncertain||!['menu','map','dialog'].includes(current.observation.scene))throw Error('只有已确认的菜单、地图或对话弹窗允许返回');
      reportProgress('recovering',`正在返回上一级（${++menuReturns}/4）：${plan.decision.reason}；随后重新观察并继续原目标`);
      const receipt=await execute({operation:'dismiss_menu',timeoutMs:10000},{signal});
      signal.throwIfAborted();
      if(!receipt.inputReleased||!receipt.processStopped||receipt.state!=='returned')throw Error('返回操作尚未确认释放输入，停止继续执行');
      const next=await observe({root,signal,reportProgress});
      recovery.push({...plan,receipt,from:current.observation,to:next.observation});current=next;
      continue;
    }
    const {operation,task,routeId}=plan.decision;
    if(policy&&operation==='task'&&(task!=='AutoFight'||!eligibleEnemies(current.enemyScan,policy)))throw Error('当前敌人未满足火/水史莱姆且无其他可见敌人的条件');
    if(policy&&operation==='path'&&!candidates.some(r=>r.id===routeId&&r.combatMode==='observe-first'))throw Error('这条路线未通过先观察后战斗检查');
    reportProgress('executing',`${recovery.length?'已返回大世界；':''}模型选择${operation==='path'?'路线 '+routeId:'任务 '+task}：${plan.decision.reason}。BetterGI 正在执行`);
    let execution;
    try{execution=await execute({operation,...(operation==='path'?{routeId}:{task}),timeoutMs:/击杀/.test(goal)?420000:180000},{signal,reportProgress});}
    catch(error){
      signal.throwIfAborted();
      if(operation==='path')remember(routeId,error.receipt,error.code,error.message);
      if(!policy&&/击杀/.test(goal)&&['COMMAND_TIMEOUT','PATH_EXECUTION_FAILED','STARTUP_SCENE_CHANGED'].includes(error.code)&&error.receipt?.inputReleased&&error.receipt?.processStopped&&++combatRounds<8&&Date.now()-startedAt<600000){
        if(operation==='path'&&error.code!=='STARTUP_SCENE_CHANGED')visitedRoutes.add(routeId);
        reportProgress('recovering','执行达到时限或路线失败，已确认释放输入；重新观察后让模型继续击杀目标');
        const next=await observe({root,signal,reportProgress});
        executionHistory.push({operation,task,routeId,error:error.message,scene:next.observation.scene,summary:next.observation.summary,outcome:'执行失败，击杀未核验'});
        recovery.push({...plan,error:error.message,execution:error.receipt,from:current.observation,to:next.observation});current=next;
        continue;
      }
      if(!policy||operation!=='path'||error.code!=='PATH_EXECUTION_FAILED'||!error.receipt?.inputReleased||!error.receipt?.processStopped)throw error;
      recordScout(root,routeId,error.receipt);scouted.add(routeId);scoutCount++;
      reportProgress('recovering','该观察路线执行失败，已释放输入；重新观察后由模型选择其他路线');
      const next=await observe({root,signal,reportProgress,receipt:error.receipt});
      recovery.push({...plan,error:error.message,execution:error.receipt,from:current.observation,to:next.observation});current=next;
      if(scoutCount>=2)return {...plan,executed:true,before,current,recovery,location,verified:false,note:'观察路线连续未能满足目标，已保存失败记录'};
      continue;
    }
    signal.throwIfAborted();
    if(operation==='path')remember(routeId,execution);
    if(policy&&operation==='path')recordScout(root,routeId,execution);
    reportProgress('verifying','BetterGI 本轮接口已返回，正在重新截图并用本地视觉核对当前场景');
    const after=await observe({root,signal,reportProgress,receipt:execution});
    if(policy&&operation==='path'){
      scouted.add(routeId);scoutCount++;recovery.push({...plan,execution,from:current.observation,to:after.observation,enemyScan:after.enemyScan});current=after;
      if(scoutCount>=2&&!eligibleEnemies(after.enemyScan,policy))return {...plan,executed:true,before,current,recovery,location,execution,after,verified:false,note:'已观察两个候选点，尚未确认满足敌人条件；没有启动自动战斗'};
      location=null;locationAttempted=true;continue;
    }
    if(/击杀/.test(goal)&&!after.observation.uncertain&&++combatRounds<8&&Date.now()-startedAt<600000){
      if(operation==='path')visitedRoutes.add(routeId);
      executionHistory.push({operation,task,routeId,scene:after.observation.scene,summary:after.observation.summary,outcome:'接口返回，击杀未核验'});
      recovery.push({...plan,execution,from:current.observation,to:after.observation});current=after;
      reportProgress('continuing-combat','击杀尚未核验，保留目标并依据新观察继续由模型决策；不会因大世界HUD直接结束');
      continue;
    }
    return {...plan,executed:true,before,current,recovery,location,execution,after,verified:false,note:'已执行并重新观察；仅凭接口返回或敌人不在画面中，不能确认击杀成功'};
  }
}
module.exports={planCommand,runGoal};
