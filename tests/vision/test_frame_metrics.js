const assert=require('node:assert/strict');const {frameMetrics}=require('../../src/vision/frame-metrics');
const frames=Array.from({length:61},(_,i)=>({gesture:1,phase:'held',capturedAt:i*1000/30,mediaTime:Math.floor(i/2)/15}));
const result=frameMetrics(frames);assert.equal(result.bursts[0].captureFps,30);assert.equal(result.bursts[0].sourceFps,15);assert.equal(result.verified,false);
assert.equal(frameMetrics(frames.slice(0,4)).bursts.length,0);
assert.equal(frameMetrics(frames.map(f=>({...f,mediaTime:null}))).bursts[0].sourceFps,null);
console.log('Frame metrics: 30 capture vs 15 source fps, insufficient duration and unknown source passed.');
