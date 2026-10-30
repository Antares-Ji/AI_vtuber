(() => {
  'use strict';
  const el = id => document.getElementById(id), names = { minecraft: '我的世界', sts2: '杀戮尖塔 2' };
  let game = 'minecraft', refreshing = false, previewing = false, reconnecting = false, previewUrl, spireStatus;
  let selectionReady = Promise.resolve();
  const goals = { minecraft: null, sts2: null };
  // Keep setup and diagnostics below the persistent live interaction layout.
  for (const panel of document.querySelectorAll('.engine-panel')) el('technicalDetails').append(panel);
  for (const selector of ['.session-toolbar', '#demoProgress']) document.querySelector('.world-viewer-card').append(document.querySelector(selector));
  async function request(route, data) {
    const response = await fetch(route, { signal: AbortSignal.timeout(10000), ...(data === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data) }) });
    const body = await response.json(); if (!response.ok) throw Error(body.error || `HTTP ${response.status}`); return body;
  }
  function notifyStage() { el('streamStage').contentWindow?.postMessage({ type: 'workbench-game', game }, location.origin); }
  function renderGoal() {
    el('goalGameLabel').textContent = names[game];
    el('longTermGoal').textContent = goals[game]?.goal || '尚未提交';
    el('currentStageGoal').textContent = goals[game]?.plan || '等待模型规划';
  }
  function selectGame(value) {
    game = Object.hasOwn(names, value) ? value : 'minecraft';
    for (const node of document.querySelectorAll('[data-game-only]')) node.hidden = node.dataset.gameOnly !== game;
    for (const tab of document.querySelectorAll('[role=tab][data-game]')) { tab.setAttribute('aria-selected', String(tab.dataset.game === game)); tab.tabIndex = tab.dataset.game === game ? 0 : -1; }
    renderGoal(); el('connectionText').textContent = `正在读取${names[game]}状态`;
    // Serialize server context changes; shared inputs and the voice iframe never remount.
    const selected = game;
    selectionReady = selectionReady.catch(() => {}).then(() => request('/api/games/active', { game: selected }));
    selectionReady.then(() => { if (game === selected) notifyStage(); }).catch(error => { el('workbenchFeedback').textContent = `游戏上下文切换失败：${error.message}`; });
    const url = new URL(location.href); url.searchParams.set('game', game); history.replaceState(null, '', url);
    try { localStorage.setItem('streamer-workbench-game', game); } catch {}
    document.title = `姬岁歌 · ${names[game]} · 游戏工作台`;
    refresh(); if (game === 'minecraft') window.dispatchEvent(new Event('workbench-minecraft-refresh')); else preview();
  }
  async function refresh() {
    if (refreshing) return; refreshing = true;
    try {
      const results = await Promise.allSettled([request('/api/minecraft/loop'), request('/api/minecraft/status'), request('/api/sts2/status'), request('/api/sts2/context')]);
      const [loop, world, status, context] = results.map(r => r.status === 'fulfilled' ? r.value : null);
      const ended = !status?.running && (context?.scene === 'game_over' || status?.lastState?.type === 'game_over');
      const defeated = ended && (context?.player?.hp ?? status?.lastState?.hp) === 0;
      const endLabel = defeated ? '角色已阵亡，本局结束' : '本局已结束';
      el('status-minecraft').textContent = loop?.enabled || loop?.running ? '运行中' : world?.connected ? '已暂停' : '未连接';
      el('status-sts2').textContent = status ? status.running ? '运行中' : ended ? endLabel : '已暂停' : '服务未连接';
      if (loop) goals.minecraft = { goal: loop.goal, plan: loop.currentSubgoal || loop.lastDecision?.reason };
      spireStatus = status; if (status) goals.sts2 = { goal: status.goal, plan: status.lastDecision?.reason };
      if (game !== 'sts2') return;
      el('connectionText').textContent = status ? status.running ? '尖塔任务运行中' : ended ? endLabel : '尖塔任务已暂停' : '尖塔服务未连接';
      el('connectionDot').classList.toggle('down', !status); el('updatedAt').textContent = new Date().toLocaleTimeString();
      el('spireStatus').textContent = status?.running ? '岁歌正在游玩' : ended ? endLabel : '任务已暂停';
      el('spireVitals').textContent = context?.player ? `生命 ${context.player.hp}/${context.player.maxHp} · 能量 ${context.player.energy ?? '—'} · 第 ${context.run?.floor ?? '—'} 层` : '实时游戏状态暂不可用';
      el('spireDetail').textContent = ended ? `第 ${context?.run?.floor ?? status?.lastState?.run?.floor ?? '—'} 层结束 · 已执行 ${status?.steps || 0} 步。返回游戏主菜单后可开始新局。` : status?.lastError || `已执行 ${status?.steps || 0} 步 · ${status?.streamer?.pending?.line || status?.streamer?.last?.line || '等待解说'}`;
      el('spireResume').disabled = !status || Boolean(status.running);
      if (status) el('spireNarration').checked = Boolean(status.streamer?.enabled);
      renderGoal();
    } finally { refreshing = false; }
  }
  async function preview() {
    if (previewing || game !== 'sts2' || document.hidden) return; previewing = true;
    try {
      const response = await fetch('/api/sts2/game-preview', { signal: AbortSignal.timeout(6000), cache: 'no-store' });
      if (!response.ok) {
        const detail = await response.json().catch(() => ({}));
        throw Error(detail.error || '游戏画面未连接，请检查 OBS 和游戏窗口后重连。');
      }
      const next = URL.createObjectURL(await response.blob());
      el('spirePreview').src = next; el('spirePreview').hidden = false; el('spirePreviewHint').hidden = true;
      if (previewUrl) URL.revokeObjectURL(previewUrl); previewUrl = next;
      return true;
    } catch (error) { el('spirePreview').hidden = true; el('spirePreviewHint').hidden = false; el('spirePreviewHint').textContent = error.message; return false; }
    finally { previewing = false; }
  }
  async function submitGoal(goal) {
    await selectionReady;
    if (spireStatus?.running) throw Error('尖塔任务正在执行，请先停止当前任务再提交新目标。');
    const steps = Number(el('spireSteps').value);
    if (!Number.isInteger(steps) || steps < 1 || steps > 500) throw Error('本轮步数应为 1 到 500 的整数。');
    await request('/api/sts2/streamer', { enabled: el('spireNarration').checked });
    const result = await request('/api/sts2/start', { goal, steps });
    goals.sts2 = { goal, plan: '正在规划下一步' }; await refresh(); return result;
  }
  async function stop() {
    const selected = game;
    try { await request(`/api/${selected}/stop`, {}); el('workbenchFeedback').textContent = `已请求停止${names[selected]}任务。`; }
    catch (error) { el('workbenchFeedback').textContent = error.message; } await refresh();
  }
  window.gameWorkbench = { get game() { return game; }, refresh, submitGoal, stop, ready: () => selectionReady };
  el('streamStage').addEventListener('load', () => selectionReady.then(notifyStage).catch(() => {}));
  for (const tab of document.querySelectorAll('[role=tab][data-game]')) {
    tab.addEventListener('click', () => selectGame(tab.dataset.game));
    tab.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault(); const next = event.key === 'Home' ? 'minecraft' : event.key === 'End' ? 'sts2' : game === 'minecraft' ? 'sts2' : 'minecraft'; selectGame(next); el(`tab-${next}`).focus();
    });
  }
  el('stopGame').addEventListener('click', stop);
  el('spireConnect').addEventListener('click', async () => {
    if (reconnecting) return; reconnecting = true;
    const button = el('spireConnect'); button.disabled = true; button.textContent = '连接中…';
    el('workbenchFeedback').textContent = '正在连接 OBS，等待游戏画面…';
    try {
      await request('/api/sts2/obs/setup', {});
      if (await preview() === false) throw Error(el('spirePreviewHint').textContent || 'OBS 游戏源已就绪，网页预览暂未收到画面，请重试。');
      el('workbenchFeedback').textContent = '尖塔游戏画面已连接。请保持游戏窗口打开，避免最小化。';
    } catch (error) {
      el('workbenchFeedback').textContent = `重连失败：${error.message}`;
      el('spirePreviewHint').hidden = false; el('spirePreviewHint').textContent = error.message;
    } finally { reconnecting = false; button.disabled = false; button.textContent = '重连画面'; }
  });
  el('spireResume').addEventListener('click', async () => { try { await submitGoal(goals.sts2?.goal || '根据当前局面合理出牌，保持生存并继续爬塔。'); } catch (error) { el('spireDetail').textContent = error.message; } });
  el('spireNarration').addEventListener('change', async event => { try { await request('/api/sts2/streamer', { enabled: event.target.checked }); } catch (error) { el('spireDetail').textContent = error.message; await refresh(); } });
  let saved; try { saved = localStorage.getItem('streamer-workbench-game'); } catch {}
  selectGame(new URLSearchParams(location.search).get('game') || saved || 'minecraft');
  setInterval(refresh, 2500); setInterval(preview, 1200);
})();
