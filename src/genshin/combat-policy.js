'use strict';
const fs=require('node:fs'),path=require('node:path');
function readPolicy(root=path.resolve(__dirname,'../..')){
  const file=path.join(root,'data/genshin-combat-policy.json');
  if(!fs.existsSync(file))return null;
  const p=JSON.parse(fs.readFileSync(file,'utf8'));
  return p.enabled===true?p:null;
}
function eligibleEnemies(scan,policy){
  return !policy||Boolean(scan&&scan.uncertain===false&&scan.allVisibleHostilesIdentified===true&&Array.isArray(scan.enemies)&&scan.enemies.length&&scan.enemies.every(e=>e&&policy.allowedEnemies.includes(e.kind)));
}
function eligibleRoutes(routes,policy){
  return !policy?routes:routes.filter(r=>r.combatMode==='observe-first'&&!policy.blockedRoutes.includes(r.originalRouteId||r.id));
}
function recentScouts(root,now=Date.now()){
  if(!root)return [];
  const file=path.join(root,'runtime/genshin/scout-attempts.json');
  if(!fs.existsSync(file))return [];
  return JSON.parse(fs.readFileSync(file,'utf8')).filter(x=>now-x.at>=0&&now-x.at<600000);
}
function recordScout(root,routeId,receipt){
  if(!root)return;
  if(receipt.state!=='returned'||receipt.inputReleased!==true||receipt.processStopped!==true)throw Error('观察路线尚未确认结束');
  const file=path.join(root,'runtime/genshin/scout-attempts.json');fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify([...recentScouts(root).filter(x=>x.routeId!==routeId),{routeId,at:Date.now(),jobId:receipt.id,enemyComposition:'unconfirmed'}],null,2));
}
module.exports={readPolicy,eligibleEnemies,eligibleRoutes,recentScouts,recordScout};
