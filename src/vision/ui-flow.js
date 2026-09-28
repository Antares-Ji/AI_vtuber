const path=require('node:path');
const {execFile}=require('node:child_process');
const pending=new Map();
function buildFlow(dir){if(pending.has(dir))return pending.get(dir);if(pending.size>=2)return Promise.reject(new Error('Flow analysis busy'));
const task=new Promise((resolve,reject)=>execFile(path.resolve(__dirname,'../../runtime/vision-env/Scripts/python.exe'),
  [path.join(__dirname,'ui-flow.py'),path.join(dir,'manifest.json')],{windowsHide:true,timeout:60000,maxBuffer:2*1024*1024},(error,out)=>{
    if(error)return reject(error);try{resolve(JSON.parse(out));}catch(e){reject(e);}
  })).finally(()=>pending.delete(dir));pending.set(dir,task);return task;}
module.exports={buildFlow};
