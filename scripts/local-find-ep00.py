"""Bounded local-model chapter navigation; no battle or account actions."""
import sys,time,json
from local_stage_session import Session
sys.stdout.reconfigure(encoding='utf8')
s=Session();result={'ok':False,'target':'EP00'}
try:
    for attempt in range(10):
        frame=s.capture('chapters')
        target=s.locate(frame,'EP00 黑暗时代上 章节封面卡片','ep00')
        if target:
            s.control('click',xRatio=target[0],yRatio=target[1]);time.sleep(1)
            s.capture('ep00-after');result['ok']=True;result['meaning']='chapter click attempted; stage identity requires verification';break
        title=s.analyze(frame,'只输出一个JSON字段title，值为最左侧完整显示的正方形章节卡片上的大字中文标题。不要描述，不要输出检测框。','chapter-title',crop=(0,400,1000,760),mode='vlm').get('title')
        if not isinstance(title,str) or not title or len(title)>30:raise RuntimeError('Chapter title unreadable')
        point=s.locate(frame,title+' 章节卡片文字中心','swipe-start')
        if point is None or not .25<point[1]<.85:raise RuntimeError('Chapter swipe start unconfirmed')
        if point[0]>.65:raise RuntimeError('Insufficient rightward swipe space')
        s.control('drag',startXRatio=point[0],startYRatio=point[1],endXRatio=min(.94,point[0]+.5),endYRatio=point[1])
        time.sleep(.8)
    else:result['error']='Chapter not found in bounded navigation'
except Exception as error:
    result['error']=str(error);s.log('failure',**result)
finally:
    (s.out/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    s.log('navigation_result',**result)
