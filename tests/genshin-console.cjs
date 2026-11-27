'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {createGenshinConsole}=require('../src/genshin/console-routes');
test('console preserves goal and current run progress/result for reloads, and rejects duplicate running goals',async t=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-console-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const runs=[],calls=[];let body;
  const host={recent:()=>runs,status:id=>runs.find(r=>r.id===id),start:input=>{calls.push(input);const run={id:'r'+calls.length,game:'genshin',skill:input.skill,state:'RUNNING'};runs.unshift(run);return run;}};
  const api=createGenshinConsole({host,root,env:{},brain:{},parseBody:async()=>body,send:(res,code,value)=>Object.assign(res,{code,value})});
  async function request(route,data) {body=data;const res={};await api.handle({method:data?'POST':'GET',headers:{host:'127.0.0.1:3000','content-type':'application/json'},socket:{remoteAddress:'127.0.0.1'}},res,new URL('http://127.0.0.1:3000/api/genshin'+route));return res;}
  assert.equal((await request('/run-goal',{goal:'寻找敌人'})).code,202);
  assert.equal(calls[0].skill,'genshin:run-goal');assert.equal(calls[0].allowLive,true);
  runs[0].progress={stage:'observing',message:'本地识别中'};
  let s=(await request('/status')).value;
  assert.equal(s.context.combatCapabilities.reactiveDodgeReady,false);
  assert.equal(s.context.combatCapabilities.directEnemyState,false);
  assert.equal(s.goal.goal,'寻找敌人');assert.equal(s.goal.run.progress.message,'本地识别中');
  assert.equal((await request('/run-goal',{goal:'重复目标'})).code,400);assert.equal(calls.length,1);
  Object.assign(runs[0],{state:'FAILED',error:'当前为菜单'});
  s=(await request('/status')).value;assert.equal(s.goal.run.error,'当前为菜单');
  assert.equal((await request('/run-goal',{goal:'寻找敌人'})).code,202);
  assert.equal((await request('/status')).value.goal.runId,'r2');
});
