'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
function enabled(root){
 const file=path.join(root,'data/genshin.local.json');
 if(!fs.existsSync(file))return false;
 const c=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 return c.provider==='deepseek'&&c.storyImageAssistance?.enabled===true&&c.storyImageAssistance?.provider==='deepseek';
}
function load(frame,root,now=Date.now()){
 if(!enabled(root))throw Error('未启用原神DeepSeek截图辅助');
 if(!frame||frame.source!=='bettergi_owned_capture'||!Number.isInteger(frame.seq)||!Number.isFinite(frame.capturedAt)||now-frame.capturedAt<0||now-frame.capturedAt>90000)throw Error('BGI截图来源或时间无效');
 const directory=fs.realpathSync(path.join(root,'runtime/genshin/observations'));
 const file=fs.realpathSync(frame.path),relative=path.relative(directory,file);
 if(relative.startsWith('..')||path.isAbsolute(relative)||path.basename(file)!=='frame.png')throw Error('只能发送本会话BGI观察目录中的截图');
 const stat=fs.statSync(file);if(stat.size<24||stat.size>12*1024*1024)throw Error('BGI截图大小无效');
 const bytes=fs.readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex');
 if(hash!==frame.sha256||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('BGI截图哈希或PNG格式无效');
 return {url:'data:image/png;base64,'+bytes.toString('base64'),evidence:{source:frame.source,provider:'deepseek',model:'deepseek-flash',seq:frame.seq,capturedAt:frame.capturedAt,sha256:hash,bytes:bytes.length}};
}
function eligible(observation){return ['world','menu','unknown'].includes(observation?.scene);}
function copyTrackingFrames(request,source,root){
 const last=request.lastStep;let detail;try{detail=JSON.parse(last?.detail);}catch{return [];}
 if(!enabled(root)||last?.seq!==request.seq-1||last.action?.kind!=='key'||last.action.key!=='V'||detail?.kind!=='quest_tracking_refresh'||detail.inputSent!==true||!detail.samples?.length)return [];
 if(!Array.isArray(detail.samples)||detail.samples.length>2)throw Error('无效的追踪连续截图');
 const directory=fs.realpathSync(path.dirname(source)),frames=[];let lastTime=0;
 for(const sample of detail.samples){
  if(![500,1500].includes(sample.offsetMs)||sample.image!==`tracking-${last.seq}-${sample.offsetMs}.png`||!Number.isFinite(sample.capturedAt)||sample.capturedAt<=lastTime||sample.capturedAt>request.capturedAt||request.capturedAt-sample.capturedAt>10000)throw Error('追踪截图序列或时间无效');
  const input=fs.realpathSync(path.join(directory,sample.image));
  if(path.dirname(input)!==directory)throw Error('追踪截图必须来自同一BGI脚本目录');
  const stat=fs.statSync(input);if(stat.size<24||stat.size>12*1024*1024)throw Error('追踪截图大小无效');
  const bytes=fs.readFileSync(input);if(bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('追踪截图不是PNG');
  const output=path.join(root,'runtime/genshin/observations',require('node:crypto').randomUUID(),'frame.png');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,bytes);
  frames.push({path:output,sha256:createHash('sha256').update(bytes).digest('hex'),source:'bettergi_owned_capture',seq:last.seq,capturedAt:sample.capturedAt,offsetMs:sample.offsetMs});lastTime=sample.capturedAt;
 }
 return frames;
}
function loadSequence(current,frames,root){
 if(!Array.isArray(frames)||frames.length>2)throw Error('追踪辅助截图最多两张');
 let at=0;
 const pictures=frames.map(frame=>{
  if(frame.seq!==current.seq-1||frame.capturedAt<=at||frame.capturedAt>current.capturedAt||current.capturedAt-frame.capturedAt>10000)throw Error('辅助截图必须来自紧邻的追踪动作');
  at=frame.capturedAt;return load(frame,root);
 });
 pictures.push(load(current,root));
 if(pictures.reduce((n,p)=>n+p.evidence.bytes,0)>24*1024*1024)throw Error('截图序列总大小超限');
 return pictures;
}
// Compare only the immediately preceding owned observation with its completed
// action. This is visual feedback, never a substitute for the current frame.
function previousActionFrame(previous,request,observation){
 const last=request.lastStep;
 if(!previous||previous.observation?.scene!=='world'||observation?.scene!=='world'||
    previous.request?.id!==request.id||previous.request.seq!==request.seq-1||
    last?.seq!==previous.request.seq||!Number.isFinite(last.finishedAt)||
    last.finishedAt<previous.request.capturedAt||last.finishedAt>request.capturedAt||
    request.capturedAt-previous.request.capturedAt>30000||
    JSON.stringify(last.action)!==JSON.stringify(previous.decision?.action))return null;
 return {path:previous.image,sha256:previous.sha256,source:'bettergi_owned_capture',
  nativeId:request.id,seq:previous.request.seq,capturedAt:previous.request.capturedAt,
  completedAction:last.action,finishedAt:last.finishedAt};
}
function loadActionPair(current,previous,root){
 if(!previous)return loadSequence(current,[],root);
 if(!current.nativeId||previous.nativeId!==current.nativeId||previous.seq!==current.seq-1||
    previous.capturedAt>=current.capturedAt||current.capturedAt-previous.capturedAt>30000||
    !Number.isFinite(previous.finishedAt)||previous.finishedAt<previous.capturedAt||previous.finishedAt>current.capturedAt)
  throw Error('动作对照截图必须来自同一原生运行的相邻已完成动作');
 const pictures=[load(previous,root),load(current,root)];
 if(pictures.reduce((n,p)=>n+p.evidence.bytes,0)>24*1024*1024)throw Error('截图序列总大小超限');
 return pictures;
}
module.exports={enabled,load,eligible,copyTrackingFrames,loadSequence,previousActionFrame,loadActionPair};
