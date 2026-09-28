"""Paired development regression: same labels, no target coordinate hints."""
import json,random,time,urllib.request,statistics
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'runtime/vlm/locator-optimization'
OUT.mkdir(parents=True,exist_ok=True)
labels=json.loads((ROOT/'runtime/vlm/quality-benchmark/labels.json').read_text(encoding='utf8'))
jobs=[(label,mode,strategy,repeat) for label in labels for mode in ['vlm','hybrid'] for strategy in ['baseline','grounded'] for repeat in range(2)]
random.Random(912).shuffle(jobs)
rows=[]
with (OUT/'results.jsonl').open('w',encoding='utf8') as f:
 for idx,(label,mode,strategy,repeat) in enumerate(jobs):
  req=dict(image=label['source'],target=label['target'],mode=mode,strategy=strategy)
  start=time.perf_counter()
  with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:17642/analyze',data=json.dumps(req).encode(),headers={'Content-Type':'application/json'}),timeout=90) as res: result=json.load(res)
  ms=(time.perf_counter()-start)*1000
  parsed=result.get('parsed') or {}; p=parsed.get('target_point')
  valid=parsed.get('target_visible') is True and isinstance(p,list) and len(p)==2 and all(isinstance(v,(int,float)) and not isinstance(v,bool) and 0<=v<=1000 for v in p)
  box=label['visible_button_rect']; hit=bool(valid and box[0]<=p[0]*1.599<=box[2] and box[1]<=p[1]*1.023<=box[3])
  row=dict(case=label['case'],mode=mode,strategy=strategy,repeat=repeat,request_ms=ms,hit=hit,result=result)
  rows.append(row);f.write(json.dumps(row,ensure_ascii=False)+'\n');f.flush()
  if (idx+1)%10==0: print(f'{idx+1}/{len(jobs)}',flush=True)
summary=[]
for mode in ['vlm','hybrid']:
 for strategy in ['baseline','grounded']:
  group=[r for r in rows if r['mode']==mode and r['strategy']==strategy]
  summary.append(dict(mode=mode,strategy=strategy,n=len(group),hits=sum(r['hit'] for r in group),median_ms=statistics.median(r['request_ms'] for r in group),failed_cases=sorted(set(r['case'] for r in group if not r['hit']))))
(OUT/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf8')
print(json.dumps(summary,indent=2),flush=True)
