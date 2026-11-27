const {test}=require('node:test'),assert=require('node:assert/strict');
const search=require('../scripts/genshin/story/macros/area-search'),g=require('../scripts/genshin/story/grounding');
const rows=[{text:'收集木材',box:[80,250,180,30]},{text:'已到达任务区域',box:[80,285,200,25]}];
function fixture({stop=null,drift=false,error=false}={}){
 let clock=1000,samples=0,point={x:100,y:200};const routes=[],events=[];
 const run=search.create({grounding:g,read:()=>rows,position:()=>({...point,x:point.x+(drift?samples++*10:0)}),now:()=>clock,sleep:async ms=>{clock+=ms;},checkInput(){},getDeadline:()=>1000000,
  movementStop:g.movementStop,createCancellationTokenSource:()=>({token:{},cancelAfter(){},cancel(){events.push('cancel');},dispose(){events.push('dispose');}}),
  pathingScript:{async run(json){const route=JSON.parse(json);routes.push(route);clock+=1000;events.push('end');if(error)throw Error('path failed');if(!stop)point={x:route.positions[0].x,y:route.positions[0].y};}},
  monitorPath:async({run})=>{await run();return {stopReason:stop,samples:[]};}});
 return {run,routes,events};
}
test('area patrol stays in a unique bounded CV-derived grid and retains cursor across calls',async()=>{
 const h=fixture(),first=await h.run(),second=await h.run();assert.equal(first.cursorBefore,0);assert.equal(second.cursorBefore,8);
 assert.equal(h.routes.length,16);assert.ok(h.routes.every(r=>Math.abs(r.positions[0].x-100)<=18&&Math.abs(r.positions[0].y-200)<=18));
 assert.equal(new Set(search.offsets().map(p=>JSON.stringify(p))).size,search.offsets().length);
});
test('F prompt interrupts patrol after joining the one active native route',async()=>{
 const h=fixture({stop:'interaction_prompt'}),r=await h.run();assert.equal(h.routes.length,1);assert.equal(r.stopReason,'interaction_prompt');assert.deepEqual(h.events,['end','cancel','dispose']);
 assert.equal(r.cursorAfter,0,'interrupted traversal is not a visited point');
});
test('a fresh native segment resumes the verified saved cursor, but rejects remote or different-stage origins',async()=>{
 const first=await fixture().run();const next=await fixture().run(first.state);
 assert.equal(next.cursorBefore,8);assert.deepEqual(next.origin,first.origin);
 for(const saved of [{...first.state,stage:'其他任务'},{...first.state,origin:{x:9999,y:9999}}])assert.equal((await fixture().run(saved)).cursorBefore,0);
});
test('unstable initial CV sends no path; path errors still dispose cancellation source',async()=>{
 const h=fixture({drift:true});assert.equal((await h.run()).stopReason,'position_unstable');assert.equal(h.routes.length,0);
 const bad=fixture({error:true});await assert.rejects(bad.run(),/path failed/);assert.equal(bad.events.at(-1),'dispose');
});
