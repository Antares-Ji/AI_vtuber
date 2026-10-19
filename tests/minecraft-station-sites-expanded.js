'use strict';
const assert=require('node:assert/strict'),{Vec3}=require('vec3');
const {stationSites}=require('../src/minecraft/survival-skills');
const air={name:'air',boundingBox:'empty',diggable:false};
const leaf={name:'spruce_leaves',boundingBox:'block',diggable:true};
const bot={entity:{position:new Vec3(0.5,73,0.5)},canDigBlock:()=>true,blockAt:p=>{
  // The only supported site is adjacent rather than one of the old six offsets.
  // Leaves above a crafting table don't prevent table use.
  if(p.x===1&&p.z===0&&[72,74].includes(p.y))return {...leaf,position:p};
  return {...air,position:p};
}};
let sites=stationSites(bot);assert(sites.some(s=>s.position.equals(new Vec3(1,73,0))&&!s.needsClearing));
const read=bot.blockAt;bot.blockAt=p=>p.equals(new Vec3(1,73,0))?{...leaf,position:p}:read(p);
sites=stationSites(bot);assert(sites.some(s=>s.position.equals(new Vec3(1,73,0))&&s.needsClearing));
bot.canDigBlock=()=>false;assert(!stationSites(bot).some(s=>s.position.equals(new Vec3(1,73,0))));
assert(!stationSites(bot).some(s=>s.position.x===0&&s.position.z===0));
console.log('Station sites passed: adjacent sites, covered ceiling, diggable clearing, actual dig reach, no self-placement.');
