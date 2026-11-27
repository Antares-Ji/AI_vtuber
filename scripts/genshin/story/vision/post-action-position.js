// Fresh local minimap CV evidence for checking a predicted teleport destination.
const StoryPostActionPosition=(()=>{
 async function sample({lastStep,genshin,sleep,now=Date.now,deadline,worldProbe=false}){
  let detail;try{detail=JSON.parse(lastStep?.detail);}catch{}
  const transport=lastStep?.action?.kind==='key'&&lastStep.action.key==='F'&&detail?.kind==='interaction'&&detail.sent===true&&detail.outcome!=='prompt_unchanged'&&/^(进入|离开|上行$|下行$)/.test(detail.target||'');
  const recovery=lastStep?.action?.kind==='native_unstuck'&&detail?.kind==='bgi-native-unstuck'&&detail.durationMs>0;
  if(lastStep?.action?.kind!=='teleport'&&!transport&&!recovery&&!worldProbe)return null;
  const result={source:'bettergi_minimap_cv',stable:false,samples:[]};
  try{
   for(let i=0;i<2;i++){
    if(now()>=deadline-2000)throw Error('position_deadline');
    const p=genshin.getPositionFromMap('Teyvat',0),x=Number(p?.x??p?.X),y=Number(p?.y??p?.Y);
    if(!Number.isFinite(x)||!Number.isFinite(y))throw Error('position_invalid');
    result.samples.push({x,y,at:now()});
    if(!i)await sleep(100);
   }
   result.stable=Math.hypot(result.samples[0].x-result.samples[1].x,result.samples[0].y-result.samples[1].y)<=10;
   if(!result.stable)result.reason='position_unstable';
  }catch(error){result.reason=String(error.message||error).slice(0,120);}
  return result;
 }
 function createSampler(){
  let lastProbeAt=null,localized=false;
  return async function observe(options){
   const now=options.now||Date.now,time=now();
   const transition=['teleport','native_unstuck'].includes(options.lastStep?.action?.kind)||options.lastStep?.action?.kind==='key'&&['F','V'].includes(options.lastStep.action.key);
   // Revalidate an acquired position on each decision frame; never reuse its
   // coordinates. Failed indoor localization backs off until a transition or
   // a bounded periodic probe. This state lives only in the current BGI run.
   if(!localized&&!transition&&lastProbeAt!==null&&time-lastProbeAt<30000)return null;
   const scene=options.readScene();
   if(scene?.ui!=='Main'||scene.motion!=='Normal'){localized=false;return null;}
   lastProbeAt=time;
   const result=await sample({...options,worldProbe:true});
   localized=result?.stable===true;
   return result;
  };
 }
 return {sample,createSampler};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=StoryPostActionPosition;
