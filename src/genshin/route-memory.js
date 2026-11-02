'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const memoryFile=root=>path.join(root,'runtime/genshin/route-attempts.json');
function readRouteAttempts(root) {
  if(!root)return [];
  try {
    const value=JSON.parse(fs.readFileSync(memoryFile(root),'utf8'));
    return Array.isArray(value)?value.filter(item=>item&&typeof item.routeId==='string'&&
      typeof item.jobId==='string'&&Number.isFinite(item.at)&&
      ['returned-unverified','path-failed','timed-out'].includes(item.outcome)).slice(-256):[];
  }catch(error){if(error.code==='ENOENT')return [];throw error;}
}
function recordRouteAttempt(root,{routeId,receipt,errorCode=null,errorMessage=''},now=Date.now()) {
  if(!root||typeof routeId!=='string'||routeId.length>500||!receipt?.inputReleased||!receipt.processStopped||
      !/^[0-9a-f-]{36}$/.test(receipt.id||'')||!Number.isFinite(now))return false;
  const outcome=errorCode==='PATH_EXECUTION_FAILED'?'path-failed':errorCode==='COMMAND_TIMEOUT'?'timed-out':
    !errorCode&&receipt.state==='returned'?'returned-unverified':null;
  if(!outcome)return false;
  const items=readRouteAttempts(root);
  if(items.some(item=>item.jobId===receipt.id))return false;
  const failureReason=outcome==='path-failed'&&/未出现交互面板|TeleportPanelNotOpened/.test(errorMessage)?
    '传送点点击后未出现交互面板，可能未激活；未确认到达':null;
  items.push({routeId,jobId:receipt.id,at:now,outcome,...(failureReason?{failureReason}:{}),source:'bettergi-bridge-receipt',verified:false});
  const file=memoryFile(root),temporary=file+'.'+randomUUID()+'.tmp';
  fs.mkdirSync(path.dirname(file),{recursive:true});
  try{fs.writeFileSync(temporary,JSON.stringify(items.slice(-256),null,2)+'\n','utf8');fs.renameSync(temporary,file);}
  finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
  return true;
}
function withRouteHistory(routes,root) {
  const items=readRouteAttempts(root);
  return routes.map(route=>{
    const history=items.filter(item=>item.routeId===route.id).slice(-3);
    return history.length?{...route,recentExecutions:history.map(item=>({...item,
      note:item.outcome==='path-failed'?'路线内部失败；不能认为到达，参考时间避免重复尝试':
        item.outcome==='timed-out'?'执行超时，不代表已击杀或已清场':'接口返回；到达、击杀和拾取均未独立核验'}))}:route;
  });
}
module.exports={recordRouteAttempt,readRouteAttempts,withRouteHistory};
