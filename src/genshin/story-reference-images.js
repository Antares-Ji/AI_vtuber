'use strict';
const fs=require('node:fs'),path=require('node:path'),{createHash}=require('node:crypto');
function eligible(context){
 const o=context.observation,ref=o?.walkthroughReference?.videoReference;
 return o?.scene==='world'&&!o.uncertain&&!context.trackingFrames?.length&&Number.isInteger(context.frameImage?.seq)&&context.frameImage.seq%8===1&&
  /返回.*旗舰.*休息/.test(o.travelQuest?.hud?.stage||'')&&ref?.source==='external_walkthrough_frames_not_current_game'&&Array.isArray(ref.frames)&&ref.frames.length===2;
}
function load(root,reference){
 const directory=fs.realpathSync(path.join(root,'runtime/genshin/references'));
 if(!Array.isArray(reference?.frames)||reference.frames.length!==2)throw Error('参考帧必须为两张');
 return reference.frames.map(frame=>{
  if(typeof frame.file!=='string'||!Number.isFinite(frame.sourceSecond)||!/^[a-f0-9]{64}$/.test(frame.sha256||''))throw Error('参考帧元数据无效');
  const file=fs.realpathSync(path.resolve(directory,frame.file)),relative=path.relative(directory,file);
  if(relative.startsWith('..')||path.isAbsolute(relative)||path.extname(file)!=='.png')throw Error('参考帧必须位于攻略参考目录');
  const size=fs.statSync(file).size;if(size<24||size>6*1024*1024)throw Error('参考帧大小无效');
  const bytes=fs.readFileSync(file),hash=createHash('sha256').update(bytes).digest('hex');
  if(hash!==frame.sha256||bytes.subarray(0,8).toString('hex')!=='89504e470d0a1a0a')throw Error('参考帧PNG或哈希不符');
  return {url:'data:image/png;base64,'+bytes.toString('base64'),evidence:{source:'external_walkthrough_reference',referenceOnly:true,url:reference.url,sourceSecond:frame.sourceSecond,sha256:hash,bytes:bytes.length}};
 });
}
module.exports={eligible,load};
