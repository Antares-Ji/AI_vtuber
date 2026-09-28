"""One local 0-1 economy trial: Saileach S1 -> Ines -> high-tile Wis'adel.

Uses reviewed squad data, current YOLO/portrait and green-tile checks. No chat
coordinates are consumed. Saves every transition; failures remain failures.
"""
import importlib.util,json,time,urllib.request,uuid,subprocess,re,sys
from pathlib import Path
import cv2,numpy as np,mss
from PIL import Image,ImageDraw,ImageFont
from ultralytics import YOLO
from local_battle_followup import ref,slot_state,green_target
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('realtime',ROOT/'scripts/realtime-deployment.py')
rt=importlib.util.module_from_spec(spec);spec.loader.exec_module(rt)
def main():
    sys.stdout.reconfigure(encoding='utf8')
    out=ROOT/'runtime/vision/economy-trials'/str(time.time_ns());out.mkdir(parents=True)
    print(str(out),flush=True);started=time.perf_counter()
    token=(ROOT/'runtime/vlm/controller/token.txt').read_text().strip()
    req=urllib.request.Request('http://127.0.0.1:17644/status',headers={'Authorization':'Bearer '+token})
    with urllib.request.urlopen(req,timeout=10) as r:status=json.load(r)
    native=rt.Native(status['info']['handle'],out/'cancel');screen=mss.MSS()
    events=(out/'events.jsonl').open('w',encoding='utf8',buffering=1)
    result=dict(ok=False,deployed=[],skill_dp_confirmed=False)
    def log(event,**fields):
        item=dict(event=event,t=time.perf_counter()-started,utc_ns=time.time_ns(),**fields)
        events.write(json.dumps(item,ensure_ascii=False)+'\n');print(json.dumps(item,ensure_ascii=False),flush=True)
    def capture(label=None):
        if time.perf_counter()-started>150:raise RuntimeError('Finite economy trial time limit')
        frame=cv2.resize(np.asarray(screen.grab(native.bounds()))[:,:,:3],(1600,1024))
        if label:cv2.imwrite(str(out/(label+'.png')),frame)
        return frame
    def ocr(frame,box,label):
        x1,y1,x2,y2=box;path=out/(label+'-ocr.png');cv2.imwrite(str(path),cv2.resize(frame[y1:y2,x1:x2],None,fx=3,fy=3))
        p=subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(ROOT/'src/vision/windows-ocr.ps1'),'-ImagePath',str(path)],capture_output=True,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
        if p.returncode:raise RuntimeError('OCR failed')
        text=json.loads(p.stdout.decode('utf-8-sig'))['text'];log('ocr',label=label,text=text)
        return re.sub(r'\s+','',text)
    def dp(frame,label):
        # Preserve the screenshot digits; add only a fixed DP label as OCR
        # context. Windows OCR otherwise drops isolated stylized digits.
        digits=Image.fromarray(cv2.cvtColor(cv2.resize(frame[755:820,1510:1600],(270,195)),cv2.COLOR_BGR2GRAY))
        digits=digits.point(lambda p:0 if p>195 else 255)
        context=Image.new('L',(600,240),255);context.paste(digits,(250,0))
        ImageDraw.Draw(context).text((15,35),'DP',font=ImageFont.truetype('C:/Windows/Fonts/arial.ttf',145),fill=0)
        path=out/(label+'-ocr.png');context.save(path)
        p=subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(ROOT/'src/vision/windows-ocr.ps1'),'-ImagePath',str(path)],capture_output=True,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
        if p.returncode:raise RuntimeError('DP OCR failed')
        text=re.sub(r'\s+','',json.loads(p.stdout.decode('utf-8-sig'))['text'])
        log('dp_ocr',label=label,text=text)
        match=re.fullmatch(r'DP(\d{1,2})',text)
        return int(match[1]) if match else None
    def locate(frame,target,label):
        name='economy-'+uuid.uuid4().hex+'.png';cv2.imwrite(str(ROOT/'runtime/vlm/live-20260911'/name),frame)
        req=urllib.request.Request('http://127.0.0.1:17642/analyze',data=json.dumps(dict(image=name,target=target,mode='vlm',strategy='grounded'),ensure_ascii=False).encode('utf8'),headers={'Content-Type':'application/json'})
        with urllib.request.urlopen(req,timeout=30) as r:answer=json.load(r)
        (out/(label+'-qwen.json')).write_text(json.dumps(answer,ensure_ascii=False,indent=2),encoding='utf8')
        p=answer.get('parsed',{});log('qwen',label=label,result=p,errors=answer.get('validation_errors'))
        if answer.get('validation_errors') or not p.get('target_visible'):raise RuntimeError('Local target absent: '+label)
        point=p.get('target_point')
        if not isinstance(point,list) or len(point)!=2 or any(type(v) not in (float,int) or not 0<=v<=1000 for v in point):raise RuntimeError('Bad local coordinates')
        return [v/1000 for v in point]
    def align(frame,kind):
        check=ref.inspect_frame(frame,kind)
        if check.get('inliers',0)<20 or not check.get('target_point'):raise RuntimeError('Map alignment failed')
        return check
    def close_profile():
        frame=capture();check=ref.inspect_frame(frame,'profile-dismiss')
        if check['ok']:point=check['target_point']
        else:
            point=locate(frame,'地图左下方没有干员站立的浅色地砖中心，用于关闭干员面板，不能是技能图标、撤退按钮或左侧立绘','dismiss-profile')
            if not .30<point[0]<.60 or not .60<point[1]<.87:raise RuntimeError('Dismiss point outside safe map area')
        native.click(point);time.sleep(.2)
        if ref.inspect_frame(capture(),'profile')['ok']:raise RuntimeError('Profile remains open')
    def name_matches(name,text):
        return name in text or (name=='维什戴尔' and '堆什戴尔' in text)
    def deploy(name,slot,tile_kind=None,already_selected=False):
        deadline=time.perf_counter()+35;card=None
        if already_selected:
            current=capture();template=ref.reference('tray-affordable.png')[921:1009,1350:1430]
            roi=current[900:1024]
            _,score,_,offset=cv2.minMaxLoc(cv2.matchTemplate(cv2.cvtColor(roi,cv2.COLOR_BGR2GRAY),cv2.cvtColor(template,cv2.COLOR_BGR2GRAY),cv2.TM_CCOEFF_NORMED))
            if score>.90:
                card=[(offset[0]+40)/1600,(900+offset[1]+44)/1024]
                log('selected_card_portrait_match',score=score,point=card)
            else:card=locate(current,'底部干员卡片中维什戴尔的头像卡片中心，白发红眼、费用24的狙击干员','selected-card')
        while time.perf_counter()<deadline:
            if card is not None:break
            frame=capture()
            state=None
            if slot is not None:
                template=ref.reference('tray-affordable.png')[921:1009,slot*133+20:slot*133+100]
                roi=frame[900:1024,:550]
                _,score,_,offset=cv2.minMaxLoc(cv2.matchTemplate(cv2.cvtColor(roi,cv2.COLOR_BGR2GRAY),cv2.cvtColor(template,cv2.COLOR_BGR2GRAY),cv2.TM_CCOEFF_NORMED))
                patch=roi[offset[1]:offset[1]+88,offset[0]:offset[0]+80]
                state=dict(ready=score>.93 and patch.mean()/max(1,template.mean())>.9 and np.abs(patch.astype(float)-template).mean()<18,portrait_x=offset[0]+40)
            if state and state['ready']:
                boxes=detector.predict(frame[850:1024,:400],imgsz=320,conf=.7,device=0,verbose=False)[0].boxes
                candidates=[b for b in boxes if float(b.xyxy[0][0])<state['portrait_x']<float(b.xyxy[0][2])]
                if candidates:
                    b=max(candidates,key=lambda b:float(b.conf[0]));x1,y1,x2,y2=b.xyxy[0].tolist();card=[(x1+x2)/3200,(850+(y1+y2)/2)/1024];break
            if slot is None:
                money=dp(frame,name+'-available')
                if money is not None and money>=24:
                    card=locate(frame,'底部干员卡片中维什戴尔的头像卡片中心，白发红眼、费用24的狙击干员',name+'-card');break
            time.sleep(.1 if slot is not None else .5)
        if card is None:raise RuntimeError('Card not affordable: '+name)
        capture(name+'-ready')
        if not already_selected:native.click(card);time.sleep(.25)
        frame=capture(name+'-selected')
        identity=ocr(frame,(0,235,440,510),name+'-identity')
        if not name_matches(name,identity):raise RuntimeError('Selected operator name not confirmed: '+name)
        if tile_kind:
            check=align(frame,tile_kind)
            if not check['ok']:raise RuntimeError('Reference tile is not green')
            tile=check['target_point']
        else:
            try:proposal=locate(frame,'中间偏右、敌人路线旁边的一块绿色可部署高台砖中心，不是地面道路，不是底部卡片',name+'-tile')
            except RuntimeError:
                # All green cells are legal for the selected, name-verified
                # operator. Find interiors, then prefer one near the frontline.
                anchor=align(frame,'fast-tile')['target_point']
                b,g,r=cv2.split(frame.astype(np.float32));mask=((g>r*1.15)&(g>b*1.05)&(g>60)).astype(np.uint8)
                mask[:250]=0;mask[720:]=0;mask[:,:540]=0;mask[:,1430:]=0
                count,labels,stats,_=cv2.connectedComponentsWithStats(mask,8)
                candidates=[]
                for component in range(1,count):
                    if stats[component,cv2.CC_STAT_AREA]<900:continue
                    distance=cv2.distanceTransform((labels==component).astype(np.uint8),cv2.DIST_L2,5)
                    _,radius,_,point=cv2.minMaxLoc(distance)
                    if radius>=15:candidates.append([point[0]/1600,point[1]/1024])
                if not candidates:raise RuntimeError('No current green high-tile interior')
                proposal=min(candidates,key=lambda p:(p[0]-anchor[0])**2+(p[1]-anchor[1])**2)
                log('green_cell_fallback',name=name,anchor=anchor,candidates=candidates,chosen=proposal)
            tile=green_target(capture(),proposal)
        log('drop',name=name,card=card,tile=tile,**native.drag(card,tile,.12));time.sleep(.12)
        frame=capture(name+'-direction');direction=ref.inspect_frame(frame,'direction')
        if not direction['ok'] or direction['target_point'][0]>.84:raise RuntimeError('No actual direction selector')
        p=direction['target_point'];native.drag(p,[p[0]+.12,p[1]],.08);time.sleep(.3);frame=capture(name+'-landed')
        count=ocr(frame,(1330,822,1600,870),name+'-counter');digits=re.findall(r'[0-8]',count)
        expected=7-len(result['deployed'])
        if not digits or int(digits[-1])!=expected or ref.inspect_frame(frame,'direction')['ok']:raise RuntimeError('Landing unconfirmed')
        result['deployed'].append(name);log('landed',name=name,remaining=expected)
    try:
        detector=YOLO(str(ROOT/'runtime/vlm/training/deployment-tray-v1/fit/weights/best.pt'))
        detector.predict(np.zeros((174,400,3),np.uint8),imgsz=320,device=0,verbose=False)
        frame=capture('formation')
        if ref.inspect_frame(frame,'profile')['ok']:
            identity=ocr(frame,(0,230,450,510),'resume-name')
            count=ocr(frame,(1330,822,1600,870),'resume-count')
            if name_matches('维什戴尔',identity) and re.search(r'6$',count):
                result['deployed']=['琴柳','伊内丝'];result['resumed']='selected_high_operator'
                result['scope']='Completes previously selected Wisadel; earlier recovery evidence is in the preceding run'
                deploy('维什戴尔',None,already_selected=True);result['ok']=True;capture('final-three');return
            if '琴柳' not in identity or not re.search(r'7$',count):raise RuntimeError('Resume requires selected Saileach and exactly one deployed operator')
            result['deployed']=['琴柳'];result['resumed']=True
            log('resumed_saileach')
        else:
            start=locate(frame,'编队界面右侧橙色开始行动按钮','start')
            native.click(start);log('battle_requested')
            deploy('琴柳',2,'multi-tile-3')
            # Verified ordinary battle shortcut. This level begins at 1X.
            native.tap_f();time.sleep(.3);capture('speed2')
        skill_deadline=time.perf_counter()+25
        while time.perf_counter()<skill_deadline:
            time.sleep(2);frame=capture()
            if not ref.inspect_frame(frame,'profile')['ok']:
                point=align(frame,'multi-tile-3')['target_point'];native.click(point);time.sleep(.25)
            frame=capture('saileach-skill-before');name=ocr(frame,(0,230,450,510),'skill-name')
            text=ocr(frame,(500,230,1450,900),'skill-ready')
            if '琴柳' not in name:raise RuntimeError('Wrong skill operator')
            if 'READY' not in text.upper():close_profile();continue
            description=ocr(frame,(0,500,570,930),'skill-description')
            if not ('支援号令' in description and '部署费用' in description and '停止攻击' in description):raise RuntimeError('Saileach S1 recovery text not confirmed')
            before_dp=dp(frame,'dp-before-skill');before_time=time.perf_counter()
            if before_dp is None:raise RuntimeError('Pre-skill DP unreadable')
            native.tap_e();log('recovery_skill_pressed',before_dp=before_dp);time.sleep(.3)
            if ref.inspect_frame(capture(),'profile')['ok']:close_profile()
            time.sleep(3);after=capture('saileach-skill-after');after_dp=dp(after,'dp-after-skill');dt=time.perf_counter()-before_time
            # Allow natural 2X recovery plus two points of timestamp/rounding margin.
            confirmed=after_dp is not None and after_dp-before_dp>dt*2+2
            result['skill_dp_confirmed']=confirmed;result['dp_measurement']=dict(before=before_dp,after=after_dp,elapsed_s=dt,natural_upper=dt*2+2)
            log('recovery_verified',confirmed=confirmed,**result['dp_measurement'])
            if not confirmed:raise RuntimeError('Could not separate skill recovery from natural DP')
            break
        if not result['skill_dp_confirmed']:raise RuntimeError('Recovery skill never became ready')
        deploy('伊内丝',1,'fast-tile')
        deploy('维什戴尔',None)
        result['ok']=True;capture('final-three')
    except Exception as e:
        result['error']=str(e)
        try:capture('failure')
        except Exception:pass
        log('failure',error=str(e))
    finally:
        native.release();screen.close();events.close()
        (out/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(result,ensure_ascii=False),flush=True)
if __name__=='__main__':main()
