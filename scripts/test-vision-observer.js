// Bounded read-only native observer check. Does not inject input or take screenshots.
const base='http://127.0.0.1:3000/api/vision/interactions';
async function request(suffix,options={}){
 const res=await fetch(base+suffix,{...options,signal:AbortSignal.timeout(20000)});
 const data=await res.json();if(!res.ok)throw new Error(data.error);return data;
}
(async()=>{
 const windows=(await request('/windows')).windows;
 if(windows.length!==1)throw new Error('Need exactly one visible Arknights window for scoped diagnostic');
 let session;
 try{
  session=await request('',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:windows[0].handle,entryId:1})});
  for(let i=0;i<5;i++){
   await new Promise(resolve=>setTimeout(resolve,1000));
   const state=await request(`/${session.id}/events?after=-1`);
   console.log(JSON.stringify({status:state.status,diagnostic:state.diagnostic,eventCount:state.events.length}));
   if(state.status!=='recording')break;
  }
 }finally{
  if(session){const result=await request(`/${session.id}/stop`,{method:'POST'});console.log(JSON.stringify({id:session.id,status:result.status,eventCount:result.events.length,outcome:result.outcome}));}
 }
})().catch(error=>{console.error(error.message);process.exitCode=1;});
