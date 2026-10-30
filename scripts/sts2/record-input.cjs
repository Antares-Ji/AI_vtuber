'use strict';
// Optional short local recording; never stops a recording started by the user.
const fs = require('node:fs'), path = require('node:path');
const { spawn } = require('node:child_process');
const { Sts2Obs, GAME } = require('../../src/sts2/obs');
async function main() {
  if (!process.argv[2]) throw Error('Usage: node scripts/sts2/record-input.cjs actions.json');
  const root = path.resolve(__dirname,'../..'), dir = path.join(root,'runtime/sts2/learning',`input-demo-${Date.now()}`);
  fs.mkdirSync(dir,{recursive:true});
  const obs = new Sts2Obs(); let owns = false, recording = null;
  const result = { dir, inputExitCode: null, recording: null };
  try {
    const c = await obs.connect();
    await c.call('SetInputSettings',{inputName:GAME,inputSettings:{cursor:true},overlay:true});
    fs.writeFileSync(path.join(dir,'before.jpg'),await obs.screenshot(GAME));
    if (!(await c.call('GetRecordStatus')).outputActive) { await c.call('StartRecord'); owns=true; }
    const child=spawn(path.join(root,'runtime/vision-env/Scripts/python.exe'),[path.join(__dirname,'native_input.py'),path.resolve(process.argv[2]),'--execute','--focus','--log',path.join(dir,'input.json')],{cwd:root,windowsHide:true,stdio:['ignore','pipe','pipe']});
    let output=''; child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
    result.inputExitCode=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('exit',resolve);});
    fs.writeFileSync(path.join(dir,'process.log'),output);
    await new Promise(r=>setTimeout(r,1000));
    fs.writeFileSync(path.join(dir,'after.jpg'),await obs.screenshot(GAME));
  } finally {
    if(owns) { recording = await obs.client.call('StopRecord'); result.recording=recording.outputPath; }
    await obs.client?.disconnect();
    fs.writeFileSync(path.join(dir,'result.json'),JSON.stringify(result,null,2));
  }
  console.log(JSON.stringify(result)); if(result.inputExitCode!==0) process.exitCode=1;
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
