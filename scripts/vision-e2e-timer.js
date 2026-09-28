/** End-to-end stopwatch spanning capture, model/agent work, click and verification.
 * One active trial at a time. Never equates transport ok with visual success.
 */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const root=path.resolve(__dirname,'..'),dir=path.join(root,'runtime/vlm/e2e-timing');
fs.mkdirSync(dir,{recursive:true});
const active=path.join(dir,'active.json');
const now=()=>process.hrtime.bigint().toString();
const elapsed=(a,b)=>Number(BigInt(b)-BigInt(a))/1e6;
const persist=s=>fs.writeFileSync(active,JSON.stringify(s,null,2));
async function controller(action,body){
 const token=fs.readFileSync(path.join(root,'runtime/vlm/controller/token.txt'),'utf8').trim();
 const res=await fetch(`http://127.0.0.1:17643/${action}`,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json'},body:JSON.stringify(body||{})});
 const result=await res.json();
 if(!res.ok||!result.ok)throw Error(result.error||'Controller failed');
 return result;
}
async function main(){
 const [action,...args]=process.argv.slice(2);
 if(action==='summary'){
  const rows=fs.readFileSync(path.join(dir,'trials.jsonl'),'utf8').trim().split('\n').map(JSON.parse);
  const median=v=>{v=[...v].sort((a,b)=>a-b);return (v[Math.floor((v.length-1)/2)]+v[Math.floor(v.length/2)])/2};
  const groups=['codex','vlm'].map(source=>{const all=rows.filter(r=>r.source===source),ok=all.filter(r=>r.success);return {source,trials:all.length,successes:ok.length,retries:all.reduce((n,r)=>n+r.retries,0),median_to_evidence_s:ok.length?median(ok.map(r=>r.total_to_success_evidence_ms))/1000:null,median_to_verified_s:ok.length?median(ok.map(r=>r.total_to_verification_ms))/1000:null}});
  fs.writeFileSync(path.join(dir,'summary.json'),JSON.stringify(groups,null,2));
  const lines=['# 从开始看画面到点击成功：端到端计时','',
   '计时从请求当前游戏截图前开始，跨工具调用持续运行；记录定位、输入、点击后截图以及Codex视觉核验。期间的对话模型处理和工具等待全部保留。仅通过此记录器执行的动作会被统计。','',
   '|路径|成功/次数|到成功画面中位数|到核验完成中位数|重试|','|---|---:|---:|---:|---:|',
   ...groups.map(g=>`|${g.source}|${g.successes}/${g.trials}|${g.median_to_evidence_s?.toFixed(2)} 秒|${g.median_to_verified_s?.toFixed(2)} 秒|${g.retries}|`),'',
   '这次每侧分别执行声音和游戏两个选项卡，起始页面、目标和控制器相同。VLM路径由本地千问给坐标，再由Codex检查及执行；不是全本地无人监督路径。Codex路径由当前助手直接看图给坐标。','',
   '“到成功画面”是取得随后被确认为成功的截图的时间，包含控制器固定等待，不是首次出现该页面的精确帧时间。“到核验完成”还包含助手读取截图并提交核验的时间。这些都是整套交互流程耗时，不是纯视觉推理速度。','',
   '样本仅每侧2次，不足以给出可靠的模型速度或稳定性排名。首个Codex试验分两次工具调用取得、读取初始截图，其余试验合并了这两步；该额外往返已保留，因此汇总不可解释为同等工具调度下的模型性能差异。','',
   '|次序|来源|目标|到成功画面|到核验完成|结果|','|---|---|---|---:|---:|---|',
   ...rows.map((r,i)=>`|${i+1}|${r.source}|${r.target}|${r.total_to_success_evidence_ms==null?'—':(r.total_to_success_evidence_ms/1000).toFixed(2)+'秒'}|${(r.total_to_verification_ms/1000).toFixed(2)}秒|${r.success?'成功':'未成功'}|`),'',
   '## 后续复用','',
   '入口：`node scripts/vision-e2e-timer.js begin codex "目标按钮"`，或将codex换成vlm自动取得本地提案。然后检查当前截图，使用`click xRatio yRatio`执行Codex坐标；VLM使用`click`直接读取已保存的模型坐标，避免手工替换。看图确认后使用`finish success "实际观察"`；失败用`finish failure "原因"`，需要停止用`abort stopped`。`summary`更新本报告。','',
   '同时只允许一个试验；没有点击后证据不能标成功。异常时保留active.json以便恢复，成功/失败记录追加到runtime/vlm/e2e-timing/trials.jsonl。截图和每轮完整状态也保存于该目录。历史记录不覆盖；批次扩展后需要按时间筛选再比较。'];
  fs.writeFileSync(path.join(root,'docs/vision-e2e-timing-20260912.md'),lines.join('\n')+'\n');
  console.log(JSON.stringify(groups));return;
 }
 if(action==='begin'){
  if(fs.existsSync(active))throw Error('Finish or abort active trial first');
  const [source,target,strategy='grounded']=args;
  if(!['baseline','grounded'].includes(strategy))throw Error('Unknown strategy');
  if(!['codex','vlm'].includes(source)||!target)throw Error('Need source and target');
  const s={id:crypto.randomUUID(),source,target,strategy,startedAt:new Date().toISOString(),startMono:now(),attempts:[],phase:'capturing'};
  persist(s);
  const before=await controller('capture');
  s.before=path.join(dir,`${s.id}-before.png`);fs.copyFileSync(before.path,s.before);
  s.captureDoneMono=now();s.capture_ms=elapsed(s.startMono,s.captureDoneMono);s.phase='observing';persist(s);
  if(source==='vlm'){
   const name=`e2e-${s.id}.png`;
   fs.copyFileSync(s.before,path.join(root,'runtime/vlm/live-20260911',name));
   const t=now();
   const res=await fetch('http://127.0.0.1:17642/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({image:name,target,mode:'vlm',strategy})});
   s.proposal=await res.json();s.model_request_ms=elapsed(t,now());
   if(!res.ok)throw Error('Local model failed');
   persist(s);
  }
  console.log(JSON.stringify({id:s.id,source,target,before:s.before,proposal:s.proposal?.parsed,capture_ms:s.capture_ms}));
  return;
 }
 if(!fs.existsSync(active))throw Error('No active trial');
 const s=JSON.parse(fs.readFileSync(active,'utf8'));
 if(action==='click'){
  let point=args.map(Number);
  if(s.source==='vlm'){
   const p=s.proposal?.parsed;
   if(p?.target_visible!==true||!Array.isArray(p.target_point))throw Error('No local proposal');
   point=p.target_point.map(v=>v/1000);
  }
  if(point.length!==2||point.some(v=>!Number.isFinite(v)||v<0||v>1))throw Error('Invalid coordinates');
  const attempt={point,clickStartMono:now()};s.attempts.push(attempt);persist(s);
  const result=await controller('click',{xRatio:point[0],yRatio:point[1],waitMs:1200});
  attempt.evidenceMono=now();attempt.controller_ms=elapsed(attempt.clickStartMono,attempt.evidenceMono);
  attempt.after=path.join(dir,`${s.id}-after-${s.attempts.length}.png`);fs.copyFileSync(result.path,attempt.after);
  attempt.click=result.click;attempt.captureAt=result.capturedAt;s.phase='awaiting_visual_verification';persist(s);
  console.log(JSON.stringify({after:attempt.after,elapsed_to_evidence_ms:elapsed(s.startMono,attempt.evidenceMono)}));return;
 }
 if(action==='finish'||action==='abort'){
  const success=action==='finish'&&args[0]==='success';
  const last=s.attempts.at(-1);
  if(success&&(s.phase!=='awaiting_visual_verification'||!last?.after||!fs.existsSync(last.after)))throw Error('Cannot verify without clicked screenshot');
  if(!args.slice(1).join(' ').trim()&&action==='finish')throw Error('Supply observed page evidence');
  s.finishedAt=new Date().toISOString();s.verifiedMono=now();s.success=success;s.observation=args.slice(1).join(' ');
  s.verifier='Codex visual inspection';s.retries=Math.max(0,s.attempts.length-1);
  s.total_to_verification_ms=elapsed(s.startMono,s.verifiedMono);
  s.total_to_success_evidence_ms=success?elapsed(s.startMono,last.evidenceMono):null;
  s.phase=action==='abort'?'aborted':'finished';
  fs.writeFileSync(path.join(dir,`${s.id}.json`),JSON.stringify(s,null,2));
  fs.appendFileSync(path.join(dir,'trials.jsonl'),JSON.stringify(s)+'\n');fs.unlinkSync(active);
  console.log(JSON.stringify({source:s.source,success:s.success,total_to_success_evidence_ms:s.total_to_success_evidence_ms,total_to_verification_ms:s.total_to_verification_ms,retries:s.retries}));return;
 }
 throw Error('Use begin/click/finish/abort');
}
main().catch(e=>{console.error(e.message);process.exitCode=1});
