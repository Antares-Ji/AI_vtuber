'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),os=require('node:os'),path=require('node:path');

test('runtime overlaps a speculative call, consumes a match without another foreground call, and replans on menu transition',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-pipeline-'));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 fs.mkdirSync(path.join(root,'data'));fs.writeFileSync(path.join(root,'data/genshin.local.json'),'{"provider":"deepseek"}');
 const bridge=require('../src/genshin/bridge'),waypoints=require('../src/genshin/story-waypoints'),install=require('../src/genshin/installation'),memory=require('../src/genshin/story-memory'),workers=require('../src/genshin/story-workers');
 const originals={start:bridge.start,execute:bridge.execute,load:waypoints.loadWaypoints,installation:install.installation,memory:memory.readQuestMemory,call:workers.call,fetch:global.fetch};
 t.after(()=>{bridge.start=originals.start;bridge.execute=originals.execute;waypoints.loadWaypoints=originals.load;install.installation=originals.installation;memory.readQuestMemory=originals.memory;workers.call=originals.call;global.fetch=originals.fetch;delete require.cache[require.resolve('../src/genshin/story-runtime')];});
 bridge.start=async()=>({ready:true});waypoints.loadWaypoints=()=>[];install.installation=()=>({directory:root});
 memory.readQuestMemory=()=>({quest:'紧急修理',details:['紧急修理'],source:'simulated-menu-evidence',at:Date.now(),verification:'historical_bettergi_ocr_recheck_current_step'});
 const calls=[],actions=[];let scene='world',prefetchStarted=0;
 const reply=(value,role)=>({text:JSON.stringify(value),provider:'deepseek',model:'mock-flash',worker:role,usage:{total_tokens:100},requestPolicy:{thinking:'disabled',maxOutputTokens:256}});
 workers.call=async(c,o)=>{
  calls.push({role:o.role,speculative:Boolean(o.forecast)});
  if(o.forecast){prefetchStarted++;assert.equal(o.forecast.basis,'hypothetical_post_action');assert.equal(c.texts.length,0);return reply({action:{kind:'move',key:'W',ms:400},prediction:{distance:96,tolerance:1}},o.role);}
  return reply(o.role==='movement'?{action:{kind:'move',key:'W',ms:400},prediction:{distance:98,tolerance:1},commentary:'应被静音'}:{action:{kind:'stop'},reason:'菜单状态变化'},o.role);
 };
 global.fetch=async()=>{throw Error('Story must not call Qwen or another visual model');};
 bridge.execute=async(command,{onStoryFrame})=>{
  assert.equal(command.operation,'story');let lastStep=null;
  const source=path.join(root,'simulation-frame.png');fs.writeFileSync(source,'simulation fixture, never a live capture');
  for(let seq=1;seq<=3;seq++){
   scene=seq===3?'menu':'world';
   const request={id:'simulation-native',seq,capturedAt:Date.now(),deadlineAt:Date.now()+100000,lastStep,nativeVision:{source:'bettergi_native_cv',ui:scene==='world'?'Main':'Unknown',motion:'Normal',closable:scene==='menu'},
    texts:scene==='world'?[{text:'前去查看详情',box:[75,246,153,33]},{text:(seq===1?'100':'98')+'m',box:[80,280,70,25]}]:[{text:'派蒙',box:[50,50,100,30]}]};
   const decision=await onStoryFrame(request,source);actions.push(decision.action.kind);assert.equal(decision.commentary,'');
   assert.equal(decision.nextObservationDelayMs,seq<3?100:400);
   if(seq===1)assert.equal(prefetchStarted,1,'next planning has started before current native action finishes');
   lastStep={seq,action:decision.action,finishedAt:Date.now(),detail:JSON.stringify({movedMs:400,stopReason:'duration_complete'}),focus:{after:true}};
   // Represents the current native action running while the HTTP planner completes.
   await new Promise(resolve=>setImmediate(resolve));
  }
  return {id:'simulation-native',inputReleased:true,processStopped:true,receipt:{id:'simulation-native',steps:[lastStep]}};
 };
 delete require.cache[require.resolve('../src/genshin/story-runtime')];
 const runtime=require('../src/genshin/story-runtime');
 const result=await runtime.runStory('继续当前任务',{root,env:{},signal:new AbortController().signal,runId:'simulation-run'});
 assert.deepEqual(actions,['move','move','stop']);
 assert.deepEqual(calls.filter(c=>!c.speculative).map(c=>c.role),['movement','interaction']);
 assert.equal(result.history[1].pipeline.lookahead.ok,true);assert.equal(result.history[2].pipeline.lookahead.reason,'scene_or_interaction_changed');
 assert.equal(result.history[0].modelCalls.filter(c=>c.phase==='lookahead').length,1);
 assert.equal(runtime.commentary(),null);assert.equal(result.verified,false);
});
