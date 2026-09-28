const assert = require('node:assert/strict');
const {LatestFrameAnalyzer} = require('../../src/vision/latest-frame-analyzer');
(async()=>{
  let release, time=100;
  const processed=[];
  const queue = new LatestFrameAnalyzer(async f=>{
    processed.push(f.id);
    if(f.id===1) await new Promise(r=>{release=r});
    return f.id;
  }, {now:()=>time,maxAgeMs:50});
  const first=queue.submit({id:1,capturedAt:100});
  const second=queue.submit({id:2,capturedAt:100});
  const third=queue.submit({id:3,capturedAt:140});
  assert.equal((await second).reason,'replaced_by_newer_frame');
  time=160;release();
  assert.equal((await first).reason,'expired_after_analysis');
  assert.equal((await third).result,3);
  assert.deepEqual(processed,[1,3]);
  assert.equal((await queue.submit({id:4,capturedAt:0})).reason,'expired_before_analysis');
  let calls=0;
  const resilient=new LatestFrameAnalyzer(async()=>{if(!calls++)throw Error('test failure');return 1});
  await assert.rejects(resilient.submit({capturedAt:Date.now()}),/test failure/);
  assert.equal((await resilient.submit({capturedAt:Date.now()})).status,'ready');
  console.log('latest frame replacement, expiry, and error recovery passed');
})().catch(e=>{console.error(e);process.exitCode=1});
