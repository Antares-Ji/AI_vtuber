// Curated upstream BGI routes. Models select an ID; coordinates stay in the catalog.
const StoryCommissionRoute=(()=>{
 function sameStage(a,b){return Boolean(a&&b)&&String(a).replace(/[\s「」『』“”"']/g,'')===String(b).replace(/[\s「」『』“”"']/g,'');}
 function available(catalog,quest,stage,states={},attempts=[]){
  return catalog.routes.filter(r=>r.quest===quest&&new RegExp(r.stagePattern).test(stage||''))
   .filter(r=>r.mode!=='entry_recovery'||Object.values(states).some(s=>sameStage(s.stage,stage)&&s.failures>=2))
   .filter(r=>r.mode!=='entry_continue'||attempts.includes('urgent-entry'))
   .filter(r=>!r.resumeFrom||attempts.includes(r.resumeFrom))
   .map(r=>({id:r.id,title:r.title,source:'bettergi_script_catalog',referenceOnly:true,
    recovery:Boolean(r.mode),
    completed:sameStage(states[r.id]?.stage,stage)&&states[r.id]?.cursor>=r.positions.length,
    blocked:Boolean(r.mode&&attempts.includes(r.id))||sameStage(states[r.id]?.stage,stage)&&(states[r.id]?.failures>=2||Boolean(r.mode)&&states[r.id]?.attempts>=1),
    cursor:sameStage(states[r.id]?.stage,stage)?states[r.id].cursor:0}));
 }
 function create({catalog,grounding,read,nativeUi=()=>null,position,pathingScript,createCancellationTokenSource,monitorPath,sleep,checkInput,getDeadline,movementStop,now=Date.now}){
  return async function run(id,saved){
   checkInput();const route=catalog.routes.find(r=>r.id===id),rows=read(),stage=grounding.questInstruction(rows)?.text;
   const result={kind:'commission-route',id,stage,points:[],pathStarted:false,stopReason:null,verified:false};
   if(!route||!stage||!new RegExp(route.stagePattern).test(stage))return {...result,stopReason:'stage_mismatch'};
   const stop=movementStop(rows);if(stop)return {...result,stopReason:stop};
   const p=position();await sleep(100);checkInput();const p2=position();
   if(!p||!p2||![p.x,p.y,p2.x,p2.y].every(Number.isFinite)||Math.hypot(p.x-p2.x,p.y-p2.y)>5)return {...result,stopReason:'position_unstable'};
   if(Math.hypot(p2.x-route.anchor.x,p2.y-route.anchor.y)>route.maxAnchorDistance)return {...result,stopReason:'wrong_variant_region'};
   if(route.mode){
    if(saved?.attempts>=1)return {...result,stopReason:'entry_already_attempted'};
    if(route.mode==='entry_continue'){
     const anchor=catalog.routes.find(r=>r.id==='urgent-entry').positions[0];
     if(Math.hypot(p2.x-anchor.x,p2.y-anchor.y)>20)return {...result,stopReason:'entry_start_unverified',from:p2};
    }
    const cts=createCancellationTokenSource();let promise=null;
    const started=now(),budget=Math.min(100000,getDeadline()-now()-3000);if(budget<=0)return {...result,stopReason:'deadline'};
    result.sourceFile=route.sourceFile;result.sourceCommit=route.sourceCommit||catalog.source.commit;result.from=p2;
    try{
     cts.cancelAfter(budget);checkInput();
     result.pathStarted=true;
     promise=Promise.resolve(pathingScript.run(JSON.stringify({info:{name:'AI-VTuber-entry-recovery',type:'collect',map_name:'Teyvat',bgi_version:'0.66.0'},positions:route.positions}),cts.token));
     const watched=await monitorPath({run:()=>promise,cts,read,checkInput,sleep,now,inspect:fresh=>{
      const next=grounding.questInstruction(fresh)?.text;
      // The upstream route owns its teleport/map/loading transition. These are
      // expected; a newly observed task stage or dialogue still interrupts it.
      return {stopReason:now()-started<20000?null:nativeUi()==='Talk'?'dialogue':next&&!sameStage(next,stage)?'stage_changed':null};
     }});
     result.stopReason=watched.stopReason||(cts.isCancellationRequested?'path_timeout':null);
    }finally{try{cts.cancel();if(promise)await promise;}finally{cts.dispose();result.durationMs=now()-started;}}
    try{result.after=position();}catch(error){result.positionError=String(error.message||error);result.after=null;}
    const end=route.positions[route.positions.length-1];
    const arrived=result.after&&Math.hypot(result.after.x-end.x,result.after.y-end.y)<=8;
    result.state={id,stage,sha256:route.sha256,cursor:arrived?route.positions.length:0,attempts:1};
    result.stopReason||=arrived?'route_complete':'arrival_unverified';return result;
   }
   let cursor=saved?.id===id&&sameStage(saved.stage,stage)&&saved.sha256===route.sha256&&Number.isInteger(saved.cursor)&&saved.cursor>=0&&saved.cursor<=route.positions.length?saved.cursor:0;
   let failures=saved?.id===id&&sameStage(saved.stage,stage)&&saved.sha256===route.sha256?saved.failures||0:0;
   if(failures>=2)return {...result,stopReason:'route_retry_limit'};
   result.sourceFile=route.sourceFile;result.sourceCommit=route.sourceCommit||catalog.source.commit;result.cursorBefore=cursor;
   const started=now();
   for(let n=0;n<10&&cursor<route.positions.length&&now()-started<75000;n++){
    checkInput();const target=route.positions[cursor],at=position();
    const tolerance=target.type==='path'?5:2;
    if(at&&Math.hypot(at.x-target.x,at.y-target.y)<=tolerance){cursor++;failures=0;continue;}
    const budget=Math.min(25000,getDeadline()-now()-2500);if(budget<=0){result.stopReason='deadline';break;}
    const cts=createCancellationTokenSource();let promise=null;
    const entry={index:cursor,from:at,to:{x:target.x,y:target.y},startedAt:now()};result.points.push(entry);
    try{
     cts.cancelAfter(budget);checkInput();
     result.pathStarted=true;
     // Each point is checked independently because upstream PathExecutor can return after an exception.
     promise=Promise.resolve(pathingScript.run(JSON.stringify({info:{name:'AI-VTuber-'+id,type:'collect',map_name:'Teyvat',bgi_version:'0.66.0'},positions:[{...target,id:1,action:''}]}),cts.token));
     const watched=await monitorPath({run:()=>promise,cts,read,checkInput,sleep,now,inspect:fresh=>{
      const next=grounding.questInstruction(fresh)?.text;
      return {stopReason:movementStop(fresh)||(!next||!sameStage(next,stage)?'stage_changed_or_missing':null)};
     }});
     entry.stopReason=watched.stopReason||(cts.isCancellationRequested?'path_timeout':null);
    }finally{try{cts.cancel();if(promise)await promise;}finally{cts.dispose();entry.durationMs=now()-entry.startedAt;}}
    const end=position();entry.after=end;entry.arrived=Boolean(end&&Math.hypot(end.x-target.x,end.y-target.y)<=Math.max(3,tolerance));
    if(entry.arrived){cursor++;failures=0;}
    else if(!entry.stopReason||entry.stopReason==='path_timeout')failures++;
    if(entry.stopReason){result.stopReason=entry.stopReason;break;}
    if(!entry.arrived){result.stopReason='arrival_unverified';break;}
   }
   result.cursorAfter=cursor;result.state={id,stage,cursor,failures,sha256:route.sha256};
   result.stopReason||=cursor>=route.positions.length?'route_complete':'segment_budget';
   return result;
  };
 }
 return {available,create};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=StoryCommissionRoute;
