'use strict';
// Director API entrypoint; game actions remain owned by registered skills.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..');
const goal='继续当前已接取的剧情任务；从新画面核对任务和阶段，历史最后观察为跟随骗子向导，不可把历史当当前事实。重点按当前地形和任务目标进行有界寻路，并在当前唯一F交互提示出现时选择交互。不要重复失败模板，不要虚构到达或完成。确认当前任务完成后，可以从已接取且可进行的剧情任务继续选择。';
async function request(route,body){const r=await fetch('http://127.0.0.1:3000/api/genshin/'+route,{method:body===undefined?'GET':'POST',headers:{'content-type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(90000)});const data=await r.json();if(!r.ok)throw Error(JSON.stringify(data));return data;}
async function main(){
 const command=process.argv[2]||'status';
 if(command==='test'){const r=await request('test',{});console.log(JSON.stringify({connected:r.connected,provider:r.provider,model:r.model,usage:r.usage}));return;}
 if(command==='compact'){console.log(JSON.stringify(await request('story/training-status'),null,2));return;}
 if(command==='disconnect'){console.log(JSON.stringify(await request('bridge/disconnect',{})));return;}
 if(command==='connect'){console.log(JSON.stringify(await request('bridge/start',{})));return;}
 if(command==='pause'){console.log(JSON.stringify(await request('story/pause-for-repair',{})));return;}
 if(command==='start'){console.log(JSON.stringify(await request('story/start',{goal,continueSegments:true,continuationMode:'until_stopped'})));return;}
 if(command==='stop'){console.log(JSON.stringify(await request('stop',{})));return;}
 if(command==='restore'){console.log(JSON.stringify(await request('window/restore',{})));return;}
 if(command==='launch'){console.log(JSON.stringify(await request('launch',{systemPrompt:process.argv.includes('--system-prompt')})));return;}
 if(command==='resume'){
  const saved=JSON.parse(fs.readFileSync(path.join(root,'runtime/genshin/training-session.json'),'utf8'));
  console.log(JSON.stringify(await request('story/resume',{sessionId:saved.sessionId,revision:saved.revision})));return;
 }
 if(command!=='status')throw Error('Use status|test|start|stop|restore|resume');
 const s=await request('status');console.log(JSON.stringify({provider:s.provider,model:s.model,continuation:s.storyContinuation,runs:s.runs?.slice(0,2),goal:s.goal&&{goal:s.goal.goal,runId:s.goal.runId,state:s.goal.run?.state,error:s.goal.run?.error},story:s.context?.story,bridge:{ready:s.bridge.ready,busy:s.bridge.busy,pid:s.bridge.pid,active:s.bridge.active,lastResult:s.bridge.lastResult}},null,2));
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
