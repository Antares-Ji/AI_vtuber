const assert=require('node:assert/strict');
const {handleVideoReview}=require('../../src/vision/video-review');
async function call(path,method='GET'){
 let code,body;const res={writeHead(c){code=c;},end(b){body=b;}};
 const handled=await handleVideoReview({method},res,new URL(path,'http://localhost'),{send(r,c,b){code=c;body=b;}});
 return {handled,code,body};
}
(async()=>{
 assert.equal((await call('/api/health')).handled,false);
 for(const path of ['/api/vision/video-runs/invalid/bundle.json','/api/vision/video-runs/settings-20260910-005141/secret.txt','/api/vision/video-runs/settings-20260910-005141/images/%2e%2e%2fframes.json'])assert.equal((await call(path)).code,404);
 assert.equal((await call('/api/vision/video-runs/settings-20260910-005141/bundle.json','POST')).code,404);
 const result=await call('/api/vision/video-runs/settings-20260910-005141/bundle.json');assert.equal(result.code,200);
 const bundle=JSON.parse(result.body);assert.equal(bundle.version,2);assert.equal(bundle.nodes.length,4);assert.equal(bundle.frames.length,bundle.decodedFrames);
 for(const n of bundle.nodes){assert(n.boxes.some(b=>b.kind==='文字'));for(const b of n.boxes){assert(b.x>=0&&b.y>=0&&b.w>0&&b.h>0&&b.x+b.w<=n.width&&b.y+b.h<=n.height);}}
 assert(bundle.nodes.some(n=>n.kind==='滚动拼接图'));assert(bundle.edges.every(e=>!e.verified));
 console.log('PASS video review route allowlist, full frame index, key pages and box bounds');
})().catch(e=>{console.error(e);process.exitCode=1;});
