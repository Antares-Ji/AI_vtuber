'use strict';
// Read evidence only. No model calls, screenshots, gameplay or inferred success.
const fs=require('node:fs'),path=require('node:path');
const {questStage,updateNavigationStage}=require('../../src/genshin/story-memory');
const root=path.resolve(__dirname,'../..'),base=path.join(root,'runtime/genshin');
const session=JSON.parse(fs.readFileSync(path.join(base,'training-session.json'),'utf8'));
const rows=[],readErrors=[];
for(const d of fs.readdirSync(path.join(base,'story'),{withFileTypes:true}).filter(d=>d.isDirectory())){
 for(const n of fs.readdirSync(path.join(base,'story',d.name)).filter(n=>/^step-\d+\.json$/.test(n))){
  const file=path.join(base,'story',d.name,n);
  try{const row=JSON.parse(fs.readFileSync(file,'utf8'));if(row.at>=session.startedAt)rows.push({...row,file:path.relative(root,file)});}catch(error){readErrors.push({file,error:error.message});}
 }
}
rows.sort((a,b)=>a.at-b.at);
const ids=new Set(rows.map(r=>r.request.id)),native=new Map(),frames=new Map();
for(const r of rows){frames.set(r.request.id+':'+r.request.seq,r);if(r.request.lastStep)native.set(r.request.id+':'+r.request.lastStep.seq,r.request.lastStep);}
const ledger=JSON.parse(fs.readFileSync(path.join(base,'story-feedback-memory.json'),'utf8'));
for(const e of ledger.events)if(ids.has(e.sessionId))native.set(e.sessionId+':'+e.step.seq,e.step);
const stats={sessionId:session.sessionId,from:session.startedAt,at:Date.now(),scope:'Recorded live frames since this training checkpoint began; single director owner, grouped by native id and seq.',nativeSessions:ids.size,recognition:{frames:frames.size,invalidLocalObservation:0,recordedFStates:{}},input:{nativeReceipts:native.size,fSent:0,fNotSent:0,keyboardReceipts:0,clickReceipts:0,movementReceipts:0},interface:{fSceneChanged:0,fPromptChangedOrMissing:0,fPromptUnchanged:0,sceneTransitions:0},task:{confirmedHudStageChanges:0,changes:[],completionVerified:false},model:{calls:0,totalTokens:0},readErrors};
let previousScene=null,stage={stage:null,pending:null},quest=null;
for(const r of frames.values()){
 if(r.observationError)stats.recognition.invalidLocalObservation++;
 const f=r.observation?.interaction?.state||'not_recorded';stats.recognition.recordedFStates[f]=(stats.recognition.recordedFStates[f]||0)+1;
 if(previousScene&&r.observation?.scene&&previousScene!==r.observation.scene)stats.interface.sceneTransitions++;
 previousScene=r.observation?.scene||null;
 if(r.decision?.quest!==quest){quest=r.decision?.quest;stage={stage:null,pending:null};}
 const next=updateNavigationStage(stage,questStage(r.request.texts));
 if(next.changed){stats.task.confirmedHudStageChanges++;stats.task.changes.push({quest,from:stage.stage,to:next.stage,file:r.file});}stage=next;
 for(const call of r.modelCalls||[{usage:r.usage}]){stats.model.calls++;stats.model.totalTokens+=Number(call.usage?.total_tokens)||0;}
}
for(const s of native.values()){
 let d;try{d=JSON.parse(s.detail);}catch{}
 if(d?.kind==='interaction'){
  if(d.sent){stats.input.fSent++;if(d.outcome==='scene_changed')stats.interface.fSceneChanged++;if(d.outcome==='prompt_changed_or_missing')stats.interface.fPromptChangedOrMissing++;if(d.outcome==='prompt_unchanged')stats.interface.fPromptUnchanged++;}else stats.input.fNotSent++;
 }
 if(s.action.kind==='key'&&s.action.key!=='F')stats.input.keyboardReceipts++;
 if(['click_text','choose_dialogue'].includes(s.action.kind)&&/已.*点击/.test(s.detail))stats.input.clickReceipts++;
 if(d?.movedMs>0)stats.input.movementReceipts++;
}
stats.limitation='Counts are local recognition and native receipt evidence, not independently labelled recall, actual key acceptance, navigation arrival or task success. Scene changes can be menus/loading. No F success percentage without real positive examples. In-flight last steps may not yet be in the ledger.';
const file=path.join(base,'training-live-summary.json');fs.writeFileSync(file,JSON.stringify(stats,null,2));console.log(JSON.stringify({file,...stats},null,2));
