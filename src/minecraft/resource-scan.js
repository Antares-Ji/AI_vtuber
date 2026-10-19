'use strict';
const { Vec3 } = require('vec3');
const { performance } = require('node:perf_hooks');
const KEY = Symbol.for('ai-vtuber.minecraft.resourceScan');
const LIFE = Symbol.for('ai-vtuber.minecraft.lifecycleEpoch');
const AIR = new Set(['air', 'cave_air', 'void_air']);
const NEIGHBORS = [[1,0,0],[-1,0,0],[0,1,0],[0,-1,0],[0,0,1],[0,0,-1]];
function scope(bot) { return `${bot.game?.dimension || ''}:${bot[LIFE] || 0}`; }
function* cells(origin, radius) {
  for (let r=0;r<=radius;r++) for(let x=-r;x<=r;x++) for(let y=-r;y<=r;y++) for(let z=-r;z<=r;z++) {
    if(Math.max(Math.abs(x),Math.abs(y),Math.abs(z))!==r || x*x+y*y+z*z>radius*radius) continue;
    yield origin.offset(x,y,z);
  }
}
function cancel(bot) {
  const state=bot[KEY]; if(!state)return;
  state.cancelled=true;clearImmediate(state.timer);state.timer=null;
  bot.removeListener?.('end',state.stop);bot.removeListener?.('death',state.stop);
  delete bot[KEY];
}
function ensure(bot, names, options={}) {
  const radius=options.radius??40, now=Date.now(); let state=bot[KEY];
  if(state && (state.scope!==scope(bot)||state.origin.distanceTo(bot.entity.position)>4||state.radius!==radius||state.signature!==names.join('|')||(state.complete&&now-state.finishedAt>10000))) {cancel(bot);state=null;}
  if(state)return state;
  state={scope:scope(bot),origin:bot.entity.position.floored(),radius,signature:names.join('|'),names:new Set(names),startedAt:now,finishedAt:null,complete:false,cancelled:false,positions:[],reads:0,unknownCells:0,slices:0,maxSliceMs:0,maxSliceReads:0};
  bot[KEY]=state;state.stop=()=>cancel(bot);bot.once?.('end',state.stop);bot.once?.('death',state.stop);
  const iterator=cells(state.origin,radius);
  const run=()=>{
    if(state.cancelled||bot[KEY]!==state)return;
    if(state.scope!==scope(bot)||!bot.entity?.position||state.origin.distanceTo(bot.entity.position)>4){cancel(bot);return;}
    const started=performance.now();let reads=0,examined=0;
    try {
      // Each candidate may need six neighboring reads. Reserve the whole
      // group before beginning it; every slice also has a hard cell cap.
      while(reads+7<=256&&examined<256&&performance.now()-started<4){
        const next=iterator.next();if(next.done){state.complete=true;state.finishedAt=Date.now();break;}
        const p=next.value;examined++;
        if(p.y<(bot.game?.minY??-64)||p.y>=(bot.game?.minY??-64)+(bot.game?.height??384))continue;
        if(!bot.world.getColumn(Math.floor(p.x/16),Math.floor(p.z/16))){state.unknownCells++;continue;}
        const block=bot.blockAt(p);reads++;
        if(!block){state.unknownCells++;continue;}
        if(!state.names.has(block.name))continue;
        for(const d of NEIGHBORS){const neighbor=bot.blockAt(p.offset(...d));reads++;if(neighbor&&AIR.has(neighbor.name)){state.positions.push({position:p,name:block.name});break;}}
      }
    }catch(error){state.error=String(error.message).slice(0,180);state.complete=false;state.cancelled=true;}
    state.reads+=reads;state.slices++;state.maxSliceReads=Math.max(state.maxSliceReads,reads);state.maxSliceMs=Math.max(state.maxSliceMs,performance.now()-started);
    if(!state.complete&&!state.cancelled){state.timer=setImmediate(run);}
    else {state.timer=null;bot.removeListener?.('end',state.stop);bot.removeListener?.('death',state.stop);}
  };
  state.timer=setImmediate(run);return state;
}
function status(state) { return {status:state.error?'error':state.complete?'complete':'pending',complete:state.complete,origin:{x:state.origin.x,y:state.origin.y,z:state.origin.z},radius:state.radius,unknownCells:state.unknownCells,startedAt:state.startedAt,ageMs:Date.now()-state.startedAt,finishedAt:state.finishedAt,reads:state.reads,slices:state.slices,maxSliceMs:Math.round(state.maxSliceMs*10)/10,maxSliceReads:state.maxSliceReads,...(state.error?{error:state.error}:{})}; }
function candidates(bot,state,names,limit=80){const wanted=new Set(names);return state.positions.filter(p=>wanted.has(p.name)&&p.position.distanceTo(bot.entity.position)<=state.radius).sort((a,b)=>a.position.distanceTo(bot.entity.position)-b.position.distanceTo(bot.entity.position)).slice(0,limit).map(p=>bot.blockAt(p.position)).filter(b=>b&&wanted.has(b.name));}
module.exports={ensure,status,candidates,cancel};
