function analyzeInteractions(events, frames) {
  const groups = new Map();
  for (const e of events) {
    if (e.type === 'down' || e.type === 'wheel') groups.set(e.gesture, { start:e, path:[e], end:e.type==='wheel'?e:undefined });
    else if (groups.has(e.gesture)) {
      const g=groups.get(e.gesture); g.path.push(e);
      if (e.type==='up' || e.type==='cancel') g.end=e;
    }
  }
  return [...groups.entries()].map(([id,g])=>{
    const durationMs=g.end ? g.end.elapsedMs-g.start.elapsedMs : null;
    const distance=Math.max(0,...g.path.filter(e=>e.x!==null).map(e=>Math.hypot(e.x-g.start.x,e.y-g.start.y)));
    const complete=g.end?.type==='up';
    const keyboard=g.start.input?.startsWith('key:');
    const kind=g.start.type==='wheel'?'wheel':!complete?'incomplete':keyboard?(durationMs>=600?'key-hold':'key-press'):distance>=8?'drag':durationMs>=600?'long-press':'short-click';
    return { id, kind, input:g.start.input||'mouse:left', repeatCount:g.path.filter(e=>e.type==='repeat').length, durationMs, maxDisplacement:Math.round(distance), start:g.start,
      frames:frames.filter(f=>f.gesture===id),
      controlType:'unknown', stateChange:'unverified',
      note:'按键轨迹规则推断；拖动不代表滑块，点击不代表开关。需对照前后画面确认控件类型、变化及数值范围。' };
  });
}
module.exports={analyzeInteractions};
