'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const grounding=require('../scripts/genshin/story-main');
const {corroborateDistances}=require('../src/genshin/story-observation');
const {validateDecision}=require('../src/genshin/story-runtime');

// Recorded OCR subsets from story 234844f6..., steps 12 and 13. No image,
// account identifier, live service, or game input is needed for these replays.
const overview=[
 {text:'果酒湖',box:[1132,20,77,29]},
 {text:'53/200',box:[1512,30,99,31]},
 {text:'星落湖',box:[1494,64,71,30]},
 {text:'摘星崖',box:[1768,99,75,31]},
 {text:'苍风高地',box:[1682,985,111,36]},
 {text:'探索度 23%',box:[1670,1020,123,29]},
];
const detail=[
 {text:'X',box:[1850,8,55,55]},
 {text:'+',box:[1448,20,29,31]},
 {text:'冒险家协会',box:[1490,18,147,35]},
 {text:'明冠峡',box:[430,31,92,36]},
 {text:'果酒湖',box:[854,103,83,31]},
 {text:'蒙德 蒙德城',box:[1484,103,119,29]},
 {text:'他们称自己「上至星天，下达九渊」。实际',box:[1452,155,431,29]},
 {text:'上好像从「找猫咪」到「探索秘境」都在其',box:[1452,191,427,26]},
 {text:'工作范围内。仰望星空，凝视深渊，都要脚',box:[1449,224,438,27]},
 {text:'蒙德城',box:[832,338,83,32]},
 {text:'传送至蒙德城',box:[1604,989,175,34]},
];
const world={scene:'world',uncertain:false,summary:'开阔道路，可以行走',visible_text:[],
 navigation:{terrain:'open',movement:'standing',marker:'center'},
 questArea:{state:'search_area'}};

for(const [kind,rows] of [['overview',overview],['detail',detail]]){
 test(`recorded map ${kind} is shared by scene and movement grounding`,()=>{
  const map=grounding.mapMenu(rows);
  assert.equal(map.kind,kind);
  assert.equal(map.source,'bettergi_ocr_map_layout');
  assert.equal(grounding.sceneCue(rows),'map');
  assert.equal(grounding.movementStop(rows),'map');
  assert.equal(grounding.interaction(rows).state,'not_world');
  if(kind==='overview')assert.equal(map.region,'苍风高地');
  else assert.equal(map.title,'冒险家协会');
 });
 test(`recorded map ${kind} replaces erroneous world navigation`,()=>{
  const result=corroborateDistances(world,rows);
  assert.equal(result.observation.scene,'map');
  assert.equal(result.observation.map.kind,kind);
  assert.equal(result.observation.navigation.terrain,'unknown');
  assert.equal(result.observation.navigation.movement,'unknown');
  assert.equal(result.observation.navigation.marker,'not_visible');
  assert.equal(result.observation.questArea,undefined);
  assert.equal(result.observation.questDistanceLabel,undefined);
  assert.equal(result.sceneEvidence,'bettergi_map_layout');
  assert.equal(world.scene,'world','corroboration must not mutate the model observation');
 });
 test(`map ${kind} rejects movement and F even if the model still reports world`,()=>{
  // A plausible incidental F/label pair must not override map layout evidence.
  const texts=[...rows,{text:'F',box:[1130,500,30,30]},
   {text:'凯瑟琳',box:[1170,500,100,30]}];
  const corrected=corroborateDistances(world,texts).observation;
  const request={texts,distanceEvidence:{meters:[80]}};
  for(const observation of [world,corrected]){
   for(const action of [{kind:'move',key:'W',ms:300},
    {kind:'advance_quest',key:'W'},{kind:'follow_marker'},
    {kind:'key',key:'F',text:'凯瑟琳'}]){
    assert.throws(()=>validateDecision({action},request,observation),
     `${kind}: ${action.kind}/${action.key||''} must not pass as ${observation.scene}`);
   }
  }
 });
}

test('single place name or teleport label is insufficient map evidence',()=>{
 for(const texts of [[{text:'蒙德城',box:[832,338,83,32]}],
  [{text:'传送',box:[1604,989,175,34]}],
  [{text:'传送至蒙德城',box:[1604,989,175,34]}]]){
  assert.equal(grounding.mapMenu(texts),null);
  assert.equal(grounding.sceneCue(texts),null);
  assert.equal(grounding.movementStop(texts),null);
  assert.equal(corroborateDistances(world,texts).observation.scene,'world');
 }
});

test('map labels without their recorded screen layout do not override world',()=>{
 for(const rows of [overview,detail]){
  const displaced=rows.map(row=>({...row,box:[100,200,row.box[2],row.box[3]]}));
  const unpositioned=rows.map(({text})=>({text}));
  for(const texts of [displaced,unpositioned]){
   assert.equal(grounding.mapMenu(texts),null);
   assert.equal(corroborateDistances(world,texts).observation.scene,'world');
  }
 }
});
