"""Bounded local multi-deployment and context-sensitive F-key experiments."""
import importlib.util,json,re,subprocess,time,urllib.request,uuid
from pathlib import Path
import cv2,numpy as np
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('followup_reference',ROOT/'scripts/deployment-reference-check.py')
ref=importlib.util.module_from_spec(spec);spec.loader.exec_module(ref)

def combat_stats(text):
    compact=re.sub(r'\s+','',text)
    compact=compact.replace('氵去抗','法抗')
    stats={}
    for name,next_label in [('攻击','防御'),('防御','法抗'),('阻挡','技能')]:
        match=re.search(re.escape(name)+r'([0-9A-Za-z,，]+)'+re.escape(next_label),compact)
        value=match[1].replace(',','').replace('，','') if match else ''
        stats[name]=int(value) if re.fullmatch(r'\d+',value) else None
    return stats

def slot_state(frame,slot):
    x=133*slot
    template=ref.reference('tray-affordable.png')[921:1009,x+20:x+100]
    # Remaining portraits shift slightly when a card leaves the tray. Match
    # within the card first instead of comparing the same fixed pixels.
    roi=frame[900:1024,x+3:x+130]
    _,score,_,point=cv2.minMaxLoc(cv2.matchTemplate(cv2.cvtColor(roi,cv2.COLOR_BGR2GRAY),cv2.cvtColor(template,cv2.COLOR_BGR2GRAY),cv2.TM_CCOEFF_NORMED))
    patch=roi[point[1]:point[1]+88,point[0]:point[0]+80]
    brightness=float(patch.mean()/max(1,template.mean()))
    error=float(np.abs(patch.astype(float)-template).mean())
    return dict(present=score>.85,ready=score>.93 and brightness>.90 and error<18,score=score,brightness=brightness,color_error=error,matched_offset=list(point))

def green_target(frame,proposal):
    if len(proposal)!=2 or any(not np.isfinite(v) for v in proposal):raise RuntimeError('Invalid tile proposal')
    x,y=np.array(proposal)*[1600,1024]
    if not 540<x<1430 or not 250<y<720:raise RuntimeError('Tile proposal outside map')
    b,g,r=cv2.split(frame.astype(np.float32))
    green=((g>r*1.15)&(g>b*1.05)&(g>60)).astype(np.uint8)
    green[:250]=0;green[720:]=0;green[:,:540]=0;green[:,1430:]=0
    interior=cv2.distanceTransform(green,cv2.DIST_L2,5)>12
    ys,xs=np.where(interior)
    if not len(xs):raise RuntimeError('No green tile interior')
    distance=(xs-x)**2+(ys-y)**2;index=int(distance.argmin())
    if distance[index]>45**2:raise RuntimeError('Model tile is not near an empty green cell')
    return [float(xs[index]/1600),float(ys[index]/1024)]

