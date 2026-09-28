"""Bounded numbered-mainline trial, local Qwen + trained card YOLO + native input.

No 0-1 map coordinates are used. Pause while inspecting new deployment geometry.
Raw proposals, failures and actual state transitions are retained for review.
"""
import sys,time,json,importlib.util,urllib.request,re,argparse,hashlib,subprocess
from pathlib import Path
import cv2,numpy as np,mss
from PIL import Image,ImageDraw,ImageFont
from ultralytics import YOLO
from local_stage_session import Session,ROOT
from battle_cost import read_cost, affordable, card_cost_box
from battle_pause import read_pause
from battle_result import lit_result_badges,result_stage_from_text
from campaign_stage import mainline_stage
from local_battle_followup import ref
from stage07_reference import align as align_stage07
spec=importlib.util.spec_from_file_location('native',ROOT/'scripts/realtime-deployment.py')
rt=importlib.util.module_from_spec(spec);spec.loader.exec_module(rt)

def main():
    sys.stdout.reconfigure(encoding='utf8')
    parser=argparse.ArgumentParser()
    parser.add_argument('--stage',type=mainline_stage,default='0-7')
    parser.add_argument('--plan',type=Path)
    parser.add_argument('--out',type=Path)
    parser.add_argument('--resume-summary',type=Path)
    args=parser.parse_args()
    if args.stage!='0-7' and args.plan is None:raise RuntimeError('New stage requires its own current map plan')
    s=Session(args.out);out=s.out;started=time.perf_counter();result={'ok':False,'stage':args.stage,'deployed':[]}
    token=(ROOT/'runtime/vlm/controller/token.txt').read_text().strip()
    req=urllib.request.Request('http://127.0.0.1:17644/status',headers={'Authorization':'Bearer '+token})
    with urllib.request.urlopen(req) as response:status=json.load(response)
    recordings=ROOT/'runtime/vision/timing-recordings'
    active_path=recordings/'active.json';recording_ok=False
    if active_path.exists():
        active=json.loads(active_path.read_text(encoding='utf8'))
        recording=Path(active['directory']).resolve()
        if recordings.resolve() in recording.parents and active.get('hwnd')==status['info']['handle'] and not (recording/'summary.json').exists():
            with (recording/'timeline.jsonl').open(encoding='utf8') as stream:first=json.loads(stream.readline())
            age=(time.time_ns()-first.get('utc_unix_ns',0))/1e9
            recording_ok=age<120 and time.time()-(recording/'timeline.jsonl').stat().st_mtime<5
            if not recording_ok:(recording/'stop').touch()
    if not recording_ok:
        with (out/'recorder-launch.log').open('w') as stdout,(out/'recorder-error.log').open('w') as stderr:
            recorder=subprocess.Popen([sys.executable,str(ROOT/'scripts/record-game-timing.py'),'--hwnd',str(status['info']['handle']),'--seconds','600','--fps','6'],cwd=ROOT,stdout=stdout,stderr=stderr,creationflags=subprocess.CREATE_NO_WINDOW)
        s.log('independent_recorder_started',process_id=recorder.pid,duration_s=600,fps=6)
        time.sleep(.7)
    native=rt.Native(status['info']['handle'],out/'cancel');screen=mss.MSS();paused=False
    def journal_native_action(method,operation):
        def call(*arguments):
            s.log('native_input_requested',action=method,arguments=arguments)
            try:value=operation(*arguments)
            except Exception as error:
                s.log('native_input_failed',action=method,error=str(error),outcome='unknown')
                raise
            s.log('native_input_completed',action=method,result=value,game_effect_verified=False)
            return value
        return call
    for method in ('click','drag','tap_scan'):
        setattr(native,method,journal_native_action(method,getattr(native,method)))
    def frame(label=None):
        if time.perf_counter()-started>420:raise RuntimeError('Finite stage trial timeout')
        a=cv2.resize(np.asarray(screen.grab(native.bounds()))[:,:,:3],(1600,1024))
        evidence=out/('frame-'+str(time.time_ns())+'.jpg')
        if not cv2.imwrite(str(evidence),a,[cv2.IMWRITE_JPEG_QUALITY,90]):raise RuntimeError('Frame evidence write failed')
        s.log('capture',label=label,path=str(evidence))
        if label:cv2.imwrite(str(out/(label+'.png')),a)
        return a
    def log(event,**data):s.log(event,t=time.perf_counter()-started,**data)
    def pause(value):
        nonlocal paused
        def observed():
            for attempt in range(12):
                image=frame('pause-state')
                try:state,parts=read_pause(image)
                except RuntimeError:
                    time.sleep(.2);continue
                log('pause_observed',components=parts)
                return state
            raise RuntimeError('Pause control not ready after opening transition')
        paused=observed()
        for attempt in range(3):
            if paused==value:break
            native.tap_space();time.sleep(.3);paused=observed()
        if paused!=value:raise RuntimeError('Pause transition not visually confirmed')
        log('pause',value=value,visually_verified=True)
    def count(image,label):
        text=s.ocr(image,(1310,820,1600,875),label)
        match=re.search(r'([0-8])$',text)
        if not match:raise RuntimeError('Deployment counter unreadable')
        return int(match[1])
    def dp(image):
        value=read_cost(image,(1510,755,1600,820),s.ocr,'dp-context')
        if value is None:
            answer=s.analyze(image,'读取当前费用数字，只输出JSON：value为0到99的整数，无法辨认则null。','dp-vlm',crop=(1460,755,1600,825),mode='vlm')
            observed=answer.get('value')
            if type(observed) is int and 0<=observed<=99:value=observed
        return value
    def identity_text(image,name,label):
        text=s.ocr(image,(0,290,280,380),label,scale=3)
        if name not in text:
            text+=' '+s.ocr(cv2.convertScaleAbs(image,alpha=2.5),(0,290,280,380),label+'-bright',scale=3)
        if name not in text:
            reading=s.analyze(cv2.convertScaleAbs(image,alpha=2),'读取左侧干员姓名。只输出JSON，name为实际显示的中文姓名，无法辨认则null。',label+'-name-vlm',crop=(0,280,350,405),mode='vlm')
            if reading.get('name')==name:text+=' '+name
        return text
    def live_card_cost(image,x,name):
        value=read_cost(image,card_cost_box(x),s.ocr,name+'-card-cost')
        if value is None:
            box=(max(0,int(x)-60),865,min(1600,int(x)+70),935)
            answer=s.analyze(image,'读取这张'+name+'卡片顶部的部署费用数字。只输出JSON：value为0到99的整数，无法辨认则null。',name+'-card-cost-vlm',crop=box,mode='vlm')
            value=answer.get('value')
            if isinstance(value,str) and re.fullmatch(r'\d{1,2}',value):value=int(value)
            if type(value) is not int or not 0<=value<=99:value=None
        return value
    def point(image,target,label,crop=None):
        p=s.locate(image,target,label,crop)
        if p is not None:return p
        r=s.analyze(image,'找出'+target+'。只输出JSON：x为横坐标，y为纵坐标，均为0至1000的数字。只依据当前图。',label+'-spatial',mode='vlm')
        x,y=r.get('x'),r.get('y')
        if any(type(v) not in (int,float) or not 0<=v<=1000 for v in (x,y)):raise RuntimeError('Local spatial target absent: '+label)
        return [x/1000,y/1000]
    def card_state(image,slot):
        template=ref.reference('tray-affordable.png')[921:1009,slot*133+20:slot*133+100]
        roi=image[900:1024,:] if slot==10 else image[900:1024,:550]
        _,score,_,offset=cv2.minMaxLoc(cv2.matchTemplate(cv2.cvtColor(roi,cv2.COLOR_BGR2GRAY),cv2.cvtColor(template,cv2.COLOR_BGR2GRAY),cv2.TM_CCOEFF_NORMED))
        patch=roi[offset[1]:offset[1]+88,offset[0]:offset[0]+80]
        return dict(ready=score>.93 and patch.mean()/max(1,template.mean())>.9 and np.abs(patch.astype(float)-template).mean()<18,x=offset[0]+40,score=score)
    def green(image,proposal,name,hint=None):
        b,g,r=cv2.split(image.astype(np.float32));mask=((g>1.15*r)&(g>1.05*b)&(g>(18 if paused else 60))).astype(np.uint8)
        mask[:180]=0;mask[770:]=0;mask[:,:430]=0;mask[:,1480:]=0
        distance=cv2.distanceTransform(mask,cv2.DIST_L2,5)
        # Select broad cell interiors, not the nearest thin green border.
        interior=distance>25;ys,xs=np.where(interior)
        if not len(xs):raise RuntimeError('No legal green deployment interior')
        peaks=[];remaining=distance.copy()
        while len(peaks)<24:
            _,radius,_,center=cv2.minMaxLoc(remaining)
            if radius<25:break
            peaks.append((center[0],center[1],radius))
            cv2.circle(remaining,center,85,0,-1)
        if not peaks:raise RuntimeError('No broad legal deployment cell')
        rejected=[p['point'] for p in result.get('rejected_placements',[]) if p['name']==name]
        peaks=[p for p in peaks if all((p[0]-q[0]*1600)**2+(p[1]-q[1]*1024)**2>110**2 for q in rejected)]
        if not peaks:raise RuntimeError('All broad green candidates were rejected in prior attempts')
        if hint:
            marked=cv2.convertScaleAbs(image,alpha=2.8) if paused else image.copy()
            for number,(x,y,radius) in enumerate(peaks,1):
                cv2.circle(marked,(x,y),16,(0,0,0),-1)
                cv2.putText(marked,str(number),(x-12,y+6),cv2.FONT_HERSHEY_SIMPLEX,.55,(255,255,0),2)
            choice=s.analyze(marked,'地图上青色数字标出当前'+name+'可部署绿色候选格。选一个编号满足：'+hint+'。不要把红门或蓝门本身当作落点。只输出JSON：candidate为编号整数，reason简述该格守哪条路线；没有合适候选则null。不要输出坐标。',name+'-green-candidate',mode='vlm')
            selected_number=choice.get('candidate')
            if isinstance(selected_number,str) and selected_number.isdigit():selected_number=int(selected_number)
            if type(selected_number) is not int or not 1<=selected_number<=len(peaks):raise RuntimeError('Local model did not select a current legal green candidate')
            x,y,radius=peaks[selected_number-1]
            tile=[float(x/1600),float(y/1024)]
            log('green_candidate_selected',name=name,candidates=peaks,model=choice,point=tile,legality_only=True)
            return tile
        broad=[p for p in peaks if p[2]>=40]
        if broad:peaks=broad
        xs=np.array([p[0] for p in peaks]);ys=np.array([p[1] for p in peaks])
        d=(xs-proposal[0]*1600)**2+(ys-proposal[1]*1024)**2;i=int(d.argmin())
        if d[i]>350**2:raise RuntimeError('Local proposal is not near a green cell')
        log('green_projection',proposal=proposal,candidates=peaks,distance_px=float(np.sqrt(d[i])),point=[float(xs[i]/1600),float(ys[i]/1024)])
        return [float(xs[i]/1600),float(ys[i]/1024)]
    def saileach_skill(wait_for_ready=True):
        if result.get('saileach_skill',{}).get('pressed'):return
        pause(False);time.sleep(3.5)
        pause(True)
        native.move(native.pixel([.965,.95],native.bounds()));log('cursor_parked',point=[.965,.95],coordinate_space='normalized client converted to screen',reason='Keep the game cursor off operator health bars')
        time.sleep(.1);image=frame('skill-locate')
        geometry=result.get('deployment_geometry',{}).get('琴柳')
        if not geometry:raise RuntimeError('Missing current-battle skill geometry')
        source=cv2.imdecode(np.fromfile(geometry['selected_image'],np.uint8),cv2.IMREAD_COLOR)
        mask=np.zeros((1024,1600),np.uint8);mask[170:790,530:1470]=255
        mask[420:610,530:1060]=0 # PAUSE overlay is screen-fixed, not a map landmark.
        orb=cv2.ORB_create(nfeatures=8000);ka,da=orb.detectAndCompute(source,mask);kb,db=orb.detectAndCompute(image,mask)
        matches=[] if da is None or db is None else [pair[0] for pair in cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(da,db,k=2) if len(pair)==2 and pair[0].distance<.75*pair[1].distance]
        transform,inliers=(None,None) if len(matches)<8 else cv2.findHomography(np.float32([ka[m.queryIdx].pt for m in matches]),np.float32([kb[m.trainIdx].pt for m in matches]),cv2.RANSAC,3)
        inlier_count=int(inliers.sum()) if inliers is not None else 0
        mapped=np.array([800.,512.]) # ranking anchor only; never clicked directly
        if transform is not None and inlier_count>=25:
            projected=cv2.perspectiveTransform(np.float32([[[geometry['point'][0]*1600,geometry['point'][1]*1024]]]),transform)[0,0]
            if 250<projected[0]<1500 and 180<projected[1]<800:mapped=projected
        else:log('skill_alignment_abstained',matches=len(matches),inliers=inlier_count,action='Use current health bars and verify selected names')
        p=[float(mapped[0]/1600),float(mapped[1]/1024)]
        log('skill_geometry',name='琴柳',source=geometry,matches=len(matches),inliers=inlier_count,point=p,ranking_only=True)
        b,g,r=cv2.split(image.astype(np.float32))
        hp=((g>1.05*r)&(g>.85*b)&(g>25)).astype(np.uint8)*255
        hp[:180]=0;hp[800:]=0;hp[:,:250]=0;hp[:,1500:]=0
        contours,_=cv2.findContours(hp,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        bars=[];all_bars=[]
        for contour in contours:
            x,y,w,h=cv2.boundingRect(contour)
            if 45<=w<=110 and 2<=h<=12 and w/h>5:
                distance=float((x+w/2-mapped[0])**2+(y+h/2-mapped[1])**2)
                all_bars.append((distance,x+w/2,y+h/2,w,h))
                if distance<110**2:bars.append((distance,x+w/2,y+h/2,w,h))
        if all_bars:
            # Map projection can extrapolate poorly. Verify identities of current
            # deployed sprites instead of trusting the nearest health bar.
            # Summons also have green bars. Four candidates can omit the actual
            # operator after deployment perspective changes; verify up to eight.
            candidates=sorted(all_bars)[:8]
            if len(candidates)>1:
                marked=image.copy()
                for number,bar in enumerate(candidates,1):
                    x,y=round(bar[1]),round(bar[2])+22
                    cv2.rectangle(marked,(x-14,y-18),(x+18,y+7),(0,0,0),-1)
                    cv2.putText(marked,str(number),(x-10,y+3),cv2.FONT_HERSHEY_SIMPLEX,.7,(255,255,0),2)
                decision=s.analyze(marked,'当前战场的绿色血条下方新增青色编号。哪个编号属于撑旗伞的金发蓝白裙干员琴柳？不要选白发维什戴尔、黑发伊内丝、红发风笛或魂灵召唤物。只输出JSON：candidate为编号整数，无法辨认则null。仅用于候选排序，选中后还会读姓名。','skill-candidate-ranking',crop=(250,170,1500,800),mode='vlm')
                chosen=decision.get('candidate')
                if type(chosen) is int and 1<=chosen<=len(candidates):
                    candidates.insert(0,candidates.pop(chosen-1))
                log('skill_candidate_ranking',model=decision,candidates=candidates,identity_verification_required=True)
            for bar in candidates:
                p=[bar[1]/1600,(bar[2]-40)/1024]
                log('skill_identity_candidate',bar=bar,click_point=p)
                pause(False);native.click(p);time.sleep(.4);native.move(native.pixel([.965,.95],native.bounds()));time.sleep(.1)
                current=frame('skill-identity-candidate')
                name=identity_text(current,'琴柳','skill-candidate-name')
                if '琴柳' in name:return activate_saileach(current,wait_for_ready)
                if ref.inspect_frame(current,'profile')['ok']:
                    s.click_target('地图上方空白背景，关闭干员详情',crop=(1000,80,1300,190),surface=True)
                    time.sleep(.4)
                pause(True)
            raise RuntimeError('Current health-bar candidates did not identify Saileach')
        if not bars:
            log('skill_geometry_rejected',reason='No current health bar near projected cell')
            p=point(cv2.convertScaleAbs(image,alpha=2),'战场上撑紫色阳伞的金发蓝裙琴柳干员本体中心，不是底部卡片','saileach-current-body',(250,100,1300,720))
        else:
            bar=min(bars);p=[bar[1]/1600,(bar[2]-40)/1024]
            log('skill_healthbar_refinement',bar=bar,click_point=p)
        pause(False)
        native.click(p);time.sleep(.35);image=frame('saileach-skill-before')
        activate_saileach(image,wait_for_ready)
    def activate_saileach(image,wait_for_ready=True):
        native.move(native.pixel([.965,.95],native.bounds()));time.sleep(.1)
        image=frame('saileach-profile-unoccluded')
        identity=identity_text(image,'琴柳','saileach-skill-name')
        if '琴柳' not in identity:raise RuntimeError('Skill target is not Saileach')
        ready=s.ocr(image,(450,220,1490,900),'saileach-ready',scale=1)
        if 'READY' not in ready.upper():
            check=s.analyze(image,'技能按钮下方是否明确显示READY？只输出JSON：ready为true、false或null。','saileach-ready-check',crop=(650,450,1440,900),mode='vlm')
            if check.get('ready') is True or check.get('ready')=='true':ready='READY'
        description=s.ocr(image,(0,530,550,930),'saileach-skill-text')
        if '支援号令' not in description or '部署费' not in description:raise RuntimeError('Saileach recovery skill identity not confirmed')
        if 'READY' not in ready.upper():
            pause(False)
            closed=s.click_target('地图上方的空白背景，关闭干员详情面板',crop=(650,80,1100,190),surface=True)
            if ref.inspect_frame(closed,'profile')['ok']:raise RuntimeError('Skill wait could not close profile')
            log('skill_not_ready',deferred_for_deployment=not wait_for_ready)
            if not wait_for_ready:return
            waits=result.get('skill_ready_waits',0)
            if waits>=3:raise RuntimeError('Skill remained not ready after three observed waits')
            result['skill_ready_waits']=waits+1
            pause(False);time.sleep(8)
            return saileach_skill(True)
        before=dp(image)
        if before is None:raise RuntimeError('Pre-skill DP unreadable')
        pause(False)
        native.tap_e();log('saileach_skill_pressed',before_dp=before,key='E');time.sleep(.25)
        # E closes the skill panel in the verified game input path.
        if ref.inspect_frame(frame(),'profile')['ok']:raise RuntimeError('Skill panel stayed open after E')
        pause(False);time.sleep(8.3);after=frame('saileach-skill-after');money=dp(after)
        result['saileach_skill']={'pressed':True,'before_dp':before,'after_dp':money,'dp_delta':money-before if money is not None else None,'exact_skill_fee_unverified':True}
        log('saileach_recovery_observed',**result['saileach_skill'])
    def deploy(item,index,already_selected=False):
        name=item['name'];slot={'风笛':0,'伊内丝':1,'琴柳':2}.get(name)
        deadline=time.perf_counter()+60;card=None;ready_since=None
        if already_selected:
            state=card_state(frame(),10 if slot is None else slot)
            if state['score']<.9:
                card=point(frame(),'底部已经选中的'+name+'头像卡片中心','resume-card',(0,850,1600,1024))
            else:card=[state['x']/1600,.94]
        else:pause(False)
        while time.perf_counter()<deadline:
            if card is not None:break
            image=frame()
            if slot is not None:
                state=card_state(image,slot)
                if state['ready']:
                    if ready_since is None:ready_since=time.perf_counter()
                    boxes=detector.predict(image[850:1024,:550],imgsz=480,conf=.30,device=0,verbose=False)[0].boxes
                    candidates=[b for b in boxes if float(b.xyxy[0][0])<state['x']<float(b.xyxy[0][2])]
                    if candidates:
                        b=max(candidates,key=lambda b:float(b.conf[0]))
                        if float(b.conf[0])<.65:
                            balance=dp(image);cost=live_card_cost(image,state['x'],name)
                            corroborated=state['score']>=.98 and affordable(balance,cost)
                            log('card_yolo_corroboration',name=name,confidence=float(b.conf[0]),portrait_score=state['score'],balance=balance,cost=cost,accepted=corroborated)
                            if not corroborated:raise RuntimeError('Low-confidence card lacks current affordability corroboration')
                        x1,y1,x2,y2=b.xyxy[0].tolist();card=[(x1+x2)/3200,(850+(y1+y2)/2)/1024];log('card_yolo',name=name,score=state['score'],confidence=float(b.conf[0]));break
                    if time.perf_counter()-ready_since>3:raise RuntimeError('Ready portrait detected but card YOLO missed; pause for correction')
            else:
                state=card_state(image,10)
                if state['score']>.9:
                    money=dp(image)
                    cost=live_card_cost(image,state['x'],name)
                    log('affordability',name=name,balance=money,card_cost=cost,
                        affordable=affordable(money,cost),portrait_score=state['score'])
                    if affordable(money,cost):
                        card=[state['x']/1600,.94]
                        log('card_reference',name=name,point=card,score=state['score'],current_cost=cost,selected_identity_check_required=True)
                        break
                time.sleep(.8)
            time.sleep(.2) # Fee/card readiness changes slowly; avoid redundant full-frame disk writes.
        if card is None:raise RuntimeError('Affordable card not found: '+name)
        pause(True);before=count(frame(),name+'-before-count')
        if not already_selected:native.click(card);time.sleep(.3)
        image=frame(name+'-selected')
        identity=s.ocr(image,(0,230,440,510),name+'-identity')
        if name not in identity and not (name=='维什戴尔' and '堆什戴尔' in identity):raise RuntimeError('Selected identity mismatch: '+name)
        profile=s.ocr(image,(0,270,560,900),name+'-stats-skill',scale=1)
        cache_dir=ROOT/'runtime/vision/profile-analysis-cache';cache_dir.mkdir(exist_ok=True)
        cache_key=hashlib.sha256((name+'\n'+profile).encode('utf8')).hexdigest()
        cache_path=cache_dir/(cache_key+'.json');reused=None
        if cache_path.exists():
            cached=json.loads(cache_path.read_text(encoding='utf8'))
            range_analysis=cached['model'];reused=cached['evidence']
            log('profile_analysis_reused',name=name,exact_ocr_match=True,source=str(cache_path),current_evidence=str(out/(name+'-selected.png')))
        else:
            range_analysis=s.analyze(image,'当前选中'+name+'。只输出JSON：name，attack攻击，defense防御，block阻挡数，range攻击范围图形描述，skill技能名称，skill_effect技能效果。看不清填null，不推测精确DPS。','profile-'+name,crop=(0,270,560,900),mode='vlm')
            cache_path.write_text(json.dumps({'name':name,'ocr':profile,'model':range_analysis,'evidence':str(out/(name+'-selected.png'))},ensure_ascii=False),encoding='utf8')
        log('operator_analysis',name=name,ocr=profile,model=range_analysis,model_verified=False,evidence=str(out/(name+'-selected.png')),reused_from=reused)
        hint=('蓝色目标右侧、通往蓝色目标的最后一段道路上的绿色地面格中心，用于拦截两路汇合的敌人' if index==0 and args.stage=='0-7' else item['tile_hint']+'的一块未被占用的绿色可部署格中心')
        if name=='维什戴尔':hint='能覆盖通向蓝色目标道路的中央绿色高台格中心，不能是地面道路'
        visible=cv2.convertScaleAbs(image,alpha=2.8) if paused else image
        proposal=point(visible,hint,name+'-tile') if args.stage=='0-7' else None
        try:
            if args.stage!='0-7':raise RuntimeError('No reviewed reference for this stage; require current green geometry')
            current=frame();matched=align_stage07(current,name);tile=matched['point'];log('stage07_reference',name=name,model_proposal=proposal,**matched)
        except (RuntimeError,FileNotFoundError,KeyError) as e:
            log('stage07_reference_unavailable',name=name,reason=str(e));tile=green(frame(),proposal,name,hint if proposal is None else None)
        frame(name+'-pre-drop')
        log('drop_requested',name=name,card=card,tile=tile,method='native single-release',duration_s=.4)
        drag_started=time.perf_counter()
        drop=native.drag(card,tile,.4)
        drop['elapsed_ms']=(time.perf_counter()-drag_started)*1000
        log('drop',name=name,card=card,tile=tile,controller=drop);time.sleep(.3);image=frame(name+'-direction')
        diamond=ref.inspect_frame(image,'direction')
        if not diamond['ok']:
            result.setdefault('rejected_placements',[]).append({'name':name,'point':tile,'reason':'Direction selector absent after drop'})
            raise RuntimeError('Actual direction selector missing')
        pending_name=identity_text(image,name,name+'-pending-identity')
        if name not in pending_name and not (name=='维什戴尔' and '堆什戴尔' in pending_name):raise RuntimeError('Dragged a different operator')
        origin=diamond['target_point'];direction=item['facing']
        if index==0 and args.stage=='0-7':direction='right'
        dx,dy={'right':(.12,0),'left':(-.12,0),'up':(0,-.16),'down':(0,.16)}[direction]
        native.drag(origin,[origin[0]+dx,origin[1]+dy],.12);time.sleep(.3);image=frame(name+'-landed')
        after=count(image,name+'-after-count')
        if after!=before-1 or ref.inspect_frame(image,'direction')['ok']:raise RuntimeError('Landing not confirmed')
        result['deployed'].append(name);log('landed',name=name,remaining=after,facing=direction)
        result.setdefault('deployment_geometry',{})[name]={'selected_image':str(out/(name+'-selected.png')),'point':tile,'stage':args.stage}
        # Current paused sprite is a same-stage reference only for subsequent skill targeting.
        if name=='琴柳':result['saileach_tile']=tile
        pause(False)
    try:
        plan=json.loads((args.plan or ROOT/'runtime/vlm/controller/stage07-plan.json').read_text(encoding='utf8'))
        if args.stage!='0-7' and plan.get('stage')!=args.stage:raise RuntimeError('Plan stage identity mismatch')
        names=[i.get('name') for i in plan.get('plan',[])]
        if not 3<=len(names)<=4 or len(set(names))!=len(names) or any(n not in ('伊内丝','风笛','琴柳','维什戴尔') for n in names):raise RuntimeError('Invalid local roster plan')
        if any(i.get('facing') not in ('right','left','up','down') for i in plan['plan']):raise RuntimeError('Invalid direction plan')
        (out/'plan.json').write_text(json.dumps(plan,ensure_ascii=False,indent=2),encoding='utf8')
        detector=YOLO(str(ROOT/'runtime/vlm/training/deployment-tray-v1/fit/weights/best.pt'))
        detector.predict(np.zeros((174,550,3),np.uint8),imgsz=480,device=0,verbose=False)
        image=frame('formation');resume=False;resume_index=0
        if args.resume_summary:
            previous=json.loads(args.resume_summary.read_text(encoding='utf8'))
            if previous.get('stage')!=args.stage:raise RuntimeError('Resume stage mismatch')
            result['rejected_placements']=previous.get('rejected_placements',[])
        selected=ref.inspect_frame(image,'profile')['ok'] or ref.inspect_frame(image,'direction')['ok']
        counter_text=s.ocr(image,(1310,820,1600,875),'initial-counter')
        if selected or ('剩余' in counter_text and re.search(r'[0-8]$',counter_text)):
            remaining=count(image,'resume-count');resume_index=8-remaining
            if not 0<=resume_index<=len(names):raise RuntimeError('Unrecognized resume count')
            expected=names[resume_index] if resume_index<len(names) else None
            if resume_index and args.resume_summary:
                if previous.get('deployed')!=names[:resume_index]:raise RuntimeError('No matching previous deployment evidence')
                result['deployed']=names[:resume_index]
                result['deployment_geometry']=previous.get('deployment_geometry',{})
                if previous.get('saileach_skill'):result['saileach_skill']=previous['saileach_skill']
            if selected:
                text=identity_text(image,expected or '琴柳','resume-name')
                if expected in ('维什戴尔',None) and '琴柳' in text and '琴柳' in previous.get('deployed',[]):
                    activate_saileach(image);selected=False;image=frame('skill-panel-resumed')
                elif (expected is None or expected not in text) and any(n in text for n in previous.get('deployed',[])):
                    pause(False)
                    s.click_target('地图上方空白背景，关闭干员详情',crop=(1000,80,1300,190),surface=True)
                    time.sleep(.4);image=frame('closed-other-deployed-profile')
                    if ref.inspect_frame(image,'profile')['ok']:raise RuntimeError('Could not close prior deployed operator profile')
                    selected=False
                elif expected is None or (expected not in text and not (expected=='维什戴尔' and '堆什戴尔' in text)):raise RuntimeError('Unrecognized resume identity')
            if resume_index:
                if args.resume_summary is None:raise RuntimeError('Resume requires an explicit previous summary, not latest-directory guessing')
                previous=json.loads(args.resume_summary.read_text(encoding='utf8'))
                if previous.get('stage')!=args.stage or previous.get('deployed')!=names[:resume_index]:raise RuntimeError('No matching previous deployment evidence')
                result['deployed']=names[:resume_index]
                result['deployment_geometry']=previous.get('deployment_geometry',{})
            paused='PAUSE' in s.ocr(image,(560,380,1060,600),'resume-pause').upper()
            pending=ref.inspect_frame(image,'direction')
            if pending['ok']:
                direction=plan['plan'][resume_index]['facing']
                dx,dy={'right':(.12,0),'left':(-.12,0),'up':(0,-.16),'down':(0,.16)}[direction]
                origin=pending['target_point']
                native.drag(origin,[origin[0]+dx,origin[1]+dy],.2);time.sleep(.4)
                confirmed=frame('pending-resume-landed')
                if count(confirmed,'pending-resume-count')!=remaining-1 or ref.inspect_frame(confirmed,'direction')['ok']:
                    raise RuntimeError('Pending direction recovery did not confirm landing')
                result['deployed'].append(expected);log('landed',name=expected,remaining=remaining-1,facing=direction,recovered_pending=True)
                result.setdefault('deployment_geometry',{})[expected]={'selected_image':str(out/'formation.png'),'point':origin,'stage':args.stage,'source':'current pending direction center; skill-ranking anchor only'}
                resume_index+=1;selected=False
            pause(True);resume=True;result['resumed']=True
        else:
            start=s.locate(image,'编队界面右侧橙色开始行动按钮','start',(1050,300,1600,900))
            if start is None:raise RuntimeError('Formation start button not verified')
            native.click(start);log('battle_requested')
            deadline=time.perf_counter()+90
            while time.perf_counter()<deadline:
                opening=frame()
                hud=s.ocr(opening,(1310,820,1600,875),'opening-hud')
                if '剩余' in hud and re.search(r'[0-8]$',hud):break
                time.sleep(.5)
            else:raise RuntimeError('Battle HUD not confirmed after loading')
            pause(True)
            opening=frame('opening-paused')
            if read_pause(opening)[0] is not True:raise RuntimeError('Opening pause not visually confirmed')
            topology=s.analyze(cv2.convertScaleAbs(opening,alpha=2.5),'当前已暂停。输出JSON：blue_gate蓝门位置、red_gate红门位置、air_spawn飞行入口、ground_routes地面连通候选路径、high_ground高台、enemy_total顶部已击杀/总数的分母。不要把生命值当敌人数。不确定写null。','opening-topology',crop=(0,0,1500,820),mode='hybrid')
            log('opening_analysis',paused_verified=True,topology=topology,plan=plan,evidence=str(out/'opening-paused.png'))
        for index,item in enumerate(plan['plan']):
            if index<resume_index:continue
            if item['name']=='维什戴尔' and '琴柳' in result['deployed']:
                saileach_skill(False)
            deploy(item,index,resume and selected and index==resume_index)
        if '琴柳' in result['deployed'] and not result.get('saileach_skill',{}).get('pressed'):
            saileach_skill(True)
        pause(False)
        deployed_image=frame('all-deployed');result['deployment_complete']=True
        def speed_glyph(img):
            hsv=cv2.cvtColor(img[22:70,1350:1450],cv2.COLOR_BGR2HSV)
            return (hsv[:,:,2]>205)&(hsv[:,:,1]<70)
        current_glyph=speed_glyph(deployed_image);one_glyph=speed_glyph(ref.reference('battle-ready.png'))
        one_similarity=float(2*np.logical_and(current_glyph,one_glyph).sum()/max(1,current_glyph.sum()+one_glyph.sum()))
        log('speed_glyph',one_similarity=one_similarity)
        speed=s.ocr(deployed_image,(1320,12,1460,90),'speed') if one_similarity<.94 else '1X'
        if '1X' in speed.upper():
            native.tap_f();time.sleep(.2);frame('speed2');log('speed_requested',value=2)
        # Wait for result; every semantic observation still calls the local model.
        until=time.perf_counter()+180
        while time.perf_counter()<until:
            time.sleep(5);image=frame('latest')
            title=s.ocr(image,(0,130,600,600),'result-title',scale=1)
            if not any(marker in title.upper() for marker in ('行动结','任务失败','MISSIONRESULTS')):continue
            observed=s.analyze(image,'判断是否已通关结算。输出JSON：stage画面显示关卡编号或null，phase（battle/result/unknown）,victory（true/false/null）,stars（0到3整数或null）,enemy_total总敌人数或null。只有出现行动结束或任务失败结算才为result，不要把已部署干员当结算。','outcome',mode='vlm')
            if observed.get('phase')=='result':
                result['raw_outcome']=dict(observed)
                if not isinstance(observed.get('stage'),str) or not re.fullmatch(r'\d{1,2}-\d{1,2}',observed['stage']):
                    stage_text=s.ocr(frame(),(0,150,420,290),'settlement-stage',scale=2)
                    recovered_stage=result_stage_from_text(stage_text)
                    log('settlement_stage_ocr',text=stage_text,stage=recovered_stage)
                    if recovered_stage:observed=dict(observed,stage=recovered_stage,stage_source='current settlement OCR')
                # The title appears before the badge lighting animation ends.
                # Reobserve after model inference and require a stable count.
                stars=lit_result_badges(frame('settlement-badges-first'))
                time.sleep(.7)
                image=frame('result');stable_stars=lit_result_badges(image)
                if stars!=stable_stars:
                    log('settlement_animation_pending',first=stars,second=stable_stars)
                    continue
                result['outcome']=observed;result['lit_badges']=stars
                result['ok']=observed.get('victory') is True and observed.get('stage')==args.stage and stars in (1,2,3)
                log('settlement_badges',count=stars,model=observed,verified_win=result['ok']);break
        if not result['ok']:result['error']='No locally confirmed victory before deadline'
    except Exception as e:
        result['error']=str(e);log('failure',error=str(e))
        try:
            pause(True)
            log('failure_hold',paused_verified=True)
        except Exception as hold_error:log('failure_hold_unavailable',error=str(hold_error))
        try:frame('failure')
        except Exception:pass
    finally:
        native.release();screen.close();result['paused_on_exit']=paused
        (out/'summary.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(result,ensure_ascii=False),flush=True)
        reload_marker=ROOT/'runtime/vlm/controller/reload-after-0-8.json'
        if args.stage=='0-8' and result.get('ok') and reload_marker.exists():
            with (ROOT/'runtime/vlm/controller/reload.log').open('w') as reload_log:
                subprocess.Popen([sys.executable,str(ROOT/'scripts/reload-arknights-controller.py')],cwd=ROOT,stdout=reload_log,stderr=subprocess.STDOUT,creationflags=subprocess.CREATE_NO_WINDOW)
if __name__=='__main__':main()
