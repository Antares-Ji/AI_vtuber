'use strict';
// Explicit director control: one fresh, validated intent per native observation.
let pending=null;
function snapshot(){return pending?.view||null;}
function wait({request,observation,context,validate,signal}){
 if(pending)throw Error('已有待处理的直接控制观察');
 signal.throwIfAborted();
 return new Promise((resolve,reject)=>{
  const clear=()=>{signal.removeEventListener('abort',abort);pending=null;};
  const abort=()=>{clear();reject(signal.reason);};
  pending={view:{nativeId:request.id,seq:request.seq,deadlineAt:request.deadlineAt,request,observation,context},
   submit(body){
    signal.throwIfAborted();
    if(body.nativeId!==request.id||body.seq!==request.seq||Date.now()>=request.deadlineAt)throw Error('直接控制观察不匹配或已过期');
    const decision=validate({...body.decision,commentary:''},request,observation);
    clear();resolve({decision,answer:{provider:'director',model:'codex-direct',usage:null},calls:[],rejected:[]});
   }};
  signal.addEventListener('abort',abort,{once:true});
 });
}
function submit(body){if(!pending)throw Error('没有等待中的直接控制观察');pending.submit(body);return {accepted:true};}
module.exports={wait,submit,snapshot};
