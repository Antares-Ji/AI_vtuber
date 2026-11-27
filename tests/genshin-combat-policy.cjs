const test=require('node:test'),assert=require('node:assert/strict');
const {eligibleEnemies,eligibleRoutes}=require('../src/genshin/combat-policy');
const policy={allowedEnemies:['pyro_slime','hydro_slime'],blockedRoutes:['old']};
test('unknown, wind and mixed enemies never satisfy fire/water-only target',()=>{
 const scan={uncertain:false,allVisibleHostilesIdentified:true,enemies:[{kind:'hydro_slime'}]};
 assert.equal(eligibleEnemies(scan,policy),true);
 for(const patch of [{uncertain:true},{allVisibleHostilesIdentified:false},{enemies:[]},{enemies:[{kind:'anemo_slime'}]},{enemies:[{kind:'hydro_slime'},{kind:'other'}]}])assert.equal(eligibleEnemies({...scan,...patch},policy),false);
 assert.equal(eligibleEnemies(null,policy),false);
});
test('policy excludes automatic-fight routes and the reported mixed encounter',()=>{
 const routes=[{id:'old',combatMode:'observe-first'},{id:'copy',originalRouteId:'old',combatMode:'observe-first'},{id:'auto'},{id:'scout',combatMode:'observe-first'}];
 assert.deepEqual(eligibleRoutes(routes,policy).map(r=>r.id),['scout']);
});
test('scout returns to fresh observation and model planning before any combat',async()=>{
 const {runGoal}=require('../src/genshin/action-planner');const operations=[],seen=[];let count=0;
 const route={id:'user:scout',category:'hunting',name:'史莱姆',combatMode:'observe-first'};
 const scan={uncertain:false,allVisibleHostilesIdentified:true,enemies:[{kind:'hydro_slime'}]};
 const result=await runGoal('找水史莱姆',{signal:new AbortController().signal,services:{policy,routes:[route],
 observe:async()=>({observation:{scene:'world',uncertain:false},enemyScan:++count>1?scan:null}),
 decide:async(goal,input)=>{seen.push(input.enemyScan);return {decision:seen.length===1?{operation:'path',routeId:route.id}:{operation:'task',task:'AutoFight'}};},
 execute:async command=>{operations.push(command.operation);return {state:'returned',processStopped:true,inputReleased:true};}}});
 assert.deepEqual(operations,['path','task']);assert.equal(seen[0],null);assert.equal(seen[1],scan);assert.equal(result.verified,false);
});
test('a model combat decision cannot override mixed-enemy evidence',async()=>{
 const {runGoal}=require('../src/genshin/action-planner');let executions=0;
 await assert.rejects(runGoal('继续攻击',{signal:new AbortController().signal,services:{policy,routes:[],
 observe:async()=>({observation:{scene:'combat',uncertain:false},enemyScan:{uncertain:false,allVisibleHostilesIdentified:true,enemies:[{kind:'hydro_slime'},{kind:'other'}]}}),
 decide:async()=>({decision:{operation:'task',task:'AutoFight'}}),execute:async()=>{executions++;}}}),/当前敌人未满足/);
 assert.equal(executions,0);
});
test('model must choose another scout for unsuitable enemies, and combat for a confirmed target',async t=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-next-target-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data/genshin.local.json'),JSON.stringify({provider:'deepseek'}));
 const {planCommand}=require('../src/genshin/action-planner');const route={id:'user:scout',combatMode:'observe-first'};
 const options={dataRoot:root,env:{GENSHIN_DEEPSEEK_API_KEY:'test'},policy,observation:{scene:'combat',uncertain:false},routes:[route],enemyScan:{uncertain:false,allVisibleHostilesIdentified:true,enemies:[{kind:'other'}]}};
 const respond=(operation,allowed)=>async(url,init)=>{const input=JSON.parse(JSON.parse(init.body).messages[1].content);assert.deepEqual(input.allowedOperations,allowed);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify({operation,task:operation==='task'?'AutoFight':'',routeId:operation==='path'?route.id:'',reason:'test'})}}]})};};
 await assert.rejects(planCommand('找火水史莱姆',{...options,fetchImpl:respond('stop',['path'])}),/当前场景不允许/);
 assert.equal((await planCommand('找火水史莱姆',{...options,fetchImpl:respond('path',['path'])})).decision.operation,'path');
 assert.equal((await planCommand('找火水史莱姆',{...options,enemyScan:{...options.enemyScan,enemies:[{kind:'hydro_slime'}]},fetchImpl:respond('task',['task'])})).decision.task,'AutoFight');
});
test('cleaned-up path failure is re-observed and excluded before another model choice',async()=>{
 const {runGoal}=require('../src/genshin/action-planner');let decisions=0,observations=0;const executed=[];
 const routes=['bad','next'].map(id=>({id:'user:'+id,name:'史莱姆',category:'hunting',combatMode:'observe-first'}));
 const scan={uncertain:false,allVisibleHostilesIdentified:true,enemies:[{kind:'hydro_slime'}]};
 const result=await runGoal('找水史莱姆',{signal:new AbortController().signal,services:{policy,routes,
 observe:async()=>({observation:{scene:'world',uncertain:false},enemyScan:++observations>=3?scan:null}),
 decide:async(goal,input)=>{decisions++;if(decisions===2)assert.deepEqual(input.routes.map(r=>r.id),['user:next']);return {decision:decisions<3?{operation:'path',routeId:input.routes[0].id}:{operation:'task',task:'AutoFight'}};},
 execute:async command=>{executed.push(command.operation);const receipt={state:'returned',inputReleased:true,processStopped:true};if(executed.length===1)throw Object.assign(Error('unavailable waypoint'),{code:'PATH_EXECUTION_FAILED',receipt});return receipt;}}});
 assert.deepEqual(executed,['path','path','task']);assert.equal(result.recovery[0].error,'unavailable waypoint');assert.equal(result.verified,false);
});
