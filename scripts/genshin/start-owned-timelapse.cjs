'use strict';
// OBS plumbing only. Observation and gameplay stay inside the BGI director API.
const fs=require('node:fs'),path=require('node:path');
const {GenshinObs}=require('../../src/genshin/obs');
async function start(){
 const root=path.resolve(__dirname,'../..'),directory=path.join(root,'runtime/genshin/recordings');
 const marker=path.join(directory,'direct-timelapse.json');
 const c=await new GenshinObs().connect();
 try{
  const recording=await c.call('GetRecordStatus'),stream=await c.call('GetStreamStatus');
  if(recording.outputActive||stream.outputActive)throw Error('An existing recording or stream is active');
  const scene='Genshin - Game Only',input='Genshin Game Window';
  const before=await c.call('GetSceneList'),previous=await c.call('GetRecordDirectory');
  if(!before.scenes.some(s=>s.sceneName===scene))await c.call('CreateScene',{sceneName:scene});
  const inputs=await c.call('GetInputList');
  if(!inputs.inputs.some(i=>i.inputName===input))await c.call('CreateInput',{sceneName:scene,inputName:input,inputKind:'window_capture',inputSettings:{method:2,client_area:true},sceneItemEnabled:true});
  const choices=await c.call('GetInputPropertiesListPropertyItems',{inputName:input,propertyName:'window'});
  const windows=choices.propertyItems.filter(w=>w.itemEnabled&&/(?:YuanShen|GenshinImpact)\.exe/i.test(w.itemValue));
  if(windows.length!==1)throw Error('Expected one capturable Genshin window');
  await c.call('SetInputSettings',{inputName:input,inputSettings:{window:windows[0].itemValue,method:2,client_area:true,cursor:false},overlay:true});
  let items=(await c.call('GetSceneItemList',{sceneName:scene})).sceneItems;
  if(!items.some(i=>i.sourceName===input))await c.call('CreateSceneItem',{sceneName:scene,sourceName:input,sceneItemEnabled:true});
  items=(await c.call('GetSceneItemList',{sceneName:scene})).sceneItems;
  for(const i of items)await c.call('SetSceneItemEnabled',{sceneName:scene,sceneItemId:i.sceneItemId,sceneItemEnabled:i.sourceName===input});
  const video=await c.call('GetVideoSettings');
  await c.call('SetSceneItemTransform',{sceneName:scene,sceneItemId:items.find(i=>i.sourceName===input).sceneItemId,sceneItemTransform:{positionX:0,positionY:0,alignment:5,boundsType:'OBS_BOUNDS_SCALE_INNER',boundsWidth:video.baseWidth,boundsHeight:video.baseHeight}});
  await c.call('SetCurrentProgramScene',{sceneName:scene});
  fs.mkdirSync(directory,{recursive:true});
  await c.call('SetRecordDirectory',{recordDirectory:directory});
  const record={owned:true,startedAt:Date.now(),speed:20,silentExport:true,scene,decisionProvider:'deepseek',observationProvider:'bettergi_native_cv_ocr',previousScene:before.currentProgramSceneName,previousDirectory:previous.recordDirectory,directory};
  await c.call('StartRecord');
  fs.writeFileSync(marker,JSON.stringify(record,null,2));
  let status=await c.call('GetRecordStatus');
  for(let i=0;i<20&&!status.outputActive;i++){
   await new Promise(resolve=>setTimeout(resolve,250));
   status=await c.call('GetRecordStatus');
  }
  if(!status.outputActive)throw Error('Recording did not become active; inspect saved ownership receipt');
  const enabled=(await c.call('GetSceneItemList',{sceneName:scene})).sceneItems.filter(i=>i.sceneItemEnabled);
  if(enabled.length!==1||enabled[0].sourceName!==input)throw Error('Game-only scene verification failed');
  console.log(JSON.stringify({...record,status,enabledSources:enabled.map(i=>i.sourceName)}));
 }finally{await c.disconnect();}
}
if(require.main===module)start().catch(e=>{console.error(e.message);process.exitCode=1;});
module.exports={start};
