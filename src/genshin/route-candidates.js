'use strict';
const huntingGoal=goal=>/敌|怪|讨伐|击杀|打怪|战斗|史莱姆|丘丘/.test(goal);
function validLocation(location,now=Date.now()) {
  return Boolean(location&&location.source==='bettergi_local_minimap_cv'&&location.map==='Teyvat'&&Number.isFinite(location.x)&&Number.isFinite(location.y)&&Number.isFinite(location.capturedAt)&&now-location.capturedAt>=0&&now-location.capturedAt<90000);
}
function routeCandidates(goal,routes,location,{scouting=false}={}) {
  routes=routes.filter(r=>scouting||r.combatMode!=='observe-first');
  const hunting=huntingGoal(goal),located=validLocation(location);
  const words=goal.match(/史莱姆|丘丘|讨伐|地脉|金币|经验|矿|采集|璃月|蒙德/g)||[];
  return routes.filter(r=>hunting?r.category==='hunting':r.category!=='hunting').map(r=>{
    const point=r.firstFight;
    const distance=located&&r.map===location.map&&Number.isFinite(point?.x)&&Number.isFinite(point?.y)?Math.hypot(point.x-location.x,point.y-location.y):null;
    return {id:r.id,name:r.name,category:r.category,map:r.map,...(r.combatMode?{combatMode:r.combatMode,originalRouteId:r.originalRouteId,enemyComposition:'尚未现场识别，不能凭名称确认元素或附近其他敌人'}:{}),distanceToFirstFight:distance===null?null:Math.round(distance),distanceMeaning:distance===null?'未定位，不能宣称最近':'到已知首个战斗点的地图直线距离；非实际行走距离，非全地图最近敌人',score:words.filter(w=>r.name.includes(w)).length};
  }).sort((a,b)=>located&&hunting?(a.distanceToFirstFight??Infinity)-(b.distanceToFirstFight??Infinity):b.score-a.score).slice(0,100).map(({score,...r})=>({...r,...(routes.find(x=>x.id===r.id)?.encounterNotes?{encounterNotes:routes.find(x=>x.id===r.id).encounterNotes}:{})}));
}
module.exports={huntingGoal,validLocation,routeCandidates};
