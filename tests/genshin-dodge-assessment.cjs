'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {assessDodgeCandidates,capabilities,recheckDodgeCandidate}=require('../src/genshin/dodge-assessment');
function fixture(){return {
  snapshot:{source:'simulation',observedAtMs:1000,validUntilMs:4000,frame:'local-ground-meters',complete:true,
    player:{x:0,y:0,radius:0.3,stamina:100,animationLockMs:0,movementProfileId:'test'},
    uncertainty:{positionM:0.1,timingMs:0},
    threats:[{id:'slam',shape:'circle',center:{x:0,y:0},radius:3,startsAtMs:1800,endsAtMs:1900}],obstacles:[]},
  calibration:{source:'simulation',profileId:'test',distanceM:2,durationMs:200,gapMs:100,staminaCost:20,reserveStamina:10,inputLatencyMs:0,distanceErrorM:0,validUntilMs:5000}
};}
function assess(f){return assessDodgeCandidates(f.snapshot,f.calibration,{now:1000});}
test('one dash remains in blast, two can exit; assessment does not select or claim success',()=>{
  const r=assess(fixture());assert.equal(r.status,'assessed');assert.equal(r.simulation,true);
  assert.equal(r.candidates.find(c=>c.id==='stay').feasible,false);
  assert.ok(r.candidates.filter(c=>c.dashCount===1).every(c=>!c.feasible));
  assert.ok(r.candidates.filter(c=>c.dashCount===2).every(c=>c.feasible));
  assert.equal(r.selected,null);assert.equal(r.verified,false);
  assert.deepEqual(r.attackCountdowns,[{id:'slam',earliestMs:800,latestMs:800}]);
});
test('a second enemy rules out an otherwise successful direction',()=>{
  const f=fixture();f.snapshot.threats.push({id:'other',shape:'circle',center:{x:4,y:0},radius:1,startsAtMs:1700,endsAtMs:2100});
  const r=assess(f);assert.equal(r.candidates.find(c=>c.id==='direction-0-dashes-2').feasible,false);
  assert.equal(r.candidates.find(c=>c.id==='direction-4-dashes-2').feasible,true);
});
test('swept path checks obstacles, not just destination',()=>{
  const f=fixture();f.snapshot.obstacles.push({shape:'circle',center:{x:1,y:0},radius:0.1});
  const r=assess(f);assert.equal(r.candidates.find(c=>c.id==='direction-0-dashes-2').blocked,true);
  assert.equal(r.candidates.find(c=>c.id==='direction-4-dashes-2').blocked,false);
});
test('active attack on intermediate path is caught even when endpoints are outside',()=>{
  const f=fixture();f.snapshot.threats=[{id:'crossing',shape:'circle',center:{x:1,y:0},radius:0.1,startsAtMs:1050,endsAtMs:1150}];
  assert.equal(assess(f).candidates.find(c=>c.id==='direction-0-dashes-1').feasible,false);
});
test('input latency and animation lock consume the attack countdown',()=>{
  const f=fixture();f.snapshot.player.animationLockMs=600;f.calibration.inputLatencyMs=300;
  assert.ok(assess(f).candidates.every(c=>!c.feasible));
});
test('stamina limits rule out repeated dashes, rather than inventing a sufficient count',()=>{
  const f=fixture();f.snapshot.player.stamina=35;const r=assess(f);
  assert.ok(r.candidates.every(c=>c.dashCount<=1));assert.ok(r.candidates.every(c=>!c.feasible));
});
test('uncertainty inflates both impact area and timing, including instantaneous attacks',()=>{
  const f=fixture();f.snapshot.uncertainty={positionM:2,timingMs:100};f.snapshot.threats[0].endsAtMs=1800;
  const r=assess(f);assert.ok(r.candidates.filter(c=>c.dashCount===2).every(c=>!c.feasible));
  assert.deepEqual(r.attackCountdowns[0],{id:'slam',earliestMs:700,latestMs:900});
});
test('no precise claims from missing, stale, partial, unsupported or mismatched state',()=>{
  const variations=[f=>{f.snapshot=null;},f=>{f.snapshot.observedAtMs=700;},f=>{f.snapshot.complete=false;},
    f=>{f.snapshot.threats[0].shape='cone';},f=>{f.snapshot.validUntilMs=1500;},
    f=>{f.calibration.profileId='different-character';},f=>{f.calibration.validUntilMs=999;},
    f=>{f.snapshot.player.stamina=NaN;},f=>{f.snapshot.source='direct-state';}];
  for(const change of variations){const f=fixture();change(f);const r=assess(f);assert.equal(r.status,'unavailable');assert.deepEqual(r.candidates,[]);}
});
test('current runtime capability explicitly distinguishes preset movement from reactive dodge',()=>{
  const c=capabilities();assert.equal(c.reactiveDodgeReady,false);assert.equal(c.directEnemyState,false);
  assert.equal(c.assessmentAvailable,true);assert.equal(c.mode,'preset-dash');
});
test('summary reports the fewest feasible dashes per direction without choosing one',()=>{
  const f=fixture();f.snapshot.obstacles.push({shape:'circle',center:{x:1,y:0},radius:0.1});
  const r=assess(f);
  assert.equal(r.escapeSummary.minimumDashes,2);
  assert.equal(r.escapeSummary.stayFeasible,false);
  assert.equal(r.escapeSummary.directionRequirements[0].minimumDashes,null);
  assert.equal(r.escapeSummary.directionRequirements[4].minimumDashes,2);
  assert.equal(r.candidates.find(c=>c.id==='direction-4-dashes-2').movementEndsAtMs,1500);
  assert.equal(r.selected,null);
});
test('no feasible route is distinct from zero dashes needed',()=>{
  const f=fixture();f.snapshot.player.stamina=10;
  let r=assess(f);assert.equal(r.escapeSummary.minimumDashes,null);
  assert.equal(r.escapeSummary.noFeasibleCandidate,true);
  f.snapshot.threats=[];
  r=assess(f);assert.equal(r.escapeSummary.minimumDashes,0);
  assert.equal(r.escapeSummary.noFeasibleCandidate,false);
  assert.equal(r.escapeSummary.stayFeasible,true);
});
test('a model response cannot reuse its original observation',()=>{
  const f=fixture(),old=assess(f);
  assert.equal(recheckDodgeCandidate(old,'direction-0-dashes-2',f.snapshot,f.calibration,{now:1010}).reason,'new-observation-required');
  f.snapshot.observedAtMs=1010;
  const r=recheckDodgeCandidate(old,'direction-0-dashes-2',f.snapshot,f.calibration,{now:1010});
  assert.equal(r.status,'rechecked');assert.equal(r.selected,null);assert.equal(r.verified,false);
  assert.equal(r.assessment.assessedAtMs,1010);
});
test('model latency consumes the countdown even when a fresh frame is available',()=>{
  const f=fixture();f.snapshot.threats[0].startsAtMs=1510;
  const old=assess(f);assert.ok(old.candidates.find(c=>c.id==='direction-0-dashes-2').feasible);
  f.snapshot.observedAtMs=1100;
  assert.equal(recheckDodgeCandidate(old,'direction-0-dashes-2',f.snapshot,f.calibration,{now:1100}).reason,'candidate-no-longer-feasible');
});
test('recheck rejects changed stamina, obstacles, stale data and invented model choices',()=>{
  for(const change of [f=>{f.snapshot.player.stamina=10;},
    f=>{f.snapshot.obstacles.push({shape:'circle',center:{x:1,y:0},radius:0.1});}]){
    const f=fixture(),old=assess(f);f.snapshot.observedAtMs=1010;change(f);
    assert.equal(recheckDodgeCandidate(old,'direction-0-dashes-2',f.snapshot,f.calibration,{now:1010}).status,'rejected');
  }
  const f=fixture(),old=assess(f);f.snapshot.observedAtMs=1010;
  assert.equal(recheckDodgeCandidate(old,'direction-0-dashes-2',f.snapshot,f.calibration,{now:2000}).reason,'stale-or-invalid-state');
  assert.equal(recheckDodgeCandidate(old,'teleport',f.snapshot,f.calibration,{now:1010}).reason,'not-a-previously-feasible-candidate');
});
