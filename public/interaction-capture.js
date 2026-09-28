const $=id=>document.getElementById(id);
const video=$('preview'), target=$('mouse-window'), start=$('mouse-start'), end=$('mouse-stop'), status=$('mouse-status');
let run=null, active=false, stopping=false, pollTimer, captureTimer, cursor=-1, gesture=null;
let sourceStream=null;
const held=new Set();
start.disabled=true;
let history=[], post=[], queue=[], uploading=false, uploadDone=Promise.resolve(), count=0;
async function api(suffix,options={}) {
  const response=await fetch('/api/vision/interactions'+suffix,{...options,signal:AbortSignal.timeout(45000)});
  const data=await response.json();if(!response.ok)throw new Error(data.error||`HTTP ${response.status}`);return data;
}
function snapshot() {
  if(!video.srcObject || video.readyState<2 || !video.videoWidth)return null;
  const canvas=document.createElement('canvas'),scale=Math.min(1,1280/video.videoWidth,960/video.videoHeight);
  canvas.width=Math.round(video.videoWidth*scale);canvas.height=Math.round(video.videoHeight*scale);
  canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height);
  return {canvas,at:Date.now(),mediaTime:video.currentTime};
}
function retain(frame,id,phase) {
  if(!frame||!active)return;
  if(count+queue.length+(uploading?1:0)>=18000||queue.length>=120) {status.textContent='达到18000帧容量或保存队列积压120帧，正在停止；已保存内容保留。';void finish();return;}
  queue.push({frame,id,phase});void drain();
}
async function drain() {
  if(uploading)return uploadDone;
  uploading=true;
  uploadDone=(async()=>{
    while(queue.length) {
      const {frame,id,phase}=queue.shift();
      const blob=await new Promise(resolve=>frame.canvas.toBlob(resolve,'image/jpeg',.9));
      if(!blob)throw new Error('连拍编码失败');
      const result=await api(`/${run.id}/frames?gesture=${id}&phase=${phase}&at=${frame.at}&mediaTime=${frame.mediaTime??''}`,{method:'POST',headers:{'Content-Type':'image/jpeg'},body:blob});
      count=result.count;
      if($('capture-meter'))$('capture-meter').textContent=`实际已落盘 ${count} 张；等待保存 ${queue.length} 张。结束后按时间戳核算连续采样帧率。`;
    }
  })();
  try {await uploadDone;} catch(error) {queue=[];status.textContent=`${error.message} 正在停止录制。`;setTimeout(()=>void finish(),0);}
  finally {uploading=false;}
}
function sample() {
  if(!active)return;
  if(!video.srcObject || video.srcObject!==sourceStream || video.srcObject.getVideoTracks()[0]?.readyState==='ended') {void finish();return;}
  const frame=snapshot();
  if(frame) {
    history.push(frame);history=history.slice(-8);
    for(const id of held)retain(frame,id,'held');
    for(const item of post.filter(item=>item.due<=frame.at))retain(frame,item.id,'after');
    post=post.filter(item=>item.due>frame.at);
  }
  if(active)captureTimer=setTimeout(sample,33);
}
async function poll() {
  if(!active)return;
  try {
    const data=await api(`/${run.id}/events?after=${cursor}`);
    if(!active)return;
    if(data.diagnostic && cursor===-1) {
      const d=data.diagnostic;
      status.textContent=`监听诊断：鼠标回调 ${d.rawMouse}，键盘回调 ${d.rawKeyboard}，已接收 ${d.accepted}；游戏${d.targetForeground?'在':'不在'}前台。尚未记录有效操作。`;
    }
    for(const event of data.events) {
      cursor=event.seq;
      if(event.type==='down' || event.type==='wheel') {
        post=[];
        const before=history.filter(f=>f.at<=event.at).at(-1);
        retain(before,event.gesture,'before');
        retain(snapshot(),event.gesture,'event');
        if(event.type==='down')held.add(event.gesture);
        else post.push({id:event.gesture,due:Date.now()+150},{id:event.gesture,due:Date.now()+500});
      } else if(event.type==='up' || event.type==='cancel') {
        held.delete(event.gesture);
        retain(snapshot(),event.gesture,'release');
        if(event.type==='up')post.push({id:event.gesture,due:Date.now()+250},{id:event.gesture,due:Date.now()+700});
      }
      status.textContent=`操作 ${event.gesture} ${event.input||''}：${({down:'按下',move:'按住移动',hover:'指针移动',up:'抬起',cancel:'中断',wheel:'滚轮 '+event.delta,repeat:'键盘重复'})[event.type]}；已保存 ${count}/18000 帧，队列 ${queue.length}。`;
    }
    if(data.status==='stopped'){status.textContent='观察器已停止，正在整理已保存内容。';void finish();return;}
  } catch(error) {status.textContent=error.message;void finish();return;}
  if(active)pollTimer=setTimeout(poll,20);
}
function show(data) {
  const output=$('mouse-results');output.replaceChildren();
  const a=document.createElement('a');a.href=`/api/vision/interactions/${data.id}`;a.target='_blank';a.rel='noopener';a.textContent='查看操作轨迹、时间及分析 JSON';output.append(a);
  const p=document.createElement('p');p.textContent=`主界面 → ${data.entryLabel}；保存目录：runtime/vision/interactions/${data.id}`;output.append(p);
  if(data.frameMetrics){const m=document.createElement('p');m.textContent=`实测：${data.frameMetrics.frameCount} 张落盘，连续按住区间 ${data.frameMetrics.bursts.length} 段。`+data.frameMetrics.bursts.map(b=>`操作${b.gesture}：${b.captureFps}采样/秒，视频时间不同的帧 ${b.sourceFps??'不可测'}/秒，最大间隔${b.maxGapMs}ms`).join('；');output.append(m);}
  const flow=document.createElement('a');flow.href=`/annotations/flow.html?kind=interactions&id=${data.id}`;flow.target='_blank';flow.rel='noopener';flow.textContent='查看／修正界面流程候选';output.append(flow);
  for(const item of data.analysis||[]) {
    const detail=document.createElement('details'),summary=document.createElement('summary');
    const names={'drag':'拖动候选','long-press':'长按候选','short-click':'短按','incomplete':'中断／缺少抬起','wheel':'滚轮','key-press':'键盘短按','key-hold':'键盘长按'};
    summary.textContent=`操作 ${item.id}：${names[item.kind]}，${item.durationMs??'?'} ms，位移 ${item.maxDisplacement}px，${item.frames.length} 张画面`;
    detail.append(summary);
    const note=document.createElement('p');note.textContent=item.note;detail.append(note);
    const evidence=data.visualEvidence?.find(e=>e.id===item.id);
    if(evidence){const p=document.createElement('p');p.textContent=evidence.description;detail.append(p);}
    for(const f of item.frames) {
      const link=document.createElement('a');link.href=`/api/vision/interactions/${data.id}/${f.file}`;link.target='_blank';link.rel='noopener';
      link.textContent=`${f.phase} · ${new Date(f.capturedAt).toISOString().slice(11,23)} UTC · ${f.file}`;
      detail.append(link,document.createElement('br'));
    }
    output.append(detail);
  }
}
async function finish() {
  if(!run||stopping)return;
  stopping=true;active=false;clearTimeout(pollTimer);clearTimeout(captureTimer);end.disabled=true;
  // Keep the observer lease alive until queued frames are persisted, without recording further screenshots.
  const lease=setInterval(()=>{void api(`/${run.id}/events?after=${cursor}`).catch(()=>{});},2000);
  try {
    await api(`/${run.id}/pause`,{method:'POST'}).catch(()=>{});
    await uploadDone.catch(()=>{});
    const data=await api(`/${run.id}/stop`,{method:'POST'});show(data);
    if(data.frames.length)void api(`/${run.id}/flow`,{method:'POST'}).catch(()=>{});
    status.textContent=data.outcome?.message || (data.frames.length
      ? `已保存 ${data.frames.length} 张画面、${data.analysis.length} 次操作，待人工验收。`
      : '采集异常：没有保存连拍画面，本次不能用于交互验收。');
  } catch(error){status.textContent=`${error.message} 已保存文件保留，请点击停止重试。`;end.disabled=false;}
  finally {clearInterval(lease);stopping=false;start.disabled=false;target.disabled=false;$('mouse-confirm').disabled=false;}
}
$('mouse-refresh').addEventListener('click',async()=>{
  if(active||stopping)return;
  try {
    const data=await api('/windows');target.replaceChildren();$('mouse-confirm').checked=false;
    for(const w of data.windows){const option=document.createElement('option');option.value=w.handle;option.textContent=`${w.title} (${w.handle})`;target.append(option);}
    status.textContent=data.windows.length?'请确认与共享预览相同，然后开启连拍。':'没有找到可见的明日方舟窗口，请先打开客户端。';
  }catch(error){status.textContent=error.message;}
});
async function begin() {
  if(active||stopping)return;
  if(!video.srcObject||!video.videoWidth)throw new Error('请先共享游戏窗口');
  if(!target.value || !$('mouse-confirm').checked) {
    const data=await api('/windows');
    const label=video.srcObject.getVideoTracks()[0]?.label||'';
    target.replaceChildren();
    for(const w of data.windows){const option=document.createElement('option');option.value=w.handle;option.textContent=`${w.title} (${w.handle})`;target.append(option);}
    if(data.windows.length!==1 || !label.includes(data.windows[0].title))throw new Error(data.windows.length?'已列出游戏窗口，但共享视频没有可验证的窗口名称。请勾选“已确认与共享窗口相同”，再点开始自动采集，无需另开连拍。':'未找到可见明日方舟窗口，请先打开游戏');
    $('mouse-confirm').checked=true;
  }
  start.disabled=true;target.disabled=true;$('mouse-confirm').disabled=true;
  try {
    sourceStream=video.srcObject;
    run=await api('',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({handle:target.value,entryId:$('page-entry').value})});
    cursor=-1;gesture=null;held.clear();history=[];post=[];queue=[];count=0;active=true;end.disabled=false;
    try{localStorage.setItem('arknights-last-interaction',run.id);}catch{}
    status.textContent='鼠标、键盘、滚轮记录已开启；事件触发截图，按住期间目标30帧/秒。';sample();void poll();
  }catch(error){status.textContent=error.message;start.disabled=false;target.disabled=false;$('mouse-confirm').disabled=false;throw error;}
}
start.addEventListener('click',()=>begin().catch(error=>{status.textContent=error.message;}));
window.interactionRecorder={begin,finish};
end.addEventListener('click',finish);
window.addEventListener('pagehide',()=>{
  active=false;clearTimeout(pollTimer);clearTimeout(captureTimer);
  if(run)void fetch(`/api/vision/interactions/${run.id}/stop`,{method:'POST',keepalive:true}).catch(()=>{});
});
try {
  const previous=localStorage.getItem('arknights-last-interaction');
  if(previous&&/^[a-f0-9-]{36}$/.test(previous)) {
    const data=await api(`/${previous}`);show(data);
  }
}catch{}
start.disabled=false;
