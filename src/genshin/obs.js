'use strict';
const { Sts2Obs } = require('../sts2/obs');
const SCENE = 'AI VTuber - Genshin Impact';
const GAME = 'Genshin Game Window';
const AVATAR = 'Genshin Live2D Streamer';
class GenshinObs extends Sts2Obs {
  async configure() {
    const obs = await this.connect();
    const { scenes } = await obs.call('GetSceneList');
    if (!scenes.some(s=>s.sceneName===SCENE)) await obs.call('CreateScene',{sceneName:SCENE});
    const {baseWidth:width,baseHeight:height}=await obs.call('GetVideoSettings');
    const {inputs}=await obs.call('GetInputList');
    if(!inputs.some(i=>i.inputName===GAME)) await obs.call('CreateInput',{sceneName:SCENE,inputName:GAME,inputKind:'window_capture',inputSettings:{method:2,cursor:true,client_area:true},sceneItemEnabled:true});
    const {propertyItems}=await obs.call('GetInputPropertiesListPropertyItems',{inputName:GAME,propertyName:'window'});
    const window=propertyItems.find(w=>w.itemEnabled&&/(?:YuanShen|GenshinImpact)\.exe/i.test(w.itemValue));
    if(!window) throw Error('OBS 未找到可捕获的原神窗口，请保持原神打开且未最小化');
    await obs.call('SetInputSettings',{inputName:GAME,inputSettings:{window:window.itemValue,method:2,cursor:true,client_area:true},overlay:true});
    const browser={url:`http://127.0.0.1:${Number(this.env.PORT||3000)}/?game=genshin&overlay=1&voice=gpt-sovits`,width,height,fps:30,shutdown:false,restart_when_active:false,reroute_audio:true,css:'html,body{background:transparent!important;margin:0;overflow:hidden}'};
    if(!inputs.some(i=>i.inputName===AVATAR)) await obs.call('CreateInput',{sceneName:SCENE,inputName:AVATAR,inputKind:'browser_source',inputSettings:browser,sceneItemEnabled:true});
    else await obs.call('SetInputSettings',{inputName:AVATAR,inputSettings:browser,overlay:true});
    let items=(await obs.call('GetSceneItemList',{sceneName:SCENE})).sceneItems;
    for(const name of [GAME,AVATAR]) if(!items.some(i=>i.sourceName===name)) await obs.call('CreateSceneItem',{sceneName:SCENE,sourceName:name,sceneItemEnabled:true});
    items=(await obs.call('GetSceneItemList',{sceneName:SCENE})).sceneItems;
    for(const name of [GAME,AVATAR]) {
      const item=items.find(i=>i.sourceName===name);
      await obs.call('SetSceneItemEnabled',{sceneName:SCENE,sceneItemId:item.sceneItemId,sceneItemEnabled:true});
      await obs.call('SetSceneItemTransform',{sceneName:SCENE,sceneItemId:item.sceneItemId,sceneItemTransform:{positionX:0,positionY:0,alignment:5,boundsType:'OBS_BOUNDS_SCALE_INNER',boundsWidth:name===GAME?Math.round(width*.76):width,boundsHeight:height}});
    }
    await obs.call('SetSceneItemIndex',{sceneName:SCENE,sceneItemId:items.find(i=>i.sourceName===AVATAR).sceneItemId,sceneItemIndex:items.length-1});
    const stream=await obs.call('GetStreamStatus'),record=await obs.call('GetRecordStatus');
    if(!stream.outputActive&&!record.outputActive) await obs.call('SetCurrentProgramScene',{sceneName:SCENE});
    this.shots.clear();
    return {scene:SCENE,gameSource:GAME,streaming:stream.outputActive,recording:record.outputActive,configured:true};
  }
  async screenshot() {
    const obs=await this.connect();
    const shot=await obs.call('GetSourceScreenshot',{sourceName:GAME,imageFormat:'jpg',imageWidth:1280,imageCompressionQuality:75});
    return Buffer.from(shot.imageData.split(',')[1],'base64');
  }
}
module.exports={GenshinObs};
