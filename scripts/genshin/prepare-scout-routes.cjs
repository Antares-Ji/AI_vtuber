'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
const root=path.resolve(__dirname,'../..');
async function get(route){const r=await fetch('http://127.0.0.1:3000'+route);if(!r.ok)throw Error('API unavailable');return r.json();}
(async()=>{
 const [status,input,vision]=await Promise.all([get('/api/genshin/status'),get('/api/game-input/state'),get('/api/game-input/vision-state')]);
 if(status.bridge.busy||input.busy||vision.busy||!status.bridge.lastResult?.inputReleased||status.runs.some(r=>['RUNNING','STOPPING'].includes(r.state)))throw Error('任务或视觉仍在运行，未改路线');
 const {directory}=require('../../src/genshin/installation').installation({root});
 const policy=require('../../src/genshin/combat-policy').readPolicy(root);
 const manifestFile=path.join(root,'data/genshin-hunting-routes.json');
 const previous=fs.readFileSync(manifestFile,'utf8'),entries=JSON.parse(previous).filter(r=>r.combatMode!=='observe-first');
 const generated=[];
 for(const entry of entries){
   if(policy.blockedRoutes.includes(entry.id))continue;
   const original=path.join(directory,'User/AutoPathing',entry.id.slice(5));
   const bytes=fs.readFileSync(original);
   if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw Error('已审查原路线发生变化');
   const route=JSON.parse(bytes.toString('utf8'));const first=route.positions.findIndex(p=>p.action==='fight');
   if(first<0||route.positions.slice(0,first+1).some(p=>!['','fight','stop_flying'].includes(p.action||'')))throw Error('路线包含未知动作，未生成');
   route.positions=route.positions.slice(0,first+1).map(p=>({...p,action:p.action==='fight'?'':p.action}));
   route.info={...route.info,name:route.info.name+'-先观察',description:'仅沿原路线到首个点，移除自动战斗；敌人类型和附近其他敌人需另行现场观察。'};
   const rel=entry.id.slice(5).replace('AI-VTuber-Hunting/','AI-VTuber-Scout/');
   const dest=path.join(directory,'User/AutoPathing',rel);fs.mkdirSync(path.dirname(dest),{recursive:true});
   const output=JSON.stringify(route,null,2);fs.writeFileSync(dest,output);
   generated.push({...entry,id:'user:'+rel,originalRouteId:entry.id,combatMode:'observe-first',sha256:createHash('sha256').update(output).digest('hex')});
 }
 fs.writeFileSync(path.join(root,'runtime/genshin/hunting-before-scout-'+Date.now()+'.json'),previous);
 fs.writeFileSync(manifestFile,JSON.stringify([...entries,...generated],null,2)+'\n');
 console.log(JSON.stringify({generated:generated.length,blocked:policy.blockedRoutes,ownerPid:status.bridge.pid,combatActionsRemoved:true}));
})().catch(e=>{console.error(e.message);process.exitCode=1;});
