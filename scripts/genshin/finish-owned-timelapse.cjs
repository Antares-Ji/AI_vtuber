'use strict';
// One recording owned by this trial. Never stops another scene/recording or a stream.
const fs=require('node:fs'),path=require('node:path'),{spawn}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),marker=path.join(root,'runtime/genshin/recordings/direct-timelapse.json');
async function finish({split=false,restart=false}={}){
 const record=JSON.parse(fs.readFileSync(marker,'utf8'));
 if(!record.owned||record.speed!==20||record.exported)throw Error('No owned 20x recording to finish');
 const obs=await new(require('../../src/genshin/obs').GenshinObs)().connect();let nextRecord=null;
 try{
  const status=await obs.call('GetRecordStatus'),scene=await obs.call('GetCurrentProgramScene');
  if(!status.outputActive||scene.currentProgramSceneName!==record.scene||Math.abs(Date.now()-record.startedAt-status.outputDuration)>15000)
   throw Error('Recording ownership no longer matches; leaving OBS untouched');
  if(split){
   const directory=await obs.call('GetRecordDirectory');
   if(path.resolve(directory.recordDirectory)!==path.resolve(record.directory))throw Error('Recording directory changed');
   const candidates=fs.readdirSync(record.directory).filter(n=>/\.(mp4|mkv|mov)$/i.test(n)&&!n.includes('20x')).map(n=>({file:path.join(record.directory,n),created:fs.statSync(path.join(record.directory,n)).birthtimeMs})).filter(f=>f.created>=record.startedAt-2000).sort((a,b)=>b.created-a.created);
   if(!candidates.length)throw Error('Owned output file not found');
   record.original=candidates[0].file;await obs.call('SplitRecordFile');record.splitAt=Date.now();
   if(!(await obs.call('GetRecordStatus')).outputActive)throw Error('Recording did not remain active after split');
  }else{
   const stopped=await obs.call('StopRecord');record.original=stopped.outputPath;record.stoppedAt=Date.now();
   fs.writeFileSync(path.join(record.directory,'timelapse-'+record.startedAt+'.json'),JSON.stringify(record,null,2));
   if(restart){
    // StopRecord responds before the output finishes releasing its encoder.
    // Preserve the closed file receipt first, then wait before starting a segment.
    await new Promise(resolve=>setTimeout(resolve,2000));
    const startedAt=Date.now();await obs.call('StartRecord');await new Promise(resolve=>setTimeout(resolve,1500));
    if(!(await obs.call('GetRecordStatus')).outputActive)throw Error('Next recording did not start');
    nextRecord={owned:true,startedAt,speed:20,silentExport:true,scene:record.scene,previousScene:record.previousScene,previousDirectory:record.previousDirectory,directory:record.directory,segments:record.segments||[]};
   }else await obs.call('SetRecordDirectory',{recordDirectory:record.previousDirectory});
  }
 }finally{await obs.disconnect();}
 record.output=path.join(record.directory,'emergency-repair-20x-'+record.startedAt+'.mp4');
 fs.writeFileSync(marker,JSON.stringify(nextRecord||record,null,2));
 const ffmpeg=path.join(root,'runtime/asr-env/Lib/site-packages/imageio_ffmpeg/binaries/ffmpeg-win-x86_64-v7.1.exe');
 await new Promise((resolve,reject)=>{
  const child=spawn(ffmpeg,['-nostdin','-hide_banner','-y','-i',record.original,'-vf','setpts=(PTS-STARTPTS)/20,fps=30','-an','-c:v','libx264','-preset','veryfast','-crf','22','-movflags','+faststart',record.output],{cwd:root,windowsHide:true,stdio:['ignore','ignore','pipe']});
  let tail='';child.stderr.on('data',b=>tail=(tail+b).slice(-3000));child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('ffmpeg '+code+': '+tail)));
 });
 record.exported=!split;record.exportedAt=Date.now();record.recordingContinues=split||restart;
 if(nextRecord){nextRecord.segments.push({original:record.original,output:record.output,startedAt:record.startedAt,stoppedAt:record.stoppedAt,exportedAt:record.exportedAt});fs.writeFileSync(marker,JSON.stringify(nextRecord,null,2));}
 else fs.writeFileSync(marker,JSON.stringify(record,null,2));
 fs.writeFileSync(path.join(record.directory,'timelapse-'+record.startedAt+'.json'),JSON.stringify(record,null,2));
 console.log(JSON.stringify({original:record.original,output:record.output,speed:20,silent:true,recordingContinues:record.recordingContinues}));
}
if(require.main===module){
 if(!['--finish','--split','--segment'].includes(process.argv[2]))throw Error('Use --finish, --split or --segment for the owned recording');
 finish({split:process.argv[2]==='--split',restart:process.argv[2]==='--segment'}).catch(e=>{console.error(e.message);process.exitCode=1;});
}
module.exports={finish};
