exec(open('/mnt/e/Github/AI_vtuber/docs/research/sts2-20261101/summarize_history.py').read().split("print('segments_since")[0])
for name in ['1793422373744','1793464683486','1793464975561']:
 rr=rows(ROOT/'runtime/game-input/autonomy'/f'{name}.jsonl')
 print('SEGMENT',name)
 for i,r in enumerate(rr,1):
  if r.get('event')=='input_completed':
   p=ROOT/'runtime/game-input/runs'/r['resultId']/'result.json'
   if p.exists():
    x=json.loads(p.read_text(encoding='utf-8-sig'))
    print('RECEIPT',i,r['resultId'],list(x),str(x)[:500])
   else: print('MISSING RECEIPT',r['resultId'])
 for i,r in enumerate(rr,1):
  if r.get('view'):
   print('OBS',i,r['view'].get('scene'),r['view'].get('summary'),r['decision'].get('kind'))
print('PROFILE', (ROOT/'runtime/game-input/learning/throughput-profile-1793418194543023100.json').read_text())
