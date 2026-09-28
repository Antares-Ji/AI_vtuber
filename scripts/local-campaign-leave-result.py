"""Leave a confirmed result and save the current map for next-chapter planning."""
import argparse,json,time
from pathlib import Path
from local_stage_session import Session
p=argparse.ArgumentParser();p.add_argument('--summary',required=True,type=Path);args=p.parse_args()
prior=json.loads(args.summary.read_text(encoding='utf8'))
if not prior.get('ok'):raise RuntimeError('Cannot advance from unconfirmed result')
s=Session();image=s.capture('settlement')
modal=s.ocr(image,(1000,250,1600,550),'proxy-dialog',scale=2)
if '保存' in modal or '代理' in modal:s.click_target('右侧是否保存代理指挥阵容弹窗里的白色叉号取消按钮')
s.click_target('左侧行动结束文字中心');time.sleep(2)
image=s.capture('chapter-map')
answer=s.analyze(image,'只输出JSON：phase为当前页面类型，chapter为当前章节编号或null，buttons为可见章节切换或返回按钮的文字和位置描述，next_stage为能看清的下一主线编号或null。TR是教学关，不能作为下一训练关。','next-chapter-observation',mode='vlm')
(s.out/'summary.json').write_text(json.dumps({'previous_summary':str(args.summary),'observation':answer,'training_eligible':False},ensure_ascii=False,indent=2),encoding='utf8')
