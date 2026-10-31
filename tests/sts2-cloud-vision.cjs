const test=require('node:test'),assert=require('node:assert/strict');
const {readCloudVision}=require('../src/sts2/cloud-vision.cjs');
const input={prompt:'Read the card as JSON',image:'data:image/jpeg;base64,/9j/AA==',maxTokens:350};
const config={url:'https://api.deepseek.com/chat/completions',key:'test-placeholder'};
const reply=(content='{"cards":[]}',finish='stop')=>new Response(JSON.stringify({model:'deepseek-flash',choices:[{finish_reason:finish,message:{content}}],usage:{completion_tokens:6}}));
test('cloud perception sends images with bounded non-thinking JSON and keeps transport read-only',async()=>{
 const result=await readCloudVision(input,{config,fetch:async(url,options)=>{
  assert.equal(url,config.url);const body=JSON.parse(options.body);
  assert.equal(body.model,'deepseek-flash');assert.equal(body.thinking.type,'disabled');assert.equal(body.max_tokens,350);
  assert.equal(body.messages[0].content[1].image_url.url,input.image);
  assert.match(body.messages[0].content[0].text,/untrusted data/);assert.equal(body.tools,undefined);
  return reply();
 }});assert.equal(result.generatedTokens,6);assert.deepEqual(JSON.parse(result.raw),{cards:[]});
});
test('cloud perception rejects malformed images and non-official destinations before sending',async()=>{
 let calls=0;const fetch=async()=>{calls++;return reply()};
 for(const bad of [{...input,image:'https://example.com/a.jpg'},{...input,maxTokens:10000},{...input,prompt:''}])await assert.rejects(readCloudVision(bad,{config,fetch}));
 for(const url of ['https://example.com/chat/completions','https://api.deepseek.com/chat/completions?key=x','https://x@api.deepseek.com/chat/completions'])await assert.rejects(readCloudVision(input,{config:{...config,url},fetch}));
 assert.equal(calls,0);
});
test('cloud perception rejects truncated JSON and schema mismatch',async()=>{
 for(const [content,finish] of [['{"cards":[]}','length'],['not json','stop'],['[]','stop'],['null','stop']])await assert.rejects(readCloudVision(input,{config,fetch:async()=>reply(content,finish)}));
});
test('cloud failure reports status without leaking response content',async()=>{
 await assert.rejects(readCloudVision(input,{config,fetch:async()=>new Response('sensitive diagnostics',{status:401})}),{message:'DeepSeek vision HTTP 401'});
});
test('malformed model JSON gets one read-only retry but HTTP failures do not',async()=>{
 let count=0;
 const result=await readCloudVision(input,{config,fetch:async()=>++count===1?reply('{"cards":[]} trailing'):reply()});
 assert.equal(count,2);assert.equal(result.formatAttempts,2);
 count=0;await assert.rejects(readCloudVision(input,{config,fetch:async()=>{count++;return new Response('error',{status:429});}}));assert.equal(count,1);
});
test('cloud map provenance still requires exact current pixel candidates',()=>{
 const {groundedMapObservation}=require('../src/sts2/native-autonomy');
 const result={parsed:{scene:'map',targets:[{id:'N1',label:'事件',point:[410,509],grounding:'local_cv_cloud_vlm',directly_connected:true}],map_grounding:{source:'local_cv_cloud_vlm',marker_id:'R1',marker_point:[412,630]}},pixel_candidates:{red:[{id:'R1',point:[412,630]}],dark:[{id:'N1',point:[410,509]}]}};
 assert.equal(groundedMapObservation(result).targets[0].id,'N1');
 result.parsed.targets[0].point=[500,500];assert.throws(()=>groundedMapObservation(result),/地图/);
});
test('drag reuses the existing pointer only after same-frame named visual confirmation',async()=>{
 const {NativeAutonomy}=require('../src/sts2/native-autonomy');
 for(const patch of [{}, {anchor_confirmed:false}, {anchor_card_name:'另一张'}, {target_center:[.5,.8]}]){
  let frames=0,plans=0,checks=0;const sent=[];
  const base={scene:'battle',energy:1,targets:[{id:'card',kind:'card',label:'打击',point:[400,900],card:{name:'打击',cost:1}},{id:'enemy',kind:'enemy',label:'敌人',point:[700,500]}]};
  const agent=new NativeAutonomy({pause:async()=>{},decide:async()=>++plans===1?{kind:'hover',targetId:'card'}:{kind:'drag',fromId:'inspected-2',targetId:'enemy'},request:async(route,body)=>{
   if(route==='vision-state')return {ready:true,sceneSupport:true};
   if(route==='read-card'){
    if(body.anchor){checks++;assert.equal(body.frameId,'2');assert.deepEqual(body.anchor,{point:[.4,.9],cardName:'打击'});return {parsed:{target_visible:true,anchor_confirmed:true,anchor_card_name:'打击',target_center:[.4,.9],...patch}};}
    if(body.target)return {parsed:{target_visible:true,target_center:[.4,.65]}};
    if(body.mode==='card')return {parsed:{cards:[{name:'打击',cost:1,type:'攻击',description:'造成6点伤害。'}],uncertain:false}};
    if(body.mode==='energy')return {parsed:{energy:1}};
    if(body.mode==='battle')return {parsed:{...base,targets:[base.targets[1]]}};
    if(body.mode==='hand')return {parsed:{...base,targets:frames===1?[base.targets[0]]:[]}};
    return {parsed:base};
   }
   if(body.kind==='capture')return {id:String(++frames),status:'captured_only'};
   sent.push(body);return {id:'input',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:2});await agent.task;assert.equal(agent.state.stage,'step-limit',agent.state.lastError);assert.equal(checks,1);
  if(!Object.keys(patch).length){assert.equal(sent[1].kind,'drag');assert.deepEqual(sent[1].from,[.4,.9]);}
  else assert.equal(sent[1].kind,'hover');
 }
});
