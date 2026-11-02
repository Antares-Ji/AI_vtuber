'use strict';
// Read-only progress evaluation for supervisors. No game input, model calls,
// screenshots, POSTs or session changes. Reports whether recorded frames show
// real quest progress (HUD distance / stage), not whether the quest succeeded.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'../..'),base=path.join(root,'runtime/genshin');
const args=process.argv.slice(2),opt=k=>{const i=args.indexOf(k);return i>=0?args[i+1]:null;};
const windowMin=Number(opt('--minutes'))||null,recent=Number(opt('--recent'))||12;
const readJson=f=>{try{return JSON.parse(fs.readFileSync(f,'utf8'));}catch{return null;}};

function loadFrames(from){
 const rows=[],dir=path.join(base,'story');
 if(!fs.existsSync(dir))return rows;
 for(const d of fs.readdirSync(dir,{withFileTypes:true}).filter(d=>d.isDirectory())){
  for(const n of fs.readdirSync(path.join(dir,d.name)).filter(n=>/^step-\d+\.json$/.test(n))){
   const row=readJson(path.join(dir,d.name,n));
   if(row?.at>=from)rows.push(row);
  }
 }
 return rows.sort((a,b)=>a.at-b.at);
}
function detail(step){try{return JSON.parse(step?.detail);}catch{return null;}}
// Milliseconds of movement input the native receipt says it actually sent.
function movedMs(step){
 const d=detail(step),k=step?.action?.kind;
 if(k==='move'||k==='follow_marker')return Number(d?.movedMs)||0;
 if(k==='advance_quest')return (d?.trace?.length||0)*400;
 return 0;
}
function hudDistance(r){const m=r.distanceEvidence?.meters||r.observation?.distanceEvidence?.meters||[];return m.length===1?m[0]:null;}
function hudStage(r){return r.observation?.trackingEvidence?.hudStage||null;}

function evaluate(rows,now=Date.now()){
 const tokens=rows.reduce((s,r)=>s+(r.modelCalls||[r]).reduce((t,c)=>t+(c.usage?.total_tokens||0),0),0);
 const scenes={},actions={};let moved=0,fSent=0,rejected=0;
 for(const r of rows){
  const sc=r.observation?.scene||'unknown';scenes[sc]=(scenes[sc]||0)+1;
  const k=r.decision?.action?.kind||'none';actions[k]=(actions[k]||0)+1;
  if(Array.isArray(r.rejected))rejected+=r.rejected.length;
  const last=r.request?.lastStep;moved+=movedMs(last);
  if(detail(last)?.kind==='interaction'&&detail(last).sent)fSent++;
 }
 const distances=rows.map(r=>({at:r.at,m:hudDistance(r)})).filter(x=>x.m!==null);
 const stages=[];for(const r of rows){const s=hudStage(r);if(s&&stages[stages.length-1]!==s)stages.push(s);}
 const tail=rows.slice(-recent),tailDist=tail.map(hudDistance).filter(x=>x!==null);
 const tailNonWorld=tail.filter(r=>r.observation?.scene!=='world').length;
 let repeat=0,maxRepeat=0,prev=null;
 for(const r of tail){const a=JSON.stringify(r.decision?.action||null);repeat=a===prev?repeat+1:1;maxRepeat=Math.max(maxRepeat,repeat);prev=a;}
 const tailTokens=tail.reduce((s,r)=>s+(r.modelCalls||[r]).reduce((t,c)=>t+(c.usage?.total_tokens||0),0),0);
 const tailStages=new Set(tail.map(hudStage).filter(Boolean));
 const gained=tailDist.length>=2?tailDist[0]-tailDist[tailDist.length-1]:0;
 const alerts=[];
 if(rows.length&&now-rows[rows.length-1].at>10*60000)alerts.push({code:'NO_NEW_FRAMES',msg:'超过10分钟没有新帧'});
 if(tail.length>=6&&tailNonWorld/tail.length>0.6)alerts.push({code:'MENU_LOOP',msg:`最近${tail.length}帧有${tailNonWorld}帧不在大世界`});
 if(maxRepeat>=4)alerts.push({code:'REPEATED_ACTION',msg:`同一动作连续重复${maxRepeat}次`});
 if(tail.length>=8&&gained<5&&tailStages.size<=1)alerts.push({code:'NO_PROGRESS',msg:`最近${tail.length}帧距离仅下降${gained}m且阶段未变`});
 if(tailTokens>150000&&gained<5&&tailStages.size<=1)alerts.push({code:'TOKEN_BURN',msg:`最近窗口消耗${tailTokens}tokens但无可测进展`});
 const verdict=!rows.length?'idle':alerts.some(a=>a.code==='NO_NEW_FRAMES')?'idle':gained>=5||tailStages.size>1?'progressing':alerts.length?'stalled':'unclear';
 return {
  at:now,frames:rows.length,from:rows[0]?.at||null,to:rows[rows.length-1]?.at||null,
  tokens,tokensPerFrame:rows.length?Math.round(tokens/rows.length):0,
  scenes,actions,rejectedDecisions:rejected,movementMsSent:moved,fInteractionsSent:fSent,
  distance:{first:distances[0]?.m??null,last:distances[distances.length-1]?.m??null,min:distances.length?Math.min(...distances.map(x=>x.m)):null,readings:distances.length},
  stages,recentWindow:{frames:tail.length,nonWorld:tailNonWorld,maxRepeat,tokens:tailTokens,distanceGained:gained,stages:[...tailStages]},
  verdict,alerts,
  limitation:'基于本地OCR距离与HUD阶段文字；距离漏读或镜头内无HUD时会低估进展。不证明任务完成，也不计算F成功率。'
 };
}
module.exports={evaluate,movedMs};
if(require.main===module){
 const session=readJson(path.join(base,'training-session.json'));
 const from=windowMin?Date.now()-windowMin*60000:(session?.startedAt||0);
 const report={sessionId:session?.sessionId||null,sessionState:session?.revoked?'stopped':session?.status||'unknown',...evaluate(loadFrames(from))};
 fs.writeFileSync(path.join(base,'progress-evaluation.json'),JSON.stringify(report,null,2));
 const d=report.distance;
 console.log(`[${report.verdict}] 会话${report.sessionState} 帧${report.frames} token${report.tokens} 移动${report.movementMsSent}ms F${report.fInteractionsSent} 距离${d.first??'-'}→${d.last??'-'}m 阶段${report.stages.length} 非大世界${report.scenes.world?report.frames-report.scenes.world:report.frames}/${report.frames}`);
 for(const a of report.alerts)console.log(`  ! ${a.code}: ${a.msg}`);
}
