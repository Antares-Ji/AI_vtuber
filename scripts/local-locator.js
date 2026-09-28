// Optimized local pointing proposal. Never clicks; verification remains separate.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'runtime/vlm/live-20260911');
const target=process.argv[2];if(!target)throw Error('Supply target description');
const image=`locator-${Date.now()}.png`;
fs.copyFileSync(path.join(root,'runtime/vision/captures/arknights/_live-control.png'),path.join(dir,image));
(async()=>{
 const start=performance.now();
 const response=await fetch('http://127.0.0.1:17642/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,target,mode:'vlm',strategy:'grounded'})});
 const result=await response.json();result.request_ms=performance.now()-start;
 if(!response.ok)throw Error(result.error||'Locator failed');
 fs.writeFileSync(path.join(dir,image.replace('.png','.proposal.json')),JSON.stringify(result,null,2));
 console.log(JSON.stringify(result));
})().catch(e=>{console.error(e.message);process.exitCode=1});
