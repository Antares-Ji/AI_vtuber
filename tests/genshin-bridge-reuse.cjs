'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm');
const source=fs.readFileSync(path.join(__dirname,'../src/genshin/bridge.js'),'utf8');
function load(root,calls,handler,overrides={}){
  const context={module:{exports:{}},__dirname:path.join(root,'src/genshin'),process:{platform:'win32'},Date,Buffer,setTimeout,setInterval:()=>({unref(){}}),clearInterval(){},
    require:name=>overrides[name]||(name==='node:child_process'?{execFile:(exe,args,options,callback)=>{calls.push(args);if(handler)return handler(args,callback);callback(null,{stdout:'{"valid":true,"pid":42}'});}}:require(name))};
  vm.runInNewContext(source,context);return context.module.exports;
}
test('repeated connect and console reload reuse one authorized helper without invoking launcher',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bgi-reuse-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const session='11111111-1111-1111-1111-111111111111',base=path.join(root,'runtime/genshin/bridge'),folder=path.join(base,session);fs.mkdirSync(folder,{recursive:true});
 fs.writeFileSync(path.join(base,'current.json'),JSON.stringify({session}));fs.writeFileSync(path.join(folder,'heartbeat'),'1');fs.writeFileSync(path.join(folder,'status.json'),JSON.stringify({ready:true,busy:false,pid:42,supervisorVersion:6,heartbeatAt:Date.now()/1000}));
 const calls=[],first=load(root,calls);
 assert.equal((await first.start({root,reuseSession:session})).pid,42);assert.equal((await first.start({root,reuseSession:session})).pid,42);
 assert.equal((await load(root,calls).start({root,reuseSession:session})).pid,42);
 assert.equal(calls.length,2);assert.ok(calls.every(args=>args[0].endsWith('bridge-identify.py')));
});
test('story provider failure is retained after confirmed cleanup instead of being replaced by watchdog stop',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bgi-story-failure-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const session='11111111-1111-1111-1111-111111111111',base=path.join(root,'runtime/genshin/bridge'),folder=path.join(base,session);
 fs.mkdirSync(folder,{recursive:true});fs.writeFileSync(path.join(base,'current.json'),JSON.stringify({session}));fs.writeFileSync(path.join(folder,'heartbeat'),'1');
 fs.writeFileSync(path.join(folder,'status.json'),JSON.stringify({ready:true,busy:false,pid:42,supervisorVersion:8,heartbeatAt:Date.now()/1000}));
 fs.mkdirSync(path.join(root,'scripts/genshin/assets'),{recursive:true});
 for(const name of ['quest-marker.png','quest-marker-blue.png'])fs.writeFileSync(path.join(root,'scripts/genshin/assets',name),'fixture');
 let id,cleanupReads=0,decisions=0;
 const mockFs={...fs,
  renameSync:(a,b)=>{fs.renameSync(a,b);if(path.basename(b).startsWith('job-')){
   id=JSON.parse(fs.readFileSync(b)).id;const script=path.join(root,'User/JsScript','AI-VTuber-Bridge-'+id);fs.mkdirSync(script,{recursive:true});
   fs.writeFileSync(path.join(script,'story-request.json'),JSON.stringify({id,seq:1,image:'story-1.png'}));
  }},
  writeFileSync:(file,data)=>{fs.writeFileSync(file,data);if(path.basename(file).startsWith('cancel-'))fs.writeFileSync(path.join(folder,'result-'+id+'.json'),JSON.stringify({id,state:'stopped',error:'Stopped by director/watchdog'}));},
  readFileSync:(file,encoding)=>{
   if(path.basename(file).startsWith('result-')){cleanupReads++;return JSON.stringify({id,state:'stopped',error:'Stopped by director/watchdog',processStopped:cleanupReads>1,inputReleased:cleanupReads>1});}
   return fs.readFileSync(file,encoding);
  }};
 const bridge=load(root,[],null,{'node:fs':mockFs,'./installation':{installation:()=>({directory:root})},'./execution-status':{executionStatus:()=>({pid:42,scriptStarted:true})}});
 await bridge.start({root,reuseSession:session});
 await assert.rejects(bridge.execute({operation:'story'},{onStoryFrame:async()=>{decisions++;throw Object.assign(Error('DeepSeek HTTP 402：余额不足'),{code:'PROVIDER_INSUFFICIENT_BALANCE'});}}),e=>e.code==='PROVIDER_INSUFFICIENT_BALANCE'&&e.receipt.inputReleased&&e.receipt.processStopped);
 assert.equal(decisions,1);assert.equal(cleanupReads,2);assert.equal(bridge.status().active,null);
});
test('reuse-only failure never launches a replacement or leaves a stuck pending connection',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bgi-missing-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));const calls=[],bridge=load(root,calls);
 for(let i=0;i<2;i++)await assert.rejects(bridge.start({root,reuseSession:'11111111-1111-1111-1111-111111111111'}),/未请求提权/);
 assert.equal(calls.length,0);
});
test('dead stale busy owner with matching released receipt can be cleared without bypassing reuse-only',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'bgi-stale-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const session='11111111-1111-1111-1111-111111111111',id='22222222-2222-2222-2222-222222222222',base=path.join(root,'runtime/genshin/bridge'),folder=path.join(base,session);fs.mkdirSync(folder,{recursive:true});
 fs.writeFileSync(path.join(base,'current.json'),JSON.stringify({session}));fs.writeFileSync(path.join(folder,'heartbeat'),'1');
 fs.writeFileSync(path.join(folder,'status.json'),JSON.stringify({ready:true,busy:false,pid:42,heartbeatAt:Date.now()/1000}));
 fs.writeFileSync(path.join(folder,'result-'+id+'.json'),JSON.stringify({id,processStopped:true,inputReleased:true,finishedAt:Date.now()/1000}));
 let dead=false;const calls=[],bridge=load(root,calls,(args,cb)=>args.includes('--probe')?cb(null,{stdout:'{"alive":false}'}):dead?cb(Error('dead')):cb(null,{stdout:'{"valid":true,"pid":42}'}));
 await bridge.start({root,reuseSession:session});dead=true;
 fs.writeFileSync(path.join(folder,'status.json'),JSON.stringify({ready:true,busy:true,jobId:id,pid:42,heartbeatAt:0}));
 await assert.rejects(bridge.start({root,reuseSession:session}),/未请求提权/);
 assert.ok(calls.some(a=>a.includes('--probe')));assert.ok(calls.every(a=>a[0].endsWith('bridge-identify.py')));
});
test('focus pause notices are scoped to the owned job process',t=>{
 const {executionStatus}=require('../src/genshin/execution-status');const root=fs.mkdtempSync(path.join(os.tmpdir(),'bgi-log-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'log'));
 const id='11111111-1111-1111-1111-111111111111',file=path.join(root,'log/better-genshin-impact20261101.log');
 fs.writeFileSync(file,`[08:00:00.100] [INF] [Primary:S1:P42:T1] 开始AI-VTuber-Bridge-${id}\n[08:00:01.100] [WRN] [Primary:S1:P42:T1] 当前获取焦点的窗口为: ChatGPT，不是原神，暂停\n`);
 assert.equal(executionStatus(root,id).notice.stage,'paused-focus');
 fs.appendFileSync(file,'[08:00:02.100] [INF] [Primary:S1:P42:T1] 到达路径点附近\n');assert.equal(executionStatus(root,id,42).notice,null);
});
test('swallowed path parser failure is scoped to the job and child, not another process',t=>{
 const {executionFailure}=require('../src/genshin/execution-status');const root=fs.mkdtempSync(path.join(os.tmpdir(),'bgi-failure-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));fs.mkdirSync(path.join(root,'log'));
 const id='11111111-1111-1111-1111-111111111111',file=path.join(root,'log/better-genshin-impact20261101.log');
 fs.writeFileSync(file,`[08:00:00.100] [INF] [Primary:S1:P42:T1] 开始AI-VTuber-Bridge-${id}\n[08:00:01.100] [ERR] [Primary:S1:P88:T1]\n执行地图追踪时候发生错误: foreign\n`);
 assert.equal(executionFailure(root,id),null);
 fs.appendFileSync(file,'[08:00:02.100] [ERR] [Primary:S1:P42:T1]\n执行地图追踪时候发生错误: invalid action name\n');
 assert.match(executionFailure(root,id),/invalid action name/);
 assert.equal(executionFailure(root,'22222222-2222-2222-2222-222222222222'),null);
});
test('startup wait is tied to the owned job and cleared when its script receipt appears',t=>{
 const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-startup-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 const id='bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';fs.mkdirSync(path.join(root,'log'));
 fs.writeFileSync(path.join(root,'log/better-genshin-impact-test.log'),`[10:00:00.000] [Primary:S1:P111:T1] AI-VTuber-Bridge-${id}\n[10:00:01.000] [Primary:S1:P222:T2] 当前不在游戏主界面，等待进入主界面后执行任务...\n`);
 const {executionStatus}=require('../src/genshin/execution-status');assert.equal(executionStatus(root,id).notice,null);
 fs.appendFileSync(path.join(root,'log/better-genshin-impact-test.log'),'[10:00:02.000] [Primary:S1:P111:T1] 当前不在游戏主界面，等待进入主界面后执行任务...\n');
 assert.equal(executionStatus(root,id).notice.stage,'waiting-main-ui');
 const dir=path.join(root,'User/JsScript','AI-VTuber-Bridge-'+id);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'receipt.json'),JSON.stringify({id,state:'running'}));
 assert.equal(executionStatus(root,id).scriptStarted,true);assert.equal(executionStatus(root,id).notice,null);
 fs.appendFileSync(path.join(root,'log/better-genshin-impact-test.log'),'[10:00:03.000] [Primary:S1:P111:T1] 当前获取焦点的窗口为: ChatGPT，不是原神，暂停\n');
 assert.equal(executionStatus(root,id).scriptStarted,true);assert.equal(executionStatus(root,id).notice.stage,'paused-focus');
});
