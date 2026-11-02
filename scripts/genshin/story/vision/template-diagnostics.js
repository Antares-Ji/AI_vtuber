// Pure matching on an already captured frame. Never captures, activates a
// window, or sends input. Only production-threshold results can be accepted.
const StoryTemplateDiagnostics=(()=>{
  const DEFAULT_TEMPLATES=['quest-marker.png','quest-marker-blue.png'];
  const read=(object,key)=>{
    if(object==null)return undefined;
    const lower=object[key];
    return lower===undefined?object[key[0].toUpperCase()+key.slice(1)]:lower;
  };
  function number(value){
    if(value===null||value===undefined)return null;
    const converted=Number(value);return Number.isFinite(converted)?converted:null;
  }
  function dispose(mat){
    if(!mat)return;
    if(mat.dispose!==undefined)mat.dispose();else if(mat.Dispose!==undefined)mat.Dispose();
  }
  function rectangle(value){
    const values=Array.isArray(value)?value:[read(value,'x'),read(value,'y'),read(value,'width'),read(value,'height')];
    if(values.length!==4)return null;
    const box=values.map(number);
    return box.every(v=>v!==null)&&box[0]>=0&&box[1]>=0&&box[2]>0&&box[3]>0?box:null;
  }
  function resultRegion(item,frameSize){
    const box=rectangle(item);
    if(!box||box[0]+box[2]>frameSize[0]||box[1]+box[3]>frameSize[1])return null;
    // ImageRegion.FindMulti already adds the ROI offset. These coordinates are
    // in the provided frame, not relative to the RecognitionObject's ROI.
    const center=[box[0]+box[2]/2,box[1]+box[3]/2];
    return {box,center,x:center[0],y:center[1]};
  }
  function count(collection){return number(read(collection,'count')??collection?.length);}
  function createTemplateDiagnostics(deps={}){
    const load=deps.loadTemplate||(name=>deps.file.readImageMatSync(name));
    const create=deps.createRecognizer||((mat,roi)=>deps.RecognitionObject.templateMatch(mat,...roi));
    const cache=new Map(),loadedMats=new Set();let closed=false;
    function template(name){
      if(cache.has(name))return cache.get(name);
      let entry;
      try{
        if(typeof name!=='string'||!/^[-\w.]+\.png$/i.test(name)||name.includes('..'))throw Error('invalid_template_name');
        const mat=load(name);if(!mat)throw Error('empty_template');
        loadedMats.add(mat);entry={mat,loaded:true};
      }catch(error){entry={mat:null,loaded:false,error:String(error.message||error).slice(0,180)};}
      cache.set(name,entry);return entry;
    }
    function observe(frame,{templateNames=DEFAULT_TEMPLATES,roi=null,productionThreshold=0.8,kind='screen'}={}){
      if(closed)throw Error('Template diagnostics already disposed');
      if(!Array.isArray(templateNames)||!templateNames.length||templateNames.length>16||templateNames.some(n=>typeof n!=='string'))throw Error('Invalid template list');
      if(typeof kind!=='string'||!kind||kind.length>64)throw Error('Invalid diagnostic kind');
      if(!Number.isFinite(productionThreshold)||productionThreshold<-1||productionThreshold>1)throw Error('Invalid production threshold');
      const names=[...new Set(templateNames)],frameSize=[number(read(frame,'width')),number(read(frame,'height'))];
      const region=rectangle(roi||[0,0,...frameSize]);
      const validRoi=frameSize.every(n=>n!==null&&n>0)&&region&&region[0]+region[2]<=frameSize[0]&&region[1]+region[3]<=frameSize[1];
      const out={kind,roi:region,frameSize,coordinateSpace:'capture_frame_px',productionThreshold,
        diagnosticThreshold:-1,peaks:[],candidates:[],unique:null,accepted:false,productionComplete:true,diagnosticsComplete:true};
      for(const name of names){
        const entry=template(name),peak={template:name,loaded:entry.loaded,score:null,status:'pending',box:null,center:null,aboveThreshold:false};
        out.peaks.push(peak);
        if(!entry.loaded){peak.status='template_load_error';peak.error=entry.error;out.productionComplete=false;out.diagnosticsComplete=false;continue;}
        if(!validRoi){peak.status='invalid_roi';out.productionComplete=false;out.diagnosticsComplete=false;continue;}
        const width=number(read(entry.mat,'width')),height=number(read(entry.mat,'height'));
        if(width!==null&&height!==null&&(width<=0||height<=0||width>region[2]||height>region[3])){
          peak.status='template_does_not_fit';out.productionComplete=false;out.diagnosticsComplete=false;continue;
        }
        let production=null;const derived=new Set();
        try{
          production=create(entry.mat,region);
          if(deps.configureRecognizer)deps.configureRecognizer(production,{template:name,kind});
          // Tiny minimap symbols need their color evidence as well as shape.
          // Screen tracking keeps its existing preprocessing.
          if(kind==='minimap')production.use3Channels=true;
          production.threshold=productionThreshold;production.maxMatchCount=2;production.drawOnWindow=false;
          // Clone shares template/gray/mask Mats, avoiding a second conversion.
          // BetterGI Clone omits these binary settings, so copy them explicitly.
          const diagnostic=production.clone();
          for(const key of ['useBinaryMatch','binaryThreshold']){
            const value=read(production,key);if(value!==undefined)diagnostic[key]=value;
          }
          diagnostic.threshold=-1;diagnostic.maxMatchCount=1;diagnostic.drawOnWindow=false;
          try{
            const matches=frame.findMulti(production),total=count(matches);
            if(!Number.isInteger(total)||total<0||total>2)throw Error('invalid_production_result_count');
            for(let i=0;i<total;i++){
              const item=matches[i],located=resultRegion(item,frameSize),score=number(read(item,'matchScore'));
              if(!located||score===null||score<productionThreshold){out.productionComplete=false;continue;}
              // Only merge overlapping yellow/blue detections. Never collapse
              // two results from one template into a falsely unique target.
              const nearby=out.candidates.filter(c=>!c.templates.includes(name)&&
                Math.abs(c.x-located.x)<=14&&Math.abs(c.y-located.y)<=14);
              if(nearby.length===1){nearby[0].templates.push(name);nearby[0].scores.push({template:name,score});}
              else out.candidates.push({...located,templates:[name],scores:[{template:name,score}],source:'production_threshold'});
            }
          }catch(error){out.productionComplete=false;peak.productionError=String(error.message||error).slice(0,180);}
          try{
            const matches=frame.findMulti(diagnostic),total=count(matches);
            if(total!==1){peak.status=total===0?'no_valid_peak':'invalid_diagnostic_result_count';out.diagnosticsComplete=false;}
            else {
              const item=matches[0],raw=read(item,'matchScore'),score=number(raw),located=resultRegion(item,frameSize);
              peak.status=raw===null||raw===undefined?'score_missing':score===null?'invalid_score':!located?'invalid_position':'ok';
              if(peak.status==='ok'){
                peak.score=score;peak.box=located.box;peak.center=located.center;peak.aboveThreshold=score>=productionThreshold;
              }else out.diagnosticsComplete=false;
            }
          }catch(error){peak.status='match_error';peak.error=String(error.message||error).slice(0,180);out.diagnosticsComplete=false;}
        }catch(error){peak.status='recognizer_error';peak.error=String(error.message||error).slice(0,180);out.productionComplete=false;out.diagnosticsComplete=false;}
        finally{
          // RecognitionObject itself owns no Dispose API. Free only derived
          // Mats created for this observation; the cloned recognizer shares them.
          if(production)for(const key of ['templateImageMat','templateImageGreyMat','maskMat']){
            const mat=read(production,key);if(mat&&!loadedMats.has(mat))derived.add(mat);
          }
          for(const mat of derived)try{dispose(mat);}catch(error){
            peak.cleanupError=String(error.message||error).slice(0,180);out.productionComplete=false;
          }
        }
      }
      if(out.productionComplete&&out.candidates.length===1){out.unique=out.candidates[0];out.accepted=true;}
      return out;
    }
    function close(){
      if(closed)return;closed=true;
      let failure=null;
      for(const mat of loadedMats)try{dispose(mat);}catch(error){failure=failure||error;}
      loadedMats.clear();cache.clear();if(failure)throw failure;
    }
    return {observe,dispose:close};
  }
  return {createTemplateDiagnostics};
})();
if(typeof module!=='undefined'&&module.exports)module.exports=StoryTemplateDiagnostics;
