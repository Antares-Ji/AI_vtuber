// Curated upstream BGI routes. Models select an ID; coordinates stay in the catalog.
const StoryCommissionRoute=(()=>{
 function available(catalog,quest,stage,states={}){
  return catalog.routes.filter(r=>r.quest===quest&&new RegExp(r.stagePattern).test(stage||''))
   .map(r=>({id:r.id,title:r.title,source:'bettergi_script_catalog',referenceOnly:true,
    completed:states[r.id]?.stage===stage&&states[r.id]?.cursor>=r.positions.length,
    cursor:states[r.id]?.stage===stage?states[r.id].cursor:0}));
 }
 function create({catalog,grounding,read,position,pathingScript,createCancellationTokenSource,monitorPath,sleep,checkInput,getDeadline,movementStop,now=Date.now}){
  return async function run(id,saved){
   checkInput();const route=catalog.routes.find(r=>r.id===id),rows=read(),stage=grounding.questInstruction(rows)?.text;
   const result={kind:'commission-route',id,stage,points:[],stopReason:null,verified:false};
   if(!route||!stage||!new RegExp(route.stagePattern).test(stage))return {...result,stopReason:'stage_mismatch'};
   const stop=movementStop(rows);if(stop)return {...result,stopReason:stop};
   const p=position();await sleep(100);checkInput();const p2=position();
   if(!p||!p2||![p.x,p.y,p2.x,p2.y].every(Number.isFinite)||Math.hypot(p.x-p2.x,p.y-p2.y)>5)return {...result,stopReason:'position_unstable'};
   if(Math.hypot(p2.x-route.anchor.x,p2.y-route.anchor.y)>route.maxAnchorDistance)return {...result,stopReason:'wrong_variant_region'};
   let cursor=saved?.id===id&&saved.stage===stage&&saved.sha256===route.sha256&&Number.isInteger(saved.cursor)&&saved.cursor>=0&&saved.cursor<=route.positions.length?saved.cursor:0;
   result.sourceFile=route.sourceFile;result.sourceCommit=catalog.source.commit;result.cursorBefore=cursor;
   const started=now();
   for(let n=0;n<10&&cursor<route.positions.length&&now()-started<75000;n++){
    checkInput();const target=route.positions[cursor],at=position();
    if(at&&Math.hypot(at.x-target.x,at.y-target.y)<=2){cursor++;continue;}
    const budget=Math.min(25000,getDeadline()-now()-2500);if(budget<=0){result.stopReason='deadline';break;}
    const cts=createCancellationTokenSource();let promise=null;
    const entry={index:cursor,to:{x:target.x,y:target.y},startedAt:now()};result.points.push(entry);
    try{
     cts.cancelAfter(budget);checkInput();
     // Each point is checked independently because upstream PathExecutor can return after an exception.
     promise=Promise.resolve(pathingScript.run(JSON.stringify({info:{name:'AI-VTuber-'+id,type:'collect',map_name:'Teyvat',bgi_version:'0.66.0'},positions:[{...target,id:1,type:'target',action:''}]}),cts.token));
     const watched=await monitorPath({run:()=>promise,cts,read,checkInput,sleep,now,inspect:fresh=>{
      const next=grounding.questInstruction(fresh)?.text;
      return {stopReason:movementStop(fresh)||(!next||next!==stage?'stage_changed_or_missing':null)};
     }});
     entry.stopReason=watched.stopReason||(cts.isCancellationRequested?'path_timeout':null);
    }finally{try{cts.cancel();if(promise)await promise;}finally{cts.dispose();entry.durationMs=now()-entry.startedAt;}}
    const end=position();entry.arrived=Boolean(end&&Math.hypot(end.x-target.x,end.y-target.y)<=3);
    if(entry.arrived)cursor++;
    if(entry.stopReason){result.stopReason=entry.stopReason;break;}
    if(!entry.arrived){result.stopReason='arrival_unverified';break;}
   }
   result.cursorAfter=cursor;result.state={id,stage,cursor,sha256:route.sha256};
   result.stopReason||=cursor>=route.positions.length?'route_complete':'segment_budget';
   return result;
  };
 }
 return {available,create};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=StoryCommissionRoute;
