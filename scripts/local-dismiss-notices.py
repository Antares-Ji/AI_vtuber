"""Bounded dismissal of routine game notices after daily sync, using fresh local vision."""
import sys,time
from local_stage_session import Session
sys.stdout.reconfigure(encoding='utf8');s=Session()
for attempt in range(6):
    image=s.capture('notice-'+str(attempt))
    scene=s.analyze(image,'只输出JSON：scene页面名，home是否为无弹窗主页，close_visible右上角是否有关闭X。','notice-state',mode='vlm')
    if scene.get('home') is True:
        s.log('home_recovered');break
    if scene.get('close_visible') is not True:raise RuntimeError('No verified routine close control')
    s.click_target('叉号关闭按钮',crop=(1250,0,1600,300))
    time.sleep(.6)
else:raise RuntimeError('Notice recovery bound reached')
