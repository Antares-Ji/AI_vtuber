'use strict';
const fs=require('node:fs'),path=require('node:path');
function executionStatus(directory,jobId,pid=null,now=Date.now()) {
  if(!/^[0-9a-f-]{36}$/.test(jobId))return {pid,notice:null};
  let scriptStarted=false;
  try {
    const receiptFile=path.join(directory,'User','JsScript','AI-VTuber-Bridge-'+jobId,'receipt.json');
    if(fs.existsSync(receiptFile)){
      const receipt=JSON.parse(fs.readFileSync(receiptFile,'utf8'));
      if(receipt.id===jobId)scriptStarted=true;
    }
    const logs=fs.readdirSync(path.join(directory,'log')).filter(n=>/^better-genshin-impact.*\.log$/.test(n)).map(n=>({file:path.join(directory,'log',n),stat:fs.statSync(path.join(directory,'log',n))})).sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
    const log=logs[0];if(!log||now-log.stat.mtimeMs>5000)return {pid,notice:null,scriptStarted};
    const size=Math.min(log.stat.size,32768),buffer=Buffer.alloc(size),fd=fs.openSync(log.file,'r');
    try{fs.readSync(fd,buffer,0,size,log.stat.size-size);}finally{fs.closeSync(fd);}
    const blocks=buffer.toString('utf8').split(/(?=\[\d\d:\d\d:\d\d\.\d+\])/);
    if(!pid){const entry=blocks.find(x=>x.includes('AI-VTuber-Bridge-'+jobId));pid=Number(entry?.match(/:P(\d+):/)?.[1])||null;}
    if(!pid)return {pid,notice:null,scriptStarted};
    const entries=blocks.filter(x=>x.includes(`:P${pid}:`));
    const last=entries.at(-1)||'';
    if(!scriptStarted&&entries.some(x=>x.includes('当前不在游戏主界面，等待进入主界面后执行任务')))return {pid,scriptStarted,notice:{stage:'waiting-main-ui',message:'BetterGI 尚未进入脚本，正在等待主界面；持续等待将自动重新观察并恢复'}};
    return {pid,scriptStarted,notice:last.includes('不是原神，暂停')?{stage:'paused-focus',message:'BetterGI 正在等待原神回到前台；切到聊天窗口会暂停游戏输入。这不是审批等待。'}:null};
  }catch{return {pid,notice:null,scriptStarted};}
}
function executionFailure(directory,jobId,pid=null) {
  if(!/^[0-9a-f-]{36}$/.test(jobId))return null;
  try {
    const logs=fs.readdirSync(path.join(directory,'log')).filter(n=>/^better-genshin-impact.*\.log$/.test(n)).map(n=>({file:path.join(directory,'log',n),stat:fs.statSync(path.join(directory,'log',n))})).sort((a,b)=>b.stat.mtimeMs-a.stat.mtimeMs);
    const log=logs[0];if(!log)return null;
    const buffer=Buffer.alloc(Math.min(log.stat.size,256*1024)),fd=fs.openSync(log.file,'r');
    try{fs.readSync(fd,buffer,0,buffer.length,log.stat.size-buffer.length);}finally{fs.closeSync(fd);}
    const blocks=buffer.toString('utf8').split(/(?=\[\d\d:\d\d:\d\d\.\d+\])/);
    const begin=blocks.findIndex(b=>b.includes('AI-VTuber-Bridge-'+jobId));
    if(begin<0&&!pid)return null;
    pid=pid||Number(blocks[begin].match(/:P(\d+):/)?.[1]);
    const failures=blocks.slice(Math.max(0,begin)).filter(b=>b.includes(`:P${pid}:`)&&b.includes('执行地图追踪时候发生错误'));
    if(!failures.length)return null;
    return failures.at(-1).split(/\r?\n/).find(line=>line.includes('执行地图追踪时候发生错误'))?.slice(0,500)||'BetterGI 地图追踪内部失败';
  }catch{return null;}
}
module.exports={executionStatus,executionFailure};
