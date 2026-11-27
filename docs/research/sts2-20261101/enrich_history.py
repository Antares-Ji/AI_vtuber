import json,pathlib,hashlib,collections
ROOT=pathlib.Path('/mnt/e/Github/AI_vtuber'); OUT=ROOT/'docs/research/sts2-20261101'
p=OUT/'historical-summary.json'; s=json.loads(p.read_text())
s['outcomes']={'autonomous_full_game_clear_evidence':False,'win_rate':None,'independent_game_denominator':None,'reason':'Resumes, development interventions, mixed observation providers, incomplete run starts and censored latest game prevent a defensible win-rate denominator.','historical_48_floor':'Codex-supervised decisions + local Qwen observation assistance + native input; documented title 胜利……？ and story HP zero. Not autonomous clear.','native_api_pre_defeat_reward_battles':2,'native_api_defeat':'3 HP inherited battle ended defeat in cloud trial 1793420472793; not a fresh-start benchmark','new_seed':'ZH3C3M86F1 versus defeated seed 35A4QGBA4D; new start documented; latest logs remain battle, outcome censored.'}
s['receipt_audits']=[]
for name in ['1793422373744','1793464683486','1793464975561']:
 rr=[json.loads(l) for l in (ROOT/'runtime/game-input/autonomy'/f'{name}.jsonl').read_text().splitlines() if l.strip()]
 receipts=[]
 for i,r in enumerate(rr,1):
  if r.get('event')!='input_completed':continue
  f=ROOT/'runtime/game-input/runs'/r['resultId']/'result.json'; x=json.loads(f.read_text())
  acts=[a.get('action') for a in x.get('actions',[])]
  kind='drag_sequence' if 'down' in acts and 'up' in acts else 'click' if 'click' in acts else 'move_only'
  receipts.append({'log_line':i,'result_id':r['resultId'],'path':str(f.relative_to(ROOT)),'sha256':hashlib.sha256(f.read_bytes()).hexdigest(),'kind':kind,'status':x.get('status'),'game_verified':x.get('game_verified'),'held_keys':x.get('held_keys'),'held_buttons':x.get('held_buttons'),'evidence_error':x.get('evidence_error')})
 s['receipt_audits'].append({'log':name,'input_completed':len(receipts),'physical_kinds':dict(collections.Counter(r['kind'] for r in receipts)),'receipts':receipts})
 print(name, s['receipt_audits'][-1]['physical_kinds'])
sources=list((ROOT/'docs').glob('sts2*'))+[ROOT/'runtime/game-input/learning'/n for n in ['cloud-trial-outcome-20261030.json','throughput-profile-1793418194543023100.json','capacity-comparison-summary-20261030.json','capacity-assessment-Qwen3-VL-4B-Instruct-1793419023125.json','capacity-assessment-Qwen3-VL-8B-Instruct-1793419117727.json','capacity-assessment-deepseek-flash-1793419941903.json','map-context-diagnostic-1793422200709710300.json','capture-speed-1793422283914.json','capture-speed-1793422293592.json','ocr-1793421766210591300.json']]
s['source_manifest']=[{'path':str(f.relative_to(ROOT)),'bytes':f.stat().st_size,'sha256':hashlib.sha256(f.read_bytes()).hexdigest()} for f in sources if f.is_file()]
p.write_text(json.dumps(s,ensure_ascii=False,indent=2)+'\n')
print('latest receipt',s['receipt_audits'][-1]['receipts'][-1])
