import argparse,json,time,sys
from local_stage_session import Session
from campaign_stage import mainline_stage
from battle_result import lit_result_badges
sys.stdout.reconfigure(encoding='utf8')
p=argparse.ArgumentParser();p.add_argument('--stage',required=True,type=mainline_stage);a=p.parse_args()
s=Session();result={'stage':a.stage,'outcome':'unknown','verified':False}
try:
    deadline=time.monotonic()+180
    while time.monotonic()<deadline:
        frame=s.capture('outcome')
        text=s.ocr(frame,(0,130,600,600),'outcome-'+str(time.time_ns()),scale=1)
        if any(marker in text.upper() for marker in ('行动结','任务失败','MISSIONRESULTS')):
            answer=s.analyze(frame,'只输出JSON：stage画面显示的关卡编号；phase为result或unknown；victory为true或false或null；stars为0到3或null。只凭结算标题，勿用卡片数量判断星级。','settlement',mode='hybrid')
            result['model']=answer;result['ocr']=text;result['lit_badges']=lit_result_badges(frame)
            if answer.get('phase')=='result' and answer.get('stage')==a.stage and type(answer.get('victory')) is bool:
                badges=result['lit_badges']
                if answer['victory'] and badges in (1,2,3):
                    result.update(outcome='victory',verified=True);break
                if not answer['victory'] and badges==0:
                    result.update(outcome='defeat',verified=True);break
                s.log('settlement_disagreement',model=answer,lit_badges=badges)
        time.sleep(4)
except Exception as error:
    result['error']=str(error)
finally:
    (s.out/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    s.log('settlement_result',**result)
