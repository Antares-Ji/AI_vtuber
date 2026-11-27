'use strict';

// Geometry only: never reads game memory, chooses a gameplay action, or sends
// input. DeepSeek must choose among assessed candidates once a real, calibrated
// state adapter exists. All distances use ONE local ground plane in meters.
function capabilities() {
  return {
    mode: 'preset-dash', reactiveDodgeReady: false, assessmentAvailable: true,
    directEnemyState: false, attackTiming: false, attackGeometry: false,
    movementCalibration: false,
    reason: '当前 BetterGI 接口未提供敌方攻击时间和范围，尚无实测冲刺距离/体力标定；预设冲刺不等于反应式闪避。',
    missing: ['enemy-attack-state', 'attack-windows-and-shapes', 'player-hitbox-and-stamina', 'ground-obstacles', 'dash-calibration'],
  };
}

const finite = n => typeof n === 'number' && Number.isFinite(n);
const nonnegative = n => finite(n) && n >= 0;
const positive = n => finite(n) && n > 0;
const point = p => p && finite(p.x) && finite(p.y);
const circle = c => c && point(c.center) && positive(c.radius);
const lerp = (a, b, f) => ({x:a.x+(b.x-a.x)*f, y:a.y+(b.y-a.y)*f});
function segmentDistance(a, b, center) {
  const x=b.x-a.x, y=b.y-a.y, length=x*x+y*y;
  const f=length ? Math.max(0,Math.min(1,((center.x-a.x)*x+(center.y-a.y)*y)/length)) : 0;
  return Math.hypot(a.x+x*f-center.x, a.y+y*f-center.y);
}

