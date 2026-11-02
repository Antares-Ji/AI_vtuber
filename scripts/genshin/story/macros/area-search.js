// Search a bounded area using BGI CV position and PathExecutor, not model keys.
const StoryAreaSearch=(()=>{
 function offsets(){
  const result=[];
  for(const radius of [6,12,18,24,30,36]){
   for(let x=-radius;x<=radius;x+=6)result.push({x,y:-radius});
   for(let y=-radius+6;y<=radius;y+=6)result.push({x:radius,y});
   for(let x=radius-6;x>=-radius;x-=6)result.push({x,y:radius});
   for(let y=radius-6;y>-radius;y-=6)result.push({x:-radius,y});
  }
  return result;
 }
 function create({grounding,read,position,pathingScript,createCancellationTokenSource,monitorPath,sleep,checkInput,getDeadline,movementStop,now=Date.now}){
  let state=null;
  return async function search(saved){
   checkInput();const rows=read(),stage=grounding.questInstruction(rows)?.text;
   const result={kind:'area-search',points:[],stopReason:null,verified:false,movementMsSent:null,movementTelemetryComplete:false};
   const stop=movementStop(rows);if(stop||!stage)return {...result,stopReason:stop||'stage_missing'};
   if(!rows.some(t=>/已到达任务区域|在此区域内搜索目标/.test(t.text)))return {...result,stopReason:'outside_search_area'};
   if(!state&&saved?.version===1&&saved.stage===stage&&Number.isInteger(saved.cursor)&&saved.cursor>=0&&saved.cursor<=offsets().length&&Number.isFinite(saved.origin?.x)&&Number.isFinite(saved.origin?.y)){
    const p=position();
    if(p&&Math.hypot(p.x-saved.origin.x,p.y-saved.origin.y)<=65)state={...saved,origin:{...saved.origin}};
   }
   if(!state||state.stage!==stage){
    const p=position();await sleep(100);checkInput();const p2=position();
    if(!p||!p2||![p.x,p.y,p2.x,p2.y].every(Number.isFinite)||Math.hypot(p.x-p2.x,p.y-p2.y)>5)return {...result,stopReason:'position_unstable'};
    state={version:1,stage,origin:p2,cursor:0};
   }
   result.origin=state.origin;result.cursorBefore=state.cursor;
   const points=offsets(),started=now();
   for(let n=0;n<8&&state.cursor<points.length&&now()-started<60000;n++){
    checkInput();const budget=Math.min(12000,getDeadline()-now()-2000);if(budget<=0){result.stopReason='deadline';break;}
    const offset=points[state.cursor],to={x:state.origin.x+offset.x,y:state.origin.y+offset.y};
    const cts=createCancellationTokenSource();let run=null;
    const entry={to,startedAt:now()};result.points.push(entry);
    try{
     cts.cancelAfter(budget);checkInput();
     run=Promise.resolve(pathingScript.run(JSON.stringify({info:{name:'AI-VTuber-area-search',type:'collect',map_name:'Teyvat',bgi_version:'0.66.0'},positions:[{id:1,...to,type:'target',move_mode:'walk',action:''}]}),cts.token));
     const watched=await monitorPath({run:()=>run,cts,read,checkInput,sleep,now,inspect:fresh=>{
      let stopReason=movementStop(fresh);
      const instruction=grounding.questInstruction(fresh);
      if(!stopReason&&(!instruction||instruction.text!==stage))stopReason='stage_changed_or_missing';
      if(!stopReason&&!fresh.some(t=>/已到达任务区域|在此区域内搜索目标/.test(t.text)))stopReason='outside_search_area';
      return {stopReason};
     }});
     entry.stopReason=watched.stopReason||(cts.isCancellationRequested?'path_timeout':null);entry.checks=watched.samples.length;
    }finally{
     try{cts.cancel();if(run)await run;}finally{cts.dispose();entry.durationMs=now()-entry.startedAt;}
    }
    const actual=position();entry.arrived=Boolean(actual&&Math.hypot(actual.x-to.x,actual.y-to.y)<=3);
    if(entry.arrived||entry.stopReason==='path_timeout'||entry.stopReason==='outside_search_area')state.cursor++;
    else if(!entry.stopReason){entry.stopReason='arrival_unverified';state.cursor++;}
    if(entry.stopReason){result.stopReason=entry.stopReason;break;}
   }
   result.cursorAfter=state.cursor;result.state={...state,origin:{...state.origin}};result.stopReason||=state.cursor>=points.length?'area_exhausted':'segment_budget';return result;
  };
 }
 return {create,offsets};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=StoryAreaSearch;
