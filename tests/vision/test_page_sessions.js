const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { handlePageSessions, validJpeg } = require('../../src/vision/page-sessions');
async function call(method, suffix, body) {
  let status, data;
  await handlePageSessions({method}, {writeHead(code) {status=code;},end(value){data=value;}},
    new URL(`http://localhost/api/vision/page-sessions${suffix}`), {
      parseBody: async()=>body, parseBinaryBody: async()=>body,
      send(res, code, value) {status=code;data=value;}
    });
  return {status,data};
}
(async()=>{
  assert.equal(validJpeg(Buffer.alloc(20)),false);
  const invalid = await call('POST','',{entryId:'../../bad'}); assert.equal(invalid.status,400);
  const created = await call('POST','',{entryId:1}); assert.equal(created.status,200);
  const id = created.data.id;
  assert.match(id,/^[a-f0-9-]{36}$/);
  const dir = path.resolve('runtime/vision/page-sessions', id);
  try {
    assert.equal(created.data.parentScene,'home'); assert.equal(created.data.entryLabel,'设置');
    const jpeg = await fs.readFile('public/annotations/home-reference-20260907.jpg');
    assert(validJpeg(jpeg));
    assert.equal((await call('POST',`/${id}/frames?seq=1`,jpeg)).status,409);
    assert.equal((await call('POST',`/${id}/frames?seq=0`,Buffer.alloc(20))).status,400);
    const saved = await call('POST',`/${id}/frames?seq=0`,jpeg); assert.equal(saved.status,200);
    assert.equal((await call('POST',`/${id}/frames?seq=0`,jpeg)).status,409);
    assert.equal((await call('GET',`/${id}/frame-999.jpg`)).status,404);
    const result = await call('POST',`/${id}/finish`); assert.equal(result.status,200);
    assert.equal(result.data.status,'complete'); assert.equal(result.data.segments.length,1);
    assert.equal((await call('GET',`/${id}/segment-001.png`)).status,200);
    assert.equal((await call('POST',`/${id}/frames?seq=1`,jpeg)).status,409);
    assert.deepEqual(await fs.readFile(path.join(dir,'frame-001.jpg')),jpeg);
  } finally {
    // Only this test-created, validated UUID directory is removed; never user sessions.
    assert.equal(path.dirname(dir),path.resolve('runtime/vision/page-sessions'));
    await fs.rm(dir,{recursive:true});
  }
  console.log('Page session API: hierarchy, sequence, JPEG validation, finish, image access, original preservation passed.');
})().catch(error=>{console.error(error);process.exitCode=1;});
