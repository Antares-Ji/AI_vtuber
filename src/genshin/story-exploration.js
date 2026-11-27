'use strict';
const grounding=require('../../scripts/genshin/story-main');
const canonical=s=>String(s||'').replace(/[\s「」『』“”‘’"']/g,'');
const short=s=>typeof s==='string'?s.slice(0,100):'';
function frame(e){
 const r=e?.request,o=e?.observation,a=e?.cloudImageAssessment,hud=r&&grounding.questHud(r.texts||[]);
 if(!e?.trainingSessionId||e.provider!=='deepseek'||!e.imageAssistance||!a||o?.scene!=='world'||r?.nativeVision?.source!=='bettergi_native_cv'||r.nativeVision.ui!=='Main'||!hud||!Number.isFinite(r.capturedAt)||!Number.isInteger(r.seq))return null;
 return {sessionId:e.trainingSessionId,quest:r.focusQuest||e.decision?.quest,nativeId:r.id,seq:r.seq,at:r.capturedAt,stage:hud.stage,
  hud:{meters:hud.meters,elevation:hud.elevation||null},
  seenByDeepSeek:{groundTrailVisible:a.groundTrailVisible===true,groundTrail:short(a.groundTrail),nearObstacle:short(a.nearObstacle),openPassage:short(a.openPassage),...(typeof a.landmarkMatch==='string'?{landmarkMatch:short(a.landmarkMatch)}:{})}};
}
function summarize(frames,{quest,stage,sessionId,now=Date.now()}={}){
 if(!sessionId||!quest||!stage)return null;
 const unique=new Map();
 for(const f of frames||[]){
  if(!f||f.sessionId!==sessionId||canonical(f.quest)!==canonical(quest)||canonical(f.stage)!==canonical(stage)||!Number.isFinite(f.at)||f.at>now||now-f.at>2*3600000||!Number.isFinite(f.hud?.meters))continue;
  unique.set(`${f.nativeId}:${f.seq}`,f);
 }
 const ordered=[...unique.values()].sort((a,b)=>a.at-b.at),best=new Map(),bins=new Map();
 for(const f of ordered){
  const level=f.hud.elevation||'unspecified',prior=best.get(level);
  if(!prior||f.hud.meters<=prior.hud.meters)best.set(level,f);
  bins.set(Math.floor(f.at/30000),f);
 }
 const closestByElevation=[...best.values()].slice(0,3),recentCheckpoints=[...bins.values()].slice(-6);
 if(!recentCheckpoints.length)return null;
 return {source:'historical_bgi_hud_and_deepseek_image_assessments',quest,stage,sessionId,closestByElevation,recentCheckpoints,
  limitation:'历史图片判断可能有误；较近HUD可能隔墙或处于不同楼层，不是到达、坐标路线或当前可走方向。只用于辨认重复经过的地标；下一步必须依据当前BGI画面。'};
}
function entries(summary){return [...(summary?.closestByElevation||[]),...(summary?.recentCheckpoints||[])];}
module.exports={frame,summarize,entries};
