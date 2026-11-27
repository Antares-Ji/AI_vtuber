'use strict';
const fs=require('node:fs'),path=require('node:path');
const {randomUUID,createHash}=require('node:crypto');
const bridge=require('./bridge');
const {validateObservation}=require('./observe');
function reusableCapture(receipt,status,now=Date.now()){
  return Boolean(receipt&&receipt.id===status.lastResult?.id&&receipt.session===status.session&&receipt.state==='returned'&&receipt.inputReleased===true&&receipt.processStopped===true&&now-receipt.finishedAt*1000>=0&&now-receipt.finishedAt*1000<30000&&receipt.captures?.some(c=>c.name==='after.png'));
}
async function observeOnce({root=path.resolve(__dirname,'../..'),signal,fetchImpl=fetch,reportProgress=()=>{},receipt:suppliedReceipt}={}) {
  signal?.throwIfAborted();
  reportProgress('vision-health','正在检查本地视觉服务');
  const health=await fetchImpl('http://127.0.0.1:17646/health',{signal:AbortSignal.timeout(2000)}).then(r=>r.json());
  if(!health.ready||health.busy||health.provider!=='local'||health.genshinSceneSupport!==true)throw Error('本地原神视觉服务未就绪；当前不启用云端图像推理');
  reportProgress('connecting','正在连接 BetterGI；如系统弹出权限窗口，请完成 Windows 确认');
  await bridge.start({root,signal});
  const reuse=reusableCapture(suppliedReceipt,bridge.status());
  reportProgress('capturing',reuse?'正在读取刚完成任务的 BetterGI 截图，无需重启截图进程':'BetterGI 正在截图，尚未执行战斗或寻路');
  const receipt=reuse?suppliedReceipt:await bridge.execute({operation:'capture',timeoutMs:60000},{signal});
  const captured=receipt.captures?.find(c=>c.name==='after.png');
  if(!captured || Date.now()-receipt.finishedAt*1000>30000)throw Error('缺少当前请求的 BetterGI 截图');
  const source=bridge.evidence(receipt.session,receipt.id,'after.png');
  const bytes=fs.readFileSync(source);
  if(createHash('sha256').update(bytes).digest('hex')!==captured.sha256)throw Error('BetterGI 截图摘要不匹配');
  const folder=path.join(root,'runtime/genshin/observations',randomUUID());fs.mkdirSync(folder,{recursive:true});
  const image=path.join(folder,'frame.png');fs.writeFileSync(image,bytes);
  reportProgress('observing','已收到 BetterGI 截图，本地 Qwen 正在识别当前场景');
  const response=await fetchImpl('http://127.0.0.1:17646/read',{method:'POST',redirect:'error',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'genshin-scene',image}),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(90000)])});
  if(!response.ok)throw Error(`本地原神视觉接口 HTTP ${response.status}`);
  const vision=await response.json();signal?.throwIfAborted();
  if(createHash('sha256').update(fs.readFileSync(image)).digest('hex')!==captured.sha256)throw Error('视觉读取期间截图发生变化');
  const result={observation:validateObservation(vision,image),model:vision.model,source:'bettergi_capture_and_local_vision_api',capture:{bridgeId:receipt.id,session:receipt.session,image,...captured},verified:false};
  if(require('./combat-policy').readPolicy(root)&&['world','combat'].includes(result.observation.scene)){
    if(health.genshinEnemySupport!==true)throw Error('本地视觉需要支持敌人类型检查，暂不进入未知混战点');
    reportProgress('observing-enemies','本地视觉正在检查史莱姆元素及可见的其他敌人');
    const response=await fetchImpl('http://127.0.0.1:17646/read',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:'genshin-enemies',image}),signal:AbortSignal.any([signal||new AbortController().signal,AbortSignal.timeout(90000)])});
    if(!response.ok)throw Error('本地敌人类型检查失败');
    const scan=await response.json();signal?.throwIfAborted();
    if(scan.source_image!==image||scan.mode!=='genshin-enemies'||scan.normalization_error||scan.verification!=='unverified_local_model_output'||!scan.parsed||createHash('sha256').update(fs.readFileSync(image)).digest('hex')!==captured.sha256)throw Error('敌人检查与当前截图不一致');
    result.enemyScan=scan.parsed;
  }
  fs.writeFileSync(path.join(folder,'observation.json'),JSON.stringify(result,null,2));return result;
}
async function observe(options={}){
  for(let attempt=0;attempt<2;attempt++){
    try{return await observeOnce(attempt?{...options,receipt:undefined}:options);}catch(error){
      options.signal?.throwIfAborted();
      if(attempt||!/视觉返回格式无效|敌人检查与当前截图不一致/.test(error.message))throw error;
      options.reportProgress?.('retrying-observation','本地识别格式错误，自动重新截图再识别一次，继续原目标');
    }
  }
}
module.exports={observe,reusableCapture};
