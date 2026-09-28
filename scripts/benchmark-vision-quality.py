"""Paired static-frame benchmark; never sends input. Labels fixed before requests."""
import json, time, random, urllib.request, statistics, math
from pathlib import Path
from PIL import Image

ROOT=Path(__file__).resolve().parents[1]
CAP=ROOT/'runtime/vlm/live-20260911'
OUT=ROOT/'runtime/vlm/quality-benchmark'
OUT.mkdir(parents=True,exist_ok=True)
# Original 1600x1024 client coordinates. Visible button interiors, not inferred hitboxes.
CASES=[
 (1789141139688,'左上角返回箭头','other',[20,12,85,85],[52,44]),
 (1789141161127,'左上角返回箭头','other',[18,16,180,70],[54,44]),
 (1789141179187,'左上角返回箭头','other',[18,16,180,70],[54,44]),
 (1789141204219,'左上角设置齿轮','home',[25,17,80,70],[53,44]),
 (1789141224399,'左侧声音选项卡','settings',[35,255,258,343],[147,299]),
 (1789141248140,'左侧提醒选项卡','settings',[35,360,258,448],[147,404]),
 (1789141266659,'左侧按键选项卡','settings',[35,464,258,552],[147,508]),
 (1789141304563,'左侧文字为游戏的选项卡','settings',[35,150,258,238],[147,194]),
 (1789141359916,'左上角返回箭头','settings',[35,28,165,73],[62,50]),
 (1789141379831,'左上角设置齿轮','home',[25,17,80,70],[53,44]),
]
labels=[dict(case=i+1,source=f'compare-{id}.png',target=target,scene=scene,
 visible_button_rect=box,codex_reference_point=point) for i,(id,target,scene,box,point) in enumerate(CASES)]
(OUT/'labels.json').write_text(json.dumps(labels,ensure_ascii=False,indent=2),encoding='utf8')
jobs=[]
for label in labels:
 im=Image.open(CAP/label['source']).convert('RGB')
 for scale in [1,.5,.25]:
  resized=im.resize((int(im.width*scale),int(im.height*scale)),Image.Resampling.LANCZOS)
  filename=f"quality-{label['case']}-{int(scale*100)}.png"
  resized.save(CAP/filename)
  for repeat in range(2):
   for mode in ['yolo','vlm','hybrid']:
    jobs.append(dict(label=label,scale=scale,repeat=repeat,mode=mode,image=filename))
random.Random(20260911).shuffle(jobs)
def call(job):
 data=json.dumps(dict(image=job['image'],target=job['label']['target'],mode=job['mode'])).encode()
 start=time.perf_counter()
 with urllib.request.urlopen(urllib.request.Request('http://127.0.0.1:17642/analyze',data=data,headers={'Content-Type':'application/json'}),timeout=90) as response:
  result=json.load(response)
 return result,(time.perf_counter()-start)*1000
# Warm all modes; excluded from measurement.
for mode in ['yolo','vlm','hybrid']:
 warm=dict(jobs[0],mode=mode)
 call(warm)
rows=[]
with (OUT/'results.jsonl').open('w',encoding='utf8') as stream:
 for idx,job in enumerate(jobs):
  result,latency=call(job)
  parsed=result.get('parsed') or {}
  point=parsed.get('target_point')
  valid=parsed.get('target_visible') is True and isinstance(point,list) and len(point)==2 and all(isinstance(v,(float,int)) and not isinstance(v,bool) and math.isfinite(v) and 0<=v<=1000 for v in point)
  pixel=[point[0]*1599/1000,point[1]*1023/1000] if valid else None
  x1,y1,x2,y2=job['label']['visible_button_rect']
  hit=bool(pixel and x1<=pixel[0]<=x2 and y1<=pixel[1]<=y2)
  ref=job['label']['codex_reference_point']
  row=dict(case=job['label']['case'],scale=job['scale'],repeat=job['repeat'],mode=job['mode'],
    image=job['image'],request_ms=latency,hit=hit,valid_point=valid,
    scene_correct=parsed.get('scene')==job['label']['scene'],
    error_from_reference_px=math.dist(pixel,ref) if pixel else None,result=result)
  rows.append(row); stream.write(json.dumps(row,ensure_ascii=False)+'\n'); stream.flush()
  if (idx+1)%12==0: print(f'{idx+1}/{len(jobs)} complete',flush=True)
def pct(values,q):
 ordered=sorted(values); return ordered[max(0,math.ceil(q*len(ordered))-1)]
summary=[]
for scale in [1,.5,.25]:
 for mode in ['yolo','vlm','hybrid']:
  group=[r for r in rows if r['scale']==scale and r['mode']==mode]
  consistent=[]
  for case in range(1,11):
   pair=[r for r in group if r['case']==case]
   consistent.append(all(r['hit'] for r in pair))
  summary.append(dict(scale=scale,mode=mode,n=len(group),hits=sum(r['hit'] for r in group),
    scene_correct=sum(r['scene_correct'] for r in group),both_repeats_hit=sum(consistent),
    median_ms=statistics.median(r['request_ms'] for r in group),p95_ms=pct([r['request_ms'] for r in group],.95)))
(OUT/'summary.json').write_text(json.dumps(summary,indent=2),encoding='utf8')
print(json.dumps(summary,indent=2),flush=True)
