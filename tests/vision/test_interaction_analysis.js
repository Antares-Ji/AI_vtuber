const assert=require('node:assert/strict');
const {analyzeInteractions}=require('../../src/vision/interaction-analysis');
const event=(gesture,type,elapsedMs,x=50,y=50)=>({gesture,type,elapsedMs,at:1000+elapsedMs,x,y,width:800,height:600});
const events=[event(1,'down',0),event(1,'up',100),event(2,'down',200),event(2,'up',1000),
  event(3,'down',1100),event(3,'move',1300,100),event(3,'up',1400,50),
  event(4,'down',1500),event(4,'cancel',1600,null,null),event(5,'down',1700)];
const result=analyzeInteractions(events,[{gesture:3,file:'frame-001.jpg'}]);
assert.deepEqual(result.map(r=>r.kind),['short-click','long-press','drag','incomplete','incomplete']);
assert.equal(result[2].maxDisplacement,50,'return to origin still counts as drag');
assert.equal(result[2].frames.length,1);
assert(result.every(r=>r.controlType==='unknown' && r.stateChange==='unverified'));
console.log('Interaction analysis: short/long/drag/return path/cancel/missing up and no false switch assertion passed.');
const more=analyzeInteractions([
 {...event(6,'wheel',2000),input:'wheel:vertical',delta:-120},
 {...event(7,'down',2100,null,null),input:'key:65:30:0'},
 {...event(7,'repeat',2500,null,null),input:'key:65:30:0'},
 {...event(7,'up',2900,null,null),input:'key:65:30:0'},
 {...event(8,'down',2150),input:'mouse:right'}, {...event(8,'up',2200),input:'mouse:right'}],[]);
assert.deepEqual(more.map(r=>r.kind),['wheel','key-hold','short-click']);
assert.equal(more[1].repeatCount,1);
assert.equal(more[1].maxDisplacement,0);
