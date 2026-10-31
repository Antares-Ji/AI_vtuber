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
test('cloud map provenance still requires exact current pixel candidates',()=>{
 const {groundedMapObservation}=require('../src/sts2/native-autonomy');
 const result={parsed:{scene:'map',targets:[{id:'N1',label:'事件',point:[410,509],grounding:'local_cv_cloud_vlm',directly_connected:true}],map_grounding:{source:'local_cv_cloud_vlm',marker_id:'R1',marker_point:[412,630]}},pixel_candidates:{red:[{id:'R1',point:[412,630]}],dark:[{id:'N1',point:[410,509]}]}};
 assert.equal(groundedMapObservation(result).targets[0].id,'N1');
 result.parsed.targets[0].point=[500,500];assert.throws(()=>groundedMapObservation(result),/地图/);
});
