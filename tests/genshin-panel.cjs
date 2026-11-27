'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const vm=require('node:vm');
const path=require('node:path');
function harness() {
  const nodes=new Map(), requests=[], goals=[];
  const node=id=>nodes.get(id)||nodes.set(id,{value:'',textContent:'',dataset:{},children:[],setAttribute(){},append(x){this.children.push(x);},before(){},replaceChildren(){this.children=[];},classList:{remove(){}}}).get(id);
  let status={provider:'deepseek',model:'test',keyConfigured:true,bridge:{ready:false},runs:[]};
  const context={document:{querySelector:node,getElementById:node,createElement:node,hidden:true},window:{gameWorkbench:{game:'genshin',updateGenshinGoal:g=>goals.push(g)}},AbortSignal,setInterval(){},URL,
    fetch:async(route,init)=>{requests.push({route,body:init?.body&&JSON.parse(init.body)});let value;
      if(route.endsWith('/run-goal'))value={id:'new-run',state:'RUNNING'};
      else if(route.endsWith('/status'))value=status;
      else if(route.endsWith('/installation'))value={configSections:0,routes:[],config:{}};
      else value={entries:[]};
      return {ok:true,json:async()=>value};
    }};
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../public/genshin-panel.js'),'utf8'),context);
  context.window.gameWorkbench.submitGoal=g=>context.window.genshinPanel.submitGoal(g);
  return {node,requests,goals,panel:context.window.genshinPanel,setStatus:s=>{status={...status,...s};}};
}
test('both Genshin goal controls execute, preserve a submitted goal, and display actual failure or completion',async()=>{
  const h=harness();
  await h.panel.submitGoal('找到附近敌人');
  assert.equal(h.requests.find(r=>r.body?.goal).route,'/api/genshin/run-goal');
  h.setStatus({goal:{goal:'找到附近敌人',run:{id:'new-run',state:'RUNNING',progress:{message:'本地 Qwen 正在识别'}}},runs:[{id:'new-run',state:'RUNNING',progress:{message:'本地 Qwen 正在识别'}}]});
  await h.panel.refresh();assert.equal(h.goals.at(-1).plan,'本地 Qwen 正在识别');assert.equal(h.node('genshinRunGoal').disabled,true);
  const failed={id:'new-run',state:'FAILED',error:'BetterGI 启动失败'};
  h.setStatus({goal:{goal:'找到附近敌人',run:failed},runs:[failed]});await h.panel.refresh();
  assert.match(h.goals.at(-1).plan,/执行失败.*BetterGI/);assert.equal(h.node('genshinRunGoal').disabled,false);
  h.node('commandInput').value='';await h.node('genshinRunGoal').onclick();
  assert.equal(h.requests.filter(r=>r.route.endsWith('/run-goal')).at(-1).body.goal,'找到附近敌人');
  const stopped={id:'new-run',state:'UNVERIFIED',result:{executed:false,decision:{operation:'stop',reason:'当前看不到敌人'}}};
  h.setStatus({goal:{goal:'找到附近敌人',run:stopped},runs:[stopped]});await h.panel.refresh();
  assert.match(h.goals.at(-1).plan,/未执行战斗或寻路.*看不到敌人/);
});
