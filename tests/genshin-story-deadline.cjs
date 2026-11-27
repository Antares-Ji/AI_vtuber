const {test}=require('node:test'),assert=require('node:assert/strict'),vm=require('node:vm'),fs=require('node:fs');
const {frameBudget}=require('../src/genshin/story-deadline');
const {decideWithRepair}=require('../src/genshin/story-runtime');
test('vision, model and repair consume one deadline with ten seconds reserved',async()=>{
 let now=1000;const signal=new AbortController().signal;
 const b=frameBudget({capturedAt:1000,deadlineAt:121000},signal,()=>now);
 assert.equal(b.remaining(),110000);now+=90000;assert.equal(b.remaining(),20000);
 let calls=0;
 const result=await decideWithRepair(async()=>{calls++;now+=8000;return {text:'bad json',provider:'mock',usage:{total_tokens:10}};},{texts:[]},{scene:'world'},signal,b);
 assert.equal(calls,1);assert.equal(result.decision.action.kind,'wait');assert.equal(result.calls[0].usage.total_tokens,10);
 now=111001;assert.throws(()=>b.check(),{code:'STORY_FRAME_TIMEOUT'});
});
test('segment ending shortens frame deadline and cancellation wins',()=>{
 let now=1000;const c=new AbortController();
 const b=frameBudget({capturedAt:1000,deadlineAt:21000},c.signal,()=>now);assert.equal(b.remaining(),10000);
 c.abort();assert.throws(()=>b.check(),{name:'AbortError'});
 const short=frameBudget({capturedAt:1000,deadlineAt:5000},new AbortController().signal,()=>now);
 assert.equal(short.remaining(),0);assert.throws(()=>short.signal(),{code:'STORY_FRAME_TIMEOUT'});
});
test('a model answer arriving after shared budget never becomes a decision',async()=>{
 let now=1000;const signal=new AbortController().signal,b=frameBudget({capturedAt:1000},signal,()=>now);
 await assert.rejects(decideWithRepair(async()=>{now=120000;return {text:JSON.stringify({action:{kind:'key',key:'J'}})};},{texts:[]},{scene:'world'},signal,b),{code:'STORY_FRAME_TIMEOUT'});
});
test('native executor rejects decision that expires while being read',async()=>{
 let now=1000,inputs=0;const files=new Map([['command.json',JSON.stringify({id:'late',timeoutMs:600000})]]);
 const ctx={Date:{now:()=>now},JSON,Number,String,Math,Set,Error,
 file:{readTextSync(n){if(n.startsWith('story-decision'))now=130000;return files.get(n);},writeTextSync(n,v){files.set(n,v);if(n==='story-request.json'){const r=JSON.parse(v);files.set(`story-decision-${r.seq}.json`,JSON.stringify({id:r.id,seq:r.seq,action:{kind:'key',key:'J'}}));}},writeImageSync(){}},
 captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose(){},findMulti:()=>({count:0})}),RecognitionObject:{ocr:()=>({})},dispatcher:{clearAllTriggers(){}},log:{info(){}},sleep:async()=>{},keyDown:()=>inputs++,keyUp(){}};
 await vm.runInNewContext(fs.readFileSync(require.resolve('../scripts/genshin/story-main'),'utf8'),Object.assign({ensureGameFocus:async()=>true,isGameActive:()=>true},ctx));
 assert.equal(inputs,0);const r=JSON.parse(files.get('receipt.json'));assert.equal(r.state,'error');assert.match(r.error,/过期/);
});