def run_followup(native,capture,log,out,operators,speed,test_skill,start_deployed=1):
    def save(frame,label):
        path=out/(label+'.png');cv2.imwrite(str(path),frame);return path
    def locate(frame,target,label,strategy='grounded'):
        name='followup-'+uuid.uuid4().hex+'.png'
        cv2.imwrite(str(ROOT/'runtime/vlm/live-20260911'/name),frame)
        save(frame,label)
        request=urllib.request.Request('http://127.0.0.1:17642/analyze',data=json.dumps(dict(image=name,target=target,mode='vlm',strategy=strategy),ensure_ascii=False).encode('utf8'),headers={'Content-Type':'application/json'})
        started=time.perf_counter()
        with urllib.request.urlopen(request,timeout=30) as response:result=json.load(response)
        log('followup_qwen',label=label,target=target,result=result.get('parsed'),errors=result.get('validation_errors'),wall_ms=(time.perf_counter()-started)*1000)
        if result.get('validation_errors'):raise RuntimeError('Invalid local Qwen output')
        parsed=result['parsed'];point=parsed.get('target_point')
        if not parsed.get('target_visible'):return None
        if not isinstance(point,list) or len(point)!=2 or any(not isinstance(v,(int,float)) or not 0<=v<=1000 for v in point):raise RuntimeError('Invalid local point')
        return [v/1000 for v in point]
    def ocr(frame,region,label):
        x1,y1,x2,y2=region;path=save(cv2.resize(frame[y1:y2,x1:x2],None,fx=4,fy=4),label+'-ocr')
        completed=subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(ROOT/'src/vision/windows-ocr.ps1'),'-ImagePath',str(path)],capture_output=True,timeout=15,creationflags=subprocess.CREATE_NO_WINDOW)
        if completed.returncode:raise RuntimeError('Local OCR failed')
        text=json.loads(completed.stdout.decode('utf-8-sig'))['text']
        log('followup_ocr',label=label,text=text)
        return text
    def speed_read(frame,label):
        def glyph(image):
            hsv=cv2.cvtColor(image[22:70,1350:1450],cv2.COLOR_BGR2HSV)
            return (hsv[:,:,2]>205)&(hsv[:,:,1]<70)
        current=glyph(frame);one=glyph(ref.reference('battle-ready.png'))
        similarity=float(2*np.logical_and(current,one).sum()/max(1,current.sum()+one.sum()))
        log('speed_glyph',label=label,one_similarity=similarity)
        if similarity>.94:return 1
        second=ref.REF/'speed-2x.png'
        if second.exists():
            two=glyph(ref.read(second));score=float(2*np.logical_and(current,two).sum()/max(1,current.sum()+two.sum()))
            if score>.94:return 2
        text=ocr(frame,(1320,12,1460,90),label)
        match=re.search(r'([12])\s*[xX×]',text)
        if match:return int(match[1])
        # Stylized 1X/2X may be missed by OCR. Confirm the literal 2X with the
        # resident local VLM before accepting a newly observed speed state.
        point=locate(frame,'右上角明确显示2X的倍速按钮中心。如果显示1X而不是2X则返回目标不可见。',label+'-qwen')
        return 2 if point and .82<point[0]<.92 and 0<point[1]<.12 else None
    def counter(frame,label):
        text=ocr(frame,(1330,822,1600,865),label)
        digits=re.findall(r'[0-8]',text)
        return int(digits[-1]) if digits else None
    def dismiss_profile():
        frame,_=capture();check=ref.inspect_frame(frame,'profile-dismiss')
        if not check['ok']:raise RuntimeError('Cannot align empty platform to dismiss profile')
        native.click(check['target_point']);time.sleep(.2);after,_=capture()
        closed=not ref.inspect_frame(after,'profile')['ok'];log('profile_dismissed',closed=closed,check=check)
        if not closed:raise RuntimeError('Operator profile did not close')
    result=dict(ok=False,deployed=start_deployed,speed=None,skill=dict(attempted=False,verified=False))
    def checkpoint():(out/'followup-progress.json').write_text(json.dumps(result,indent=2),encoding='utf8')
    checkpoint()
    if start_deployed==3:
        frame,_=capture()
        if counter(frame,'resume')!=5 or ref.inspect_frame(frame,'fast-tile').get('target_point') is None:raise RuntimeError('Three deployed operators not confirmed for resume')
        panel=ocr(frame,(0,210,560,760),'resume-panel')
        if '风' in panel and '笛' in panel:dismiss_profile()
    frame,_=capture();save(frame,'speed-before');observed=speed_read(frame,'speed-before')
    if observed is None:raise RuntimeError('Cannot verify current speed before F')
    if observed!=speed:
        # This call follows a verified landing in the normal battle view.
        native.tap_f();time.sleep(.20);frame,_=capture();save(frame,'speed-after')
        observed_after=speed_read(frame,'speed-after')
        log('speed_changed',before=observed,requested=speed,observed=observed_after,input='F')
        if observed_after!=speed:raise RuntimeError('F did not produce the requested speed')
    result['speed']=speed
    checkpoint()
    if operators>1:
        from ultralytics import YOLO
        training=ROOT/'runtime/vlm/training/deployment-tray-v1'
        gate=json.loads((training/'deployment-gate.json').read_text(encoding='utf8'))
        if not gate.get('approved_for_existing_team'):raise RuntimeError('Multi-card detector is not approved')
        detector=YOLO(str(training/'fit/weights/best.pt'))
        detector.predict(np.zeros((174,400,3),np.uint8),imgsz=320,device=0,verbose=False)
        for slot in range(start_deployed,operators):
            deadline=time.perf_counter()+35;card=None;last_log=0
            while time.perf_counter()<deadline:
                frame,ready_at=capture();state=slot_state(frame,slot)
                if state['ready']:
                    boxes=detector.predict(frame[850:1024,:400],imgsz=320,conf=.7,device=0,verbose=False)[0].boxes
                    candidates=[]
                    for box in boxes:
                        x1,y1,x2,y2=box.xyxy[0].tolist();cx=(x1+x2)/2
                        if slot*133<cx<(slot+1)*133:candidates.append(dict(point=[cx/1600,(850+(y1+y2)/2)/1024],confidence=float(box.conf.item())))
                    if candidates:
                        card=max(candidates,key=lambda c:c['confidence'])['point'];save(frame,f'card-{slot+1}-ready');log('additional_card_ready',slot=slot,state=state,yolo=candidates,frame_time=ready_at);break
                if time.perf_counter()-last_log>2:log('additional_wait',slot=slot,state=state);last_log=time.perf_counter()
                time.sleep(.05)
            if card is None:raise RuntimeError(f'Card {slot+1} did not become affordable')
            native.click(card);time.sleep(.25)
            frame,_=capture();cached=ref.inspect_frame(frame,f'multi-tile-{slot+1}')
            tile=cached['target_point'] if cached['ok'] else None
            log('additional_memory_alignment',slot=slot,result=cached)
            if tile:save(frame,f'card-{slot+1}-green')
            for attempt in range(2):
                if tile is not None:break
                frame,_=capture()
                target='定位画面正中间偏右的一块空闲绿色地面砖中心。绿色高亮代表可部署，不需要文字或图标；不要选已有角色和白色高台。'
                if attempt:target='当前是干员选中画面，绿色高亮地面就是可部署位置。定位靠近已部署干员、但是没有人物站立的绿色地面砖中心，不能选灰白色高台或红色入口。'
                proposal=locate(frame,target,f'card-{slot+1}-selected-{attempt}','baseline')
                if proposal is None:continue
                fresh,_=capture()
                try:tile=green_target(fresh,proposal);save(fresh,f'card-{slot+1}-green');log('additional_tile',slot=slot,proposal=proposal,point=tile);break
                except RuntimeError as error:log('additional_tile_rejected',slot=slot,error=str(error),proposal=proposal)
            if tile is None:raise RuntimeError('Local model could not locate an empty green cell')
            log('additional_drop_released',slot=slot,**native.drag(card,tile,.09))
            deadline=time.perf_counter()+1;direction=None
            while time.perf_counter()<deadline:
                frame,_=capture();check=ref.inspect_frame(frame,'direction')
                if check['ok']:direction=check['target_point'];save(frame,f'card-{slot+1}-direction');break
                time.sleep(.01)
            if direction is None or direction[0]>.85:
                save(frame,f'card-{slot+1}-direction-failure')
                raise RuntimeError('No safe actual direction selector')
            log('additional_direction_released',slot=slot,**native.drag(direction,[direction[0]+.12,direction[1]],.05))
            time.sleep(.25);frame,landed_at=capture();save(frame,f'card-{slot+1}-landed')
            remaining=counter(frame,f'card-{slot+1}-landed')
            if remaining!=7-slot or ref.inspect_frame(frame,'direction')['ok'] or slot_state(frame,slot)['present']:
                raise RuntimeError(f'Card {slot+1} landing not confirmed: remaining={remaining}')
            result['deployed']+=1
            checkpoint()
            log('additional_landed',slot=slot,remaining=remaining,ready_to_landed_s=landed_at-ready_at)
    if test_skill:
        # Let charge progress in the normal view; selecting a unit slows battle.
        time.sleep(3 if start_deployed==1 else .05);frame,_=capture();save(frame,'skill-unit')
        aligned=ref.inspect_frame(frame,'fast-tile')
        point=aligned.get('target_point')
        if point is None:raise RuntimeError('Deployed Bagpipe map position not localized')
        log('skill_unit_memory_alignment',result=aligned)
        for attempt in range(3):
            frame,_=capture();point=ref.inspect_frame(frame,'fast-tile').get('target_point')
            if point is None:raise RuntimeError('Map no longer matches deployed-operator reference')
            native.click(point);time.sleep(.2);before,_=capture();save(before,f'skill-before-{attempt}')
            panel=ocr(before,(0,210,560,760),f'skill-panel-{attempt}')
            if '风' not in panel or '笛' not in panel:raise RuntimeError('Deployed operator panel not confirmed; F suppressed')
            # The displayed hint is E in this client. Read READY in the actual
            # skill menu; do not mistake the left-side description for a key.
            region=(600,250,1400,875)
            label=ocr(before,region,f'skill-ready-{attempt}')
            hsv=cv2.cvtColor(before[region[1]:region[3],region[0]:region[2]],cv2.COLOR_BGR2HSV)
            green=float(((hsv[:,:,0]>30)&(hsv[:,:,0]<95)&(hsv[:,:,1]>90)&(hsv[:,:,2]>120)).mean())
            ready='READY' in re.sub(r'\s+','',label).upper()
            log('skill_readiness',attempt=attempt,ready=ready,green_fraction=green,text=label)
            if not ready:
                dismiss_profile();time.sleep(6);continue
            save(before,'skill-before');native.tap_f();time.sleep(.3);after_f,_=capture();save(after_f,'skill-after-f')
            after_f_text=ocr(after_f,region,'skill-after-f')
            f_left_ready='READY' in re.sub(r'\s+','',after_f_text).upper()
            log('skill_f_attempt',ready_remains=f_left_ready,before='skill-before.png',after='skill-after-f.png')
            used_e=False
            if f_left_ready:
                # The visible E hint and still-ready skill establish that F
                # did not activate it. Use the displayed shortcut.
                template=ref.reference('skill-ready.png')[565:608,1170:1240]
                roi=before[250:875,600:1400]
                _,hint_score,_,_=cv2.minMaxLoc(cv2.matchTemplate(cv2.cvtColor(roi,cv2.COLOR_BGR2GRAY),cv2.cvtColor(template,cv2.COLOR_BGR2GRAY),cv2.TM_CCOEFF_NORMED))
                log('skill_e_hint',score=hint_score,source='visually reviewed displayed E hint')
                if not re.search(r'\bE\b',label) and hint_score<.90:raise RuntimeError('Skill still READY after F, but E hint was not recognized')
                native.tap_e();used_e=True;time.sleep(.4)
            after,_=capture();save(after,'skill-after')
            after_text=ocr(after,region,'skill-after')
            ready_disappeared='READY' not in re.sub(r'\s+','',after_text).upper()
            result['skill']=dict(attempted=True,f_left_ready=f_left_ready,used_e=used_e,ready_disappeared=ready_disappeared,verified=False,reason='Before/after screenshots and independent recording must confirm effect or charge reset.')
            if ready_disappeared:
                point=ref.inspect_frame(after,'fast-tile').get('target_point')
                if point is not None:
                    native.click(point);time.sleep(.2);active,_=capture();save(active,'skill-active-panel')
                    active_text=ocr(active,(0,210,560,760),'skill-active-panel')
                    before_stats,after_stats=combat_stats(panel),combat_stats(active_text)
                    defense_changed=bool(before_stats['防御'] and after_stats['防御'] and after_stats['防御']>before_stats['防御']*1.5)
                    block_changed=before_stats['阻挡']==1 and after_stats['阻挡']==2
                    result['skill'].update(stats_before=before_stats,stats_after=after_stats,
                        effect_confirmed=defense_changed and block_changed)
                    if ref.inspect_frame(active,'profile')['ok']:dismiss_profile()
            normal,_=capture()
            if not ref.inspect_frame(normal,'profile')['ok']:
                observed=speed_read(normal,'speed-after-skill');result['skill']['speed_after_keys']=observed
                if observed in (1,2) and observed!=speed:
                    native.tap_f();time.sleep(.2);normal,_=capture()
                    result['skill']['speed_restored']=speed_read(normal,'speed-restored')==speed
                    save(normal,'after-skill-speed-restored')
            checkpoint()
            log('skill_key_result',**result['skill']);break
    result['ok']=result['deployed']==operators
    (out/'followup-summary.json').write_text(json.dumps(result,indent=2),encoding='utf8')
    return result
