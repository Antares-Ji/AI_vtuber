import json
from pathlib import Path
here=Path(__file__).resolve().parent
data=json.loads(sorted(here.glob('replay-*/results.json'))[-1].read_text(encoding='utf-8'))
for c in data['conditions']:
    print('\n'+c['label'])
    for r in c['rows']:
        if r['repeat']!=1:continue
        v=r['response'];p=v.get('parsed')
        print(json.dumps({'case':r['case'],'raw':v['raw'],'parsed':p,'normalization_error':v.get('normalization_error')},ensure_ascii=False))
print(json.dumps({'stop':data.get('stop_receipt'),'cleanup':data['cleanup']},ensure_ascii=False))
