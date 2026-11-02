'use strict';
// One recording owned by this trial. Never stops another scene/recording or a stream.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),marker=path.join(root,'runtime/genshin/recordings/direct-timelapse.json');
async function finish(){
 const record=JSON.parse(fs.readFileSync(marker,'utf8'));
 if(!record.owned||record.speed!==20||record.exported)throw Error('No owned 20x recording to finish');
 const obs=await new(require('../../src/genshin/obs').GenshinObs)().connect();
 try{
  const status=await obs.call('GetRecordStatus'),scene=await obs.call('GetCurrentProgramScene');
  if(!status.outputActive||scene.currentProgramSceneName!==record.scene||Math.abs(Date.now()-record.startedAt-status.outputDuration)>15000)
   throw Error('Recording ownership no longer matches; leaving OBS untouched');
  const stopped=await obs.call('StopRecord');record.original=stopped.outputPath;record.stoppedAt=Date.now();
  await obs.call('SetRecordDirectory',{recordDirectory:record.previousDirectory});
 }finally{await obs.disconnect();}
 record.output=path.join(record.directory,'emergency-repair-20x-'+record.startedAt+'.mp4');
 fs.writeFileSync(marker,JSON.stringify(record,null,2));
 const ffmpeg=path.join(root,'runtime/asr-env/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
 await new Promise((resolve,reject)=>{
  const child=spawn(ffmpeg,['-nostdin','-hide_banner','-y','-i',record.original,'-vf','setpts=(PTS-STARTPTS)/20,fps=30','-an','-c:v','libx264','-preset','veryfast','-crf','22','-movflags','+faststart',record.output],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let tail='';child.stderr.on('data',b=>tail=(tail+b).slice(-3000));child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('ffmpeg '+code+': '+tail)));
 });
 record.exported=true;record.exportedAt=Date.now();fs.writeFileSync(marker,JSON.stringify(record,null,2));
 console.log(JSON.stringify({original:record.original,output:record.output,speed:20,silent:true}));
}
if(require.main===module){
 if(process.argv[2]!=='--finish')throw Error('Use --finish to stop and export the owned recording in this process');
 finish().catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={finish};
