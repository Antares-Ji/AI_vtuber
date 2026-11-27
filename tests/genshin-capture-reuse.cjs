const test=require('node:test'),assert=require('node:assert/strict');
const {reusableCapture}=require('../src/genshin/bridge-observe');
test('only the latest released command may supply a fresh after image',()=>{
 const receipt={id:'job',session:'session',state:'returned',inputReleased:true,processStopped:true,finishedAt:100,captures:[{name:'after.png'}]};
 const status={lastResult:{id:'job'},session:'session'};
 assert.equal(reusableCapture(receipt,status,110000),true);
 for(const patch of [{inputReleased:false},{processStopped:false},{state:'error'},{finishedAt:70},{finishedAt:111},{id:'old'},{session:'old'},{captures:[]}])assert.equal(reusableCapture({...receipt,...patch},status,110000),false);
});
test('malformed local inference triggers one fresh capture, never attacks or reuses the bad frame',async t=>{
 const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),{createHash}=require('node:crypto');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-observe-retry-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const frame=path.join(root,'frame.png'),bytes=Buffer.from('test-owned-capture');fs.writeFileSync(frame,bytes);let captures=0,reads=0;
 const bridge={start:async()=>{},status:()=>({}),evidence:()=>frame,execute:async command=>{assert.equal(command.operation,'capture');captures++;return {id:'capture'+captures,session:'session',finishedAt:Date.now()/1000,captures:[{name:'after.png',sha256:createHash('sha256').update(bytes).digest('hex')}]};}};
 const context={module:{exports:{}},__dirname:path.join(__dirname,'../src/genshin'),Buffer,AbortController,AbortSignal,Date,require:n=>n==='./bridge'?bridge:n==='./combat-policy'?{readPolicy:()=>null}:n==='./observe'?require('../src/genshin/observe'):require(n)};
 vm.createContext(context);vm.runInContext(fs.readFileSync(path.join(__dirname,'../src/genshin/bridge-observe.js'),'utf8'),context);
 const images=[];
 const result=await context.module.exports.observe({root,fetchImpl:async(url,options)=>{
  if(url.endsWith('/health'))return {json:async()=>({ready:true,busy:false,provider:'local',genshinSceneSupport:true})};
  const image=JSON.parse(options.body).image;images.push(image);reads++;
  return {ok:true,json:async()=>({source_image:image,mode:'genshin-scene',model:'local-test',verification:'unverified_local_model_output',normalization_error:reads===1?'truncated':null,parsed:reads===1?null:{scene:'world',summary:'world',visible_text:[],uncertain:false}})};
 }});
 assert.equal(captures,2);assert.equal(reads,2);assert.notEqual(images[0],images[1]);assert.equal(result.capture.bridgeId,'capture2');
});
