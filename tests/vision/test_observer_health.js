const assert=require('node:assert/strict');
const {observerStopReason}=require('../../src/vision/observer-health');
assert.equal(observerStopReason({now:5000,lastPoll:4900,lastDiagnostic:4500}),null);
assert.equal(observerStopReason({now:6000,lastPoll:6000,lastDiagnostic:0}),null);
assert.equal(observerStopReason({now:6001,lastPoll:6000,lastDiagnostic:0}),'observer-unresponsive');
assert.equal(observerStopReason({now:11000,lastPoll:0,lastDiagnostic:10999}),'heartbeat-lost');
assert.equal(observerStopReason({now:11000,lastPoll:10999,lastDiagnostic:10999}),null);
console.log('Observer watchdog: healthy, threshold, stalled observer, missing browser heartbeat passed.');
