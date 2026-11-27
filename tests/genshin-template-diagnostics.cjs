'use strict';
const {test}=require('node:test'),assert=require('node:assert/strict');
const {createTemplateDiagnostics}=require('../scripts/genshin/story/vision/template-diagnostics');
const names=['quest-marker.png','quest-marker-blue.png'];
const found=(score,x=100,y=200)=>({matchScore:score,x,y,width:20,height:10});
const collection=items=>({count:items.length,...items});
function fixture({matches=()=>[],loadError=null,productionError=false}={}){
 const loaded=[],derived=[],calls=[],recognizers=[];let capturesDisposed=0;
 function mat(name,width=20,height=10){return {name,width,height,disposed:0,dispose(){this.disposed++;}};}
 const diagnostic=createTemplateDiagnostics({
  loadTemplate(name){if(name===loadError)throw Error('cannot_load_fixture');const value=mat(name);loaded.push(value);return value;},
  createRecognizer(template,roi){
   const gray=mat('gray');derived.push(gray);
   const ro={templateImageMat:template,templateImageGreyMat:gray,maskMat:null,roi:[...roi],
    use3Channels:false,useBinaryMatch:false,binaryThreshold:128,templateMatchMode:5,
    clone(){const {useBinaryMatch,binaryThreshold,...copy}=this;return {...copy};}};
   recognizers.push(ro);return ro;
  },
 });
 const frame={width:1920,height:1080,dispose(){capturesDisposed++;},
  findMulti(ro){calls.push({name:ro.templateImageMat.name,threshold:ro.threshold,maxMatchCount:ro.maxMatchCount,
   draw:ro.drawOnWindow,roi:ro.roi,binary:ro.useBinaryMatch,binaryThreshold:ro.binaryThreshold});
   if(productionError&&ro.threshold!==-1)throw Error('match_failed');
   return collection(matches(ro.templateImageMat.name,ro.threshold,ro));
  }};
 return {diagnostic,frame,loaded,derived,calls,recognizers,get capturesDisposed(){return capturesDisposed;}};
}
test('subthreshold highest NCC is recorded without making a candidate or changing production threshold',()=>{
 const f=fixture({matches:(_,threshold)=>threshold===-1?[found(0.68)]:[]});
 const result=f.diagnostic.observe(f.frame,{roi:[300,0,1320,1080]});
 assert.equal(result.peaks.length,2);assert.equal(result.peaks[0].score,0.68);assert.equal(result.peaks[0].aboveThreshold,false);
 assert.equal(result.candidates.length,0);assert.equal(result.unique,null);assert.equal(result.accepted,false);
 assert.deepEqual(f.calls.map(c=>[c.threshold,c.maxMatchCount]),[[0.8,2],[-1,1],[0.8,2],[-1,1]]);
 assert.ok(f.recognizers.every(r=>r.threshold===0.8&&r.maxMatchCount===2));assert.ok(f.calls.every(c=>c.draw===false));
 f.diagnostic.dispose();
});
test('minimap production and diagnostic matches both retain color evidence',()=>{
 const seen=[];
 const f=fixture({matches:(_name,_threshold,ro)=>{seen.push(ro.use3Channels);return [];}});
 f.diagnostic.observe(f.frame,{templateNames:['minimap-commission.png'],kind:'minimap'});
 assert.deepEqual(seen,[true,true]);
 seen.length=0;
 f.diagnostic.observe(f.frame,{templateNames:[names[0]],kind:'screen'});
 assert.deepEqual(seen,[false,false]);
 f.diagnostic.dispose();
});
test('a high diagnostic peak alone is never accepted',()=>{
 const f=fixture({matches:(_,threshold)=>threshold===-1?[found(0.99)]:[]});
 const result=f.diagnostic.observe(f.frame,{templateNames:[names[0]]});
 assert.equal(result.peaks[0].aboveThreshold,true);assert.equal(result.accepted,false);assert.equal(result.unique,null);
 f.diagnostic.dispose();
});
test('null, undefined, NaN and Infinity never become numeric zero or serialize as trusted scores',()=>{
 for(const score of [null,undefined,NaN,Infinity,-Infinity]){
  const f=fixture({matches:(_,threshold)=>threshold===-1?[found(score)]:[]});
  const result=f.diagnostic.observe(f.frame,{templateNames:[names[0]]});
  assert.equal(result.peaks[0].score,null);assert.equal(result.peaks[0].aboveThreshold,false);assert.equal(result.accepted,false);
  assert.equal(result.peaks[0].status,score==null?'score_missing':'invalid_score');
  assert.doesNotThrow(()=>JSON.parse(JSON.stringify(result)));assert.equal(result.diagnosticsComplete,false);
  f.diagnostic.dispose();
 }
});
test('finite negative NCC is retained as diagnostic evidence',()=>{
 const f=fixture({matches:(_,threshold)=>threshold===-1?[found(-0.35)]:[]});
 const result=f.diagnostic.observe(f.frame,{templateNames:[names[0]]});
 assert.equal(result.peaks[0].status,'ok');assert.equal(result.peaks[0].score,-0.35);assert.equal(result.accepted,false);
 f.diagnostic.dispose();
});
test('template loading errors are explicit and cached; incomplete production cannot be accepted',()=>{
 const f=fixture({loadError:names[1],matches:()=>[found(0.91)]});
 const result=f.diagnostic.observe(f.frame,{});
 assert.equal(result.peaks[1].loaded,false);assert.equal(result.peaks[1].status,'template_load_error');
 assert.equal(result.productionComplete,false);assert.equal(result.candidates.length,1);assert.equal(result.accepted,false);
 f.diagnostic.observe(f.frame,{});assert.equal(f.loaded.length,1);
 f.diagnostic.dispose();
});
test('same-template multiple production matches remain ambiguous even with a diagnostic max of one',()=>{
 const f=fixture({matches:(_,threshold)=>threshold===-1?[found(0.94)]:[found(0.94,100,200),found(0.9,112,200)]});
 const result=f.diagnostic.observe(f.frame,{templateNames:[names[0]]});
 assert.equal(result.candidates.length,2);assert.equal(result.unique,null);assert.equal(result.accepted,false);
 assert.equal(result.peaks[0].score,0.94);f.diagnostic.dispose();
});
test('overlapping yellow and blue production detections merge while distinct targets do not',()=>{
 for(const separate of [false,true]){
  const f=fixture({matches:name=>[found(0.9,name===names[0]?100:separate?180:102,200)]});
  const result=f.diagnostic.observe(f.frame,{});
  assert.equal(result.candidates.length,separate?2:1);assert.equal(result.accepted,!separate);
  if(!separate){assert.deepEqual(result.unique.templates,names);assert.equal(result.unique.source,'production_threshold');}
  f.diagnostic.dispose();
 }
});
test('ROI offset is already present in results; diagnostics preserve origin and plain frame coordinates',()=>{
 const f=fixture({matches:()=>[found(0.93,310,45)]});
 const result=f.diagnostic.observe(f.frame,{templateNames:[names[0]],kind:'minimap',roi:[300,20,250,250]});
 assert.equal(result.coordinateSpace,'capture_frame_px');assert.deepEqual(result.peaks[0].box,[310,45,20,10]);
 assert.deepEqual(result.peaks[0].center,[320,50]);assert.equal(result.unique.x,320);assert.equal(result.unique.y,50);
 assert.equal(JSON.parse(JSON.stringify(result)).unique.x,320);f.diagnostic.dispose();
 const zero=fixture({matches:()=>[found(1,0,0)]});
 const atOrigin=zero.diagnostic.observe(zero.frame,{templateNames:[names[0]],roi:[0,0,20,10]});
 assert.equal(atOrigin.accepted,true);assert.deepEqual(atOrigin.unique.box,[0,0,20,10]);zero.diagnostic.dispose();
});
test('Mats are reused across scans, derived Mats released once, and caller frame remains owned by caller',()=>{
 const f=fixture({matches:()=>[found(0.9)]});
 f.diagnostic.observe(f.frame,{});f.diagnostic.observe(f.frame,{});
 assert.equal(f.loaded.length,2);assert.ok(f.loaded.every(m=>m.disposed===0));
 assert.equal(f.derived.length,4);assert.ok(f.derived.every(m=>m.disposed===1));assert.equal(f.capturesDisposed,0);
 f.diagnostic.dispose();f.diagnostic.dispose();assert.ok(f.loaded.every(m=>m.disposed===1));
 assert.throws(()=>f.diagnostic.observe(f.frame,{}),/disposed/);
});
test('recognizer preprocessing is shared, including the binary settings omitted by native Clone',()=>{
 const seen=[],gray={dispose(){}},mask={dispose(){}},mat={width:20,height:10,dispose(){}};
 const diagnostics=createTemplateDiagnostics({loadTemplate:()=>mat,createRecognizer:()=>({
  templateImageMat:mat,templateImageGreyMat:gray,maskMat:mask,use3Channels:true,useMask:true,
  useBinaryMatch:true,binaryThreshold:155,templateMatchMode:5,referenceImageSize:{width:1920,height:1080},
  clone(){const {useBinaryMatch,binaryThreshold,...copy}=this;return copy;},
 })});
 const frame={width:1920,height:1080,findMulti(ro){seen.push(ro);return collection([]);}};
 diagnostics.observe(frame,{templateNames:[names[0]]});
 for(const key of ['templateImageMat','templateImageGreyMat','maskMat','use3Channels','useMask','useBinaryMatch','binaryThreshold','templateMatchMode','referenceImageSize'])assert.equal(seen[0][key],seen[1][key],key);
 diagnostics.dispose();
});
test('matching failure still releases derived resources and does not accept a diagnostic-only result',()=>{
 const f=fixture({productionError:true,matches:()=>[found(0.98)]});
 const result=f.diagnostic.observe(f.frame,{templateNames:[names[0]]});
 assert.equal(result.productionComplete,false);assert.equal(result.accepted,false);
 assert.equal(result.peaks[0].score,0.98);assert.match(result.peaks[0].productionError,/match_failed/);
 assert.ok(f.derived.every(m=>m.disposed===1));f.diagnostic.dispose();
});
test('invalid ROI and a too-small ROI are reported without running matching',()=>{
 const f=fixture();
 const invalid=f.diagnostic.observe(f.frame,{templateNames:[names[0]],roi:[1900,1000,100,100]});
 assert.equal(invalid.peaks[0].status,'invalid_roi');assert.equal(invalid.accepted,false);
 const small=f.diagnostic.observe(f.frame,{templateNames:[names[0]],roi:[0,0,5,5]});
 assert.equal(small.peaks[0].status,'template_does_not_fit');assert.equal(f.calls.length,0);f.diagnostic.dispose();
});
test('PascalCase scalar host properties are copied into ordinary JSON values',()=>{
 const f=fixture({matches:()=>[{MatchScore:0.9,X:10,Y:20,Width:20,Height:10}]});
 const result=f.diagnostic.observe(f.frame,{templateNames:[names[0]]});
 assert.deepEqual(result.unique.center,[20,25]);assert.equal(result.peaks[0].score,0.9);
 assert.equal(Object.getPrototypeOf(result.unique),Object.prototype);assert.equal(result.unique.click,undefined);f.diagnostic.dispose();
});
