const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '../runtime/vlm/live-20260911');
const name = `compare-${Date.now()}.png`;
fs.copyFileSync(path.resolve(__dirname, '../runtime/vision/captures/arknights/_live-control.png'), path.join(dir,name));
(async()=>{
  const reports=[];
  for(const mode of ['yolo','vlm','hybrid']) {
    const start=Date.now();
    const response=await fetch('http://127.0.0.1:17642/analyze',{
      method:'POST',headers:{'Content-Type':'application/json'},
      body:JSON.stringify({image:name,target:process.argv[2],mode})});
    const result=await response.json();
    if(!response.ok)throw Error(JSON.stringify(result));
    result.request_ms=Date.now()-start;
    reports.push(result);
    console.log(JSON.stringify(result));
  }
  fs.writeFileSync(path.join(dir,name.replace('.png','.comparison.json')),JSON.stringify(reports,null,2));
})().catch(e=>{console.error(e);process.exitCode=1});
