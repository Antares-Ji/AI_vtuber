'use strict';
const fs=require('node:fs'),path=require('node:path'),{randomUUID}=require('node:crypto');
const {processRun}=require('../skills/process');
async function restoreWindow({root,signal,runProcess=processRun}){
 signal.throwIfAborted();
 const bridge=require('./bridge').status();
 if(bridge.busy||bridge.active)throw Error('先等待BetterGI输入清理后再恢复窗口');
 if(bridge.ready&&bridge.supervisorVersion>=9){
  const receipt=await require('./bridge').execute({operation:'restore_window',timeoutMs:10000},{signal});
  if(receipt.window?.inputSent!==false||receipt.window?.focused!==true)throw Error('Invalid authorized window restore receipt');
  return {...receipt.window,execution:receipt};
 }
 const folder=path.join(root,'runtime/genshin/window-restore',randomUUID());fs.mkdirSync(folder,{recursive:true});
 const cancelFile=path.join(folder,'cancel');const cancel=()=>fs.writeFileSync(cancelFile,'stop');
 signal.addEventListener('abort',cancel,{once:true});
 try{
  const output=await runProcess(path.join(root,'runtime/vlm-env/Scripts/python.exe'),[path.join(root,'scripts/genshin/restore-window.py'),'--cancel-file',cancelFile],{cwd:root,signal});
  signal.throwIfAborted();const result=JSON.parse(output.trim());
  if(result.inputSent!==false||result.verified!==false||result.focused!==true||!Number.isInteger(result.pid)||!Array.isArray(result.client))throw Error('Invalid window restore receipt');
  fs.writeFileSync(path.join(folder,'receipt.json'),JSON.stringify(result,null,2));return result;
 }finally{signal.removeEventListener('abort',cancel);}
}
module.exports={restoreWindow};
