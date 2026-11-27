'use strict';
// Read recorded decisions/receipts only. No screenshots, model calls or input.
const fs=require('node:fs'),path=require('node:path');
const grounding=require('./story-main');
const root=path.resolve(__dirname,'../..'),base=path.join(root,'runtime/genshin/story');
const rows=fs.readdirSync(base,{withFileTypes:true}).filter(d=>d.isDirectory()).flatMap(d=>fs.readdirSync(path.join(base,d.name)).filter(n=>/^step-\d+\.json$/.test(n)).map(n=>{const file=path.join(base,d.name,n);return {file:path.relative(root,file).replaceAll('\\','/'),...JSON.parse(fs.readFileSync(file,'utf8'))};})).sort((a,b)=>a.at-b.at);
const counts={},native=[],interactions=[],stages=[],interactionReplay={unique:0,ambiguous:0,absent:0,not_world:0},movementStops={},promptExamples=[];const seen=new Set();
for(const r of rows){
 const a=r.decision?.action||{};const key=a.kind+(a.key?':'+a.key:'');counts[key]=(counts[key]||0)+1;
 const prompt=grounding.interaction(r.request?.texts||[]);interactionReplay[prompt.state]++;
 if(['unique','ambiguous'].includes(prompt.state))promptExamples.push({file:r.file,...prompt});
 const cue=grounding.movementStop(r.request?.texts||[]);if(cue&&['move','advance_quest','follow_marker'].includes(a.kind))movementStops[cue]=(movementStops[cue]||0)+1;
 const stage=r.request?.texts?.find(t=>/^(前往|寻找|跟随|尝试|抵达|与.+对话)/.test(t.text)&&t.box?.[0]<640&&t.box?.[1]<540)?.text;
 if(stage&&!stages.some(s=>s.text===stage))stages.push({text:stage,file:r.file});
 if(a.key==='F')interactions.push({file:r.file,scene:r.observation?.scene,texts:r.request.texts.filter(t=>/^F$|对话|交互/.test(t.text)||t.box?.[0]>1000&&t.box?.[1]>250&&t.box?.[1]<850).map(t=>({text:t.text,box:t.box})),reason:r.decision.reason});
 const step=r.request?.lastStep;if(!step)continue;
 const id=r.request.id+':'+step.seq;if(seen.has(id))continue;seen.add(id);
 let detail;try{detail=JSON.parse(step.detail);}catch{detail=step.detail;}
 native.push({file:r.file,action:step.action,detail,nextScene:r.observation?.scene,meters:r.distanceEvidence?.meters});
}
const markers=native.filter(n=>n.action?.kind==='follow_marker');
const histories=new Map(),blockedMarkerDecisions=[];
for(const r of rows){
 const id=r.request?.id;if(!id)continue;
 if(!histories.has(id))histories.set(id,new Map());
 const history=histories.get(id),step=r.request.lastStep;
 if(step)history.set(step.seq,step);
 if(r.decision?.action?.kind==='follow_marker'&&grounding.navigationFeedback([...history.values()]).blocked)blockedMarkerDecisions.push(r.file);
}
const output={sessions:new Set(rows.map(r=>path.dirname(r.file))).size,decisionFrames:rows.length,firstAt:rows[0]?.at,lastAt:rows.at(-1)?.at,decisionCounts:counts,stages,nativeReceipts:native.length,markerReceipts:markers.length,markerWithoutForwardEligibleTrace:markers.filter(n=>!n.detail?.trace?.some(t=>t.marker&&Math.abs(t.marker.x-960)<=80&&t.marker.y<540&&!(t.distance!==null&&t.distance<=4))).length,markerMissingOrAmbiguous:markers.filter(n=>n.detail?.trace?.some(t=>t.matches!==1)).length,interactions,offlineReplay:{interactionStates:interactionReplay,movementDecisionsNowYielding:movementStops,promptExamples},markerExamples:markers.slice(-8),limitation:'Recorded text/trace replay only, not new game input. Forward-eligible trace is a heuristic, not proof of actual movement or failure. Decisions are not execution; receipts may omit last step; no game completion, F success rate or training weights claimed.'};
output.offlineReplay.markerDecisionsNowBlocked=blockedMarkerDecisions;
const file=path.join(root,'runtime/genshin/story-training-summary.json');fs.writeFileSync(file,JSON.stringify(output,null,2));
console.log(JSON.stringify({file,sessions:output.sessions,decisionFrames:rows.length,nativeReceipts:native.length,markerReceipts:markers.length,markerMissingOrAmbiguous:output.markerMissingOrAmbiguous,markerWithoutForwardEligibleTrace:output.markerWithoutForwardEligibleTrace,interactionReplay,markerDecisionsNowBlocked:blockedMarkerDecisions.length,limitation:output.limitation},null,2));
