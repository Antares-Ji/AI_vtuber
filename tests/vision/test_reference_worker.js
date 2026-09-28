const assert=require('node:assert/strict'),path=require('node:path'),fs=require('node:fs');
const {ReferenceWorker}=require('../../src/vision/reference-worker');
const root=path.resolve(__dirname,'../..');
(async()=>{
 const worker=new ReferenceWorker(root);const rows=[];
 try{
  await worker.ready;
  for(let round=0;round<3;round++)for(const [kind,name,expected] of [['tile','selected',true],['direction','direction',true],['direction','landed',false],['landed','landed',true],['landed','direction',false],['battle-card','battle-ready',true],['battle-card','result',false]]){
   const image=kind==='tile'?path.join(root,'runtime/vision/local-deployment/1789189001769/1789189084774-click.png'):path.join(root,'data/vision/deployment-references/0-1',name+'.png');
   const start=performance.now();const result=await worker.inspect(kind,image);
   assert.equal(result.result.ok,expected,kind+' '+name);rows.push({kind,name,ms:performance.now()-start,server_ms:result.server_ms});
  }
  fs.writeFileSync(path.join(root,'runtime/vlm/controller/reference-worker-benchmark.json'),JSON.stringify(rows,null,2));
  console.log(JSON.stringify({passed:rows.length,median_ms:rows.map(x=>x.ms).sort((a,b)=>a-b)[10],maximum_ms:Math.max(...rows.map(x=>x.ms))}));
 }finally{worker.close();}
})().catch(e=>{console.error(e.message);process.exitCode=1});
