const assert=require('node:assert/strict');
const {handleReview}=require('../../src/vision/review-routes');
async function call(suffix,method='GET',body){let code,data;await handleReview({method},{},new URL('http://localhost/api/vision/review/'+suffix),{parseBody:async()=>body,send(res,c,d){code=c;data=d;}});return {code,data};}
(async()=>{
 const catalog=await call('sources');assert.equal(catalog.code,200);assert(catalog.data.sessions.some(s=>s.frames.length));
 const s=catalog.data.sessions.find(s=>s.frames.length);const file=s.frames[0].file;
 const result=await call('annotation?'+new URLSearchParams({kind:s.kind,id:s.id,file}));assert.equal(result.code,200);assert(result.data.width>0);assert(Array.isArray(result.data.boxes));
 for(const b of result.data.boxes){assert(b.x>=0&&b.y>=0&&b.x+b.w<=result.data.width&&b.y+b.h<=result.data.height);assert.equal(b.uncertain,true);}
 assert.equal((await call('annotation?kind=page-sessions&id=../../bad&file=x')).code,400);
 assert.equal((await call('stitch','POST',{kind:s.kind,id:s.id,files:[file,file]})).code,400);
 console.log('Review routes: source catalog, bounded uncertain boxes, traversal and duplicate selection rejection passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
