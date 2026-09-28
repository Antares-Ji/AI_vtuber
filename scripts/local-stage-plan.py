"""Generate a stage-scoped proposal from the currently open map preview."""
import argparse,json,sys
import cv2,numpy as np
from pathlib import Path
from local_stage_session import Session,ROOT
from campaign_analysis import analyze_stage
from campaign_stage import mainline_stage
from map_portals import portal_candidates
sys.stdout.reconfigure(encoding='utf8')
p=argparse.ArgumentParser();p.add_argument('--stage',required=True,type=mainline_stage);p.add_argument('--image',type=Path);a=p.parse_args()
s=Session();image=cv2.imread(str(a.image)) if a.image else s.capture('map-preview')
if image is None:raise RuntimeError('Map image unavailable')
analysis=analyze_stage(s,image,a.stage)
crop=image[210:755,260:1340]
b,g,r=cv2.split(crop.astype(np.float32))
blue=(b>120)&(g>90)&(b>r*1.4)&(g>r*1.3)
ys,xs=np.where(blue)
if len(xs)<30:raise RuntimeError('Blue portal color evidence unavailable')
blue_side='left' if float(np.median(xs))<crop.shape[1]/2 else 'right'
s.log('map_color_landmark',blue_side=blue_side,blue_pixels=len(xs),source='current map preview color mask; provisional')
portals=portal_candidates(image);s.log('map_portal_candidates',candidates=portals)
landmarks='；'.join(color+'色候选标记'+str(len(items))+'处：'+','.join(item['position'] for item in items) for color,items in [('蓝',portals['blue']),('红',portals['red'])])
plan=s.analyze(image[210:820,260:1340],'这是当前'+a.stage+'地图预览。忽略装饰性英文和数字。当前颜色检测：'+landmarks+'。蓝色保护门总体偏'+blue_side+'侧。必须分别保护每一个蓝门；多蓝门时前两名分守不同出口或共享必经汇合点，不能三人都守一个蓝门。只输出JSON包含stage、blue_goal(left/right)、red_entries(left/right)、plan数组。plan按部署顺序恰好3项，干员依次风笛、伊内丝、琴柳，每项字段name、tile_hint(用当前地图地标描述不同的地面格，禁止高台和蓝红门本身)、facing(right/left/up/down)。根据落点附近实际来敌路段选择朝向，不是总朝全图红门方向。无需坐标，不要输出检测框。','stage-plan',mode='vlm')
if plan.get('blue_goal')!=blue_side or plan.get('red_entries') not in ('left','right'):raise RuntimeError('Plan landmark schema inconsistent')
if plan.get('stage')!=a.stage or [x.get('name') for x in plan.get('plan',[])]!=['风笛','伊内丝','琴柳']:raise RuntimeError('Plan schema mismatch')
for item in plan['plan']:
    if item.get('facing') not in ('left','right','up','down') or not isinstance(item.get('tile_hint'),str):raise RuntimeError('Invalid tile/facing')
plan['proposal_only']=True;plan['source_session']=str(s.out);plan['color_portal_candidates']=portals
if a.stage not in ('0-1','0-2'):
    anti_air=s.analyze(crop,'针对当前地图，为狙击干员维什戴尔选择能覆盖红门到蓝门的路线的高台。输出JSON：name固定为维什戴尔，tile_hint用高台相对地标描述，facing为right/left/up/down。','anti-air-plan',mode='hybrid')
    if anti_air.get('name')!='维什戴尔' or anti_air.get('facing') not in ('left','right','up','down') or not isinstance(anti_air.get('tile_hint'),str):raise RuntimeError('Invalid anti-air plan')
    plan['plan'].append(anti_air)
    priority=s.analyze(crop,'为当前地图选择这四人的部署顺序：风笛、伊内丝、琴柳、维什戴尔。先建立地面拦截；有飞行入口时尽早建立高台对空，不要机械地先放完三名先锋。当前费用未知，实际执行仍需逐张读实时费用。只输出JSON：order为四个姓名各一次的数组，air_threat为true/false/null，reason为简短理由。','deployment-priority',mode='vlm')
    order=priority.get('order')
    if isinstance(order,list) and len(order)==4 and set(order)=={x['name'] for x in plan['plan']} and order[0] in ('风笛','伊内丝','琴柳'):
        by_name={item['name']:item for item in plan['plan']}
        plan['plan']=[by_name[name] for name in order]
        plan['priority_reason']=priority
        s.log('deployment_priority',decision=priority,current_fees_unknown=True)
target=ROOT/'runtime/vision/campaign-20260926'/a.stage/'plan.json';target.parent.mkdir(parents=True,exist_ok=True)
target.write_text(json.dumps(plan,ensure_ascii=False,indent=2),encoding='utf8');s.log('plan_saved',path=str(target),plan=plan)
