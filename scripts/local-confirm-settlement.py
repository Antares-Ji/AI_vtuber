"""Recover a missed settlement without changing the original trial's evidence."""
import argparse,json,sys,shutil,re
from pathlib import Path
from local_stage_session import Session
from battle_result import lit_result_badges,result_stage_from_text
sys.stdout.reconfigure(encoding='utf8')
p=argparse.ArgumentParser();p.add_argument('--source-summary',type=Path,required=True);a=p.parse_args()
prior=json.loads(a.source_summary.read_text(encoding='utf8'))
s=Session(a.source_summary.parent.parent/('settlement-'+str(__import__('time').time_ns())))
image=s.capture('result');text=s.ocr(image,(0,130,600,600),'result-title',scale=1)
if not any(x in text.upper() for x in ['行动结','任务失败','MISSIONRESULTS']):raise RuntimeError('Settlement heading absent')
answer=s.analyze(image,'只输出JSON：stage画面关卡编号，phase=result或unknown，victory=true/false/null，stars=蓝色亮起的结算徽章数。','settlement',mode='vlm')
raw_answer=dict(answer)
if not isinstance(answer.get('stage'),str) or not re.fullmatch(r'\d{1,2}-\d{1,2}',answer['stage']):
    stage_text=s.ocr(image,(0,150,420,290),'settlement-stage',scale=2)
    read_stage=result_stage_from_text(stage_text)
    s.log('settlement_stage_ocr',text=stage_text,stage=read_stage)
    if read_stage:answer=dict(answer,stage=read_stage,stage_source='current settlement OCR')
stars=lit_result_badges(image)
result=dict(prior,source_summary=str(a.source_summary),outcome=answer,lit_badges=stars,ok=answer.get('phase')=='result' and answer.get('stage')==prior['stage'] and answer.get('victory') is True and stars in (1,2,3))
result['raw_outcome']=raw_answer
result.pop('error',None)
(s.out/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
s.log('settlement_recovered',**result)
