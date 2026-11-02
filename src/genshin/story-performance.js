'use strict';
const percentile=(values,p)=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?a[Math.min(a.length-1,Math.ceil(a.length*p)-1)]:null;};
function performance(rows,receipts,now){
 const calls=rows.flatMap(r=>r.modelCalls||[]),latencies=calls.map(c=>c.latencyMs);
 const checks=rows.map(r=>r.pipeline?.lookahead).filter(c=>c&&typeof c.ok==='boolean');
 const speculative=calls.filter(c=>c.phase==='lookahead');
 const hits=checks.filter(c=>c.ok).length;
 const steps=receipts.map(e=>e.step),first=Math.min(...rows.map(r=>r.request?.capturedAt||r.at));
 const last=Math.max(...steps.map(s=>s.finishedAt||0),...rows.map(r=>r.at||0));
 const wallMs=Number.isFinite(first)&&last>=first?last-first:0;
 const held=steps.reduce((sum,s)=>{let d;try{d=typeof s.detail==='string'?JSON.parse(s.detail):s.detail;}catch{}return sum+(d?.movementMsSent??d?.movedMs??0);},0);
 const incomplete=steps.some(s=>['travel_quest','search_area'].includes(s.action?.kind));
 const providers={};for(const r of rows){const p=r.provider||'unknown';providers[p]=(providers[p]||0)+1;}
 return {providers,modelLatencyMs:{p50:percentile(latencies,.5),p90:percentile(latencies,.9)},
  decisionWallMs:{p50:percentile(rows.map(r=>r.at-r.request?.capturedAt),.5),p90:percentile(rows.map(r=>r.at-r.request?.capturedAt),.9)},
  wallMs,movementDutyRatio:wallMs?held/wallMs:null,movementDutyIsLowerBound:incomplete,
  lookahead:{checks:checks.length,hits,hitRate:checks.length?hits/checks.length:null,chargedTokens:speculative.reduce((s,c)=>s+(c.usage?.total_tokens||0),0),
   // A call can finish after its evidence was charged; do not infer discarded billing from aggregate hit rate.
   discardedTokens:null,discardedTokenLimitation:'requires per-call consumed identity'},at:now};
}
module.exports={performance};
