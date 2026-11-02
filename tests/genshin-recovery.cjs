'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {planCommand,runGoal}=require('../src/genshin/action-planner');
const observation=scene=>({observation:{scene,summary:scene,visible_text:[],uncertain:false}});
const plan=(operation,task='')=>({provider:'deepseek',model:'test',decision:{operation,task,routeId:'',reason:'model decision'}});
test('model receives menu return capability but cannot attack until world is observed',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-recovery-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data/genshin.local.json'),JSON.stringify({provider:'deepseek'}));
  const options={dataRoot:root,env:{GENSHIN_DEEPSEEK_API_KEY:'test'},observation:observation('menu').observation,routes:[]};
  const respond=decision=>async(url,init)=>{const body=JSON.parse(init.body),input=JSON.parse(body.messages[1].content);assert.deepEqual(input.allowedOperations,['dismiss_menu','stop']);assert.deepEqual(input.tasks,[]);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(decision)}}]})};};
  assert.equal((await planCommand('找到敌人',{...options,fetchImpl:respond(plan('dismiss_menu').decision)})).decision.operation,'dismiss_menu');
  const normalized=await planCommand('找到敌人',{...options,fetchImpl:respond({operation:'dismiss_menu',task:null,routeId:null,reason:'说明'.repeat(300),diagnostic:'ignored'})});
  assert.equal(normalized.decision.task,'');assert.equal(normalized.decision.reason.length,500);assert.equal(normalized.decision.diagnostic,undefined);
  await assert.rejects(planCommand('找到敌人',{...options,fetchImpl:respond(plan('task','AutoFight').decision)}),/当前场景不允许/);
});
test('a kill objective re-plans from fresh combat evidence after a returned task',async()=>{
 const actions=[];let observations=0,decisions=0;
 const result=await runGoal('击杀眼前目标',{signal:new AbortController().signal,services:{routes:[],
 observe:async()=>observation(++observations<3?'combat':'world'),
 decide:async(goal,{observation:o})=>{decisions++;return o.scene==='combat'?plan('task','AutoFight'):plan('stop');},
 execute:async command=>{actions.push(command.task);return {state:'returned',inputReleased:true,processStopped:true};}}});
 assert.deepEqual(actions,['AutoFight','AutoFight']);assert.equal(decisions,3);assert.equal(result.current.observation.scene,'world');assert.equal(result.verified,false);
});
test('kill objective re-plans after world HUD, supplies outcome history, and excludes completed routes',async()=>{
 const commands=[];let calls=0;
 const routes=[{id:'user:first.json',name:'first',kind:'hunting'},{id:'user:second.json',name:'second',kind:'hunting'}];
 const result=await runGoal('击杀目标',{signal:new AbortController().signal,services:{routes,
 observe:async()=>observation('world'),
 decide:async(goal,{routes:candidates,executionHistory})=>{
   if(++calls===1)return {...plan('path'),decision:{operation:'path',task:'',routeId:routes[0].id,reason:'first'}};
   assert.equal(executionHistory.length,1);assert.equal(executionHistory[0].routeId,routes[0].id);
   assert.ok(!candidates.some(r=>r.id===routes[0].id));return plan('stop');
 },execute:async command=>{commands.push(command);return {state:'returned',inputReleased:true,processStopped:true};}}});
 assert.equal(calls,2);assert.equal(commands.length,1);assert.equal(result.verified,false);
});
test('kill timeout re-observes after confirmed cleanup, excludes failed route, and never retries with held input',async()=>{
 for(const released of [true,false]){
  let seen=0,called=0;const actions=[];
  const run=runGoal('击杀目标',{signal:new AbortController().signal,services:{routes:[{id:'user:failed.json',category:'hunting'}],
   observe:async()=>{seen++;return observation(seen===1?'world':'combat');},
   decide:async(goal,{routes,executionHistory})=>{called++;if(called===1)return {decision:{operation:'path',routeId:'user:failed.json',reason:'test'}};assert.equal(routes.length,0);assert.match(executionHistory[0].error,/budget/);return plan('stop');},
   execute:async command=>{actions.push(command);throw Object.assign(Error('runtime budget'),{code:'COMMAND_TIMEOUT',receipt:{inputReleased:released,processStopped:released,state:'error'}});}}});
  if(released){const result=await run;assert.equal(seen,2);assert.equal(called,2);assert.equal(result.recovery.length,1);assert.equal(result.verified,false);}
  else {await assert.rejects(run,/runtime budget/);assert.equal(seen,1);assert.equal(called,1);}
  assert.equal(actions.length,1);
 }
});
test('achievement -> menu -> world is re-observed after each return, then resumes original goal',async()=>{
  const seen=[],actions=[],frames=['menu','menu','world','world'];
  const result=await runGoal('原来的目标',{signal:new AbortController().signal,services:{routes:[],
    observe:async()=>{const scene=frames.shift();seen.push('observe:'+scene);return observation(scene);},
    decide:async(goal,{observation:o})=>{assert.equal(goal,'原来的目标');seen.push('decide:'+o.scene);return o.scene==='menu'?plan('dismiss_menu'):plan('task','AutoFight');},
    execute:async command=>{actions.push(command.operation);seen.push('execute:'+command.operation);return {state:'returned',inputReleased:true,processStopped:true};}}});
  assert.deepEqual(actions,['dismiss_menu','dismiss_menu','task']);assert.equal(result.recovery.length,2);assert.equal(result.executed,true);
  assert.deepEqual(seen,['observe:menu','decide:menu','execute:dismiss_menu','observe:menu','decide:menu','execute:dismiss_menu','observe:world','decide:world','execute:task','observe:world']);
});
test('stuck menu has a four-return limit and cancellation prevents another observation/action',async()=>{
  let presses=0;
  await assert.rejects(runGoal('任务',{signal:new AbortController().signal,services:{routes:[],observe:async()=>observation('menu'),decide:async()=>plan('dismiss_menu'),execute:async()=>{presses++;return {state:'returned',inputReleased:true,processStopped:true};}}}),/返回4次/);
  assert.equal(presses,4);
  const controller=new AbortController();let observations=0;
  await assert.rejects(runGoal('任务',{signal:controller.signal,services:{routes:[],observe:async()=>{observations++;return observation('menu');},decide:async()=>plan('dismiss_menu'),execute:async()=>{controller.abort();return {state:'returned',inputReleased:true,processStopped:true};}}}));
  assert.equal(observations,1);
});
test('loading is waited out without input, then the same goal resumes',async()=>{
  let waited=0;const frames=['loading','world'];
  const result=await runGoal('原目标',{signal:new AbortController().signal,services:{routes:[],
    observe:async()=>observation(frames.shift()),wait:async()=>{waited++;},
    decide:async(goal,{observation:o})=>{assert.equal(goal,'原目标');return o.scene==='loading'?plan('wait'):plan('stop');},
    execute:async()=>assert.fail('waiting must never send native input')}});
  assert.equal(waited,1);assert.equal(result.current.observation.scene,'world');assert.equal(result.executed,false);
});
test('stale supervisor receipts are not advertised as ready',()=>{
  const vm=require('node:vm');let state={ready:true,busy:false,heartbeatAt:Date.now()/1000-60};
  const context={module:{exports:{}},__dirname:path.join(__dirname,'../src/genshin'),process,Date,setTimeout,setInterval,clearInterval,
    require:name=>name==='node:fs'?{readFileSync:()=>JSON.stringify(state)}:require(name)};
  vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/genshin/bridge.js'),'utf8'),context);
  vm.runInContext("folder='fixture';session='fixture';",context);
  assert.equal(context.module.exports.status().ready,false);assert.equal(context.module.exports.status().stale,true);
  state.heartbeatAt=Date.now()/1000;assert.equal(context.module.exports.status().ready,true);
  state.closedAt=Date.now()/1000;assert.equal(context.module.exports.status().ready,false);
});
test('revival dialog is cancelled with one return and fresh observation, never confirmed',async()=>{
  const actions=[];const frames=['dialog','world'];
  const result=await runGoal('找到敌人',{signal:new AbortController().signal,services:{routes:[],
    observe:async()=>observation(frames.shift()),
    decide:async(goal,{observation:o})=>o.scene==='dialog'?plan('dismiss_menu'):plan('stop'),
    execute:async command=>{actions.push(command);return {state:'returned',inputReleased:true,processStopped:true};}}});
  assert.deepEqual(actions,[{operation:'dismiss_menu',timeoutMs:10000}]);assert.equal(result.current.observation.scene,'world');assert.equal(result.recovery.length,1);
});
test('explicit revival uses model-selected built-in path recovery instead of cancelling death modal',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-revive-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data/genshin.local.json'),JSON.stringify({provider:'deepseek'}));
 const route={id:'user:reviewed.json'};const options={dataRoot:root,env:{GENSHIN_DEEPSEEK_API_KEY:'test'},observation:{scene:'dialog',summary:'全队死亡',visible_text:['注意敌人','复苏'],uncertain:false},routes:[route]};
 const fetchImpl=async(url,init)=>{const input=JSON.parse(JSON.parse(init.body).messages[1].content);assert.deepEqual(input.allowedOperations,['path','stop']);assert.deepEqual(input.routes,[route]);assert.ok(input.reviveContext);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({operation:'path',task:'',routeId:route.id,reason:'revive and continue'})}}]})};};
 assert.equal((await planCommand('点击复苏，再继续讨伐',{...options,fetchImpl})).decision.operation,'path');
 assert.equal((await planCommand('继续攻击当前这一波敌人',{...options,fetchImpl})).decision.operation,'path');
 assert.equal((await planCommand('立即击杀，先复苏',{...options,observation:{scene:'dialog',summary:'提示框小心机关',visible_text:['小心机关','复苏'],uncertain:false},fetchImpl})).decision.operation,'path');
});
test('user-directed current fight allows AutoFight from world HUD but offers no teleport route',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-current-fight-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data/genshin.local.json'),JSON.stringify({provider:'deepseek'}));
 const fetchImpl=async(url,init)=>{const input=JSON.parse(JSON.parse(init.body).messages[1].content);assert.ok(input.tasks.includes('AutoFight'));assert.deepEqual(input.routes,[]);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(plan('task','AutoFight').decision)}}]})};};
 assert.equal((await planCommand('继续攻击眼前这一波敌人，不要传送',{dataRoot:root,env:{GENSHIN_DEEPSEEK_API_KEY:'test'},observation:observation('world').observation,routes:[{id:'user:any.json'}],fetchImpl})).decision.task,'AutoFight');
});
test('world-labelled kill observation still offers fight and routes for model choice',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-kill-world-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data/genshin.local.json'),JSON.stringify({provider:'deepseek'}));
 const fetchImpl=async(url,init)=>{const input=JSON.parse(JSON.parse(init.body).messages[1].content);assert.ok(input.tasks.includes('AutoFight'));assert.equal(input.routes.length,1);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(plan('task','AutoFight').decision)}}]})};};
 const result=await planCommand('击杀是第一要务',{dataRoot:root,env:{GENSHIN_DEEPSEEK_API_KEY:'test'},observation:{...observation('world').observation,summary:'前方有蓝色冰晶状敌人'},routes:[{id:'user:any.json'}],fetchImpl});
 assert.equal(result.decision.task,'AutoFight');
});
test('current scene wording does not suppress travel after combat or in an empty world',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-scene-wording-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data/genshin.local.json'),JSON.stringify({provider:'deepseek'}));
 const route={id:'user:any.json'};
 const fetchImpl=async(url,init)=>{const input=JSON.parse(JSON.parse(init.body).messages[1].content);assert.deepEqual(input.routes,[route]);assert.equal(input.currentFightContext,null);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({operation:'path',task:'',routeId:route.id,reason:'没有目标，继续讨伐路线'})}}]})};};
 for(const goal of ['先判断当前状态，再决定自动战斗或路线，击杀后无怪转场','当前没有敌人，寻找下一处怪物','继续击杀。当前尚未接入敌方攻击倒计时。']) {
  const result=await planCommand(goal,{dataRoot:root,env:{GENSHIN_DEEPSEEK_API_KEY:'test'},observation:observation('world').observation,routes:[route],fetchImpl});
  assert.equal(result.decision.operation,'path');
 }
});
