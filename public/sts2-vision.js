(() => {
  const status=document.getElementById('spireVisionStatus'), watch=document.getElementById('spireVisionWatch'), button=document.getElementById('spireVisionRead');
  if(!status||!watch||!button)return;
  const base='http://127.0.0.1:17645';let reading=false;
  async function call(route,body,timeout=4000) {
    const response=await fetch(base+route,{signal:AbortSignal.timeout(timeout),...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});
    const data=await response.json();if(!response.ok)throw Error(data.error||'视觉服务请求失败');return data;
  }
  async function refresh() {
    try {
      const s=await call('/health');watch.checked=Boolean(s.watch);
      button.disabled=reading||s.busy;
      status.textContent=`本地 VL + YOLO 已就绪 · ${s.busy?'正在读字':s.watch?'自动观察中':'待机'} · 已处理 ${s.frames} 张画面`+(s.last_result?` · 最近核验 ${s.last_result.verified_matches} 张牌`:'')+(s.last_error?` · ${s.last_error}`:'');
    } catch {status.textContent='本地视觉服务未连接；卡牌记忆仍保留。';}
  }
  watch.addEventListener('change',async()=>{try{await call('/watch',{enabled:watch.checked});await refresh();}catch(e){status.textContent=e.message;}});
  button.addEventListener('click',async()=>{reading=true;button.disabled=true;status.textContent='正在定位卡牌并读取文字…';try{await call('/capture',{},180000);}catch(e){status.textContent=e.message;}finally{reading=false;await refresh();}});
  setInterval(refresh,5000);refresh();
})();
