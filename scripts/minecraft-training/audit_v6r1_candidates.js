'use strict';
const fs=require('fs'),path=require('path'),crypto=require('crypto'),mcData=require('minecraft-data')('1.21.11');
const {compactObservation}=require('../../src/minecraft/survival-planner');
const {validateAction,FOODS}=require('../../src/minecraft/survival-skills');
const ROOT=path.resolve(__dirname,'../..'),DATA=path.join(ROOT,'data/minecraft-training'),OUT=path.join(ROOT,'output/minecraft-training');
const read=p=>fs.readFileSync(p,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse),sha=b=>crypto.createHash('sha256').update(b).digest('hex'),same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const train=read(path.join(DATA,'train-v6r1-candidates.jsonl')),dev=read(path.join(DATA,'development-v6r1-candidates.jsonl'));
const replayPath=path.join(DATA,'train-v6r1-weighted-replay-candidates.jsonl'),replay=read(replayPath),prior=fs.readFileSync(path.join(DATA,'train-v5r2-replay-candidates.jsonl')),replayBytes=fs.readFileSync(replayPath),manifest=JSON.parse(fs.readFileSync(path.join(DATA,'manifest-v6r1-candidates.json'),'utf8'));
const old=read(path.join(DATA,'train-v5r2-replay-candidates.jsonl'));
const autonomyPath=path.join(ROOT,'logs/minecraft-autonomy.jsonl');
const autonomy=fs.readFileSync(autonomyPath,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
const requests=new Map(autonomy.filter(e=>e.event==='model_request').map(e=>[e.requestId,e]));
const errors=[],summary={train:[],dev:[]};
for(const [name,rows,isDev] of [['train',train,false],['dev',dev,true]]) for(const row of rows){
 const sourceFaithful=Boolean(row.sourceRef?.requestId);
 try{validateAction(row.action)}catch(e){errors.push(`${row.id}: schema ${e.message}`)}
 if(row.messages.at(-1)?.role!=='assistant'||row.messages.at(-1)?.content!==JSON.stringify(row.action)) errors.push(`${row.id}: assistant/action mismatch`);
 let user;try{user=JSON.parse(row.messages[1].content)}catch{errors.push(`${row.id}: bad user JSON`);continue}
 if(!same(user.state,compactObservation(row.state))) errors.push(`${row.id}: user state != compactObservation`);
 const recent=user.recentResults||[];if(!sourceFaithful&&recent.length!==6)errors.push(`${row.id}: recentResults not six`);
 const histFails=recent.filter(x=>x.status==='failed').map(x=>({action:x.action,error:x.error}));
 const stateFails=(row.state.recentFailures||[]).map(x=>({action:x.action,error:x.error}));if(!sourceFaithful&&!same(histFails,stateFails))errors.push(`${row.id}: history/recentFailures mismatch`);
 if(sourceFaithful){
   const captured=requests.get(row.sourceRef.requestId);
   if(!captured)errors.push(`${row.id}: source requestId not found in raw autonomy log`);
   else {const capturedUser=captured.request.messages.find(m=>m.role==='user');if(!capturedUser||capturedUser.content!==row.messages[1].content)errors.push(`${row.id}: source user message differs from raw request`);}
   if(!same(user.state,row.state))errors.push(`${row.id}: source state changed`);
   const rawCompletion=autonomy.find(e=>e.event==='model_completion'&&e.requestId===row.sourceRef.requestId);
   if(!rawCompletion)errors.push(`${row.id}: source completion missing`);
   else {let rawAction;try{rawAction=JSON.parse(rawCompletion.completion.content)}catch{};if(!same(rawAction,row.sourceRef.modelAction||row.action)&&!same(rawAction,row.action))errors.push(`${row.id}: source original model action mismatch`);}
 }
 const n=Object.fromEntries((row.state.inventory||[]).map(x=>[x.name,x.count]));
 const logs=(row.state.inventory||[]).filter(x=>/_log$/.test(x.name)).reduce((a,x)=>a+x.count,0);
 const planks=(row.state.inventory||[]).filter(x=>/_planks$/.test(x.name)).reduce((a,x)=>a+x.count,0);
 const action=row.action;
 if(action.action==='gather_wood'&&!row.state.resources.wood?.length)errors.push(`${row.id}: gather without visible wood`);
 if(action.action==='eat'&&(!(row.state.food<20)||!row.state.inventory.some(x=>FOODS.includes(x.name)&&x.count>0)))errors.push(`${row.id}: eat precondition invalid`);
 if(row.state.food===20&&action.action==='eat')errors.push(`${row.id}: full-food eat label`);
 if(action.action==='craft'){
   const table=(n.crafting_table||0)>0||row.state.stations.some(s=>s.name==='crafting_table');
   if(action.item==='planks'&&action.count>logs*4)errors.push(`${row.id}: planks count exceeds logs`);
   if(action.item==='stick'&&planks<2)errors.push(`${row.id}: stick recipe lacks two planks`);
   if(action.item==='crafting_table'&&(planks<4||table))errors.push(`${row.id}: table recipe precondition`);
   if(action.item==='wooden_pickaxe'&&(!table||planks<3||(n.stick||0)<2))errors.push(`${row.id}: wooden pickaxe prerequisites`);
   if(action.item==='stone_pickaxe'&&(!table||((n.cobblestone||0)+(n.cobbled_deepslate||0)<3)||(n.stick||0)<2))errors.push(`${row.id}: stone pickaxe prerequisites`);
 }
 if(action.action==='mine'){
   const tier=['wooden_pickaxe','stone_pickaxe','iron_pickaxe','diamond_pickaxe'].findIndex(k=>n[k]>0);
   const need={stone:0,coal:0,iron:1,diamond:2,obsidian:3,gravel:-1}[action.resource];
   if(tier<need)errors.push(`${row.id}: mine tier too low`);
   if(!row.state.resources[action.resource]?.length)errors.push(`${row.id}: missing visible target`);
 }
 if(action.action==='dig_staircase'){
   if(!['north','south','east','west'].includes(action.direction)||action.steps<1||action.steps>8)errors.push(`${row.id}: invalid staircase direction/steps`);
   if(row.state.health<12||row.state.food<10||!row.state.inventory.some(i=>i.name.endsWith('_pickaxe')&&i.count>0))errors.push(`${row.id}: staircase health/food/tool prerequisites`);
   if(row.state.position.y-action.steps<50&&(row.state.inventory.find(i=>i.name==='torch')?.count||0)<Math.ceil(action.steps/4))errors.push(`${row.id}: staircase torch prerequisite`);
   if((row.state.resources.gravel||[]).length||row.state.hazards?.length||(row.state.fluids?.lava||[]).length)errors.push(`${row.id}: staircase has observed terrain hazard`);
 }
 if(!sourceFaithful)for(const [kind,list] of Object.entries(row.state.resources||{}))for(const b of list||[]){const dist=Math.round(Math.hypot(row.state.position.x-b.position.x,row.state.position.y-b.position.y,row.state.position.z-b.position.z)*10)/10;if(dist!==b.distance)errors.push(`${row.id}: ${kind} distance mismatch`)}
 for(const t of row.state.tools||[])if(mcData.itemsByName[t.name]?.maxDurability!==t.maxDurability)errors.push(`${row.id}: durability mismatch ${t.name}`);
 if(isDev&&!row.expectedActionSet)errors.push(`${row.id}: missing action set`);
 summary[name].push({id:row.id,action:row.action,food:row.state.food,inventory:row.state.inventory,resourceCounts:Object.fromEntries(Object.entries(row.state.resources||{}).map(([k,v])=>[k,v.length]))});
}
if(train.length!==24||dev.length!==10||replay.length!==286)errors.push(`counts train/dev/replay ${train.length}/${dev.length}/${replay.length}`);
if(!replayBytes.subarray(0,prior.length).equals(prior))errors.push('prior v5r2 replay byte prefix changed');
const key=r=>r.messages[1].content;const sets=[new Set(train.map(key)),new Set(dev.map(key)),new Set(old.map(key))];
const overlap=(a,b)=>[...a].filter(x=>b.has(x)).length;const overlaps={newTrainDev:overlap(sets[0],sets[1]),newTrainPriorReplay:overlap(sets[0],sets[2]),newDevPriorReplay:overlap(sets[1],sets[2])};
if(Object.values(overlaps).some(Boolean))errors.push(`prompt overlap ${JSON.stringify(overlaps)}`);
const hashes={train:sha(fs.readFileSync(path.join(DATA,'train-v6r1-candidates.jsonl'))),dev:sha(fs.readFileSync(path.join(DATA,'development-v6r1-candidates.jsonl'))),replay:sha(replayBytes)};
if(hashes.train!==manifest.trainingSha256||hashes.dev!==manifest.developmentSha256||hashes.replay!==manifest.weightedReplaySha256)errors.push('manifest hash mismatch');
const report={status:errors.length?'failed':'passed',trainingRows:train.length,developmentRows:dev.length,weightedReplayRows:replay.length,overlaps,hashes,replayPrefixPreserved:replayBytes.subarray(0,prior.length).equals(prior),checked:{actionSchema:true,runtimeCompactState:true,historyConsistency:true,recipeMaterials:true,foodPrerequisites:true,miningPrerequisites:true,geometry:true,durability:true},errors,rowSummary:summary};
fs.writeFileSync(path.join(OUT,'v6r1-candidate-semantic-preflight.json'),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify(report,null,2));if(errors.length)process.exitCode=1;
