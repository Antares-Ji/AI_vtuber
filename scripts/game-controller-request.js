const fs = require('node:fs');
const path = require('node:path');
const dir = path.resolve(__dirname, '../runtime/vlm/controller');
const action = process.argv[2] || 'status';
if (!['status', 'capture', 'click', 'drag', 'shutdown'].includes(action)) throw Error('Unsupported action');
const token = fs.readFileSync(path.join(dir, 'token.txt'), 'utf8').trim();
const options = {method:action === 'status' ? 'GET' : 'POST', headers:{Authorization:`Bearer ${token}`}};
if (action === 'click') {
  const xRatio = Number(process.argv[3]), yRatio = Number(process.argv[4]);
  if (![xRatio,yRatio].every(v=>Number.isFinite(v) && v>=0 && v<=1)) throw Error('Invalid coordinates');
  options.headers['Content-Type']='application/json';
  options.body=JSON.stringify({xRatio,yRatio,waitMs:1200});
}
if (action === 'drag') {
 const coords=process.argv.slice(3,7).map(Number);
 if(coords.length!==4||coords.some(v=>!Number.isFinite(v)||v<0||v>1))throw Error('Invalid drag');
 options.headers['Content-Type']='application/json';
 options.body=JSON.stringify({startXRatio:coords[0],startYRatio:coords[1],endXRatio:coords[2],endYRatio:coords[3],waitMs:900});
}
(async()=>{
 const requestStarted=performance.now();
 const response=await fetch(`http://127.0.0.1:17643/${action}`,options);
 const result=await response.json();
 result.controller_request_ms=performance.now()-requestStarted;
 if (result.path && fs.existsSync(result.path)) {
   const evidence=path.join(dir,`${Date.now()}-${action}.png`);
   fs.copyFileSync(result.path,evidence);
   result.evidence=evidence;
 }
 fs.appendFileSync(path.join(dir,'requests.jsonl'),JSON.stringify({time:new Date().toISOString(),action,...result})+'\n');
 console.log(JSON.stringify(result,null,2));
 if(!response.ok)process.exitCode=1;
})().catch(e=>{console.error(e.message);process.exitCode=1;});
