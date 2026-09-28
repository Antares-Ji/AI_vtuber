const start = document.querySelector('#start');
const stop = document.querySelector('#stop');
const save = document.querySelector('#save');
const analyze = document.querySelector('#analyze');
const preview = document.querySelector('#preview');
const status = document.querySelector('#status');
let stream = null;
let generation = 0;
let saving = false;
let saveController = null;

function stopCapture() {
  generation++;
  if (saveController) {
    document.querySelector('#analysis').textContent = '共享已停止，未完成的识别已取消。';
    document.querySelector('#saved').textContent = '未完成的保存请求已取消；若此前已保存到本机，文件仍保留。';
  }
  saveController?.abort();
  stream?.getTracks().forEach(track => track.stop());
  stream = null;
  preview.srcObject = null;
  start.disabled = false;
  stop.disabled = true;
  save.disabled = true;
  analyze.disabled = true;
  status.textContent = '已停止共享。';
}

start.addEventListener('click', async () => {
  const owner = ++generation;
  start.disabled = true;
  stop.disabled = false;
  try {
    if (!navigator.mediaDevices?.getDisplayMedia) throw new Error('此浏览器不支持窗口共享，请在 Edge 打开 http://localhost:3000/vision.html');
    const granted = await navigator.mediaDevices.getDisplayMedia({ video: { displaySurface: 'window', frameRate: { ideal: 30, max: 30 } }, audio: false });
    if (owner !== generation) { granted.getTracks().forEach(track => track.stop()); return; }
    stream = granted;
    if (stream.getVideoTracks()[0].getSettings().displaySurface === 'monitor') throw new Error('请选择游戏窗口，不要共享整个屏幕。');
    stream.getVideoTracks()[0].addEventListener('ended', () => {
      if (owner === generation) stopCapture();
    }, { once: true });
    preview.srcObject = stream;
    await preview.play();
    if (owner !== generation) return;
    save.disabled = saving;
    analyze.disabled = saving;
    status.textContent = '只读预览已连接。请确认画面是明日方舟，再选择场景并保存一张样本。';
  } catch (error) {
    if (owner !== generation) return;
    stopCapture();
    status.textContent = `未连接：${error.message}`;
  }
});
stop.addEventListener('click', stopCapture);
window.addEventListener('pagehide', stopCapture);
async function captureFrame(recognize = false) {
  if (!stream || saving || !preview.videoWidth) return;
  saving = true;
  const owner = generation;
  const scene = document.querySelector('#scene').value;
  const controller = new AbortController();
  saveController = controller;
  save.disabled = true;
  analyze.disabled = true;
  const output = document.querySelector(recognize ? '#analysis' : '#saved');
  output.textContent = recognize ? '正在本机识别…' : '正在保存…';
  try {
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, 1920 / preview.videoWidth);
    canvas.width = Math.round(preview.videoWidth * scale);
    canvas.height = Math.round(preview.videoHeight * scale);
    canvas.getContext('2d').drawImage(preview, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .92));
    if (owner !== generation || controller.signal.aborted) return;
    if (!blob) throw new Error('截图编码失败');
    const endpoint = recognize ? '/api/vision/arknights' : `/api/vision/capture?game=arknights&scene=${encodeURIComponent(scene)}`;
    const response = await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'image/jpeg' }, body: blob, signal: AbortSignal.any([controller.signal, AbortSignal.timeout(25000)]) });
    if (!response.ok) throw new Error(`请求失败 HTTP ${response.status}`);
    const result = await response.json();
    if (owner !== generation || controller.signal.aborted) return;
    output.textContent = recognize
      ? `${result.description}\n文字证据：${(result.evidence || []).join('、') || '不足'}\n耗时：${result.latencyMs}ms\n\n识别文字：\n${result.text || '未识别到文字'}\n\n${(result.limitations || []).join('；')}`
      : `已保存本地样本：${result.file || '完成'}（手工标注，不是识别结论）`;
  } catch (error) {
    if (owner === generation && !controller.signal.aborted) output.textContent = error.message;
  }
  finally {
    if (saveController === controller) saveController = null;
    saving = false;
    save.disabled = !stream;
    analyze.disabled = !stream;
  }
}
save.addEventListener('click', () => captureFrame(false));
analyze.addEventListener('click', () => captureFrame(true));
