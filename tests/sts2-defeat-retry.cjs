const test=require('node:test'),assert=require('node:assert/strict');
const {NativeAutonomy,actionFor}=require('../src/sts2/native-autonomy');
const defeat=()=>({scene:'terminal',terminal_outcome:'defeat',ocr_check:{status:'corroborated',scope:'terminal_defeat'},targets:[{id:'continue',label:'继续',point:[500,820],enabled:true,defeat_continue_checked:true}]});
test('terminal continuation is opt-in and allows only the corroborated continue click',()=>{
 const view={...defeat(),retry_after_defeat:true};
 assert.deepEqual(actionFor({kind:'click',targetId:'continue'},view),{kind:'click',to:[.5,.82]});
 for(const patch of [{retry_after_defeat:false},{terminal_outcome:'unknown'},{ocr_check:{}},{targets:[{...view.targets[0],defeat_continue_checked:false}]}])assert.throws(()=>actionFor({kind:'click',targetId:'continue'},{...view,...patch}));
 for(const kind of ['hover','drag','scroll','key'])assert.throws(()=>actionFor({kind,targetId:'continue'},view));
});
test('start authorization is bounded and vision JSON cannot grant it',async()=>{
 for(const allowed of [false,true]){
  const seen=[],inputs=[];let frame=0;
  const agent=new NativeAutonomy({pause:async()=>{},decide:async(view)=>{seen.push(view.retry_after_defeat);return view.retry_after_defeat?{kind:'click',targetId:'continue'}:{kind:'stop'};},request:async(route,body)=>{
   if(route==='vision-state')return {ready:true,sceneSupport:true,terminalOcrCheck:true};
   if(route==='read-card')return {parsed:{...defeat(),summary:`结算页${frame}`,retry_after_defeat:true}};
   if(body.kind==='capture')return {id:String(++frame),status:'captured_only'};
   inputs.push(body);return {id:'input',status:'awaiting_visual_review'};
  }});
  agent.start({maxSteps:5,continueAfterDefeat:allowed});await agent.task;
  assert.equal(agent.state.stage,'finished',agent.state.lastError);assert.equal(inputs.length,allowed?3:0);assert.deepEqual(seen,allowed?[true,true,true,false]:[false]);
 }
});
test('entering a new adventure revokes remaining defeat continuation permission',async()=>{
 let frame=0;const seen=[];
 const agent=new NativeAutonomy({pause:async()=>{},decide:async(view)=>{seen.push(view.retry_after_defeat);return view.scene==='event'?{kind:'click',targetId:'go'}:{kind:'stop'};},request:async(route,body)=>{
  if(route==='vision-state')return {ready:true,sceneSupport:true,terminalOcrCheck:true};
  if(route==='read-card')return {parsed:frame===1?{scene:'event',targets:[{id:'go',label:'开始',point:[500,500]}]}:defeat()};
  if(body.kind==='capture')return {id:String(++frame),status:'captured_only'};
  return {id:'input',status:'awaiting_visual_review'};
 }});
 agent.start({maxSteps:3,continueAfterDefeat:true});await agent.task;
 assert.deepEqual(seen,[false,false]);assert.equal(agent.state.remainingDefeatContinuations,0);
});
