const test=require('node:test'),assert=require('node:assert/strict');
const control=require('../src/genshin/direct-control');
test('direct control validates fresh identity and preserves pending after rejection',async()=>{
 const c=new AbortController(),request={id:'native',seq:1,deadlineAt:Date.now()+10000};
 const p=control.wait({request,observation:{},context:{},signal:c.signal,validate:v=>{if(v.action.kind!=='wait')throw Error('invalid');return v;}});
 assert.throws(()=>control.submit({nativeId:'old',seq:1}),/不匹配/);
 assert.throws(()=>control.submit({nativeId:'native',seq:1,decision:{action:{kind:'move'}}}),/invalid/);
 control.submit({nativeId:'native',seq:1,decision:{action:{kind:'wait'},commentary:'discard'}});
 const result=await p;assert.equal(result.decision.commentary,'');assert.equal(result.answer.provider,'director');assert.deepEqual(result.calls,[]);assert.equal(control.snapshot(),null);
 assert.throws(()=>control.submit({}),/没有/);
});
test('cancellation clears pending without issuing an action',async()=>{
 const c=new AbortController();
 const p=control.wait({request:{id:'native',seq:2,deadlineAt:Date.now()+10000},observation:{},context:{},signal:c.signal,validate:()=>{throw Error('must not run');}});
 c.abort(Error('cancelled'));await assert.rejects(p,/cancelled/);assert.equal(control.snapshot(),null);
});
