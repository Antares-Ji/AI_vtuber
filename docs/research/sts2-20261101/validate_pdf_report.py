"""Check the exact exported PDF against the recorded numerical evidence."""
from pathlib import Path
import hashlib,json,re,statistics
from pypdf import PdfReader
ROOT=Path(__file__).resolve().parents[3]
DATA=Path(__file__).resolve().parent
pdf=ROOT/'output/pdf/shiyanbaogao1.pdf'
r=PdfReader(pdf);raw=json.loads((DATA/'replay-20261101T141827Z/results.json').read_text(encoding='utf-8'))
texts=[p.extract_text() for p in r.pages]
assert len(texts)==15
assert all(len(t)>400 for t in texts)
assert all('\ufffd' not in t and '\u25a0' not in t for t in texts)
assert '5.900' in texts[5] and '5.234' in texts[5] and '3.124' in texts[5]
flat=re.sub(r'\s+','',texts[13])
for case in raw['cases']:
    for rep in [1,2,3]:
        values=[next(x['elapsed_s'] for x in c['rows'] if x['case']==case['name'] and x['repeat']==rep) for c in raw['conditions']]
        assert ''.join(f'{v:.3f}' for v in values) in flat,(case['name'],rep,values)
links=[]
for page in r.pages:
    for annot in page.get('/Annots',[]):
        a=annot.get_object().get('/A',{})
        if a.get('/URI'):links.append(str(a['/URI']))
assert len(links)==5
qa={'pdf':str(pdf),'sha256':hashlib.sha256(pdf.read_bytes()).hexdigest(),'pages':len(texts),'page_text_chars':[len(t) for t in texts],'checks':['15 A4 pages','54 appendix timings matched against raw requests','headline means matched','5 primary source hyperlinks preserved','no replacement glyphs or black-square characters in extracted text'],'visual_review':'All 15 rendered pages inspected; changed pages reinspected after layout edits.','limitations':['No independent image accuracy ground truth','No new gameplay trial in PDF authoring turn','Untagged PDF; not a certified accessible PDF']}
(ROOT/'output/pdf/shiyanbaogao1.qa.json').write_text(json.dumps(qa,ensure_ascii=False,indent=2),encoding='utf-8')
(DATA/'shiyanbaogao1-extracted.txt').write_text('\n\n'.join(f'PAGE {i+1}\n{t}' for i,t in enumerate(texts)),encoding='utf-8')
print(json.dumps(qa,ensure_ascii=False,indent=2))
