(() => {
  const el = id => document.getElementById(id);
  if (!el('spireTacticsStatus')) return;
  async function refresh() {
    try {
      const response = await fetch('/sts2-tactics.json', { cache: 'no-store', signal: AbortSignal.timeout(4000) });
      if (!response.ok) throw Error('尚未生成总结');
      const report = await response.json();
      const worker = await fetch('/sts2-tactics-status.json', { cache: 'no-store', signal: AbortSignal.timeout(4000) }).then(r => r.ok ? r.json() : null).catch(() => null);
      for (const field of ['Situation', 'Plan', 'Reason', 'Risk', 'Lesson']) el('spireTactics' + field).textContent = report.summary[field.toLowerCase()];
      const current = await fetch('/api/sts2/context', { signal: AbortSignal.timeout(4000) }).then(r => r.json());
      const changed = report.stale || current?.run?.floor !== report.run?.floor || current?.scene !== report.scene || Date.now() - Date.parse(report.observedAt) > 90000;
      el('spireTacticsStatus').textContent = `${worker?.phase || '自动观察'}${worker?.lastError ? '：' + worker.lastError : ''} · 第 ${report.run?.floor ?? '—'} 层${report.round ? ` · 第 ${report.round} 回合` : ''} · ${new Date(report.observedAt).toLocaleTimeString()} · ${changed ? '历史局面，等待新总结' : '该次观测的打法推断'} · 未实战验证`;
    } catch (error) { el('spireTacticsStatus').textContent = error.message; }
  }
  refresh(); setInterval(refresh, 5000);
})();
