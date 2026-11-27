const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const provider=require('../src/genshin/model-provider');
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-provider-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'.env.openai.local'),'OPENAI_API_KEY=test-openai\n');fs.writeFileSync(path.join(root,'data/minecraft-engine.local.json'),JSON.stringify({deepseekApiKey:'test-deepseek'}));return {dataRoot:root,env:{}};}
test('manual provider changes select separate credentials and preserve installation config',async t=>{
 const options=fixture(t),file=path.join(options.dataRoot,'data/genshin.local.json');fs.writeFileSync(file,JSON.stringify({executable:'game',bettergiExecutable:'bgi'}));
 provider.selectProvider('deepseek',options);assert.equal(provider.settings(options).key,'test-deepseek');assert.equal(provider.publicSettings(options).fallback,false);
 let calls=[];
 const result=await provider.respond('连接测试',{...options,fetchImpl:async(url,request)=>{calls.push(url);assert.equal(request.headers.authorization,'Bearer test-deepseek');return {ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:'OK'}}],model:'deepseek-flash'})};}});
 assert.equal(result.provider,'deepseek');assert.deepEqual(calls,['https://api.deepseek.com/chat/completions']);
 provider.selectProvider('openai',options);assert.equal(provider.settings(options).key,'test-openai');assert.equal(JSON.parse(fs.readFileSync(file)).bettergiExecutable,'bgi');
 assert.throws(()=>provider.selectProvider('automatic',options));
});
test('DeepSeek failure never retries against OpenAI and hides server secret echo',async t=>{
 const options=fixture(t);provider.selectProvider('deepseek',options);let calls=0;
 await assert.rejects(provider.respond('test',{...options,fetchImpl:async url=>{calls++;assert.match(url,/api\.deepseek\.com/);return {ok:false,status:402,json:async()=>({error:{message:'test-deepseek secret'}})};}}),error=>!error.message.includes('test-deepseek')&&error.message.includes('余额不足')&&error.code==='PROVIDER_INSUFFICIENT_BALANCE'&&error.status===402);
 assert.equal(calls,1);
});
test('bridge rejects injected operations, arbitrary tasks and traversal before launch',()=>{
 const {validate}=require('../src/genshin/bridge');
 for(const a of [{operation:'shell'},{operation:'task',task:'Process.Start'},{operation:'path',routeId:'user:../config.json'},{operation:'capture',code:'evil'},{operation:'capture',timeoutMs:9999999}])assert.throws(()=>validate(a));
 assert.equal(validate({operation:'path',routeId:'user:route.json'}).timeoutMs,180000);
});
test('action planner accepts only observed scenes and installed routes',async t=>{
 const {planCommand}=require('../src/genshin/action-planner');const options=fixture(t);provider.selectProvider('deepseek',options);
 const observation={scene:'world',uncertain:false,summary:'世界场景',visible_text:[]},routes=[{id:'user:known.json',name:'known'}];
 const reply=value=>async()=>({ok:true,json:async()=>({choices:[{finish_reason:'stop',message:{content:JSON.stringify(value)}}]})});
 const valid=await planCommand('采集',{...options,observation,routes,fetchImpl:reply({operation:'path',task:'',routeId:'user:known.json',reason:'选择已安装路线'})});assert.equal(valid.provider,'deepseek');
 await assert.rejects(planCommand('采集',{...options,observation,routes,fetchImpl:reply({operation:'path',task:'',routeId:'user:invented.json',reason:'bad'})}),/未提供/);
 await assert.rejects(planCommand('采集',{...options,observation:{...observation,uncertain:true},routes,fetchImpl:()=>{throw Error('must not call model');}}),/本地视觉/);
});
