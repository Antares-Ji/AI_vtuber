const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { requestPing, pingBetterGi } = require('../src/genshin/bettergi-ipc');
const { BetterGiAdapter } = require('../src/genshin/adapters');

function frame(value) {
  const payload = Buffer.from(JSON.stringify(value)), header = Buffer.alloc(5);
  header.writeUInt32LE(payload.length); header[4] = 1;
  return Buffer.concat([header, payload]);
}
function endpoint(request) {
  return { version:2, operation:'response', requestId:request.requestId, success:true,
    data:{instanceType:0,processId:123,windowsSessionId:1,startedAt:'2026-10-26T00:00:00Z'} };
}
function transport(respond) {
  const socket = new EventEmitter(); socket.destroyed = false; socket.requests = [];
  socket.destroy = () => { socket.destroyed = true; socket.emit('close'); };
  socket.write = buffer => {
    assert.equal(buffer[4],1); assert.equal(buffer.readUInt32LE(),buffer.length-5);
    const request=JSON.parse(buffer.subarray(5));socket.requests.push(request);
    assert.equal(request.operation,'ping');assert.equal(request.data,undefined);
    respond(socket,request);
  };
  return {socket,connect:()=>{queueMicrotask(()=>socket.emit('connect'));return socket;}};
}
test('read-only ping reassembles fragmented v2 frames and closes its pipe',async()=>{
  const t=transport((socket,request)=>{
    const bytes=frame(endpoint(request));
    for(const byte of bytes)socket.emit('data',Buffer.from([byte]));
  });
  const result=await requestPing('test',{connect:t.connect});
  assert.equal(result.processId,123);assert.equal(result.protocol,2);
  assert.equal(t.socket.requests.length,1);assert.equal(t.socket.destroyed,true);
});
test('mismatched, unsuccessful and malformed endpoint replies are rejected',async()=>{
  for(const mutate of [r=>r.requestId='other',r=>r.version=1,r=>r.operation='task.started',r=>r.success=false,
    r=>r.data.processId=0,r=>r.data.instanceType=2,r=>r.data.windowsSessionId=-1,r=>r.data.startedAt='invalid']){
    const t=transport((s,q)=>{const r=endpoint(q);mutate(r);s.emit('data',frame(r));});
    await assert.rejects(requestPing('test',{connect:t.connect}));assert.equal(t.socket.destroyed,true);
  }
});
test('bounded framing refuses non-JSON, oversized, truncated and extra data',async()=>{
  for(const send of [
    (s,q)=>{const b=frame(endpoint(q));b[4]=2;s.emit('data',b);},
    s=>{const b=Buffer.alloc(5);b.writeUInt32LE(1048577);b[4]=1;s.emit('data',b);},
    (s,q)=>{s.emit('data',frame(endpoint(q)).subarray(0,8));s.emit('end');},
    (s,q)=>s.emit('data',Buffer.concat([frame(endpoint(q)),Buffer.from('extra')])),
    s=>{const b=Buffer.from([2,0,0,0,1,123,123]);s.emit('data',b);},
  ]){
    const t=transport(send);await assert.rejects(requestPing('test',{connect:t.connect}));assert.equal(t.socket.destroyed,true);
  }
});
test('timeout, disconnect and cancellation settle without a launch or retry',async()=>{
  const timed=transport(()=>{});await assert.rejects(requestPing('test',{connect:timed.connect,timeoutMs:10}),/timed out/);
  assert.equal(timed.socket.requests.length,1);assert.equal(timed.socket.destroyed,true);
  const closed=transport(s=>s.emit('close'));await assert.rejects(requestPing('test',{connect:closed.connect}),/closed/);
  const controller=new AbortController(),active=transport(()=>controller.abort(Error('stop')));
  await assert.rejects(requestPing('test',{signal:controller.signal,connect:active.connect}),/stop/);
  await assert.rejects(requestPing('test',{signal:controller.signal,connect:()=>assert.fail('No connect after abort')}),/stop/);
});
test('doctor resolves only the current-user pipe and never treats ping as live readiness',async()=>{
  const t=transport((s,q)=>s.emit('data',frame(endpoint(q))));let pipe;
  const ipc=await pingBetterGi({platform:'win32',sidReader:async()=>'S-1-5-21-123',connect:p=>{pipe=p;return t.connect();}});
  assert.equal(pipe,'\\\\.\\pipe\\BetterGI.v2.user-S-1-5-21-123.root');assert.equal(ipc.online,true);
  assert.equal(JSON.stringify(ipc).includes('S-1-5'),false);
  const report=await new BetterGiAdapter().diagnose({ping:async()=>ipc});
  assert.equal(report.ipc.online,true);assert.equal(report.ready,false);assert.equal(report.bridgeReady,false);assert.equal(report.gameConnected,false);
});
test('unsupported hosts, missing users and permission failures are explicit and redacted',async()=>{
  const notWindows=await pingBetterGi({platform:'linux',sidReader:()=>assert.fail('No host command')});assert.equal(notWindows.online,false);
  const missing=await pingBetterGi({platform:'win32',sidReader:async()=>null,connect:()=>assert.fail('No pipe without SID')});assert.equal(missing.online,false);
  const denied=await pingBetterGi({platform:'win32',sidReader:async()=>'S-1-5-21-123',connect:()=>{throw Object.assign(Error('private pipe path'),{code:'EACCES'});}});
  assert.deepEqual(denied,{online:false,reason:'EACCES'});
});
