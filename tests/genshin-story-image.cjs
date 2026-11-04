'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),{createHash}=require('node:crypto');
const image=require('../src/genshin/story-image'),workers=require('../src/genshin/story-workers'),provider=require('../src/genshin/model-provider');
function fixture(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-image-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'data'));const config=path.join(root,'data/genshin.local.json');
 fs.writeFileSync(config,JSON.stringify({provider:'deepseek',storyImageAssistance:{enabled:true,provider:'deepseek'}}));
 const folder=path.join(root,'runtime/genshin/observations/frame-id');fs.mkdirSync(folder,{recursive:true});
 const bytes=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aX4QAAAAASUVORK5CYII=','base64');
 const file=path.join(folder,'frame.png');fs.writeFileSync(file,bytes);
 return {root,config,bytes,frame:{path:file,sha256:createHash('sha256').update(bytes).digest('hex'),seq:1,capturedAt:Date.now(),source:'bettergi_owned_capture'},env:{GENSHIN_DEEPSEEK_API_KEY:'test'}};
}
const observation={scene:'world',uncertain:false,interaction:{state:'none'},nativeTracking:{available:true},nativeRecovery:{available:true}};
test('only opted-in current owned PNG with matching hash can enter vision transport',t=>{
 const f=fixture(t);assert.equal(image.load(f.frame,f.root).evidence.sha256,f.frame.sha256);
 for(const frame of [{...f.frame,capturedAt:Date.now()-100000},{...f.frame,sha256:'wrong'},{...f.frame,source:'desktop'}])assert.throws(()=>image.load(frame,f.root));
 const outside=path.join(f.root,'frame.png');fs.writeFileSync(outside,f.bytes);assert.throws(()=>image.load({...f.frame,path:outside},f.root),/观察目录/);
 fs.writeFileSync(f.config,'{"provider":"deepseek"}');assert.throws(()=>image.load(f.frame,f.root),/未启用/);
});
test('live image uses DeepSeek Flash and reports hash without retaining image bytes in evidence',async t=>{
 const f=fixture(t),context={observation,texts:[],frameImage:f.frame};let body;
 const answer=await workers.call(context,{...f,fetchImpl:async(url,request)=>{
  body=JSON.parse(request.body);return {ok:true,json:async()=>({model:'deepseek-flash',choices:[{finish_reason:'stop',message:{content:'{"action":{"kind":"move","key":"A","ms":600},"reason":"右侧障碍，向左侧通道移"}'}}]})};
 }});
 assert.equal(body.model,'deepseek-flash');assert.equal(body.max_tokens,384);assert.equal(body.thinking.type,'disabled');
 assert.equal(body.messages[1].content[1].type,'image_url');assert.equal(body.messages[1].content[1].image_url.detail,'original');
 assert.match(body.messages[0].content,/当前BGI截图/);assert.ok(!body.messages[0].content.includes('新的BGI原生脱困能力可用，优先'));
 assert.equal(answer.imageInput.sha256,f.frame.sha256);assert.ok(!JSON.stringify(answer).includes('base64'));
});
test('forecast, dialogue and opt-out calls remain text-only',async t=>{
 const f=fixture(t);
 for(const variant of ['forecast','dialogue','disabled']){
  if(variant==='disabled')fs.writeFileSync(f.config,'{"provider":"deepseek"}');
  let body;const context={observation:variant==='dialogue'?{scene:'dialogue'}:observation,texts:[],frameImage:f.frame};
  const answer=await workers.call(context,{...f,...(variant==='forecast'?{forecast:{distance:10}}:{}),fetchImpl:async(_,req)=>{body=JSON.parse(req.body);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"action":{"kind":"wait"}}'}}]})};}});
  assert.equal(typeof body.messages[1].content,'string');assert.equal(answer.imageInput,null);
 }
});
test('image does not switch providers or bypass OCR interaction/completion validation',async t=>{
 const f=fixture(t);provider.selectProvider('openai',{dataRoot:f.root});
 await assert.rejects(provider.respond('x',{dataRoot:f.root,env:f.env,imageUrl:'data:image/png;base64,abc=',model:'deepseek-flash'}),/未切换供应商/);
 const {validateDecision}=require('../src/genshin/story-runtime');
 assert.throws(()=>validateDecision({action:{kind:'key',key:'F',text:'休息'}},{texts:[]},observation),/唯一/);
 assert.throws(()=>validateDecision({action:{kind:'complete_quest',quest:'任务'}},{texts:[],focusQuest:'任务'},observation),/完成文字/);
 assert.equal(image.eligible({scene:'menu'}),true);assert.equal(image.eligible({scene:'unknown'}),true);
 assert.throws(()=>validateDecision({action:{kind:'move',key:'W',ms:600}},{texts:[]},{scene:'unknown',uncertain:true}),/场景不确定/);
});
