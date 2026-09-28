// Finite local trials: Qwen+YOLO proposals, reference alignment, and visual checks.
// No Codex/chat calls. Local verification remains provisional until video review.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'..');
const eventLoop=process.argv.includes('--event-loop');
const prepareOnly=process.argv.includes('--prepare-only');
const multiple=process.argv.includes('--multi');
const requestedSpeed=process.argv.includes('--speed2')?2:1;
const testSkill=process.argv.includes('--skill');
const roundCount=process.argv.includes('--once')?1:2;
const fastControl=process.argv.includes('--fast-control')||eventLoop;
const controlOrigin=fastControl?'http://127.0.0.1:17644':'http://127.0.0.1:17643';
const inputProfile=fastControl?'responsive':'reliable';
const {ensureNativeController}=require('../src/bot/native-controller-client');
const {ReferenceWorker}=require('../src/vision/reference-worker');
const referenceWorker=new ReferenceWorker(root);
const out=path.join(root,'runtime/vision/local-deployment',String(Date.now()));fs.mkdirSync(out,{recursive:true});
const token=fs.readFileSync(path.join(root,'runtime/vlm/controller/token.txt'),'utf8').trim();
const start=performance.now(),logFile=path.join(out,'events.jsonl');
let current,currentReceived=0,realtimeJob;
function log(event,data={}) {const r={event,elapsed_ms:performance.now()-start,utc_ms:Date.now(),...data};fs.appendFileSync(logFile,JSON.stringify(r)+'\n');console.log(JSON.stringify(r));}
async function control(action,body={}) {
 const began=performance.now();
 const res=await fetch(controlOrigin+'/'+action,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({...body,waitMs:200,profile:inputProfile}),signal:AbortSignal.timeout(30000)});
 const r=await res.json();if(!res.ok||!r.ok)throw Error(r.error||'Controller failed');
 current=path.join(out,`${Date.now()}-${action}.png`);fs.copyFileSync(r.path,current);
 currentReceived=performance.now();
 log('control',{action,ms:performance.now()-began,image:current,input:r.drag||r.click||null,timing:r.timing});return r;
}
async function referenceCheck(kind){
 const began=performance.now();
 const response=await referenceWorker.inspect(kind,current);const r=response.result;
 log('reference_check',{kind,ms:performance.now()-began,server_ms:response.server_ms,result:r,image:current});return r;
}
async function waitJobFile(name,timeoutMs){
 const until=performance.now()+timeoutMs;
 while(performance.now()<until){
  const file=path.join(realtimeJob,name);
  if(fs.existsSync(file))return JSON.parse(fs.readFileSync(file,'utf8'));
  if(name!=='summary.json'&&fs.existsSync(path.join(realtimeJob,'summary.json')))throw Error('Realtime worker failed before warming: '+fs.readFileSync(path.join(realtimeJob,'summary.json'),'utf8'));
  await new Promise(r=>setTimeout(r,50));
 }
 fs.writeFileSync(path.join(realtimeJob,'cancel'),'');
 throw Error('Realtime job timeout');
}
async function armRealtime(){
 const response=await fetch(controlOrigin+'/deploy-local',{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify({stage:'0-1',operators:multiple?3:1,speed:requestedSpeed,skill:testSkill}),signal:AbortSignal.timeout(10000)});
 const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error||'Cannot start realtime job');
 realtimeJob=result.jobDirectory;await waitJobFile('ready.json',30000);log('realtime_armed',{directory:realtimeJob});
}
async function infer(target,strategy='grounded',mode='hybrid') {
 const image=`trial-${crypto.randomUUID()}.png`;fs.copyFileSync(current,path.join(root,'runtime/vlm/live-20260911',image));
 const began=performance.now();const response=await fetch('http://127.0.0.1:17642/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image,target,mode,strategy}),signal:AbortSignal.timeout(30000)});
 const r=await response.json();log('local_model',{target,mode,ms:performance.now()-began,result:r.parsed,errors:r.validation_errors,detections:r.detections,image:current});
 if(!response.ok||r.validation_errors?.length)throw Error('Invalid local model response');
 if(strategy==='grounded'&&mode==='hybrid'&&r.parsed?.target_visible!==true)return infer(target,strategy,'vlm');
 return r.parsed;
}
async function locate(target,required=true,strategy='grounded') {
 if(fastControl&&performance.now()-currentReceived>150)await control('capture');
 let p=await infer(target,strategy);
 const deadline=performance.now()+8000;
 while(required&&p?.target_visible!==true&&performance.now()<deadline){
  await new Promise(r=>setTimeout(r,200));
  await control('capture');p=await infer(target,strategy);
 }
 if(p?.target_visible!==true) {if(required)throw Error('Target not found: '+target);return null;}
 const q=p.target_point;if(!Array.isArray(q)||q.length!==2||q.some(x=>!Number.isFinite(x)||x<0||x>1000))throw Error('Bad point');return q.map(x=>x/1000);
}
async function clickTarget(target,required=true){const p=await locate(target,required);if(p)await control('click',{xRatio:p[0],yRatio:p[1]});return !!p;}
async function drag(a,b){await control('drag',{startXRatio:a[0],startYRatio:a[1],endXRatio:b[0],endYRatio:b[1]});}
async function prepare(){
 await control('capture');
 const dismiss=await locate('结算画面右侧“是否将此阵容保存为代理指挥阵容”弹窗的白色叉号取消按钮',false);
 if(dismiss&&dismiss[0]>.7&&dismiss[0]<.85&&dismiss[1]>.3&&dismiss[1]<.5)await control('click',{xRatio:dismiss[0],yRatio:dismiss[1]});
 const existing=await locate('画面最底部最左边，红发少女头像的干员卡片中心',false);
 if(existing&&existing[1]>.8&&existing[0]<.2){if(prepareOnly)throw Error('Still in battle');log('already_in_battle');return;}
 await control('capture');
 if((await referenceCheck('result')).ok)await clickTarget('行动结束四个字的中心');
 const mapDeadline=performance.now()+15000;let mapNode;
 do {
  await control('capture');mapNode=await referenceCheck('stage-select');
  if(!mapNode.ok)await new Promise(r=>setTimeout(r,300));
 }while(!mapNode.ok&&performance.now()<mapDeadline);
 if(!mapNode.ok)throw Error('Actual 0-1 map node not visible');
 const proposedNode=await locate('关卡地图正中间的0-1关卡节点按钮，不是结算画面左上角的关卡标题');
 if(Math.hypot(proposedNode[0]-mapNode.target_point[0],proposedNode[1]-mapNode.target_point[1])>.04)log('reference_corrected_map_node',{model_point:proposedNode,reference_point:mapNode.target_point});
 await control('click',{xRatio:mapNode.target_point[0],yRatio:mapNode.target_point[1]});
 await clickTarget('关卡详情右下角蓝色开始行动按钮，不能是演习或突袭或代理指挥');
 if(prepareOnly)return;
 if(eventLoop)await armRealtime();
 await clickTarget('编队界面右侧橙色开始行动按钮');
}
async function battle(){
 // Network/loading time is variable and is not the battle-response metric.
 const deadline=performance.now()+90000;
 while(performance.now()<deadline){await control('capture');const p=await locate('画面最底部最左边，红发少女头像的干员卡片中心',false);if(p){if(p[1]<.8||p[0]>.2)throw Error('Card outside expected tray');return p;} }
 throw Error('Battle load timeout');
}
(async()=>{
 if(fastControl)await ensureNativeController(root,token);
 await referenceWorker.ready;
 log('configuration',{controlOrigin,inputProfile,eventLoop,multiple,requestedSpeed,testSkill,residentReferences:true});
 if(prepareOnly){await prepare();log('formation_ready');return;}
 const trials=[];
 for(let round=1;round<=roundCount;round++){
  log('trial_started',{round});const began=performance.now();let entered=false;
  try{
   realtimeJob=null;await prepare();
   if(eventLoop){
    if(!realtimeJob)throw Error('Realtime test must start from the chapter or result page');
    const result=await waitJobFile('summary.json',180000);entered=true;
    if(!result.ok)throw Error(result.error);
    trials.push({round,status:result.followup?.ok===false?'followup_incomplete':'local_candidate_success',verified_by_recording:false,total_ms:performance.now()-began,realtime:result});
    log('trial_result',trials.at(-1));
   }else{
   const card=await battle();entered=true;const recognized=performance.now();log('battle_recognized',{round});
   await control('click',{xRatio:card[0],yRatio:card[1]});
   let tile=await locate('参考成功截图定位当前绿色部署格',true,'deploy-tile');
   // Model inference can outlast the selection-camera transition. Align the
   // reference against a fresh frame immediately before dispatching the drag.
   if(fastControl)await control('capture');
   const aligned=await referenceCheck('tile');if(!aligned.ok)throw Error('Reference map or green tile not verified');
   if(Math.hypot(tile[0]-aligned.target_point[0],tile[1]-aligned.target_point[1])>.035){log('reference_corrected_tile',{model_point:tile,aligned_point:aligned.target_point});tile=aligned.target_point;}
   if(tile[1]<.2||tile[1]>.75||tile[0]<.3||tile[0]>.92)throw Error('Tile outside battlefield');
   await drag(card,tile);
   const diamond=await referenceCheck('direction');if(!diamond.ok)throw Error('Direction selector not visible after mouse release');
   let center=await locate('参考成功截图定位当前方向框中心',true,'deploy-direction');
   if(Math.hypot(center[0]-diamond.target_point[0],center[1]-diamond.target_point[1])>.06){log('reference_corrected_direction',{model_point:center,outline_center:diamond.target_point});center=diamond.target_point;}
   if(center[0]>.85)throw Error('Direction drag would leave safe bounds');
   await drag(center,[center[0]+.12,center[1]]);
   const verification=await infer('核对落地状态','stage-fast');
   const landed=await referenceCheck('landed');
   const candidate=landed.ok;
   trials.push({round,status:candidate?'local_candidate_success':'not_confirmed',verified_by_recording:false,
      recognized_to_verification_ms:performance.now()-recognized,total_ms:performance.now()-began,verification,landed});
   log('trial_result',trials.at(-1));
   }
  }catch(e){trials.push({round,status:'failed',error:e.message,total_ms:performance.now()-began});log('trial_result',trials.at(-1));}
  if(round<roundCount && entered){
   let result=false;const until=performance.now()+180000;
   while(performance.now()<until){await control('capture');if((await referenceCheck('result')).ok){result=true;break;}await new Promise(r=>setTimeout(r,2000));}
   if(!result){log('second_trial_blocked',{reason:'No result page, avoid unrelated navigation'});break;}
  }
 }
 fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({trials,directory:out,eventLoop,scope:eventLoop?'Local Qwen pre-battle navigation; trained card YOLO and cached image checks drive the in-process battle controller. No chat or per-gesture Qwen call. Independent video review required.':'Local Qwen+YOLO proposals plus reference image alignment and counter/diamond checks; no chat in loop. Video review required for battle appearance timing.'},null,2));
 log('finished',{directory:out});
})().catch(e=>{log('fatal',{error:e.message});process.exitCode=1}).finally(()=>referenceWorker.close());
