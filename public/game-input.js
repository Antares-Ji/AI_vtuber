const $ = id => document.getElementById(id);
let frame = null, points = [], busy = false, skillRunId = null;
const agentPanel = document.createElement('div');
agentPanel.className = 'pane';
agentPanel.innerHTML = '<h2>角色自动玩</h2><p>当前主播角色调用 DeepSeek 决策，本地 Qwen 看画面，原生键鼠执行。启动后由服务器持续运行，无需保持此页面前台。</p><div class="row"><button id="gi-agent-start">启动角色自动玩</button><button id="gi-agent-stop" class="danger">停止自动玩</button></div><p class="meta">打开游戏的单人菜单或当前冒险后启动，并松开键鼠。结算、连续识别失败或重复动作会自动停止；单次上限300步。首次读取画面可能需要等待。不会自动开始下一局。</p><p id="gi-agent-status" role="status">尚未启动</p><pre id="gi-agent-decision"></pre>';
$('game-input').querySelector('.section-head').after(agentPanel);
for (const p of $('game-input').querySelectorAll('p.meta')) if (p.textContent.includes('未启用后台模型自主循环')) p.textContent = '手动操作与角色自动循环共用原生执行器。自动运行期间手动动作锁定；停止后可接管。';
async function api(route, body) {
  const response = await fetch('/api/game-input/' + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '操作未完成');
  return data;
}
async function skillApi(route, body) {
  const response = await fetch('/api/skills/' + route, body === undefined ? {} : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '自动任务未完成');
  return data;
}
function showPoints() {
  $('gi-coordinates').textContent = points.length ? points.map((p, i) => `${i + 1}: (${p.map(v => v.toFixed(3)).join(', ')})`).join(' → ') : '尚未选择落点';
  $('gi-markers').replaceChildren(...points.map((p, i) => {
    const dot = document.createElement('span'); dot.textContent = String(i + 1); dot.style.left = p[0] * 100 + '%'; dot.style.top = p[1] * 100 + '%'; return dot;
  }));
}
function showRun(run) {
  if (!run || run.id === frame?.id) return;
  frame = run; points = []; showPoints();
  if (run.image) $('gi-image').src = run.image;
  else $('gi-image').removeAttribute('src');
  $('gi-result').textContent = `${run.status === 'captured_only' ? '截图完成' : run.status === 'awaiting_visual_review' ? '输入已执行，请核对游戏变化' : '已停止'} · ${run.error || new Date(run.updatedAt).toLocaleTimeString()}`;
  $('gi-details').textContent = JSON.stringify({ actions: run.actions, events: run.events, error: run.error, held_keys: run.held_keys, held_buttons: run.held_buttons, game_verified: run.game_verified }, null, 2);
  $('gi-video').hidden = !run.recording;
  $('gi-video').href = run.recording || '#'; $('gi-video').download = 'game-input.avi';
}
async function refresh() {
  try {
    const state = await api('state');
    const jobs = await skillApi('runs');
    const managed = jobs.runs.find(j => j.skill === 'sts2:native-play' && ['RUNNING','STOPPING'].includes(j.state));
    skillRunId = managed?.id || null;
    const agent = state.autonomous;
    if (agent) {
      if (agent.stage === 'vision-retry') agent.stage = '识图结果无效，正在重试';
      if (agent.stage === 'map-reading') agent.stage = '正在识别下一层可选地图节点';
      if (agent.stage === 'target-grounding') agent.stage = '正在精确定位所选节点';
      if (agent.stage === 'waiting-for-vision') agent.stage = '等待本地视觉模型就绪';
      if (agent.stage === 'energy-reading') agent.stage = '单独核对剩余能量';
      if (agent.stage === 'battle-reading') agent.stage = '本地视觉分区识别战场与手牌';
      if (agent.stage === 'player-reading') agent.stage = '本地视觉读取生命与格挡';
      if (agent.stage === 'card-reading') agent.stage = '本地视觉读取展开牌面';
      const stages = {idle:'待启动',starting:'启动中','waiting-for-game':'正在切换游戏窗口，请松开键鼠；若未切换，请点回游戏窗口',capturing:'截图',seeing:'本地视觉识别', 'role-thinking':'角色 API 思考',executing:'执行键鼠','observing-next-frame':'等待下一帧',finished:'已到结局或角色停止',stopped:'已停止',stopping:'正在停止',error:'异常停止','step-limit':'达到本次步数上限','preview-complete':'只读决策验证完成'};
      $('gi-agent-status').textContent = `${agent.running ? '运行中' : '未运行'} · ${stages[agent.stage] || agent.stage} · ${agent.steps}步${agent.lastError ? ' · '+agent.lastError : ''}`;
      $('gi-agent-start').disabled = agent.running || state.busy || state.stopped || Boolean(managed);
      $('gi-agent-decision').textContent = agent.lastDecision ? `${agent.lastDecision.line || ''}\n理由：${agent.lastDecision.reason || ''}\n预期：${agent.lastDecision.expected || ''}\n上一步反馈：${agent.lastDecision.previousOutcome || '暂无'}\n${agent.logFile || ''}` : '';
    }
    $('gi-state').textContent = state.busy || busy ? '正在操作游戏，请松开键鼠…' : state.stopped ? '已停止，按键已请求释放' : '本地执行器就绪 · 截图按动作更新';
    $('gi-execute').disabled = state.busy || busy || state.stopped || agent?.running;
    $('gi-capture').disabled = state.busy || busy || state.stopped || agent?.running;
    showRun(state.runs[0]);
  } catch (error) { $('gi-state').textContent = error.message; }
}
async function execute(body) {
  if (busy) return;
  busy = true; $('gi-execute').disabled = true; $('gi-capture').disabled = true;
  $('gi-state').textContent = '正在激活游戏并执行，请松开键鼠…';
  try { showRun(await api('action', { ...body, frameId: frame?.id })); }
  catch (error) { $('gi-result').textContent = error.message; }
  finally { busy = false; await refresh(); }
}
$('gi-image').addEventListener('click', event => {
  if (!frame?.image || busy) return;
  const rect = event.currentTarget.getBoundingClientRect();
  const p = [(event.clientX - rect.left) / rect.width, (event.clientY - rect.top) / rect.height];
  if ($('gi-kind').value !== 'drag' || points.length === 2) points = [];
  points.push(p); showPoints();
});
$('gi-kind').onchange = () => { points = []; showPoints(); };
$('gi-capture').onclick = () => execute({ kind: 'capture' });
$('gi-read-card').onclick = async () => {
  if (!frame?.image) return;
  $('gi-read-card').disabled = true; $('gi-card-result').textContent = '本地 Qwen 正在读取截图…';
  try { const result = await api('read-card', { frameId: frame.id }); $('gi-card-result').textContent = JSON.stringify({ model: result.model, seconds: result.seconds, parsed: result.parsed, record: result.record, verification: result.verification }, null, 2); }
  catch (error) { $('gi-card-result').textContent = error.message; }
  finally { $('gi-read-card').disabled = false; }
};
$('gi-execute').onclick = () => {
  const kind = $('gi-kind').value;
  if (['click', 'hover'].includes(kind) && points.length !== 1 || kind === 'drag' && points.length !== 2) { $('gi-result').textContent = '请先在截图上选好落点'; return; }
  execute({ kind, from: points[0], to: kind === 'drag' ? points[1] : points[0], steps: Number($('gi-steps').value), key: $('gi-key').value });
};
for (const action of ['stop', 'resume']) $('gi-' + action).onclick = async () => {
  try {
    // The direct stop is always available, including during host cleanup.
    await api(action, {});
    if (action === 'stop' && skillRunId) await skillApi(`runs/${skillRunId}/stop`, {});
    await refresh();
  } catch (error) { $('gi-result').textContent = error.message; }
};
$('gi-agent-start').onclick = async () => {
  $('gi-agent-start').disabled = true;
  try {
    const job = await skillApi('run', { skill: 'sts2:native-play', args: { maxSteps: 300 }, allowLive: true });
    skillRunId = job.id; await refresh();
  }
  catch (error) { $('gi-agent-status').textContent = error.message; $('gi-agent-start').disabled = false; }
};
$('gi-agent-stop').onclick = () => $('gi-stop').click();
if (location.hash === '#game-input') document.querySelector('[data-tab="game-input"]').click();
setInterval(() => { if ($('game-input').classList.contains('active')) refresh(); }, 2000);
refresh();
