// Pure watchdog policy, separately testable without installing input hooks.
function observerStopReason({ now, lastPoll, lastDiagnostic }) {
  if(now-lastPoll>10000)return 'heartbeat-lost';
  if(now-lastDiagnostic>6000)return 'observer-unresponsive';
  return null;
}
function recordingOutcome(data,events,frames,analysis) {
  const issues=[];
  if(data.stopReason && data.stopReason!=='user')issues.push(`非正常结束：${data.stopReason}`);
  if(!events.length)issues.push('没有收到输入事件，本次不能用于交互验收');
  if(!frames.length)issues.push('没有保存连拍画面');
  const missing=analysis.filter(a=>!a.frames.length).length;
  const incomplete=analysis.filter(a=>a.kind==='incomplete').length;
  if(missing)issues.push(`${missing} 次操作缺少截图`);
  if(incomplete)issues.push(`${incomplete} 次操作中断或缺少抬起`);
  return {verified:false,status:issues.length?'needs-attention':'awaiting-review',issues,
    message:`${issues.length?'采集需检查':'采集已保存，待人工验收'}：${events.length} 条事件，${frames.length} 张画面，${analysis.length} 次操作。${issues.join('；')}`};
}
module.exports={observerStopReason,recordingOutcome};
