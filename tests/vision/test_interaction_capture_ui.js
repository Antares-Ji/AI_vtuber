const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
async function test(shared) {
  const calls=[],nodes={};
  for(const id of ['preview','mouse-window','mouse-start','mouse-stop','mouse-status','mouse-results','mouse-refresh','mouse-confirm','page-entry'])
    nodes[id]={value:'1',checked:true,addEventListener(e,fn){this[e]=fn;},replaceChildren(){},append(){}};
  Object.assign(nodes.preview,{srcObject:shared?{getVideoTracks:()=>[{readyState:'live'}]}:null,videoWidth:800,videoHeight:600,readyState:2});
  const context={Date,Math,Promise,JSON,Error,AbortSignal,
    localStorage:{getItem(){return null;},setItem(){}},window:{addEventListener(){}},
    setTimeout(){},clearTimeout(){},setInterval(){},clearInterval(){},
    document:{getElementById:id=>nodes[id],createElement:()=>({append(){},getContext:()=>({drawImage(){}})})},
    fetch:async url=>{calls.push(url);return {ok:true,json:async()=>url.endsWith('/stop')?
      {id:'test',entryLabel:'设置',frames:[],analysis:[]} : url.includes('/events')?{status:'recording',events:[]}:{id:'test'}};}
  };
  vm.createContext(context);await vm.runInContext(`(async()=>{${fs.readFileSync('public/interaction-capture.js','utf8')}\n})()`,context);
  await nodes['mouse-start'].click();
  if(!shared){assert.equal(calls.length,0);return;}
  await nodes['mouse-stop'].click();
  assert(calls.findIndex(c=>c.endsWith('/pause'))<calls.findIndex(c=>c.endsWith('/stop')));
  assert.equal(nodes['mouse-start'].disabled,false);
}
(async()=>{await test(false);await test(true);console.log('Interaction UI: sharing prerequisite and pause-before-finalize passed.');})().catch(e=>{console.error(e);process.exitCode=1;});
