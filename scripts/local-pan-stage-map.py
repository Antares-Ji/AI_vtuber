"""Reveal later chapter nodes by dragging from a freshly recognized visible node."""
import argparse,sys,time
from local_stage_session import Session
sys.stdout.reconfigure(encoding='utf8')
p=argparse.ArgumentParser();p.add_argument('--anchor',required=True);a=p.parse_args();s=Session()
image=s.capture('map-before');point=s.locate(image,a.anchor+'关卡节点','map-anchor')
if point is None:
    target=s.analyze(image,'给出当前城市地图中间用于横向拖动地图的建筑位置。只输出JSON，x和y是0到1000的坐标；不能选右侧详情面板或按钮。','map-surface',mode='vlm')
    x,y=target.get('x'),target.get('y')
    if type(x) in (int,float) and type(y) in (int,float) and 300<x<700 and 250<y<750:point=[x/1000,y/1000]
if point is None or point[0]<.3:raise RuntimeError('Insufficient visible map anchor for leftward pan')
s.control('drag',startXRatio=point[0],startYRatio=point[1],endXRatio=max(.1,point[0]-.35),endYRatio=point[1],profile='reliable')
time.sleep(.5);s.capture('map-after')
