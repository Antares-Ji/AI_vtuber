// Record actual matched navigation trials. No fabricated model-inference timer.
const fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'runtime/vlm/quality-benchmark');
const [source,target,x,y]=process.argv.slice(2);
if(!['codex','vlm'].includes(source))throw Error('Unknown source');
if(![x,y].every(v=>v!==undefined&&Number.isFinite(Number(v))&&Number(v)>=0&&Number(v)<=1))throw Error('Invalid point');
const before=path.join(dir,`paired-${Date.now()}-before.png`);
fs.copyFileSync(path.join(root,'runtime/vision/captures/arknights/_live-control.png'),before);
const output=cp.execFileSync(process.execPath,[path.join(__dirname,'game-controller-request.js'),'click',x,y],{encoding:'utf8'});
const result=JSON.parse(output);
fs.appendFileSync(path.join(dir,'paired-clicks.jsonl'),JSON.stringify({source,target,point:[Number(x),Number(y)],before,...result})+'\n');
console.log(JSON.stringify(result));
