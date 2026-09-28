"""Read actual branch text and range diagrams for the existing twelve cards."""
import json,subprocess,sys,time,importlib.util
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('roster_reader',ROOT/'scripts/inspect-operator-roster.py')
reader=importlib.util.module_from_spec(spec);spec.loader.exec_module(reader)
sys.stdout.reconfigure(encoding='utf8')
targets=[('伊内丝',1,1),('风笛',1,2),('维什戴尔',1,3),('Mon3tr',1,4),('新约能天使',1,5),('圣聆初雪',1,6),('琴柳',2,1),('黍',2,2),('遥',2,3),('酒神',2,4),('予愿安洁莉娜',2,5),('望',2,6)]
if sys.argv[1:]:targets=[entry for entry in targets if entry[0] in sys.argv[1:]]
def click(target):
    p=subprocess.run([sys.executable,str(ROOT/'scripts/inspect-operator-roster.py'),'--click',target],capture_output=True,timeout=60,creationflags=subprocess.CREATE_NO_WINDOW)
    rows=[json.loads(s) for s in p.stdout.decode('utf8').splitlines() if s.startswith('{')]
    if p.returncode:raise RuntimeError('Navigation failed: '+target)
    return Path(rows[-1]['directory'])
out=ROOT/'runtime/vision/roster'/('branches-'+str(time.time_ns()));out.mkdir(parents=True)
rows=[]
for name,row,column in targets:
    click('画面最左上角深灰色长条中的白色向左箭头按钮中心')
    selected=click(f'编队界面第{row}排从左数第{column}张干员卡片中心，姓名{name}，不要选其他列')
    # Save skills as well, including the previously missed Shu profile.
    detail=reader.read_profile_evidence(selected/'after.png',selected)
    branch=click('左侧面板里技能右边的分支选项卡')
    facts=reader.read_profile_evidence(branch/'after.png',branch)
    observed=facts['name']
    aliases={'遥':'Haruka','望':'wang','黍':'Shu'}
    valid=name in observed or aliases.get(name,'__no_alias__').lower() in observed.lower()
    item=dict(expected=name,identity_confirmed=valid,ocr=facts,skills=detail['skills'],skills_directory=str(selected),branch_directory=str(branch))
    rows.append(item);(out/'profiles.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf8')
    print(json.dumps(item,ensure_ascii=False),flush=True)
    if not valid:raise RuntimeError('Profile name mismatch; no squad changes submitted')
print(json.dumps(dict(directory=str(out),completed=True),ensure_ascii=False))
