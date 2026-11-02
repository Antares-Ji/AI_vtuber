'use strict';
const fs=require('node:fs'),path=require('node:path');
const {GenshinObs}=require('../../src/genshin/obs');
const root=path.resolve(__dirname,'../..'),folder=path.join(root,'runtime/genshin/recordings');
const marker=path.join(folder,'current.json');
(async()=>{
 const mode=process.argv[2]||'status',service=new GenshinObs(),client=await service.connect();
 try{
  let status=await client.call('GetRecordStatus');
  if(mode==='start'){
   if(status.outputActive){console.log(JSON.stringify({alreadyRecording:true,status}));return;}
   const setup=await service.setup();
   const scenes=await client.call('GetSceneList');
   if(scenes.currentProgramSceneName!==setup.scene)throw Error('OBS当前场景不是原神，未启动录像');
   fs.mkdirSync(folder,{recursive:true});
   const previous=await client.call('GetRecordDirectory');
   await client.call('SetRecordDirectory',{recordDirectory:folder});
   try{await client.call('StartRecord');}catch(error){await client.call('SetRecordDirectory',previous);throw error;}
   const record={startedAt:Date.now(),scene:setup.scene,directory:folder,previousDirectory:previous.recordDirectory,owned:true};
   fs.writeFileSync(marker,JSON.stringify(record,null,2));
   for(let i=0;i<20;i++){status=await client.call('GetRecordStatus');if(status.outputActive)break;await new Promise(resolve=>setTimeout(resolve,250));}
   if(!status.outputActive)throw Error('OBS尚未确认录制启动，请检查输出状态');
   console.log(JSON.stringify({...record,status}));
  }else if(mode==='stop'){
   const record=JSON.parse(fs.readFileSync(marker,'utf8'));
   if(!record.owned||record.finishedAt)throw Error('没有本脚本拥有的活动录制');
   if(!status.outputActive)throw Error('录制已停止，不能推测输出文件');
   const result=await client.call('StopRecord');
   Object.assign(record,{finishedAt:Date.now(),...result});
   fs.writeFileSync(marker,JSON.stringify(record,null,2));
   fs.writeFileSync(path.join(folder,`trial-${record.startedAt}.json`),JSON.stringify(record,null,2));
   for(let i=0;i<20;i++){status=await client.call('GetRecordStatus');if(!status.outputActive)break;await new Promise(resolve=>setTimeout(resolve,250));}
   try{
    await client.call('SetRecordDirectory',{recordDirectory:record.previousDirectory});record.directoryRestored=true;
   }catch(error){record.directoryRestored=false;record.directoryRestoreError=error.message||String(error.code||'OBS directory restore failed');}
   fs.writeFileSync(marker,JSON.stringify(record,null,2));
   fs.writeFileSync(path.join(folder,`trial-${record.startedAt}.json`),JSON.stringify(record,null,2));
   console.log(JSON.stringify(record));
  }else if(mode==='status')console.log(JSON.stringify({status,directory:await client.call('GetRecordDirectory')}));
  else throw Error('Use start, status or stop');
 }finally{await client.disconnect();}
})().catch(error=>{console.error(error.message);process.exitCode=1;});
