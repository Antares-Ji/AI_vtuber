'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash,randomUUID}=require('node:crypto');
const {questFromEvidence}=require('./story-memory');
const {questMenu}=require('../../scripts/genshin/story-main');
const clone=value=>JSON.parse(JSON.stringify(value));
function validMemory(memory){
 if(!memory||typeof memory.quest!=='string'||!memory.quest.trim()||memory.quest.length>500||
  !Array.isArray(memory.details)||!memory.details.every(t=>typeof t==='string')||!memory.details.includes(memory.quest)||
  typeof memory.source!=='string'||!memory.source||!Number.isFinite(memory.at)||
  memory.verification!=='historical_bettergi_ocr_recheck_current_step')throw Error('Quest focus requires validated quest-menu evidence');
 return clone(memory);
}
function completionEvidence(texts,quest){
 if(!Array.isArray(texts)||typeof quest!=='string'||!quest||texts.some(t=>!t||typeof t.text!=='string'))return null;
 // A task menu, series-completion instruction, model statement or a duplicated
 // quest name is not an in-world completion banner for the anchored quest.
 if(questMenu(texts)||texts.some(t=>/任务专注模式|完成系列任务/.test(t.text)))return null;
 const complete=texts.filter(t=>t.text==='任务完成'),titles=texts.filter(t=>t.text===quest);
 if(complete.length!==1||titles.length!==1||quest==='任务完成')return null;
 const evidence=t=>({text:t.text,...(Array.isArray(t.box)&&t.box.length===4&&t.box.every(Number.isFinite)?{box:[...t.box]}:{})});
 return {source:'bettergi_ocr_exact_quest_completion',quest,completion:evidence(complete[0]),title:evidence(titles[0])};
}
function earliestMemory(root,startedAt){
 const base=path.join(root,'runtime/genshin/story');if(!fs.existsSync(base))return null;
 const rows=[];
 for(const folder of fs.readdirSync(base,{withFileTypes:true})){
  if(!folder.isDirectory())continue;
  const directory=path.join(base,folder.name);
  for(const name of fs.readdirSync(directory)){
   if(!/^step-\d+\.json$/.test(name))continue;
   const source=path.join(directory,name);
   try{
    const evidence=JSON.parse(fs.readFileSync(source,'utf8'));
    if(!Number.isFinite(evidence.at)||evidence.at<startedAt)continue;
    const memory=questFromEvidence(evidence,source);if(memory)rows.push({memory,source});
   }catch{/* Incomplete individual evidence files cannot select a quest. */}
  }
 }
 rows.sort((a,b)=>a.memory.at-b.memory.at||a.source.localeCompare(b.source));
 return rows[0]?.memory||null;
}
class StoryQuestFocus{
 constructor({root,sessionId,startedAt,initialMemory=null}={}){
  if(typeof root!=='string'||!root||typeof sessionId!=='string'||!sessionId||sessionId.length>200||!Number.isFinite(startedAt)||startedAt<0)throw Error('Quest focus requires root, training sessionId and startedAt');
  this.sessionId=sessionId;
  const key=createHash('sha256').update(sessionId).digest('hex');
  this.file=path.join(root,'runtime/genshin/story-quest-focus',key+'.json');
  if(fs.existsSync(this.file)){this._load();return;}
  const migrated=earliestMemory(root,startedAt);
  this.state={version:1,sessionId,startedAt,memory:migrated?validMemory(migrated):initialMemory?validMemory(initialMemory):null,completions:[],createdAt:Date.now(),initializedFrom:migrated?'earliest_session_menu_evidence':initialMemory?'provided_memory':'no_memory'};
  this._save();
 }
 _load(){
  let state;try{state=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{throw Error('Quest focus checkpoint is unreadable; refusing to choose another quest');}
  if(state?.version!==1||state.sessionId!==this.sessionId||!Array.isArray(state.completions)||!Object.hasOwn(state,'memory'))throw Error('Invalid quest focus checkpoint');
  if(state.memory!==null)validMemory(state.memory);
  this.state=state;
 }
 _save(){
  fs.mkdirSync(path.dirname(this.file),{recursive:true});
  const temporary=this.file+'.'+randomUUID()+'.tmp';
  try{fs.writeFileSync(temporary,JSON.stringify(this.state,null,2),'utf8');fs.renameSync(temporary,this.file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
 }
 snapshot(){return clone({memory:this.state.memory,completions:this.state.completions});}
 select(memory){
  memory=validMemory(memory);this._load();
  if(this.state.memory&&this.state.memory.quest!==memory.quest)throw Object.assign(Error('Current quest is still anchored: '+this.state.memory.quest),{code:'QUEST_FOCUS_CONFLICT'});
  const completed=this.state.completions.at(-1);
  if(!this.state.memory&&completed&&memory.at<=completed.at)throw Error('Next quest requires fresh menu evidence after acknowledged completion');
  if(!this.state.memory||memory.at>=this.state.memory.at){this.state.memory=memory;this._save();}
  return this.snapshot();
 }
 acknowledgeCompletion({id,seq,texts}={}){
  if(typeof id!=='string'||!id||id.length>200||!Number.isInteger(seq)||seq<1)throw Error('Completion acknowledgement requires native request id and sequence');
  this._load();
  if(this.state.completions.some(c=>c.requestId===id&&c.seq===seq))return {acknowledged:false,duplicate:true,...this.snapshot()};
  const evidence=this.state.memory&&completionEvidence(texts,this.state.memory.quest);
  if(!evidence)return {acknowledged:false,...this.snapshot()};
  this.state.completions.push({requestId:id,seq,at:Date.now(),quest:this.state.memory.quest,evidence,memory:this.state.memory});
  this.state.memory=null;this._save();return {acknowledged:true,...this.snapshot()};
 }
}
module.exports={StoryQuestFocus,completionEvidence};
