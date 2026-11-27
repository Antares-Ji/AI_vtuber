'use strict';
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const {readLock,alive,modeFrom}=require('./training-monitor.cjs');
const ROOT=path.resolve(__dirname,'../..');
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function ensureMonitor({root=ROOT,argument='until_stopped',spawnChild=spawn,isAlive=alive,sleep=delay,now=Date.now}={}){
 const mode=modeFrom(argument).mode,folder=path.join(root,'runtime/genshin/training-monitor'),lockFile=path.join(folder,'monitor.lock.json');
 const existing=readLock(lockFile);
 if(existing&&isAlive(existing.pid))return {reused:true,pid:existing.pid,mode:existing.mode,heartbeatAgeMs:now()-existing.heartbeatAt,log:path.join(folder,'monitor.log')};
 fs.mkdirSync(folder,{recursive:true});
 const log=path.join(folder,'monitor.log'),fd=fs.openSync(log,'a');let child,spawnError=null;
 try{child=spawnChild(process.execPath,[path.join(root,'scripts/genshin/training-monitor.cjs'),argument],{cwd:root,detached:true,windowsHide:true,stdio:['ignore',fd,fd]});}
 finally{fs.closeSync(fd);}
 child.once('error',error=>{spawnError=error;});child.unref();
 for(let n=0;n<40;n++){
  if(spawnError)throw spawnError;
  const current=readLock(lockFile);
  if(current&&isAlive(current.pid))return {reused:current.pid!==child.pid,pid:current.pid,mode:current.mode||mode,heartbeatAgeMs:now()-current.heartbeatAt,log};
  await sleep(250);
 }
 throw Error('Monitor did not publish its PID lock; inspect '+log);
}
module.exports={ensureMonitor};
if(require.main===module)ensureMonitor({argument:process.argv[2]||'until_stopped'}).then(value=>console.log(JSON.stringify(value))).catch(error=>{console.error(error.message);process.exitCode=1;});
