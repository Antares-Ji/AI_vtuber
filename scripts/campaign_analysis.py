"""Evidence-linked stage and roster analysis, separate from training truth."""
import json
from pathlib import Path
import cv2
import numpy as np
from local_stage_session import ROOT
from campaign_stage import mainline_stage


def similarity(image, reference):
    other=cv2.imread(str(reference))
    if other is None:return {'available':False}
    if reference.name=='battle-ready.png':
        return {'available':False,'reference':str(reference),'reason':'Battle view and map preview use different camera projections; similarity withheld'}
    # Remove common navigation, text and decorative UI before matching maps.
    image=cv2.resize(image,(1600,1024))[210:755,260:1340]
    other=cv2.resize(other,(1600,1024))[210:755,260:1340]
    orb=cv2.ORB_create(nfeatures=1800)
    ka,da=orb.detectAndCompute(cv2.cvtColor(image,cv2.COLOR_BGR2GRAY),None)
    kb,db=orb.detectAndCompute(cv2.cvtColor(other,cv2.COLOR_BGR2GRAY),None)
    if da is None or db is None:return {'available':False}
    pairs=cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(da,db,k=2)
    good=[p[0] for p in pairs if len(p)==2 and p[0].distance<.7*p[1].distance]
    inliers=0
    if len(good)>=8:
        _,mask=cv2.findHomography(np.float32([ka[m.queryIdx].pt for m in good]),np.float32([kb[m.trainIdx].pt for m in good]),cv2.RANSAC,4)
        if mask is not None:inliers=int(mask.sum())
    return dict(available=True,reference=str(reference),matches=len(good),geometric_inliers=inliers,
        inlier_fraction=inliers/max(1,len(good)),interpretation='visual similarity only; not stage identity or route equivalence')


def analyze_stage(session,image,stage):
    destination=ROOT/'runtime/vision/campaign-20260926'/stage
    destination.mkdir(parents=True,exist_ok=True)
    cv2.imwrite(str(destination/'map-preview.png'),image)
    refs=[('0-1',ROOT/'data/vision/deployment-references/0-1/battle-ready.png'),
          ('0-7',ROOT/'data/vision/deployment-references/0-7/map-preview.png')]
    refs += [(p.parent.name,p) for p in destination.parent.glob('*/map-preview.png') if p.parent.name!=stage]
    comparisons=[dict(stage=name,**similarity(image,path)) for name,path in refs if path.exists()]
    prediction=session.analyze(image,'只依据这张'+stage+'地图预览，输出紧凑JSON：blue_gates蓝色立方门位置列表，red_gates红色立方门位置列表，routes敌人到蓝门的候选路线，ground可部署地面描述，high_ground高台描述，chokepoints汇合拦截点，enemy_total整数或null。地图不能证明的敌人数必须null，路线推断须标为候选；不抄装饰文字。','comprehensive-map',crop=(260,210,1340,755),mode='hybrid')
    def valid_semantics(value):
        return (all(isinstance(value.get(k),list) and all(isinstance(x,str) for x in value[k]) for k in ('blue_gates','red_gates','routes'))
                and bool(value['blue_gates']) and all(isinstance(value.get(k),(str,type(None))) for k in ('ground','high_ground','chokepoints')))
    raw_prediction=prediction
    if not valid_semantics(prediction):
        prediction=session.analyze(image,'只看当前地图，输出JSON。blue_gates和red_gates必须是中文位置字符串数组，例如["右下方"]，routes必须是中文候选路线字符串数组；ground、high_ground、chokepoints必须是中文描述字符串或null。不要输出数字坐标；区分红色地面立方门和飞行入口标记；蓝门可能被图片右边缘部分截断。enemy_total固定null。不能判定就写null或空数组。','map-semantic-recheck',crop=(260,210,1340,820),mode='vlm')
        session.log('map_semantic_schema_recheck',valid=valid_semantics(prediction),raw_prediction=raw_prediction)
    roster_path=ROOT/'data/vision/operator-memory/current-squad.json'
    roster=json.loads(roster_path.read_text(encoding='utf8'))
    report=dict(stage=stage,map_analysis=prediction,map_analysis_verified=False,map_schema_valid=valid_semantics(prediction),raw_map_analysis=raw_prediction,similarity=comparisons,
        roster_source=str(roster_path),roster_date=roster.get('date'),
        operators=[dict(name=o['name'],profession=o.get('profession'),branch=o.get('branch'),
            attack_range=o.get('range'),skill_text=o.get('selected_skill_text'),recovery=o.get('recovery'),
            base_cost=o.get('detail_cost'),block_count=None,live_stats=None,live_verified=False,
            skill_strength='Use source skill text; exact DPS unknown without current attack and interval. Current skill selection must be checked in battle.',
            evidence=o.get('source')) for o in roster['operators']],
        enemy_types=[],enemy_total=None,
        caveat='Historical operator memory is reference, not proof of today\'s roster or skill; unverified range candidates stay unverified.',
        evidence_session=str(session.out),training_eligible=False)
    (destination/'analysis.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf8')
    session.log('stage_analysis_saved',stage=stage,path=str(destination/'analysis.json'),similarity=comparisons)
    return report


if __name__=='__main__':
    import argparse,sys
    from local_stage_session import Session
    sys.stdout.reconfigure(encoding='utf8')
    parser=argparse.ArgumentParser();parser.add_argument('--stage',required=True,type=mainline_stage);parser.add_argument('--image',type=Path,required=True)
    args=parser.parse_args();frame=cv2.imread(str(args.image))
    if frame is None:raise RuntimeError('Map evidence not readable')
    analyze_stage(Session(),frame,args.stage)
