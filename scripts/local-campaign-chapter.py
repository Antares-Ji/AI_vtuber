"""Use the visible next-episode button, then retain a fresh chapter observation."""
import argparse,json,sys,time
from local_stage_session import Session
sys.stdout.reconfigure(encoding='utf8')
p=argparse.ArgumentParser();p.add_argument('--chapter',type=int,required=True);args=p.parse_args()
if not 1<=args.chapter<=99:raise ValueError('Numbered next chapter required')
s=Session()
s.click_target(f'右下角标有EPISODE {args.chapter:02d}和向右箭头的下一章按钮',crop=(1200,850,1600,1024))
time.sleep(2);image=s.capture('next-chapter-map')
answer=s.analyze(image,'只输出JSON：chapter为当前EPISODE编号，visible_stages为可辨认的主线关卡编号列表；unknown不要猜测，TR不包含在主线里。','chapter-identity',mode='vlm')
(s.out/'summary.json').write_text(json.dumps({'requested_chapter':args.chapter,'observation':answer,'verified':False},ensure_ascii=False,indent=2),encoding='utf8')
