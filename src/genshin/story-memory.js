'use strict';
const fs=require('node:fs'),path=require('node:path');
const {questMenu,questInstruction}=require('../../scripts/genshin/story-main');
function questFromEvidence(e,source){
 const texts=e?.request?.texts,quest=e?.decision?.quest;
 if(!Array.isArray(texts)||typeof quest!=='string'||!quest||!questMenu(texts)&&!texts.some(t=>/任务专注模式/.test(t.text)))return null;
 // The frame precedes the action. Selecting a different list entry cannot
 // commit the old detail panel as the chosen task.
 const action=e.decision.action;
 if(action?.kind==='click_text'&&action.scope==='quest_list'&&action.text!==quest)return null;
 // The right-hand detail panel distinguishes the selected quest from the list.
 const details=texts.filter(t=>Array.isArray(t.box)&&t.box[0]>700&&t.box[1]<700).map(t=>t.text);
 if(!details.some(t=>t===quest))return null;
 return {quest,details:details.slice(0,20),source,at:e.at,verification:'historical_bettergi_ocr_recheck_current_step'};
}
function recentEvidence(root){
 const base=path.join(root,'runtime/genshin/story');if(!fs.existsSync(base))return [];
 const folders=fs.readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory()).map(d=>path.join(base,d.name)).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs).slice(0,40);
 const files=folders.flatMap(folder=>fs.readdirSync(folder).filter(n=>/^step-\d+\.json$/.test(n)).map(n=>path.join(folder,n))).sort((a,b)=>fs.statSync(b).mtimeMs-fs.statSync(a).mtimeMs).slice(0,800);
 const rows=[];
 for(const file of files){
  try{const e=JSON.parse(fs.readFileSync(file,'utf8'));if(Date.now()-e.at>8*3600000)continue;rows.push({e,file});}catch{}
 }
 return rows;
}
function readQuestMemory(root){
 for(const {e,file} of recentEvidence(root)){const memory=questFromEvidence(e,file);if(memory)return memory;}
 return null;
}
function questStage(texts){
 return questInstruction(texts)?.text||null;
}
function compatibleStage(a,b){
 const normalize=s=>String(s||'').replace(/\s/g,'');a=normalize(a);b=normalize(b);
 return Boolean(a&&b&&(a===b||Math.min(a.length,b.length)>=6&&(a.startsWith(b)||b.startsWith(a))));
}
// OCR suffix loss must not reset the attempted-waypoint ledger. A genuinely
// different stage needs two consecutive usable reads before clearing it.
function updateNavigationStage(state,reading){
 if(!reading||reading.length<4)return {...state,pending:null,changed:false};
 if(!state.stage)return {stage:reading,pending:null,changed:false};
 if(compatibleStage(state.stage,reading))return {stage:reading.length>state.stage.length?reading:state.stage,pending:null,changed:false};
 if(state.pending===reading)return {stage:reading,pending:null,changed:true};
 return {...state,pending:reading,changed:false};
}
function navigationFromEvidence(rows,quest){
 const matching=rows.filter(({e})=>e.decision?.quest===quest);
 const stage=matching.map(({e})=>questStage(e.request?.texts)).find(Boolean)||null;
 const attempted=new Set();
 for(const {e} of matching){
  if(!stage||!compatibleStage(questStage(e.request?.texts),stage))continue;
  if(e.decision?.action?.kind==='teleport'||e.decision?.action?.kind==='quest_route'&&require('../../data/genshin-commission-routes.json').routes.find(r=>r.id===e.decision.action.id)?.positions.some(p=>p.type==='teleport'))attempted.add(e.decision.action.id);
  if(e.request?.lastStep?.action?.kind==='teleport')attempted.add(e.request.lastStep.action.id);
 }
 return {stage,teleportAttempts:[...attempted],verification:'historical_attempts_not_arrival',previousSteps:matching.slice(0,5).reverse().map(({e})=>({observation:e.observation,decision:e.decision,lastStep:e.request.lastStep}))};
}
function readNavigationMemory(root,quest){return navigationFromEvidence(recentEvidence(root),quest);}
module.exports={readQuestMemory,questFromEvidence,questStage,readNavigationMemory,navigationFromEvidence,compatibleStage,updateNavigationStage};
