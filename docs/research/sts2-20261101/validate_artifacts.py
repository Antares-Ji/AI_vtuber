"""Validate report artifacts and source arithmetic; no live services."""
import hashlib,json,re,statistics
from pathlib import Path
HERE=Path(__file__).resolve().parent
source=sorted(HERE.glob('replay-*/results.json'))[-1]
r=json.loads(source.read_text(encoding='utf-8'))
s=json.loads((HERE/'replay-summary.json').read_text(encoding='utf-8'))
assert r['complete'] and r['input_sent'] is False
assert r['stop_receipt']['releaseComplete'] is True
assert r['cleanup']['benchmark_port_free'] and r['cleanup']['ocr_port_free']
assert r['cleanup']['director']['stopped'] and not r['cleanup']['director']['busy']
assert len(r['conditions'])==3
for c,cs in zip(r['conditions'],s['conditions']):
    assert len(c['rows'])==18
    assert abs(statistics.mean(x['elapsed_s'] for x in c['rows'])-cs['mean_s'])<1e-9
    assert all(not x['response']['perception_cache']['hit'] for x in c['rows'])
    assert sum(x['response']['parsed'] is not None for x in c['rows'])==cs['normalized_not_null']
    assert all(sum(x['case']==case['name'] for x in c['rows'])==3 for case in r['cases'])
broken=[]
paths=[HERE/'stage-report.md',HERE/'group-meeting-notes.md',HERE/'replay-tables.md']
for p in paths:
    for target in re.findall(r'\]\(([^)]+)\)',p.read_text(encoding='utf-8')):
        if '://' in target or target.startswith('#'):continue
        if not (p.parent/target.split('#')[0]).exists():broken.append({'file':str(p),'target':target})
assert not broken,broken
evidence={'status':'passed','checks':['54 requests / 6 cases / 3 technical repeats','means recomputed','normalized counts recomputed','zero cache hits','stop releaseComplete=true','owned service cleanup','main report local links exist'],'limits':['No independent image labels','No new gameplay outcomes','No statistical inference or human peer review'],'files':{p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in paths}}
(HERE/'validation.json').write_text(json.dumps(evidence,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(evidence,ensure_ascii=False,indent=2))
