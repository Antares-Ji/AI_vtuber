const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'runtime/vlm/quality-benchmark');
const name=`paired-${Date.now()}.png`;
fs.copyFileSync(path.join(root,'runtime/vision/captures/arknights/_live-control.png'),path.join(root,'runtime/vlm/live-20260911',name));
(async()=>{
 const started=performance.now();
 const res=await fetch('http://127.0.0.1:17642/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:name,target:process.argv[2],mode:'vlm'})});
 const data=await res.json();
 const result={...data,request_ms:performance.now()-started};
 fs.appendFileSync(path.join(dir,'paired-local-proposals.jsonl'),JSON.stringify(result)+'\n');
 console.log(JSON.stringify(result));
})().catch(e=>{console.error(e);process.exitCode=1});
