'use strict';
const $ = id => document.getElementById(id);
let fetching = false, previewing = false, previewReady = false, previewUrl = null;
async function api(route, data) {
  const r = await fetch('/api/sts2' + route, { ...(data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) });
  const body = await r.json(); if (!r.ok) throw Error(body.error || `HTTP ${r.status}`); return body;
}
async function preview() {
  if (previewing || !previewReady) return;
  previewing = true;
  try {
    const r = await fetch('/api/sts2/preview', { cache: 'no-store' });
    if (!r.ok) { const detail = await r.json().catch(() => ({})); throw Error(detail.error || 'OBS 画面尚未就绪，请连接直播场景'); }
    const next = URL.createObjectURL(await r.blob());
    const previous = previewUrl; previewUrl = next;
    $('preview').src = next; $('previewEmpty').hidden = true;
    if (previous) URL.revokeObjectURL(previous);
    $('previewStatus').textContent = 'OBS 合成画面已连接';
  } catch (e) { $('previewStatus').textContent = e.message; }
  finally { previewing = false; }
}
async function refresh() {
  if (fetching) return; fetching = true;
  try {
    const [status, context] = await Promise.all([api('/status'), api('/context')]);
    $('liveStatus').textContent = status.running ? '岁歌正在游玩' : '游玩已暂停'; $('liveDot').dataset.running = String(status.running);
    $('phase').textContent = `已执行 ${status.steps || 0} 步${context?.run ? `，第 ${context.run.act} 幕，第 ${context.run.floor} 层` : ''}`;
    $('intent').textContent = status.lastDecision?.reason || '等我看一眼这手牌。';
    $('speech').textContent = status.streamer?.pending?.line || status.streamer?.last?.line || '等待新的解说';
    const phase = status.streamer?.pending?.state;
    $('speechLabel').textContent = phase === 'started' ? '岁歌正在说' : phase ? '下一句解说' : '最近一句解说';
    $('sync').textContent = phase === 'started' ? '主播正在解说，游戏动作已放行' : phase === 'delivered' ? '正在准备语音' : phase === 'queued' ? '等待主播接过这句台词' : status.streamer?.enabled ? '解说联动已开启' : '解说联动已关闭';
    if (document.activeElement !== $('narration')) $('narration').checked = Boolean(status.streamer?.enabled);
    $('character').textContent = context?.player?.character || '—';
    $('hp').textContent = context?.player ? `${context.player.hp} / ${context.player.maxHp}` : '—';
    $('energy').textContent = context?.player?.energy ?? '—';
    $('floor').textContent = context?.run ? `${context.run.act} 幕 ${context.run.floor} 层` : '—';
    $('diagnostic').textContent = `${status.model || 'DeepSeek'}，${status.keyConfigured ? '凭据已配置' : '缺少凭据'}${status.lastError ? '；' + status.lastError : ''}`;
    $('start').disabled = Boolean(status.running); $('stop').disabled = !status.running;
    if (status.lastError) $('feedback').textContent = status.lastError;
  } catch (e) { $('liveStatus').textContent = '连接暂时中断'; $('feedback').textContent = e.message; }
  finally { fetching = false; }
}
async function setup() {
  $('feedback').textContent = '正在连接游戏画面与主播…';
  try { const scene = await api('/obs/setup', {}); previewReady = true; $('feedback').textContent = `已连接 ${scene.scene}`; await preview(); }
  catch (e) { $('feedback').textContent = e.message; }
}
$('setup').onclick = setup; $('reconnect').onclick = setup;
$('start').onclick = async () => {
  $('start').disabled = true; $('feedback').textContent = '';
  try {
    await api('/streamer', { enabled: $('narration').checked });
    await api('/start', { steps: Number($('steps').value), goal: $('goal').value });
    await refresh();
  } catch (e) { $('feedback').textContent = e.message; $('start').disabled = false; }
};
$('stop').onclick = async () => { try { await api('/stop', {}); await refresh(); } catch (e) { $('feedback').textContent = e.message; } };
$('narration').onchange = async () => { try { await api('/streamer', { enabled: $('narration').checked }); } catch (e) { $('feedback').textContent = e.message; } };
$('fullscreen').onclick = () => $('preview').parentElement.requestFullscreen();
$('chat').onsubmit = async event => {
  event.preventDefault(); const text = $('chatText').value.trim(); if (!text) return;
  try {
    const r = await fetch('/api/sts2/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text }) });
    if (!r.ok) throw Error('发送失败，请重试');
    $('chatText').value = ''; $('chatStatus').textContent = '已送到直播间，岁歌会在解说间隙回应。';
  } catch (e) { $('chatStatus').textContent = e.message; }
};
// Discover a preconfigured OBS scene without changing the user's current scene.
fetch('/api/sts2/preview').then(r => { if (r.ok) { previewReady = true; return preview(); } }).catch(() => {});
refresh(); setInterval(refresh, 1400); setInterval(preview, 1100);
