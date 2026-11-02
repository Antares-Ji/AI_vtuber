'use strict';
const {respond}=require('./model-provider');
// CombatScenes logs Name(costume), but JSON actions match Avatar.Name only.
function canonicalPartyName(name){return name.replace(/\([^()]*\)$/,'');}
// A bounded data format, never arbitrary JS or raw key-down sequences.
function validateStrategy(value,party) {
  party=party.map(canonicalPartyName);
  if(new Set(party).size!==party.length)throw Error('队伍角色名称存在歧义');
  if(!value||typeof value.reason!=='string'||value.reason.length>1000||!Array.isArray(value.actions)||value.actions.length<party.length||value.actions.length>12)throw Error('战斗策略格式无效');
  const indexes=new Set(),covered=new Set(),effective=new Set();
  const actions=value.actions.map(a=>({...a,character:typeof a?.character==='string'?canonicalPartyName(a.character):a?.character,condition:{expression:typeof a?.condition?.expression==='string'?a.condition.expression.trim().replace(/^since\s*>\s*/,'since>'):a?.condition?.expression}}));
  for(const a of actions) {
    if(!a||typeof a.name!=='string'||!a.name||a.name.length>80||!party.includes(a.character)||!Number.isInteger(a.index)||a.index<1||a.index>999||indexes.has(a.index)||typeof a.ensureCast!=='boolean')throw Error('战斗策略包含未知角色或无效优先级');
    if(typeof a.action!=='string'||a.action.length>300)throw Error('战斗动作无效');
    const commands=a.action.split(',').map(s=>s.trim());
    if(!commands.length||commands.length>12||commands.some(c=>! /^(?:e(?:\(hold\))?|q|ready|check|(?:attack|wait|dash|w|a|s|d)\((?:[0-2](?:\.\d{1,2})?|3(?:\.0{1,2})?)\))$/.test(c)))throw Error('战斗策略包含未允许的动作');
    const expression=a.condition?.expression;
    // Bound repetition; fairness across the whole loop still needs live checks.
    if(typeof expression!=='string'||!/^since>(?:[1-9]|[1-5]\d|60)(?:\s*&&\s*(?:e-ready|q-ready|low-hp)){0,2}$/.test(expression))throw Error('战斗策略条件无效或可能饿死其他角色');
    if(expression.includes('low-hp')&&Number(expression.match(/^since>(\d+)/)[1])<5)throw Error('低血规避限频至少5秒，避免持续低血时所有攻击被高优先规避抢占');
    if(commands.some(c=>c==='e'||c==='e(hold)')&&!expression.includes('e-ready'))throw Error('E 动作必须有 e-ready，避免在冷却时反复重试');
    if(commands.includes('q')&&!expression.includes('q-ready'))throw Error('Q 动作必须有 q-ready');
    if(a.ensureCast&&!commands.includes('e')&&!commands.includes('e(hold)'))throw Error('技能验证需要包含 E');
    indexes.add(a.index);covered.add(a.character);
    if(commands.some(c=>/^(e(?:\(hold\))?|q|attack\([\d.]+\))$/.test(c)))effective.add(a.character);
  }
  if(party.some(c=>!covered.has(c)))throw Error('战斗策略遗漏当前队伍成员');
  if(party.some(c=>!effective.has(c)))throw Error('每名角色至少需要一个技能或普攻动作，不能仅等待占位');
  const fallback=actions.filter(a=>/^since>[1-3]$/.test(a.condition.expression)&&a.action.split(',').some(c=>/^attack\((?!0\))/.test(c.trim())));
  if(!fallback.length)throw Error('需要不依赖低血量或技能就绪的短间隔普攻，避免技能冷却时站着不动');
  if(new Set(fallback.map(a=>a.character)).size!==fallback.length)throw Error('每名角色只能有一个普攻补位');
  const regular=actions.filter(a=>!fallback.includes(a));
  if(regular.length&&Math.min(...fallback.map(a=>a.index))<=Math.max(...regular.map(a=>a.index)))throw Error('全部普攻补位必须排在技能之后，避免抢占技能循环');
  for(const character of party){const skills=actions.filter(a=>a.character===character&&a.action.split(',').some(c=>/^e(?:\(hold\))?$/.test(c.trim())));if(skills.length&&skills.every(a=>a.condition.expression.includes('low-hp')))throw Error('常规E不能全部限定为低血量才释放');}
  // Upstream ConditionEvaluator.Tokenize accepts letters/digits, NOT underscores.
  return {info:{name:'AI-VTuber 当前队伍循环',author:'DeepSeek API',description:value.reason,config:{},preActions:[]},actions:actions.map(a=>({name:`action${a.index}`,character:a.character,action:a.action,condition:{expression:a.condition.expression},index:a.index,ensureCast:a.ensureCast}))};
}
async function prepareStrategy(context,options={}) {
  const party=context.party?.map(canonicalPartyName);
  context={...context,combatCapabilities:require('./dodge-assessment').capabilities(),reactiveDodgeRequirement:'用户要求按敌方攻击倒计时、攻击范围、我方碰撞体与可移动范围计算冲刺方向和次数，避开其他攻击与障碍，并在每次冲刺后复查。当前无这些状态数据，不能编造倒计时、方位、范围、躲避成功率；JSON中的dash只是预设移动，不是已实现的反应式躲避。'};
  context={...context,combatFeedback:'上一轮技能间隔出现站桩：普攻仅在low-hp触发，技能冷却时无事可做。必须提供独立普攻补位动作，条件仅since>1、since>2或since>3，优先级排在所有技能之后。用户要求疾跑规避，至少一个常规可触发动作包含dash(短秒数)，不能全部限于低血时。BGI dash使用游戏冲刺鼠标绑定；它是预设冲刺，不是看见敌人前摇后闪避。最多12个动作，可给四名角色分别安排E、Q并另加补位。不要为了凑八个动作删掉普攻。Q就绪优先，常规动作应有短移动/冲刺，避免固定站桩。'};
  if(!Array.isArray(party)||party.length!==4||new Set(party).size!==4||party.some(c=>typeof c!=='string'||c.length>40))throw Error('需要本地识别确认的四人队伍');
  context.schedulerRequirement='BGI每次循环只执行第一个有效动作。四名角色各一个since>1/2/3无条件普攻补位，全部放在所有E/Q之后，优先顺序由你决定；各补位包含短dash。原生层跳过已确认阵亡的角色，因此主要普攻位死亡后仍有其他人的补位可用。四人E/Q共8动作，加4个普攻补位共12动作，不另外添加low-hp节点。瑞希梦浮期间不能普攻，不能把她排在首选普攻位。';
  context.regularSkillRequirement='四名角色各有常规E和Q，另各有一个末尾普攻补位，共12动作。用户已确认主角使用荒星（岩），不能继续说元素未知或宣称主角制造冰水反应；荒星会遮挡视野。具体动作与优先级由你决定。';
  context.latestCombatFeedback='用户已亲眼确认上一轮击杀史莱姆；明确纠正问题为主角和砂糖一个Q都没有放。主角旧策略确实只有普攻冲刺，必须补Q；砂糖有Q节点但BGI在切人后立即用中央图标分类器复查，非Ready时直接跳过，日志只说明进入节点。请给Q动作加切人后短wait再q，减少切人动画误判；其他角色保留Q/E和短普攻。瑞希梦浮不能普攻。此前元素硬筛选已取消，允许尝试其他史莱姆或敌群。战后没怪应结束，不要原地空转；结束检测由原生BGI定期执行。';
  context.lowHpRateLimit='所有low-hp条件的since必须至少5秒；持续低血状态不能因1秒一次的高优先规避而完全抢占其他技能和普攻。';
  context.actionSemantics='普攻只能写attack(秒)。a(秒)表示按A键向左走，不是普攻缩写，不能用于普攻补位！四个补位都必须包含attack(秒)和dash(秒)，条件仅since>1/2/3。E/Q的since至少6秒，以免就绪识别误报时反复抢占其他角色。';
  context.combatFeedback='用户要求个别队员倒下后由其他队友继续攻击，全队死亡才复苏。实战原生日志已确认2、3、4号阵亡被跳过，但唯一普攻位砂糖死亡后，凯亚只剩E/Q可用。必须四人各配置一个末尾普攻补位，全部低于技能优先级，并各带短dash；这是预设移动，不是反应式闪避。';
  context={...context,party,validationRequirements:'四名角色名字必须逐字照抄party。四人各至少有一个e/q/attack动作，不能用wait/ready占位。E动作必须有e-ready，Q动作必须有q-ready，禁止冷却期间反复强行重试。低血响应应优先于常规输出。请严格检查四人覆盖率与调度饥饿风险。',latestUserRequest:'用户现在明确要求：Q技能已经就绪时应释放，释放后切换下一个角色，不要一直停在同一角色。根据当前队伍规划能实际触发的Q就绪条件，不把所有Q都限定为濒死才用。'};
  const answer=await (options.respond||respond)(JSON.stringify(context),{...options,instructions:'你是游戏的 DeepSeek 战斗策略规划API。根据提供的本地识别队伍与用户要求编排 BetterGI JSON 技能循环，不改变队伍，不编造旅行者元素。角色名字必须与party完全一致。为四名角色全部配置E和Q，避免只让一个角色反复站场；自行选择合理技能优先级、短循环和低血处理。不具备怪物前摇检测、阵亡计数或跳过死者能力，不能声称解决了这三项。返回reason及actions，最多12个动作。每个动作字段name,character,action,condition:{expression},index,ensureCast。action只允许e,e(hold),q,ready,check,attack(秒),wait(秒),dash(秒),w(秒),a(秒),s(秒),d(秒)，秒0到3，逗号分割，禁止原始键鼠和代码。condition.expression仅允许since>N，再用 && 连接e-ready、q-ready、low-hp，N整数1到60；每个动作必须有自己的since限频以保证循环不会饿死。index为唯一1到999整数，小者优先。ensureCast仅含E动作可以true。只返回JSON。',schema:{type:'object',required:['reason','actions'],properties:{reason:{type:'string'},actions:{type:'array',items:{type:'object'}}}}});
  let candidate;try{candidate=JSON.parse(answer.text);}catch{throw Error('DeepSeek 战斗策略没有返回单个有效JSON对象，未安装');}options.onCandidate?.(candidate);
  const strategy=validateStrategy(candidate,party);
  for(const a of strategy.actions)if(a.action.split(',').some(c=>/^(e(?:\(hold\))?|q)$/.test(c.trim()))&&Number(a.condition.expression.match(/^since>(\d+)/)[1])<6)throw Error('E/Q节点限频至少6秒，防止就绪误报时饿死其他动作');
  for(const character of party)for(const skill of ['e','q'])if(!strategy.actions.some(a=>a.character===character&&a.action.split(',').some(c=>c.trim()===skill||skill==='e'&&c.trim()==='e(hold)')))throw Error(`策略遗漏${character}的${skill.toUpperCase()}技能`);
  for(const character of party)if(!strategy.actions.some(a=>a.character===character&&/^since>[1-3]$/.test(a.condition.expression)&&a.action.split(',').some(c=>/^attack\((?!0\))/.test(c.trim()))&&a.action.includes('dash(')))throw Error(`策略遗漏${character}的普攻与短冲刺补位`);
  if(!strategy.actions.some(a=>a.action.includes('dash(')&&!a.condition.expression.includes('low-hp')))throw Error('策略遗漏用户要求的常规疾跑动作');
  return {strategy:compileNativeStrategy(strategy),semanticStrategy:strategy,provider:answer.provider,model:answer.model,usage:answer.usage,party,context,createdAt:new Date().toISOString(),verified:false};
}
function compileNativeStrategy(strategy){
  // q-ready already uses BGI's local party/active-avatar vision. In v0.66.0,
  // UseBurst performs a second, different classifier check after switching and
  // silently returns on Unknown. Send one mapped Q press for the model's
  // validated, q-ready-gated burst instead. BGI still owns switching, focus,
  // cancellation and key release; this does not verify that the burst landed.
  return {...strategy,actions:strategy.actions.map(a=>({...a,action:a.action.split(',').flatMap(c=>c.trim()==='q'?['keypress(VK_Q)','wait(1.8)']:[c.trim()]).join(',')}))};
}
module.exports={prepareStrategy,validateStrategy,canonicalPartyName,compileNativeStrategy};
