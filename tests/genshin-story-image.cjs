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
test('walkthrough frames are hash checked references; only the last BGI image is current',async t=>{
 const f=fixture(t),refs=require('../src/genshin/story-reference-images'),directory=path.join(f.root,'runtime/genshin/references');fs.mkdirSync(directory,{recursive:true});
 for(const n of [335,341])fs.writeFileSync(path.join(directory,n+'.png'),f.bytes);
 const reference={source:'external_walkthrough_frames_not_current_game',url:'https://example.org/guide',frames:[335,341].map(sourceSecond=>({file:sourceSecond+'.png',sourceSecond,sha256:f.frame.sha256}))};
 const c={observation:{...observation,travelQuest:{hud:{stage:'返回「旗舰」休息'}},walkthroughReference:{videoReference:reference}},texts:[],frameImage:f.frame};
 assert.equal(refs.eligible(c),true);assert.equal(refs.eligible({...c,trackingFrames:[{}]}),false);assert.equal(refs.eligible({...c,frameImage:{...f.frame,seq:2}}),false);
 let body;const fetchImpl=async(_,req)=>{body=JSON.parse(req.body);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"action":{"kind":"wait"}}'}}]})};};
 const answer=await workers.call(c,{...f,fetchImpl});
 assert.equal(answer.imageInput.sequenceKind,'walkthrough_reference');assert.deepEqual(answer.imageInput.sequence.map(e=>e.source),['external_walkthrough_reference','external_walkthrough_reference','bettergi_owned_capture']);
 assert.equal(answer.imageInput.sha256,f.frame.sha256);assert.equal(body.messages[1].content.filter(v=>v.type==='image_url').length,3);
 assert.match(body.messages[0].content,/第3张才是当前BGI画面/);assert.ok(!body.messages[0].content.includes('两张图依次是上一动作'));
 assert.ok(!JSON.stringify(answer).includes('base64'));
 assert.throws(()=>refs.load(f.root,{...reference,frames:reference.frames.map(r=>({...r,sha256:'0'.repeat(64)}))}),/哈希/);
 const outside=path.join(f.root,'outside.png');fs.writeFileSync(outside,f.bytes);
 assert.throws(()=>refs.load(f.root,{...reference,frames:[{...reference.frames[0],file:outside},reference.frames[1]]}),/目录/);
 fs.unlinkSync(path.join(directory,'335.png'));
 const fallback=await workers.call(c,{...f,fetchImpl});assert.ok(fallback.imageInput.referenceWarning);assert.equal(body.messages[1].content.filter(v=>v.type==='image_url').length,1);
});
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
 assert.equal(body.model,'deepseek-flash');assert.equal(body.max_tokens,640);assert.equal(body.thinking.type,'disabled');
 assert.equal(body.messages[1].content[1].type,'image_url');assert.equal(body.messages[1].content[1].image_url.detail,'original');
 assert.match(body.messages[0].content,/当前BGI截图/);assert.ok(!body.messages[0].content.includes('新的BGI原生脱困能力可用，优先'));
 assert.match(body.messages[0].content,/地面.*星光/);assert.match(body.messages[0].content,/一次key:V/);
 assert.match(body.messages[0].content,/先输出imageAssessment再输出action/);
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
test('tracking burst copies only adjacent owned samples and sends them chronologically before the current frame',async t=>{
 const f=fixture(t),native=path.join(f.root,'native-script');fs.mkdirSync(native);
 const now=Date.now(),samples=[500,1500].map((offsetMs,i)=>({image:`tracking-1-${offsetMs}.png`,offsetMs,capturedAt:now-3000+i*1000}));
 for(const sample of samples)fs.writeFileSync(path.join(native,sample.image),f.bytes);
 const request={seq:2,capturedAt:now,lastStep:{seq:1,action:{kind:'key',key:'V'},detail:JSON.stringify({kind:'quest_tracking_refresh',inputSent:true,samples})}};
 const frames=image.copyTrackingFrames(request,path.join(native,'story-2.png'),f.root);
 assert.equal(frames.length,2);assert.equal(frames[0].seq,1);
 const frame={...f.frame,seq:2,capturedAt:now};let body;
 const answer=await workers.call({observation,texts:[],frameImage:frame,trackingFrames:frames},{...f,fetchImpl:async(_,req)=>{body=JSON.parse(req.body);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"action":{"kind":"wait"}}'}}]})};}});
 assert.equal(body.messages[1].content.filter(v=>v.type==='image_url').length,3);
 assert.deepEqual(answer.imageInput.sequence.map(p=>p.capturedAt),[now-3000,now-2000,now]);
 assert.ok(!JSON.stringify(answer).includes('base64'));assert.match(body.messages[0].content,/固定灯带/);
 for(const changes of [{seq:3},{capturedAt:now+20000},{lastStep:{...request.lastStep,detail:JSON.stringify({kind:'quest_tracking_refresh',inputSent:true,samples:[{...samples[0],image:'../frame.png'}]})}}]){
  if(changes.seq)assert.deepEqual(image.copyTrackingFrames({...request,...changes},path.join(native,'story-2.png'),f.root),[]);
  else assert.throws(()=>image.copyTrackingFrames({...request,...changes},path.join(native,'story-2.png'),f.root));
 }
 assert.throws(()=>image.loadSequence(frame,[{...frames[0],seq:20}],f.root),/紧邻/);
 assert.throws(()=>image.loadSequence(frame,[frames[1],frames[0]],f.root),/紧邻/);
 assert.throws(()=>image.loadSequence(frame,[...frames,frames[0]],f.root),/最多/);
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
test('explicit system route is used before sending and failure is never replayed',async t=>{
 const f=fixture(t),config=JSON.parse(fs.readFileSync(f.config));config.deepseekNetworkRoute='system';fs.writeFileSync(f.config,JSON.stringify(config));
 let calls=0;const original=globalThis.fetch;t.after(()=>{globalThis.fetch=original;});
 globalThis.fetch=async url=>{calls++;assert.equal(url,'https://api.deepseek.com/chat/completions');throw Error('network test');};
 await assert.rejects(provider.respond('test',{dataRoot:f.root,env:f.env}),/network test/);assert.equal(calls,1);
});
test('action comparison includes only a matched adjacent completed input and labels the current image',async t=>{
 const f=fixture(t),now=Date.now(),action={kind:'turn',dx:300,dy:0};
 const previous={request:{id:'native-1',seq:1,capturedAt:now-5000},observation:{scene:'world'},decision:{action},image:f.frame.path,sha256:f.frame.sha256};
 const request={id:'native-1',seq:2,capturedAt:now,lastStep:{seq:1,action,finishedAt:now-500}};
 const frame=image.previousActionFrame(previous,request,observation);
 assert.equal(frame.seq,1);assert.deepEqual(frame.completedAction,action);
 for(const changes of [{id:'other-run'},{seq:3},{capturedAt:now+40000},{lastStep:{...request.lastStep,action:{kind:'wait'}}},{lastStep:{...request.lastStep,finishedAt:now+1}}])
  assert.equal(image.previousActionFrame(previous,{...request,...changes},observation),null);
 assert.equal(image.previousActionFrame(previous,request,{scene:'menu'}),null);
 let body;
 const current={...f.frame,nativeId:request.id,seq:2,capturedAt:now};
 const answer=await workers.call({observation,texts:[],frameImage:current,previousFrameImage:frame},{...f,fetchImpl:async(_,req)=>{body=JSON.parse(req.body);return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'{"action":{"kind":"wait"}}'}}]})};}});
 assert.equal(body.messages[1].content.filter(v=>v.type==='image_url').length,2);
 assert.match(body.messages[0].content,/上一动作执行前和执行后的当前BGI画面/);
 assert.ok(!body.messages[0].content.includes('前两张是同一次V追踪'));
 assert.equal(answer.imageInput.sequenceKind,'completed_action_pair');
 assert.deepEqual(answer.imageInput.sequence.map(p=>p.seq),[1,2]);
 assert.match(body.messages[1].content[0].text,/completedActionBetweenImages/);
 assert.throws(()=>image.loadActionPair({...current,nativeId:'other'},frame,f.root),/相邻/);
 assert.throws(()=>image.loadActionPair(current,{...frame,sha256:'changed'},f.root),/哈希/);
 assert.equal(image.loadActionPair(current,null,f.root).length,1);
});
