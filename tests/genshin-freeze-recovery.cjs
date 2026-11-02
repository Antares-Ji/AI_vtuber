const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm'),path=require('node:path');
const code=fs.readFileSync(path.join(__dirname,'../scripts/genshin/bridge-main.js'),'utf8');
async function run(texts){
 let resolveTask,reads=0;const presses=[],receipts=[];
 const task=new Promise(resolve=>resolveTask=resolve);
 const context={Date,Math,Number,JSON,String,Error,RecognitionObject:{ocr:()=>({})},
 file:{readTextSync:name=>name==='command.json'?JSON.stringify({id:'test',operation:'task',task:'AutoFight'}):'',writeImageSync:()=>{},writeTextSync:(name,value)=>receipts.push(JSON.parse(value))},
 log:{info:()=>{},warn:()=>{}},dispatcher:{clearAllTriggers:()=>{},runTask:()=>task},SoloTask:function(){},keyPress:key=>presses.push(key),
 captureGameRegion:()=>({width:1920,height:1080,srcMat:{},dispose:()=>{},find:()=>({text:texts[Math.min(reads++,texts.length-1)]})}),
 sleep:async ms=>{if(reads>=texts.length)resolveTask();await new Promise(resolve=>setImmediate(resolve));}};
 await vm.runInNewContext(code,context);
 return {presses,result:receipts.at(-1)};
}
test('frozen reaction without a Space prompt and ordinary jump hints produce no input',async()=>{
 for(const text of ['冻结 伤害123','Space 跳跃','Space 冻结 复苏']){
  const r=await run([text]);assert.deepEqual(r.presses,[]);assert.equal(r.result.state,'returned');
 }
});
test('fresh local frozen+Space evidence triggers bounded presses and stops when prompt disappears',async()=>{
 const r=await run(['冻结 Space','冻结 Space','正常大世界']);
 assert.ok(r.presses.length>0&&r.presses.length<=6);assert.ok(r.presses.every(k=>k==='VK_SPACE'));
 assert.equal(r.result.state,'returned');assert.equal(r.result.freezeRecovery.verified,false);assert.equal(r.result.freezeRecovery.bursts,1);
});
