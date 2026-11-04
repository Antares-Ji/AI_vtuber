// Fresh local minimap CV evidence for checking a predicted teleport destination.
const StoryPostActionPosition=(()=>{
 async function sample({lastStep,genshin,sleep,now=Date.now,deadline}){
  let detail;try{detail=JSON.parse(lastStep?.detail);}catch{}
  const transport=lastStep?.action?.kind==='key'&&lastStep.action.key==='F'&&detail?.kind==='interaction'&&detail.sent===true&&detail.outcome!=='prompt_unchanged'&&/^(进入|离开|上行$|下行$)/.test(detail.target||'');
  const recovery=lastStep?.action?.kind==='native_unstuck'&&detail?.kind==='bgi-native-unstuck'&&detail.durationMs>0;
  if(lastStep?.action?.kind!=='teleport'&&!transport&&!recovery)return null;
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
 return {sample};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=StoryPostActionPosition;
