'use strict';
const fs=require('node:fs'),path=require('node:path');
function loadWaypoints(directory){
 const file=path.join(directory,'GameTask/AutoTrackPath/Assets/tp.json');
 const source=JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
 return (source.data.find(s=>s.mapName==='Teyvat')?.points||[])
  .filter(p=>p.type==='TeleportWaypoint'&&p.position?.length===3&&p.position.every(Number.isFinite))
  .map(p=>({id:String(p.id),country:p.country,areas:p.areas||[],name:p.name,x:p.position[2],y:p.position[0]}));
}
function areas(points){return [...new Set(points.flatMap(p=>p.areas))].sort();}
function select(points,area){return points.filter(p=>p.areas.includes(area));}
module.exports={loadWaypoints,areas,select};
