'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const runFile = promisify(execFile);
const ROOT = path.resolve(__dirname, '../..');
const TASKS = ['AutoGeniusInvokation','AutoWood','AutoFight','AutoDomain','AutoBoss','AutoFishing','AutoCook','AutoEat','CountInventoryItem'];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let session = null, folder = null, heartbeat = null, starting = null, active = null, lastResult = null;
function read(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; } }
function status() { const value = folder && read(path.join(folder, 'status.json')); const stale=Boolean(value&&Date.now()-value.heartbeatAt*1000>15000);return { ...(value || {ready:false,busy:false}),ready:Boolean(value?.ready&&!value.closedAt&&!stale),stale,session, active, lastResult, operations:['capture','path','task','cancelProbe','window','dismiss_menu','locate','story'], tasks:TASKS }; }
async function processAlive(root=ROOT) {
  const output=await runFile(path.join(root,'runtime/vlm-env/Scripts/python.exe'),[path.join(root,'scripts/genshin/bridge-identify.py'),session,'--probe'],{cwd:root,windowsHide:true,timeout:3000,maxBuffer:8192});
  return JSON.parse(output.stdout).alive===true;
}
async function start({ root = ROOT, signal, reuseSession } = {}) {
  signal?.throwIfAborted();
  if(reuseSession!==undefined&&!/^[0-9a-f-]{36}$/.test(reuseSession))throw Error('无效的已授权会话');
  if(reuseSession&&session&&reuseSession!==session)throw Error('当前管理连接与待复用会话不同');
  if (status().ready) return status();
  if (starting) return starting;
  const previousStatus=status();
  const cleanupConfirmed=lastResult?.id===previousStatus.jobId&&lastResult?.processStopped===true&&lastResult?.inputReleased===true;
  // A crashed owner may leave busy=true on disk after a completed cleanup.
  // Only discard it after a real process probe; never trust staleness alone.
  if(session && !active && (!previousStatus.busy || (previousStatus.stale&&cleanupConfirmed)) && (previousStatus.closedAt || !await processAlive(root))){clearInterval(heartbeat);session=null;folder=null;lastResult=null;}
  if (session) throw Error('BetterGI 管理进程未就绪；请检查上次状态，避免重复启动');
  if (process.platform !== 'win32') throw Error('BetterGI 需要 Windows');
  starting = (async () => {
    const marker=path.join(root,'runtime/genshin/bridge/current.json');
    const previous=read(marker);
    if(previous && /^[0-9a-f-]{36}$/.test(previous.session) && (!reuseSession||previous.session===reuseSession)) {
      const oldFolder=path.join(root,'runtime/genshin/bridge',previous.session);
      const recent=fs.existsSync(path.join(oldFolder,'heartbeat')) && Date.now()-fs.statSync(path.join(oldFolder,'heartbeat')).mtimeMs<10000;
      if(recent) {
        try {
          await runFile(path.join(root,'runtime/vlm-env/Scripts/python.exe'),[path.join(root,'scripts/genshin/bridge-identify.py'),previous.session],{cwd:root,windowsHide:true,timeout:3000,maxBuffer:8192});
          session=previous.session;folder=oldFolder;
          lastResult=fs.readdirSync(folder).filter(f=>/^result-[0-9a-f-]{36}\.json$/.test(f)).map(f=>read(path.join(folder,f))).filter(Boolean).sort((a,b)=>b.finishedAt-a.finishedAt)[0]||null;
          if(lastResult)lastResult={...lastResult,session};
          const pulse=()=>fs.writeFileSync(path.join(folder,'heartbeat'),String(Date.now()));pulse();heartbeat=setInterval(pulse,2000);heartbeat.unref();
          starting=null;return status();
        } catch { /* Dead/closed old instance will be handled by its watchdog. */ }
      }
    }
    if(reuseSession)throw Error('原已授权管理进程无法复用；未新建进程，也未请求提权');
    session=randomUUID();folder=path.join(root,'runtime/genshin/bridge',session);fs.mkdirSync(folder,{recursive:true});
    const pulse=()=>fs.writeFileSync(path.join(folder,'heartbeat'),String(Date.now()));pulse();heartbeat=setInterval(pulse,2000);heartbeat.unref();
    try {
      await runFile(path.join(root,'runtime/vlm-env/Scripts/python.exe'),[path.join(root,'scripts/genshin/start-bridge.py'),session],{cwd:root,windowsHide:true,timeout:90000,maxBuffer:8192});
      const deadline=Date.now()+15000;
      while(Date.now()<deadline) {signal?.throwIfAborted();if(status().ready){fs.writeFileSync(marker,JSON.stringify({session}));return status();}await delay(200);}
      throw Error('BetterGI 管理进程未返回就绪回执');
    } catch(error) {
      clearInterval(heartbeat);fs.writeFileSync(path.join(folder,'shutdown'),'stop');
      const detail=String(error.stderr||error.message).trim().split(/\r?\n/).at(-1);
      throw Error(/1223/.test(detail)?'Windows 提权被取消，未启动管理进程；已停止重试，不会反复弹窗':'BetterGI 管理进程启动失败：'+detail.slice(0,500));
    } finally {starting=null;}
  })().finally(()=>{starting=null;});
  return starting;
}
function validate(input) {
  if (!input || Object.keys(input).some(k=>!['operation','routeId','task','timeoutMs'].includes(k))) throw Error('无效的 BetterGI 命令字段');
  if (!['capture','path','task','cancelProbe','window','restore_window','dismiss_menu','locate','story'].includes(input.operation)) throw Error('不支持的 BetterGI 操作');
  if(input.operation==='restore_window'&&(input.routeId!==undefined||input.task!==undefined))throw Error('窗口恢复不能混入路线或独立任务');
  if(input.operation==='story'&&(input.routeId!==undefined||input.task!==undefined))throw Error('剧情会话不能混入路线或独立任务');
  if(input.operation==='locate'&&(input.routeId!==undefined||input.task!==undefined))throw Error('定位只能使用固定的小地图视觉识别');
  if(input.operation==='dismiss_menu'&&(input.routeId!==undefined||input.task!==undefined))throw Error('返回菜单只能使用固定的原生返回动作');
  if(input.operation==='path' && (typeof input.routeId!=='string' || input.routeId.length>1500 || !/^(user|builtin_leyline):/.test(input.routeId) || input.routeId.includes('..') || input.routeId.includes('\\'))) throw Error('无效的路线标识');
  if(input.operation==='task' && !TASKS.includes(input.task)) throw Error('不支持的自动化任务');
  const timeoutMs=input.timeoutMs ?? (input.operation==='capture'?60000:180000);
  if(!Number.isInteger(timeoutMs)||timeoutMs<1000||timeoutMs>600000)throw Error('任务时限必须在 1–600 秒');
  return {...input,timeoutMs};
}
async function execute(input,{signal,reportProgress=()=>{},onStoryFrame}={}) {
  const command=validate(input);signal?.throwIfAborted();
  if(!status().ready)throw Error('请先启动 BetterGI 连接管理进程');
  if(command.operation==='restore_window'&&status().supervisorVersion<9)throw Error('显式窗口恢复需要版本9管理进程，请通过正常Windows授权流程更新连接');
  if(command.operation==='story'&&(status().supervisorVersion<8||typeof onStoryFrame!=='function'))throw Error('剧情需要版本8管理进程及模型决策回调');
  if(command.operation==='dismiss_menu' && status().supervisorVersion<4)throw Error('BetterGI 管理进程需要更新后才能执行菜单返回');
  if(command.operation==='locate' && status().supervisorVersion<5)throw Error('BetterGI 管理进程需要更新后才能执行小地图定位');
  if(active||status().busy)throw Error('BetterGI 正在执行或清理任务');
  const id=randomUUID();active=id;
  const cancel=()=>fs.writeFileSync(path.join(folder,'cancel-'+id),'stop');
  signal?.addEventListener('abort',cancel,{once:true});
  fs.writeFileSync(path.join(folder,'job-'+id+'.tmp'),JSON.stringify({...command,id}));
  fs.renameSync(path.join(folder,'job-'+id+'.tmp'),path.join(folder,'job-'+id+'.json'));
  if(signal?.aborted)cancel();
  try {
    let lastNotice=null,lastCheck=0,childPid=null,startupWaitSince=0,startupRecovery=false,storySequence=0,storyFailure=null;
    while(true) {
      if(command.operation==='story'&&!storyFailure){
        const {directory}=require('./installation').installation();
        const script=path.join(directory,'User/JsScript','AI-VTuber-Bridge-'+id);
        const request=read(path.join(script,'story-request.json'));
        if(request?.id===id&&Number.isInteger(request.seq)&&request.seq>storySequence&&request.seq<=40&&request.image===`story-${request.seq}.png`){
          storySequence=request.seq;
          try{
            for(const name of ['quest-marker.png','quest-marker-blue.png','minimap-commission.png','minimap-candidates.source.json','minimap-commission.source.json']){
              const marker=path.join(ROOT,'scripts/genshin/assets',name);
              if(!fs.existsSync(path.join(script,name)))fs.copyFileSync(marker,path.join(script,name));
            }
            const decision=await onStoryFrame(request,path.join(script,request.image));
            signal?.throwIfAborted();
            const output=path.join(script,`story-decision-${request.seq}.json`);
            fs.writeFileSync(output+'.tmp',JSON.stringify({...decision,id,seq:request.seq}));fs.renameSync(output+'.tmp',output);
          }catch(error){storyFailure=error;cancel();reportProgress('story-error','剧情决策失败，正在释放输入：'+error.message);}
        }
      }
      if(Date.now()-lastCheck>2000&&['path','task','story'].includes(command.operation)) {
        lastCheck=Date.now();
        // The script receipt does not exist until the owned process starts.
        const {directory}=require('./installation').installation();
        const observed=require('./execution-status').executionStatus(directory,id,childPid);
        childPid=observed.pid;const notice=observed.notice;
        if(observed.scriptStarted)startupWaitSince=0;
        else if(notice?.stage==='waiting-main-ui'&&!startupWaitSince)startupWaitSince=Date.now();
        if(startupWaitSince&&Date.now()-startupWaitSince>30000&&!startupRecovery){startupRecovery=true;cancel();reportProgress('recovering','BetterGI 等待主界面超过30秒，先释放输入，再重新观察并恢复原目标');}
        if(notice?.stage!==lastNotice){lastNotice=notice?.stage;if(notice)reportProgress(notice.stage,notice.message);else reportProgress('executing','BetterGI 正在执行模型选定的任务；完成后会重新观察');}
      }
      const result=read(path.join(folder,'result-'+id+'.json'));
      if(result?.id===id) {
        lastResult={...result,session};
        if(!result.processStopped||!result.inputReleased) {
          // Retain the director's desktop lease when input cleanup is unknown.
          // The status endpoint exposes the failure, instead of claiming idle.
          await delay(1000);continue;
        }
        signal?.throwIfAborted();
        if(storyFailure)throw Object.assign(storyFailure,{receipt:result});
        if(result.state==='error')throw Object.assign(Error(lastNotice==='paused-focus'&&result.error?.includes('runtime budget')?'原神长期不在前台，BetterGI 暂停后达到本轮时限；已释放按键，目标仍保留':result.error||result.receipt?.error||'BetterGI 执行失败'),{code:result.error?.includes('runtime budget')?'COMMAND_TIMEOUT':'COMMAND_FAILED',receipt:result});
        if(result.state==='stopped')throw Object.assign(Error(startupRecovery?'BetterGI 启动前场景发生变化，需重新观察恢复':result.error||'BetterGI 操作已停止；没有继续执行游戏动作'),{code:startupRecovery?'STARTUP_SCENE_CHANGED':'COMMAND_STOPPED',receipt:result});
        if(result.state==='returned'&&command.operation==='path') {
          const {directory}=require('./installation').installation();
          const failure=require('./execution-status').executionFailure(directory,id,result.pid||childPid);
          if(failure)throw Object.assign(Error(failure),{code:'PATH_EXECUTION_FAILED',receipt:lastResult});
        }
        return lastResult;
      }
      await delay(150);
    }
  } finally {signal?.removeEventListener('abort',cancel);active=null;}
}
function evidence(sessionId,id,name) {
  if(sessionId!==session || !/^[0-9a-f-]{36}$/.test(id) || !['before.png','after.png'].includes(name))throw Error('截图不存在');
  const file=path.join(folder,'evidence-'+id,name);if(!fs.existsSync(file))throw Error('截图尚未生成');return file;
}
async function disconnect(){if(active||status().busy)throw Error('请先停止并等待 BetterGI 释放输入');if(!folder)return status();clearInterval(heartbeat);fs.writeFileSync(path.join(folder,'shutdown'),'stop');const deadline=Date.now()+15000;while(Date.now()<deadline){if(status().closedAt)return status();if(!await processAlive()){fs.writeFileSync(path.join(folder,'status.json'),JSON.stringify({...read(path.join(folder,'status.json')),ready:false,closedAt:Date.now()/1000,exitConfirmedByProcessProbe:true}));return status();}await delay(300);}throw Error('管理进程尚未确认退出');}
module.exports={start,status,execute,validate,evidence,disconnect,TASKS};