function assessDodgeCandidates(snapshot, calibration, {now=Date.now(), maxAgeMs=150, maxDashes=3}={}) {
  const unavailable = reason => ({status:'unavailable',reason,candidates:[],selected:null,verified:false});
  if (!finite(now)||!positive(maxAgeMs)||maxAgeMs>500||!Number.isInteger(maxDashes)||maxDashes<1||maxDashes>3)
    return unavailable('invalid-assessment-options');
  if (!snapshot || !['direct-state','visual-estimate','simulation'].includes(snapshot.source))
    return unavailable('missing-state-source');
  if (!finite(snapshot.observedAtMs)||!finite(snapshot.validUntilMs)||now<snapshot.observedAtMs||now-snapshot.observedAtMs>maxAgeMs)
    return unavailable('stale-or-invalid-state');
  if (snapshot.frame!=='local-ground-meters'||snapshot.complete!==true)
    return unavailable('incomplete-ground-state');
  const p=snapshot.player, u=snapshot.uncertainty;
  if (!point(p)||!positive(p.radius)||!nonnegative(p.stamina)||!nonnegative(p.animationLockMs))
    return unavailable('missing-player-state');
  if (!u||!nonnegative(u.positionM)||!nonnegative(u.timingMs)) return unavailable('missing-uncertainty');
  const threats=snapshot.threats, obstacles=snapshot.obstacles;
  // Arbitrary shapes/moving hitboxes must be converted to conservative circles
  // with explicit time windows by the observation adapter, never guessed here.
  if (!Array.isArray(threats)||threats.length>64||!Array.isArray(obstacles)||obstacles.length>128||
      threats.some(t=>!circle(t)||t.shape!=='circle'||typeof t.id!=='string'||!finite(t.startsAtMs)||!finite(t.endsAtMs)||t.endsAtMs<t.startsAtMs)||
      obstacles.some(o=>!circle(o)||o.shape!=='circle')) return unavailable('unsupported-or-invalid-geometry');
  const c=calibration;
  if (!c||!['measured','simulation'].includes(c.source)||typeof c.profileId!=='string'||!c.profileId||
      c.profileId!==p.movementProfileId||!positive(c.distanceM)||!positive(c.durationMs)||!nonnegative(c.gapMs)||
      !positive(c.staminaCost)||!nonnegative(c.reserveStamina)||!nonnegative(c.inputLatencyMs)||!nonnegative(c.distanceErrorM)||
      !finite(c.validUntilMs)||c.validUntilMs<now) return unavailable('missing-or-expired-movement-calibration');
  if(snapshot.source!=='simulation'&&c.source!=='measured')return unavailable('simulation-calibration-cannot-assess-live-state');
  const start=now+p.animationLockMs+c.inputLatencyMs;
  const active=threats.filter(t=>t.endsAtMs+u.timingMs>=now);
  const horizon=Math.max(now,...active.map(t=>t.endsAtMs+u.timingMs));
  if(horizon-now>5000||snapshot.validUntilMs<horizon)return unavailable('insufficient-prediction-horizon');
  const results=[];
  // Include staying in place so the planner can avoid unnecessary stamina use.
  for(let count=0;count<=maxDashes;count++) {
    if(count*c.staminaCost+c.reserveStamina>p.stamina&&count>0)continue;
    for(let direction=0;direction<(count?8:1);direction++) {
      const angle=direction*Math.PI/4, dx=Math.cos(angle),dy=Math.sin(angle);
      const points=[{x:p.x,y:p.y,t:now}];
      let x=p.x,y=p.y,t=start;
      if(count)points.push({x,y,t});
      for(let i=0;i<count;i++) {
        x+=dx*c.distanceM;y+=dy*c.distanceM;t+=c.durationMs;
        points.push({x,y,t});
        if(i<count-1){t+=c.gapMs;points.push({x,y,t});}
      }
      const end=Math.max(t,horizon);
      if(end>snapshot.validUntilMs||end>c.validUntilMs)continue;
      points.push({x,y,t:end});
      const hitThreats=new Set();let blocked=false,clearance=Infinity;
      const inflate=p.radius+u.positionM+count*c.distanceErrorM;
      for(let j=1;j<points.length;j++) {
        const a=points[j-1],b=points[j];
        for(const o of obstacles)if(segmentDistance(a,b,o.center)<=o.radius+inflate)blocked=true;
        for(const threat of active) {
          const from=Math.max(a.t,threat.startsAtMs-u.timingMs),to=Math.min(b.t,threat.endsAtMs+u.timingMs);
          if(from>to)continue;
          const span=b.t-a.t;
          const aa=span?lerp(a,b,(from-a.t)/span):a,bb=span?lerp(a,b,(to-a.t)/span):b;
          const margin=segmentDistance(aa,bb,threat.center)-threat.radius-inflate;
          clearance=Math.min(clearance,margin);
          if(margin<=0)hitThreats.add(threat.id);
        }
      }
      results.push({id:count?`direction-${direction}-dashes-${count}`:'stay',directionGroundDegrees:count?direction*45:null,
        dashCount:count,staminaCost:count*c.staminaCost,trajectory:points,blocked,
        movementStartsAtMs:count?start:null,movementEndsAtMs:count?t:null,
        intersectsThreats:[...hitThreats],minimumClearanceM:Number.isFinite(clearance)?clearance:null,
        feasible:!blocked&&!hitThreats.size});
    }
  }
  const feasible=results.filter(candidate=>candidate.feasible);
  const directionRequirements=Array.from({length:8},(_,direction)=>{
    const matches=feasible.filter(candidate=>candidate.directionGroundDegrees===direction*45);
    return {directionGroundDegrees:direction*45,
      minimumDashes:matches.length?Math.min(...matches.map(candidate=>candidate.dashCount)):null,
      candidateIds:matches.map(candidate=>candidate.id)};
  });
  // Preserve every candidate; no automatic action selection or key generation.
  return {status:results.length?'assessed':'unavailable',reason:results.length?null:'no-covered-trajectories',
    source:snapshot.source,simulation:snapshot.source==='simulation',observedAtMs:snapshot.observedAtMs,
    assessedAtMs:now,
    expiresAtMs:Math.min(snapshot.observedAtMs+maxAgeMs,snapshot.validUntilMs,c.validUntilMs),
    escapeSummary:{stayFeasible:feasible.some(candidate=>candidate.dashCount===0),
      minimumDashes:feasible.length?Math.min(...feasible.map(candidate=>candidate.dashCount)):null,
      noFeasibleCandidate:feasible.length===0,directionRequirements},
    attackCountdowns:active.map(t=>({id:t.id,earliestMs:Math.max(0,t.startsAtMs-u.timingMs-now),latestMs:Math.max(0,t.startsAtMs+u.timingMs-now)})),
    candidates:results,selected:null,verified:false,
    limitations:['仅评估已提供的攻击与障碍','不假设冲刺无敌帧','冲刺距离按标定的线性运动估计','只评估八个地面方向的同向冲刺，不代表所有路径','方位角不是屏幕方向或按键，需相机朝向映射','模型返回后必须用新状态复算；执行一次后再次观察']};
}

// The caller supplies a NEW observation after the model returns. Never trust
// a candidate's old feasible flag or let model/network latency freeze time.
// This only checks the model's choice; it cannot authorize or send game input.
function recheckDodgeCandidate(previousAssessment, candidateId, snapshot, calibration, options={}) {
  const rejected=reason=>({status:'rejected',reason,selected:null,verified:false});
  if(!previousAssessment||previousAssessment.status!=='assessed'||!finite(previousAssessment.assessedAtMs)||
      !Array.isArray(previousAssessment.candidates)||typeof candidateId!=='string'||
      !previousAssessment.candidates.some(candidate=>candidate.id===candidateId&&candidate.feasible))
    return rejected('not-a-previously-feasible-candidate');
  if(!snapshot||snapshot.source!==previousAssessment.source||
      !finite(snapshot.observedAtMs)||snapshot.observedAtMs<=previousAssessment.assessedAtMs)
    return rejected('new-observation-required');
  const assessment=assessDodgeCandidates(snapshot,calibration,options);
  if(assessment.status!=='assessed')return rejected(assessment.reason);
  const candidate=assessment.candidates.find(item=>item.id===candidateId);
  if(!candidate||!candidate.feasible)return rejected('candidate-no-longer-feasible');
  return {status:'rechecked',candidate,assessment,selected:null,verified:false};
}
module.exports={capabilities,assessDodgeCandidates,recheckDodgeCandidate};
