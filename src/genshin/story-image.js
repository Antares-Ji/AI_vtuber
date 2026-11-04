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
module.exports={enabled,load,eligible};
