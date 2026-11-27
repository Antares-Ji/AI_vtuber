import json, pathlib, collections, hashlib
ROOT=pathlib.Path('/mnt/e/Github/AI_vtuber')
def read(p):
    return json.loads(p.read_text(encoding='utf-8-sig'))
paths=list((ROOT/'runtime/game-input/autonomy').glob('*.jsonl'))
print('AUTONOMY FILES',len(paths))
print('FILE NAMES', [p.name for p in sorted(paths)])
for p in sorted(paths)[-20:]:
    rows=[json.loads(l) for l in p.read_text(encoding='utf-8-sig').splitlines() if l.strip()]
    print(p.name,len(rows),str(rows[0])[:500],str(rows[-1])[:750])
print('SUMMARY LEARNING')
for p in sorted((ROOT/'runtime/game-input/learning').glob('*.json')):
    if any(s in p.name for s in ('outcome','summary','profile','assessment','comparison','diagnostic','capture-speed')):
        print(p.name, p.stat().st_size)
for name in ['cloud-trial-outcome-20261030.json','throughput-profile-1793418194543023100.json']:
    print(name, (ROOT/'runtime/game-input/learning'/name).read_text())
for name in ['1793422373744','1793464683486','1793464975561']:
    p=ROOT/'runtime/game-input/autonomy'/f'{name}.jsonl'
    rows=[json.loads(l) for l in p.read_text().splitlines() if l.strip()]
    print('DETAIL',name,'events',dict(collections.Counter(r.get('event','observation_decision') for r in rows)))
    for i,r in enumerate(rows,1):
        if r.get('decision') or r.get('input') or r.get('event') in ('action','input','error','stopped'):
            print(i,json.dumps(r,ensure_ascii=False)[:2000])
