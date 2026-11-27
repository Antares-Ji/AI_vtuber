'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');

// Private checkpoint, separate from the public skill execution timeline.
// Locked compare-and-swap prevents an old callback/console from overwriting
// a user stop saved by a newer owner.
class TrainingSessionStore {
 constructor({file,clock=Date.now}){this.file=file;this.clock=clock;}
 read(){
  if(!fs.existsSync(this.file))return null;
  const value=JSON.parse(fs.readFileSync(this.file,'utf8'));
  if(value.version!==1||typeof value.sessionId!=='string'||!Number.isInteger(value.revision)||typeof value.goal!=='string')throw Error('Invalid Genshin training checkpoint');
  return value;
 }
 transaction(fn){
  fs.mkdirSync(path.dirname(this.file),{recursive:true});
  const lock=this.file+'.lock';let handle;
  try{handle=fs.openSync(lock,'wx');}catch(error){if(error.code==='EEXIST')throw Error('Genshin training checkpoint is busy');throw error;}
  let temporary;
  try{
   const next=fn(this.read());
   temporary=this.file+'.'+randomUUID()+'.tmp';fs.writeFileSync(temporary,JSON.stringify(next,null,2));fs.renameSync(temporary,this.file);return next;
  }finally{if(temporary&&fs.existsSync(temporary))fs.unlinkSync(temporary);fs.closeSync(handle);fs.unlinkSync(lock);}
 }
 create(value){return this.transaction(previous=>({...value,version:1,sessionId:randomUUID(),revision:(previous?.revision||0)+1,updatedAt:this.clock()}));}
 update(token,patch){
  return this.transaction(current=>{
   if(!current||current.sessionId!==token.sessionId||current.revision!==token.revision)throw Object.assign(Error('Genshin training session changed; reload its state'),{code:'TRAINING_SESSION_CONFLICT'});
   return {...current,...patch,version:1,sessionId:current.sessionId,revision:current.revision+1,updatedAt:this.clock()};
  });
 }
}
module.exports={TrainingSessionStore};
