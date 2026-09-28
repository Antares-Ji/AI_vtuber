"""Local Qwen navigation between verified campaign results and next formation."""
import argparse,json,subprocess,sys,time,re,cv2
from pathlib import Path
from local_stage_session import Session,ROOT
from campaign_stage import mainline_stage

def main():
    sys.stdout.reconfigure(encoding='utf8')
    sys.stdout.reconfigure(encoding='utf8')
    p=argparse.ArgumentParser();p.add_argument('--stage',required=True,type=mainline_stage)
    p.add_argument('--previous-summary',type=Path);p.add_argument('--reuse-plan',action='store_true');a=p.parse_args();s=Session()
    try:
        if a.previous_summary:
            previous=json.loads(a.previous_summary.read_text(encoding='utf8'))
            if not previous.get('ok'):raise RuntimeError('Previous result has not confirmed victory')
            image=s.capture('settlement')
            modal=s.ocr(image,(1000,250,1600,550),'proxy-dialog',scale=2)
            if '保存' in modal or '代理' in modal:
                s.click_target('右侧是否保存代理指挥阵容弹窗里的白色叉号取消按钮')
            s.click_target('左侧行动结束文字中心');time.sleep(2)
        current=s.capture('map-state')
        heading=s.analyze(current,'只输出JSON：stage为OPERATION旁关卡编号，没有则null。','current-stage-heading',crop=(1080,60,1600,190),mode='vlm')
        if isinstance(heading.get('stage'),str) and re.fullmatch(r'\d+-\d+',heading['stage']):
            s.click_target('灰色建筑空白处',crop=(250,620,950,850),surface=True)
            s.log('selection_cleared',reason='User-confirmed blank-map click before selecting another stage')
        try:
            image=s.click_target('关卡地图上的'+a.stage+'节点，不能是任何TR教学关')
        except RuntimeError as error:
            if 'Local target absent' not in str(error):raise
            current=s.capture('dark-node')
            target=s.locate(current,a.stage+'关卡编号文字中心，不能是旁边奖励图标','cropped-node',(0,260,1450,710))
            if target is None:
                reading=s.analyze(current,'寻找当前地图上写着'+a.stage+'的关卡编号文字中心，不是旁边奖励圆形图标。只输出JSON：stage为实际读到的编号，x和y为这张裁剪图中0到1000坐标；没有则null。','node-spatial',crop=(0,260,1450,710),mode='vlm')
                x,y=reading.get('x'),reading.get('y')
                if reading.get('stage')==a.stage and all(type(v) in (int,float) and 0<=v<=1000 for v in (x,y)):
                    target=[x/1000*1450/1600,(260+y/1000*450)/1024]
            if target is None and current.mean()<80:
                target=s.locate(cv2.convertScaleAbs(current,alpha=2.2),a.stage+'关卡节点','bright-node',(0,260,1450,710))
            if target is None:raise
            s.control('click',xRatio=target[0],yRatio=target[1]);time.sleep(.7);image=s.capture('node-selected')
        identity=s.ocr(image,(1060,60,1600,310),'stage-identity',scale=2).replace('O-','0-')
        if a.stage not in identity:
            stage_read=s.analyze(image,'只输出JSON：stage为OPERATION旁显示的关卡编号。','stage-heading',crop=(1080,60,1600,190),mode='vlm')
            if stage_read.get('stage')!=a.stage:raise RuntimeError('Requested stage not confirmed: '+str(stage_read))
        if a.reuse_plan:
            plan_path=ROOT/'runtime/vision/campaign-20260926'/a.stage/'plan.json'
            plan=json.loads(plan_path.read_text(encoding='utf8'))
            if plan.get('stage')!=a.stage:raise RuntimeError('Cached plan stage mismatch')
            s.log('same_stage_plan_reused',stage=a.stage,path=str(plan_path),reason='UI recovery after interruption; live opening topology still required')
            s.click_target('右下角蓝色开始行动按钮');s.log('formation_ready',stage=a.stage);return
        s.click_target('敌方情报按钮')
        enemy_image=s.capture('enemy-info')
        enemies=s.analyze(enemy_image,'只输出JSON：enemies列出当前可见敌人名称，attributes记录可见生命攻击防御法抗评级，看不清填null。','enemy-info')
        s.click_target('左上角返回箭头')
        s.click_target('地图预览按钮，文字为地图的方框')
        child=subprocess.run([sys.executable,str(ROOT/'scripts/local-stage-plan.py'),'--stage',a.stage],cwd=ROOT)
        if child.returncode:raise RuntimeError('Stage plan generation failed')
        dest=ROOT/'runtime/vision/campaign-20260926'/a.stage/'enemy-info.json'
        dest.write_text(json.dumps({'model':enemies,'verified':False,'scope':'visible enemy information only; not an exhaustive per-enemy inspection','evidence':str(s.out/'enemy-info.png')},ensure_ascii=False,indent=2),encoding='utf8')
        analysis_path=dest.parent/'analysis.json'
        analysis=json.loads(analysis_path.read_text(encoding='utf8'))
        analysis['enemy_info_source']=str(dest)
        analysis['enemy_types']=enemies.get('enemies',[])
        analysis['enemy_types_verified']=False
        analysis['enemy_info_scope']='Only visible current information; selected enemy attributes do not apply to every enemy.'
        analysis_path.write_text(json.dumps(analysis,ensure_ascii=False,indent=2),encoding='utf8')
        s.click_target('地图预览图片上方灰色遮罩空白处',surface=True)
        s.click_target('右下角蓝色开始行动按钮')
        s.log('formation_ready',stage=a.stage)
    except Exception as e:
        s.log('navigation_failed',stage=a.stage,error=str(e));raise

if __name__=='__main__':main()
