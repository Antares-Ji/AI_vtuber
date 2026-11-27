(() => {
  'use strict';
  const tabs=document.querySelector('[role=tablist]');
  const tab=document.createElement('button');tab.type='button';tab.role='tab';tab.id='tab-genshin';tab.dataset.game='genshin';tab.setAttribute('aria-selected','false');
  tab.innerHTML='✦ 原神 <small id="status-genshin">读取中</small>';tabs.append(tab);
  const panel=document.createElement('article');panel.className='panel stage-card';panel.dataset.gameOnly='genshin';panel.hidden=true;
  panel.innerHTML=`<div class="panel-heading"><h2>原神 · API 主播</h2><span id="genshinProvider">读取配置</span></div>
    <div class="viewer-wrap"><img id="genshinPreview" alt="原神实时画面" hidden style="width:100%;height:100%;object-fit:contain"><p id="genshinPreviewHint">点击“连接原神画面”配置 OBS 场景。</p></div>
    <div class="stage-foot"><button id="genshinLaunch" type="button">启动原神</button><button id="genshinObs" type="button">连接原神画面</button><button id="genshinObserve" type="button">观察当前场景</button></div>
    <p id="genshinFeedback" role="status">准备读取本机状态</p>
    <div class="stage-foot"><label>模型 <select id="genshinProviderChoice"><option value="deepseek">DeepSeek</option><option value="openai">OpenAI</option></select></label><button id="genshinSwitch" type="button">切换模型</button><button id="genshinTest" type="button">测试当前 API</button><button id="genshinDoctor" type="button">检查 BetterGI</button></div>
    <p>仅手动切换；调用失败不会自动改用其他供应商。</p><button id="genshinRunGoal" type="button">执行游戏指令／继续当前目标（一轮）</button>
    <div class="stage-foot"><button id="genshinBridgeStart" type="button">连接 BetterGI</button><button id="genshinCapture" type="button">BetterGI 截图</button><button id="genshinWindow" type="button">调整为 16:9</button><button id="genshinBridgeStop" type="button">停止并释放按键</button></div><p id="genshinBridgeState"></p>
    <details><summary>BetterGI 路线与自动化任务</summary><p id="genshinCounts"></p><p>路线与任务会实际操作游戏。完成回执只表示接口返回，游戏目标仍需观察核验。</p><label>已安装路线 <select id="genshinRoutes" aria-label="原神路线列表"></select></label><button id="genshinPath" type="button">执行所选路线</button>
    <label>自动化任务 <select id="genshinTask"><option value="AutoFishing">自动钓鱼</option><option value="AutoFight">自动战斗</option><option value="AutoDomain">自动秘境</option><option value="AutoBoss">首领讨伐</option><option value="AutoWood">自动伐木</option><option value="AutoGeniusInvokation">七圣召唤</option><option value="AutoCook">自动烹饪</option><option value="AutoEat">自动进食</option><option value="CountInventoryItem">背包计数</option></select></label><button id="genshinRunTask" type="button">启动所选任务</button></details>
    <details><summary>全部配置与 SDK 接口目录</summary><p>接口目录不等于已实测；上方只开放固定的截图、路线和独立任务。</p><pre id="genshinConfig" style="max-height:280px;overflow:auto;white-space:pre-wrap"></pre><div id="genshinCatalog" style="max-height:240px;overflow:auto"></div></details>
    <details><summary>任务回执与 BetterGI 截图</summary><div id="genshinEvidence"></div><pre id="genshinBridgeReceipt" style="max-height:220px;overflow:auto;white-space:pre-wrap"></pre><pre id="genshinRuns" style="max-height:220px;overflow:auto;white-space:pre-wrap"></pre></details>`;
  document.querySelector('.avatar-card').before(panel);
  const el=id=>document.getElementById(id);
  async function request(route,body) {const r=await fetch('/api/genshin'+route,{signal:AbortSignal.timeout(70000),...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)})});const data=await r.json();if(!r.ok)throw Error(data.error||`HTTP ${r.status}`);return data;}
  let busy=false,loaded=false,previewing=false,previewUrl,lastEvidence,providerDirty=false,submitting=false,currentGoal='',trackedRun=null,actionPending=false;
  function describeRun(run) {
    if(!run)return '等待提交游戏指令';
    if(run.state==='FAILED')return `执行失败：${run.error||'未收到有效回执'}`;
    if(run.state==='STOPPING')return '正在停止任务并等待键鼠释放，请勿重复提交';
    if(run.state==='INTERRUPTED')return run.reason==='BUDGET_EXHAUSTED'?'本轮已超时停止；未确认目标完成':'本轮已停止；未确认目标完成';
    if(run.state==='RUNNING')return run.progress?.message||'任务已提交，正在准备观察与执行';
    const r=run.result;
    if(r?.decision?.operation==='stop')return `${r.recovery?.length?'已完成 '+r.recovery.length+' 步场景恢复；':''}模型决定暂停，未执行战斗或寻路：${r.decision.reason}`;
    if(r?.executed)return `本轮接口已返回：${r.decision.reason}。${r.after?.observation?.summary?'执行后观察：'+r.after.observation.summary+'。':''}击杀结果尚未确认`;
    if(r?.plan)return `仅规划完成（未执行）：${r.plan.steps.map(s=>s.skill).join(' → ')}。点击“观察并执行一轮”执行目标`;
    if(r?.observation)return `观察完成：${r.observation.summary||r.observation.scene}；未执行战斗或寻路`;
    return '操作已返回；详细结果见下方任务回执';
  }
  function syncRuns(s) {
    if(s.goal){currentGoal=s.goal.goal;window.gameWorkbench?.updateGenshinGoal({goal:currentGoal,plan:describeRun(s.goal.run)});}
    const current=s.runs.find(r=>r.id===trackedRun)||s.runs[0];
    if(current&&!actionPending)el('genshinFeedback').textContent=describeRun(current);
    const running=s.runs.some(r=>['RUNNING','STOPPING'].includes(r.state))||s.bridge?.busy;
    for(const id of ['genshinLaunch','genshinObserve','genshinBridgeStart','genshinCapture','genshinPath','genshinRunTask','genshinWindow','genshinRunGoal','genshinSwitch'])el(id).disabled=Boolean(running||submitting);
    if(window.gameWorkbench?.game==='genshin')el('sendButton').disabled=Boolean(running||submitting);
  }
  async function refresh(){if(busy)return;busy=true;try{
    const s=await request('/status');el('genshinProvider').textContent=`${s.provider==='openai'?'OpenAI':'DeepSeek'} · ${s.model}`;el('status-genshin').textContent=s.keyConfigured?'API 已配置':'待配置 API';
    if(!providerDirty && document.activeElement!==el('genshinProviderChoice'))el('genshinProviderChoice').value=s.provider;
    el('genshinBridgeState').textContent=s.bridge?.busy?'BetterGI 正在执行或释放输入':s.bridgeReady?'BetterGI 管理进程就绪':'BetterGI 管理进程未连接';
    syncRuns(s);
    el('genshinRuns').textContent=JSON.stringify(s.runs,null,2);
    el('genshinBridgeReceipt').textContent=JSON.stringify(s.bridge?.lastResult||{},null,2);
    const receipt=s.bridge?.lastResult;if(receipt?.id!==lastEvidence){el('genshinEvidence').replaceChildren();lastEvidence=receipt?.id;for(const name of receipt?.images||[]){const link=document.createElement('a');link.href=`/api/genshin/bridge/evidence/${receipt.session}/${receipt.id}/${name}`;link.target='_blank';link.textContent=name==='before.png'?'查看任务前截图':'查看任务后截图';link.style.marginRight='16px';el('genshinEvidence').append(link);}}
    if(s.lastError)el('genshinFeedback').textContent=s.lastError;
    if(window.gameWorkbench?.game==='genshin'){el('connectionText').textContent=s.lastError?'原神 · API 调用受阻':'原神控制台已连接';el('connectionDot').classList.remove('down');}
    if(!loaded){const [i,c]=await Promise.all([request('/installation'),request('/catalog')]);el('genshinCounts').textContent=`${i.configSections} 个配置项组 · ${i.routes.filter(r=>r.category==='hunting').length} 条讨伐短线 · ${i.routes.filter(r=>r.category==='leyline').length} 条内置地脉路线 · ${c.entries.length} 个 JS 接口签名`;
      el('genshinConfig').textContent=JSON.stringify(i.config,null,2);for(const route of i.routes){const opt=document.createElement('option');opt.value=route.id;opt.textContent=route.name;el('genshinRoutes').append(opt);}
      for(const entry of c.entries){const row=document.createElement('p');row.textContent=`${entry.namespace}.${entry.method}(${entry.signature}) — 已核对，待接通`;el('genshinCatalog').append(row);}loaded=true;}
  }catch(error){el('genshinFeedback').textContent=error.message;}finally{busy=false;}}
  async function action(id,route,body={}){const button=el(id);button.disabled=true;actionPending=true;el('genshinFeedback').textContent='处理中…';try{const r=await request(route,body);if(r.id)trackedRun=r.id;el('genshinFeedback').textContent=r.id?`任务已提交：${r.id}`:r.connected?`${r.provider} API 连接成功`:JSON.stringify(r);return r;}catch(error){el('genshinFeedback').textContent=error.message;}finally{actionPending=false;button.disabled=false;}}
  async function submitGoal(goal) {
    goal=(goal||'').trim()||currentGoal;
    if(!goal)throw Error('请先在“游戏指令”中输入目标');
    if(submitting)throw Error('正在提交，请勿重复点击');
    submitting=true;
    try {
      const run=await request('/run-goal',{goal});currentGoal=goal;trackedRun=run.id;
      window.gameWorkbench?.updateGenshinGoal({goal,plan:describeRun(run)});
      el('genshinFeedback').textContent=describeRun(run);return run;
    }catch(error){el('genshinFeedback').textContent=`提交失败：${error.message}`;throw error;}
    finally{submitting=false;await refresh();}
  }
  async function preview(){if(previewing||window.gameWorkbench?.game!=='genshin'||document.hidden)return;previewing=true;try{const r=await fetch('/api/genshin/preview',{signal:AbortSignal.timeout(5000)});if(!r.ok)throw Error((await r.json()).error);const next=URL.createObjectURL(await r.blob());el('genshinPreview').src=next;el('genshinPreview').hidden=false;el('genshinPreviewHint').hidden=true;if(previewUrl)URL.revokeObjectURL(previewUrl);previewUrl=next;}catch(error){el('genshinPreview').hidden=true;el('genshinPreviewHint').hidden=false;el('genshinPreviewHint').textContent=error.message;}finally{previewing=false;}}
  el('genshinLaunch').onclick=()=>action('genshinLaunch','/launch',{systemPrompt:true});el('genshinObserve').onclick=()=>action('genshinObserve','/bridge/observe');el('genshinDoctor').onclick=()=>action('genshinDoctor','/doctor');el('genshinTest').onclick=()=>action('genshinTest','/test');el('genshinObs').onclick=async()=>{await action('genshinObs','/obs/setup');await preview();};
  el('genshinProviderChoice').onchange=()=>{providerDirty=true;};
  el('genshinSwitch').onclick=async()=>{const result=await action('genshinSwitch','/provider',{provider:el('genshinProviderChoice').value});if(result)providerDirty=false;};
  el('genshinBridgeStart').onclick=()=>action('genshinBridgeStart','/bridge/start');
  el('genshinRunGoal').onclick=async()=>{try{await window.gameWorkbench.submitGoal(el('commandInput').value||currentGoal);}catch(error){el('genshinFeedback').textContent=error.message;}};
  el('genshinCapture').onclick=()=>action('genshinCapture','/bridge/command',{operation:'capture',timeoutMs:60000});
  el('genshinWindow').onclick=()=>action('genshinWindow','/bridge/command',{operation:'window',timeoutMs:10000});
  el('genshinPath').onclick=()=>action('genshinPath','/bridge/command',{operation:'path',routeId:el('genshinRoutes').value,timeoutMs:180000});
  el('genshinRunTask').onclick=()=>action('genshinRunTask','/bridge/command',{operation:'task',task:el('genshinTask').value,timeoutMs:180000});
  el('genshinBridgeStop').onclick=()=>action('genshinBridgeStop','/stop');
  window.genshinPanel={refresh,submitGoal,stop:()=>request('/stop',{})};
  setInterval(()=>{if(window.gameWorkbench?.game==='genshin'){void refresh();void preview();}},3000);
})();
