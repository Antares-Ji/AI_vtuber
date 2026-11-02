'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),vm=require('node:vm');
const source=fs.readFileSync(require.resolve('../scripts/genshin/story-main'),'utf8');
const mapRows=[{text:'53/200',box:[1512,30,99,31]},
 {text:'苍风高地',box:[1682,985,111,36]},
 {text:'探索度 23%',box:[1670,1020,123,29]}];
async function run(action,options={}){
 let now=1000,active=options.initialActive!==false,deadline=0,ensures=0;
 const inputs=[],releases=[],requests=[],files=new Map([['command.json',JSON.stringify({id:'focus',timeoutMs:600000})]]);
 const state={inputs,releases,get now(){return now;},set now(v){now=v;},
  get active(){return active;},set active(v){active=v;},get deadline(){return deadline;}};
 const context={JSON,Number,String,Math,Set,Error,Date:{now:()=>now},
  file:{readTextSync:n=>files.get(n),writeImageSync(){},readImageMatSync:()=>({dispose(){}}),
   writeTextSync(n,v){files.set(n,v);if(n==='story-request.json'){
    const r=JSON.parse(v);deadline=r.deadlineAt;requests.push(r);
    files.set(`story-decision-${r.seq}.json`,JSON.stringify({...options.decisionFields,id:r.id,seq:r.seq,action:r.seq===1?action:{kind:'stop'}}));
   }}},
  captureGameRegion(){const rows=options.rows?.(state)||[];return {width:1920,height:1080,srcMat:{},dispose(){},
   findMulti(ro){const found=ro.template?[]:rows;return {count:found.length,...found.map(t=>({text:t.text,x:t.box[0],y:t.box[1],width:t.box[2],height:t.box[3],click(){inputs.push(['click',t.text]);}}))};}};},
  RecognitionObject:{ocr:()=>({}),templateMatch:()=>({template:true})},
  dispatcher:{clearAllTriggers(){},async runTask(){inputs.push(['fight']);}},SoloTask:function(){},
  genshin:{async tp(){inputs.push(['teleport']);}},log:{info(){},error(){}},
  keyDown(k){inputs.push(['down',k]);},keyUp(k){releases.push(k);},
  moveMouseBy(x,y){inputs.push(['move',x,y]);},middleButtonClick(){inputs.push(['middle']);},
  async sleep(ms){
   // Model the competing timeout as pending; immediate sleep mocks would
   // incorrectly race focus acquisition. No timer keeps Node alive here.
   if(ms===1500){if(options.focusTimeout){now+=ms;return;}return new Promise(()=>{});}
   now+=ms;await options.onSleep?.(ms,state);
  },
  isGameActive:()=>active,
  async ensureGameFocus(){ensures++;return options.ensure?options.ensure(state):true;},
 };
 if(options.missing)delete context[options.missing];
 if(options.nonCallable)context[options.nonCallable]={};
 await vm.runInNewContext(source,context);
 return {...state,ensures,requests,receipt:JSON.parse(files.get('receipt.json'))};
}
test('fast navigation removes 300ms of fixed frame delay, and invalid cadence values retain the normal delay',async()=>{
 for(const nextObservationDelayMs of [undefined,100,0,-1,1]){
  const result=await run({kind:'move',key:'W',ms:200},{decisionFields:{nextObservationDelayMs}});
  assert.equal(result.receipt.state,'returned');
  assert.equal(result.requests[1].capturedAt-result.requests[0].capturedAt,nextObservationDelayMs===100?300:600);
  assert.equal(result.inputs.filter(i=>i[0]==='down').length,1);
 }
});
test('missing, refused and timed-out focus fail closed with durable failure evidence',async()=>{
 for(const options of [{missing:'ensureGameFocus'},{missing:'isGameActive'},
  {nonCallable:'ensureGameFocus'},{nonCallable:'isGameActive'},
  {ensure:()=>false},{focusTimeout:true,ensure:()=>new Promise(()=>{})}]){
  const result=await run({kind:'key',key:'J'},options);
  assert.deepEqual(result.inputs,[]);
  assert.equal(result.receipt.state,'error');
  assert.match(result.receipt.errorCode,/^STORY_FOCUS_/);
  assert.equal(result.receipt.pendingInput.inputChecks,0);
  assert.ok(result.receipt.finishedAt);
 }
});
test('focus acquired after action deadline cannot send late input',async()=>{
 const result=await run({kind:'key',key:'J'},{ensure:s=>{s.now=s.deadline+1;return true;}});
 assert.deepEqual(result.inputs,[]);
 assert.equal(result.receipt.errorCode,'STORY_INPUT_EXPIRED');
 assert.equal(result.receipt.pendingInput.ensureResult,true);
});
test('lost focus during a segmented move prevents the next press and releases the first',async()=>{
 const result=await run({kind:'move',key:'W',ms:600},{onSleep(ms,s){if(ms===400&&s.inputs.length)s.active=false;}});
 assert.deepEqual(result.inputs,[['down','VK_W']]);
 assert.ok(result.releases.includes('VK_W'));
 assert.equal(result.receipt.errorCode,'STORY_FOCUS_LOST');
 assert.equal(result.receipt.pendingInput.after,false);
});
test('deadline expiry during an action wait prevents later input but not releases',async()=>{
 const result=await run({kind:'move',key:'W',ms:600},{onSleep(ms,s){if(ms===400&&s.inputs.length)s.now=s.deadline;}});
 assert.deepEqual(result.inputs,[['down','VK_W']]);
 assert.ok(result.releases.includes('VK_W'));
 assert.equal(result.receipt.errorCode,'STORY_INPUT_EXPIRED');
});
test('successful action records focus before and after acquisition and execution',async()=>{
 const result=await run({kind:'key',key:'J'},{initialActive:false,ensure:s=>{s.active=true;return true;}});
 assert.deepEqual(result.inputs,[['down','VK_J']]);
 assert.equal(result.receipt.state,'returned');
 assert.equal(result.receipt.steps[0].focus.before,false);
 assert.equal(result.receipt.steps[0].focus.after,true);
 assert.equal(result.receipt.steps[0].focus.inputChecks,1);
 assert.equal(result.receipt.pendingInput,undefined);
});
test('observation and non-input decisions do not activate the game',async()=>{
 for(const action of [{kind:'wait'},{kind:'complete_quest',quest:'test'},
  {kind:'list_waypoints',area:'test'},{kind:'stop'}]){
  const result=await run(action,{initialActive:false});
  assert.equal(result.ensures,0);assert.deepEqual(result.inputs,[]);
  assert.equal(result.receipt.state,'returned');
 }
});
test('a map present before following prevents all camera and navigation input',async()=>{
 const result=await run({kind:'follow_marker'},{rows:()=>mapRows});
 assert.deepEqual(result.inputs,[]);
 const detail=JSON.parse(result.receipt.steps[0].detail);
 assert.equal(detail.stopReason,'map');assert.equal(detail.cameraReset,false);
});
test('map appearing during follow does not receive a camera reset click',async()=>{
 const result=await run({kind:'follow_marker'},{rows:s=>s.inputs.some(i=>i[1]==='VK_V')?mapRows:[]});
 assert.deepEqual(result.inputs,[['move',0,7000],['down','VK_V']]);
 assert.equal(JSON.parse(result.receipt.steps[0].detail).stopReason,'map');
 assert.equal(JSON.parse(result.receipt.steps[0].detail).cameraReset,false);
});
