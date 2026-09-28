"""Finite read-only roster detail tour; never confirms squad replacement."""
import json,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.stdout.reconfigure(encoding='utf8')
names=sys.argv[1:] or ['伊内丝','风笛','维什戴尔','Mon3tr','新约能天使','圣聆初雪','黍','遥','酒神','予愿安洁莉娜','望']
def run(*args):
    done=subprocess.run([sys.executable,str(ROOT/'scripts/inspect-operator-roster.py'),*args],capture_output=True,timeout=100,creationflags=subprocess.CREATE_NO_WINDOW)
    output=done.stdout.decode('utf8');print(output,flush=True)
    if done.returncode:raise RuntimeError(done.stderr.decode('utf8',errors='replace')[-1200:])
    return [json.loads(line) for line in output.splitlines() if line.startswith('{')]
for name in names:
    run('--click','画面最左上角深灰色长条中的白色向左箭头按钮中心')
    run('--click',f'编队界面姓名为{name}的干员卡片中心')
    rows=run('--strategy','operator-profile')
    observed=rows[0].get('ocr',{}).get('name','')
    aliases={'遥':'haruka','黍':'shu'}
    compact=''.join(observed.split()).lower()
    if name.lower() not in compact and not (name in aliases and aliases[name] in compact):
        raise RuntimeError(f'Profile identity mismatch: expected {name}, OCR {observed}')
print(json.dumps({'completed':True,'profiles':len(names)},ensure_ascii=False))
