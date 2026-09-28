const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const { validJpeg } = require('./page-sessions');
const { analyzeInteractions } = require('./interaction-analysis');
const { buildFlow } = require('./ui-flow');
const { observerStopReason, recordingOutcome } = require('./observer-health');
const { frameMetrics } = require('./frame-metrics');
const ROOT=path.resolve(__dirname,'../../runtime/vision/interactions');
const SCRIPT=path.join(__dirname,'mouse-observer.ps1');
let current=null;
let starting=false;
const fail=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
async function windows() {
  return new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',SCRIPT,'-Mode','list'],
    {windowsHide:true,timeout:15000,maxBuffer:65536,encoding:'utf8'},(error,out)=>{
      if(error)return reject(fail('读取游戏窗口失败；此功能需要 Windows 桌面会话。',503));
      resolve(out.trim().split(/\r?\n/).filter(Boolean).map(line=>{ const [handle,...title]=line.split('\t');return {handle,title:title.join(' ')}; }).filter(w=>/^\d+$/.test(w.handle)));
    }));
}
async function persist(r) {
  const body={...r.data,events:r.events,analysis:analyzeInteractions(r.events,r.data.frames)};
  if(r.data.status==='stopped')body.outcome=recordingOutcome(r.data,r.events,r.data.frames,body.analysis);
  if(r.data.status==='stopped')body.frameMetrics=frameMetrics(r.data.frames);
  await fs.writeFile(path.join(r.dir,'manifest.tmp'),JSON.stringify(body,null,2));
  await fs.rename(path.join(r.dir,'manifest.tmp'),path.join(r.dir,'manifest.json'));
  return body;
}
async function stop(r,reason='user') {
  if(r.stopping)return r.stopping;
  r.stopping=(async()=>{
    r.accepting=false; clearInterval(r.lease);
    if(r.child && r.child.exitCode===null) { r.child.kill(); await r.closed; }
    await r.pending.catch(()=>{});
    r.data.status='stopped'; r.data.stopReason=reason; r.data.stoppedAt=Date.now();
    let result=await persist(r);
    if(result.frames.length) {
      try {
        const visual=await new Promise((resolve,reject)=>execFile(path.resolve(__dirname,'../../runtime/vision-env/Scripts/python.exe'),
          [path.join(__dirname,'interaction-visual.py'),path.join(r.dir,'manifest.json')],
          {windowsHide:true,timeout:30000,maxBuffer:1024*1024},(error,out)=>{if(error)return reject(error);try{resolve(JSON.parse(out));}catch(e){reject(e);}}));
        r.data.visualEvidence=visual;
      } catch {r.data.visualAnalysisError='画面对比失败；原图与轨迹已保留。';}
      result=await persist(r);
    }
    return result;
  })();
  return r.stopping;
}
async function start(body) {
  if(current && current.data.status!=='stopped')throw fail('已有交互录制在运行，请先停止',409);
  const target=(await windows()).find(w=>w.handle===String(body.handle));
  if(!target)throw fail('请选择当前明日方舟窗口');
  const reviewed=JSON.parse(await fs.readFile(path.resolve(__dirname,'../../public/annotations/home-reviewed.json'),'utf8'));
  const entry=reviewed.boxes.find(b=>String(b.id)===String(body.entryId));
  if(!entry)throw fail('请选择主界面入口');
  const id=randomUUID(),dir=path.join(ROOT,id);await fs.mkdir(dir,{recursive:true});
  const r={dir,events:[],accepting:true,pending:Promise.resolve(),lastPoll:Date.now(),data:{id,parentScene:'home',entryId:entry.id,entryLabel:entry.label,
    target,status:'starting',createdAt:Date.now(),frames:[],limits:{frames:18000,durationMs:600000,heartbeatMs:10000}}};
  current=r;await persist(r);
  const child=r.child=spawn('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',SCRIPT,'-Mode','watch','-WindowHandle',target.handle,'-ParentProcessId',String(process.pid)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
  r.closed=new Promise(resolve=>{child.once('close',resolve);child.once('error',resolve);});
  let buffer=''; child.stderr.resume();
  try {
    await new Promise((resolve,reject)=>{
      const timeout=setTimeout(()=>reject(fail('鼠标观察器启动超时',503)),15000);
      const ready=()=>{clearTimeout(timeout);resolve();};
      child.once('error',()=>{clearTimeout(timeout);reject(fail('鼠标观察器无法启动',503));});
      child.once('close',()=>{clearTimeout(timeout);reject(fail('鼠标观察器已退出',503)); if(r.accepting)void stop(r,'observer-exited').catch(()=>{});});
      child.stdout.on('data',chunk=>{
        buffer+=chunk.toString('utf8');
        const lines=buffer.split(/\r?\n/); buffer=lines.pop();
        if(buffer.length>65536) {void stop(r,'invalid-output').catch(()=>{});return;}
        for(const line of lines) {
          try {
            const event=JSON.parse(line);
            if(event.type==='ready'){ready();continue;}
            if(event.type==='diagnostic'){r.lastDiagnostic=Date.now();r.data.diagnostic={...event,receivedAt:r.lastDiagnostic};continue;}
            if(!r.accepting || !['down','move','hover','up','cancel','repeat','wheel'].includes(event.type))continue;
            if(r.events.length>=30000){void stop(r,'event-limit').catch(()=>{});continue;}
            event.seq=r.events.length; r.events.push(event);
            syncFs.appendFileSync(path.join(dir,'events.jsonl'),JSON.stringify(event)+'\n');
          } catch { void stop(r,'event-write-failed').catch(()=>{}); }
        }
      });
    });
    if(!r.accepting)throw fail('观察器已停止',503);
    r.data.status='recording';await persist(r);
    r.lastDiagnostic=Date.now();
    r.lease=setInterval(()=>{
      const reason=observerStopReason({now:Date.now(),lastPoll:r.lastPoll,lastDiagnostic:r.data.status==='draining'?Date.now():r.lastDiagnostic});
      if(reason)void stop(r,reason).catch(()=>{});
    },1000);
    r.lease.unref(); return r.data;
  } catch(error) {await stop(r,'start-failed');throw error;}
}
async function handleInteractions(req,res,url,{parseBody,parseBinaryBody,send}) {
  const prefix='/api/vision/interactions';
  if(!url.pathname.startsWith(prefix))return false;
  try {
    if(req.method==='GET' && url.pathname===prefix+'/windows') {send(res,200,{windows:await windows()});return true;}
    if(req.method==='POST' && url.pathname===prefix) {
      if(starting)throw fail('正在启动观察器',409);
      starting=true;try {send(res,200,await start(await parseBody(req)));}finally{starting=false;}
      return true;
    }
    const match=/^\/api\/vision\/interactions\/([a-f0-9-]{36})(?:\/(events|frames|pause|stop|flow|flow-scroll-\d+-\d+\.png|frame-\d{3,5}\.jpg))?$/.exec(url.pathname);
    if(!match)throw fail('Not found',404);
    const [,id,action]=match,r=current?.data.id===id?current:null;
    if(action==='flow') {
      if(r && r.data.status!=='stopped')throw fail('请先结束采集',409);
      send(res,200,req.method==='POST'?await buildFlow(path.join(ROOT,id)):JSON.parse(await fs.readFile(path.join(ROOT,id,'flow.json'),'utf8')));
    } else if(req.method==='GET' && action?.startsWith('flow-scroll-')) {
      const flow=JSON.parse(await fs.readFile(path.join(ROOT,id,'flow.json'),'utf8'));
      if(!flow.images.some(f=>f.file===action))throw fail('Not found',404);
      res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store'});res.end(await fs.readFile(path.join(ROOT,id,action)));
    } else if(req.method==='GET' && action==='events') {
      if(!r)throw fail('观察器已重启，请重新开始录制',410);
      r.lastPoll=Date.now();
      const after=Number(url.searchParams.get('after')??-1);
      if(!Number.isInteger(after)||after< -1)throw fail('Invalid cursor');
      send(res,200,{status:r.accepting?'recording':'stopped',events:r.events.slice(after+1),reason:r.data.stopReason,diagnostic:r.data.diagnostic});
    } else if(req.method==='POST' && action==='pause') {
      if(!r || r.stopping)throw fail('录制已停止',409);
      r.accepting=false;r.data.status='draining';r.child.kill();
      send(res,200,{ok:true});
    } else if(req.method==='POST' && action==='stop') {
      if(!r)throw fail('没有运行中的录制',410);
      send(res,200,await stop(r));
    } else if(req.method==='POST' && action==='frames') {
      if(!r || !['recording','draining'].includes(r.data.status) || r.stopping)throw fail('录制已停止',409);
      if(r.uploading)throw fail('上一帧正在保存',409);
      if(r.data.frames.length>=18000)throw fail('已达到18000帧上限，请停止录制',409);
      const gesture=Number(url.searchParams.get('gesture')),phase=url.searchParams.get('phase'),at=Number(url.searchParams.get('at'));
      if(!r.events.some(e=>e.gesture===gesture&&(e.type==='down'||e.type==='wheel')) || !['before','held','release','after','event'].includes(phase) || !Number.isFinite(at) || Math.abs(Date.now()-at)>600000)throw fail('帧关联无效');
      r.uploading=true;
      r.pending=(async()=>{
        const image=await parseBinaryBody(req,12000000);if(!validJpeg(image))throw fail('无效 JPEG');
        const file=`frame-${String(r.data.frames.length+1).padStart(3,'0')}.jpg`;
        await fs.writeFile(path.join(r.dir,file),image);
        const mediaTime=url.searchParams.get('mediaTime');
        r.data.frames.push({file,gesture,phase,capturedAt:at,receivedAt:Date.now(),mediaTime:mediaTime && Number.isFinite(Number(mediaTime))?Number(mediaTime):null});
        await fs.appendFile(path.join(r.dir,'frames.jsonl'),JSON.stringify(r.data.frames[r.data.frames.length-1])+'\n');
        if(r.data.frames.length%20===0)await persist(r);return {ok:true,count:r.data.frames.length};
      })();
      try {send(res,200,await r.pending);} finally {r.uploading=false;r.pending=Promise.resolve();}
    } else if(req.method==='GET' && (!action || /^frame-\d{3,5}\.jpg$/.test(action))) {
      const data=JSON.parse(await fs.readFile(path.join(ROOT,id,'manifest.json'),'utf8'));
      if(!action)send(res,200,data);
      else {if(!data.frames.some(f=>f.file===action))throw fail('Not found',404);
        const image=await fs.readFile(path.join(ROOT,id,action));res.writeHead(200,{'Content-Type':'image/jpeg','Cache-Control':'no-store'});res.end(image);}
    } else throw fail('Not found',404);
  } catch(error){send(res,error.code==='ENOENT'?404:error.statusCode||500,{error:error.statusCode?error.message:'交互录制失败，已保存文件仍保留。'});}
  return true;
}
process.once('exit',()=>{current?.child?.kill();});
module.exports={handleInteractions};
