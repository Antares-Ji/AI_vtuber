function frameMetrics(frames){
 const groups=new Map();
 for(const f of frames)if(f.phase==='held'){if(!groups.has(f.gesture))groups.set(f.gesture,[]);groups.get(f.gesture).push(f);}
 const bursts=[];
 for(const [gesture,items] of groups){
  items.sort((a,b)=>a.capturedAt-b.capturedAt);
  const duration=items.at(-1).capturedAt-items[0].capturedAt;
  if(duration<1000||items.length<5)continue;
  const times=[...new Set(items.map(f=>f.capturedAt))].sort((a,b)=>a-b);
  const source=items.every(f=>Number.isFinite(f.mediaTime))?new Set(items.map(f=>f.mediaTime)).size:null;
  bursts.push({gesture,durationMs:duration,captureFps:+((times.length-1)*1000/duration).toFixed(1),sourceFps:source===null?null:+((source-1)*1000/duration).toFixed(1),maxGapMs:Math.max(...times.slice(1).map((t,i)=>t-times[i]))});
 }
 return {frameCount:frames.length,bursts,verified:false,note:'采样与视频时间戳统计，不等于零丢帧保证；需连续按住至少1秒才统计。'};
}
module.exports={frameMetrics};
