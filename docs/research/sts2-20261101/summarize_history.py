import json,pathlib,collections,hashlib
ROOT=pathlib.Path('/mnt/e/Github/AI_vtuber')
OUT=ROOT/'docs/research/sts2-20261101'
def rows(p): return [json.loads(l) for l in p.read_text(encoding='utf-8-sig').splitlines() if l.strip()]
latest=[]
for p in sorted((ROOT/'runtime/game-input/autonomy').glob('*.jsonl')):
    rr=rows(p)
    if int(p.stem)<1793388525484: continue
    obs=[(i,r) for i,r in enumerate(rr,1) if r.get('decision') and r.get('view')]
    item={'log':str(p.relative_to(ROOT)), 'sha256':hashlib.sha256(p.read_bytes()).hexdigest(),'lines':len(rr),'first_event':rr[0].get('at'),'last_event':rr[-1].get('at'),'terminal_event':rr[-1].get('event','observation_decision'),'last_error':rr[-1].get('error'),'events':dict(collections.Counter(r.get('event','observation_decision') for r in rr)),'accepted_observation_decisions':len(obs),'decision_kinds':dict(collections.Counter(r['decision'].get('kind') for i,r in obs)),'scenes':dict(collections.Counter(r['view'].get('scene') for i,r in obs)),'models':sorted(set(r['decision'].get('model','unknown') for i,r in obs))}
    item['observation_summary']=[{'line':i,'at':r.get('at'),'frame':r.get('frameId'),'record':r.get('visionRecord'),'scene':r['view'].get('scene'),'summary':r['view'].get('summary'),'terminal_outcome':r['view'].get('terminal_outcome'),'energy':r['view'].get('energy'),'player':r['view'].get('player'),'decision':r['decision'].get('kind')} for i,r in obs]
    latest.append(item)
print('segments_since_first_20261030_native_api',len(latest))
for x in latest[-7:]:
    print(json.dumps({k:v for k,v in x.items() if k!='observation_summary'},ensure_ascii=False))
    print('firstlast',json.dumps(x['observation_summary'][:1]+x['observation_summary'][-1:],ensure_ascii=False))
p=ROOT/'runtime/game-input/autonomy/1793464975561.jsonl'
rr=rows(p)
print('EVENT_SHAPES')
for event in sorted(set(r.get('event','observation_decision') for r in rr)):
    r=next(r for r in rr if r.get('event','observation_decision')==event)
    print(event,json.dumps(r,ensure_ascii=False)[:1000] if event not in ('observation_decision','battle_read') else list(r))
summary={'audit_date':'2026-11-01','scope':'Read-only historical files; no game input, live requests, service changes or manual screenshot interpretation.','all_autonomy_file_count':len(list((ROOT/'runtime/game-input/autonomy').glob('*.jsonl'))),'native_api_20261030plus_segment_count':len(latest),'count_warning':'Task log segments are repeated starts/resumes, including diagnosis and settlement. They are not independent games. Older numeric logs are not classified as live trials.','segments':latest}
(OUT/'historical-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2)+'\n')
