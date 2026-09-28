import { StableFrames } from './page-stability.mjs';
const $ = id => document.getElementById(id);
const video = $('preview'), entry = $('page-entry'), start = $('page-start'), end = $('page-end');
const status = $('page-status'), results = $('page-results');
let session = null, active = false, pending = null, timer = null, finishing = false;
let detector;
async function request(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(60000) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`);
  return data;
}
function link(text, file) {
  const a = document.createElement('a');
  a.textContent = text; a.href = `/api/vision/page-sessions/${session.id}/${file}`;
  a.target = '_blank'; a.rel = 'noopener';
  results.append(a, document.createElement('br'));
}
function show(data) {
  results.replaceChildren();
  const p = document.createElement('p');
  p.textContent = `层级：主界面 → ${data.entryId} ${data.entryLabel}；保存目录：runtime/vision/page-sessions/${data.id}`;
  results.append(p);
  const flowLink=document.createElement('a');flowLink.textContent='查看／修正界面流程候选';flowLink.href=`/annotations/flow.html?kind=page-sessions&id=${data.id}`;flowLink.target='_blank';flowLink.rel='noopener';results.append(flowLink,document.createElement('br'));
  link('查看采集记录 JSON（含层级及原图映射）', '');
  // Manifest URL has no trailing slash.
  results.querySelectorAll('a')[1].href = `/api/vision/page-sessions/${data.id}`;
  for (const [i, segment] of data.segments.entries()) {
    link(`结果 ${i + 1} · ${segment.kind === 'scroll-content' ? '滚动内容长图' : '独立画面（未拼接）'} · 待核验`, segment.file);
  }
  for (const [i, frame] of data.frames.entries()) link(`原图 ${i + 1}`, frame.file);
}
async function finish() {
  if (finishing || !session) return;
  finishing = true; active = false; clearTimeout(timer); end.disabled = true;
  status.textContent = '正在结束采集、自动匹配重叠区域并拼接…';
  try {
    await window.interactionRecorder?.finish();
    await pending;
    session = await request(`/api/vision/page-sessions/${session.id}/finish`, { method: 'POST' });
    show(session);
    void fetch(`/api/vision/page-sessions/${session.id}/flow`,{method:'POST'}).catch(()=>{});
    status.textContent = `已保存 ${session.frames.length} 张原图，生成 ${session.segments.length} 份结果。请打开结果检查；无法对齐的画面未强行拼接。`;
  } catch (error) {
    status.textContent = `${error.message} 可点击“结束采集”重试；原图保留。`;
    end.disabled = false;
  } finally { finishing = false; start.disabled = false; entry.disabled = false; }
}
async function sample() {
  if (!active) return;
  if (!video.srcObject || video.srcObject.getVideoTracks()[0]?.readyState === 'ended') {
    active = false; setTimeout(finish, 0); return;
  }
  if (!video.videoWidth || video.readyState < 2) return;
  const frame = document.createElement('canvas');
  const scale = Math.min(1, 1920 / video.videoWidth, 1200 / video.videoHeight);
  frame.width = Math.round(video.videoWidth * scale); frame.height = Math.round(video.videoHeight * scale);
  frame.getContext('2d').drawImage(video, 0, 0, frame.width, frame.height);
  const small = document.createElement('canvas'); small.width = 160; small.height = 100;
  const ctx = small.getContext('2d', { willReadFrequently: true }); ctx.drawImage(frame, 0, 0, 160, 100);
  const rgba = ctx.getImageData(0, 0, 160, 100).data;
  const pixels = new Uint8Array(16000);
  for (let i = 0; i < pixels.length; i++) pixels[i] = Math.round((rgba[i*4] + rgba[i*4+1] + rgba[i*4+2])/3);
  if (!detector.consider(pixels, performance.now())) return;
  const blob = await new Promise(resolve => frame.toBlob(resolve, 'image/jpeg', .94));
  if (!active) return;
  if (!blob) throw new Error('截图编码失败');
  session = await request(`/api/vision/page-sessions/${session.id}/frames?seq=${session.frames.length}`, {
    method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: blob
  });
  detector.saved(pixels);
  status.textContent = `已自动保存 ${session.frames.length}/40 张停稳画面。继续向下滚动；完成后点击结束采集。`;
  if (session.frames.length >= 40) { active = false; status.textContent='停稳样本已达40张，交互连拍继续运行。完成后点击结束采集。'; }
}
function tick() {
  pending = sample().catch(error => {
    active = false; status.textContent = `${error.message} 已暂停，请结束采集查看已保存内容。`;
  }).finally(() => { if (active) timer = setTimeout(tick, 350); });
}
start.addEventListener('click', async () => {
  if (active || finishing) return;
  if (!video.srcObject || !video.videoWidth) { status.textContent = '请先选择游戏窗口，确认预览有画面。'; return; }
  start.disabled = true; entry.disabled = true; end.disabled = true;
  let interactionStarted=false;
  try {
    if (!window.interactionRecorder) throw new Error('交互模块未加载，请刷新页面后重试');
    await window.interactionRecorder.begin();
    interactionStarted=true;
    session = await request('/api/vision/page-sessions', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entryId: entry.value }) });
    try { localStorage.setItem('arknights-last-page-session', session.id); } catch { /* Capture still works if storage is disabled. */ }
    detector = new StableFrames(); active = true; end.disabled = false; results.replaceChildren();
    status.textContent = `正在采集“${session.entryLabel}”。请现在手动进入该入口，滚动后停留约一秒。`;
    tick();
  } catch (error) { if(interactionStarted)await window.interactionRecorder?.finish(); status.textContent = error.message; start.disabled = false; entry.disabled = false; }
});
end.addEventListener('click', finish);
window.addEventListener('pagehide', () => { active = false; clearTimeout(timer); });
try {
  const response = await fetch('/annotations/home-reviewed.json');
  if (!response.ok) throw new Error('入口标注读取失败');
  const data = await response.json(); entry.replaceChildren();
  for (const box of data.boxes) {
    const option = document.createElement('option'); option.value = box.id; option.textContent = `${box.id} · ${box.label}`; entry.append(option);
  }
  let last = null;
  try { last = localStorage.getItem('arknights-last-page-session'); } catch { /* Optional recovery only. */ }
  if (last && /^[0-9a-f-]{36}$/.test(last)) {
    try { session = await request(`/api/vision/page-sessions/${last}`); show(session);
      if (session.status !== 'complete') { end.disabled = false; status.textContent = '上次采集尚未完成，点击“结束采集”可处理已保存原图。'; }
    } catch { /* A missing old session must not block a new capture. */ }
  }
  entry.disabled = false; start.disabled = false;
} catch (error) { status.textContent = error.message; }
