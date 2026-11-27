'use strict';
const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {settings,publicSettings,respond}=require('../src/genshin/openai');
const {redact}=require('../src/genshin/installation');
function fixture(t){const dataRoot=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-openai-'));t.after(()=>fs.rmSync(dataRoot,{recursive:true,force:true}));return {dataRoot,env:{}};}
test('OpenAI config never reuses legacy DeepSeek key or untrusted origins',t=>{
 const o=fixture(t);assert.equal(settings({...o,env:{OPENAI_API_KEY:'ds-secret',OPENAI_BASE_URL:'https://api.deepseek.com'}}).key,'');
 fs.writeFileSync(path.join(o.dataRoot,'.env.openai.local'),'OPENAI_API_KEY="openai-secret"\nOPENAI_MODEL=gpt-6-astra\nOPENAI_BASE_URL=https://untrusted.invalid\n');
 assert.equal(settings(o).url,'https://api.openai.com/v1/responses');assert.equal(settings(o).key,'openai-secret');assert.equal(JSON.stringify(publicSettings(o)).includes('openai-secret'),false);
});
test('billing failure has safe actionable message, no retry or fallback',async t=>{
 const o=fixture(t);o.env={GENSHIN_OPENAI_API_KEY:'private-key'};let calls=0;
 await assert.rejects(respond('test',{...o,fetchImpl:async()=>{calls++;return {ok:false,status:429,json:async()=>({error:{code:'billing_not_active',message:'private-key'}})};}}),e=>e.code==='billing_not_active'&&!e.message.includes('private-key'));
 assert.equal(calls,1);
});
test('cancelled and incomplete responses cannot become valid plans',async t=>{
 const o=fixture(t);o.env={GENSHIN_OPENAI_API_KEY:'fake'};const c=new AbortController();
 await assert.rejects(respond('test',{...o,signal:c.signal,fetchImpl:async()=>{c.abort(Error('stopped'));return{ok:true,json:async()=>({status:'completed'})};}}),/stopped/);
 await assert.rejects(respond('test',{...o,fetchImpl:async()=>({ok:true,json:async()=>({status:'incomplete'})})}),/完整结束/);
});
test('BetterGI configuration masks nested credentials',()=>{
 assert.deepEqual(redact({notification:{webhook:'secret'},model:{apiKey:'secret'},pathingConditionConfig:{mapMatchingMethod:'TemplateMatch'}}),{notification:{webhook:'[已隐藏]'},model:{apiKey:'[已隐藏]'},pathingConditionConfig:{mapMatchingMethod:'TemplateMatch'}});
});
