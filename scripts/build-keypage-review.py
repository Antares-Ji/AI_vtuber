"""Continuous-frame evidence -> scroll groups -> key pages -> OCR/edit bundle.

This calibration is for this recording, not a general game UI recognizer.
"""
import argparse, json, re, subprocess, hashlib
from pathlib import Path
import cv2
import numpy as np

BASE=Path(__file__).resolve().parent.parent
NAMES=['游戏','声音','提醒','按键']
IDS={'游戏':'game','声音':'sound','提醒':'alerts','按键':'keys'}
ROI=(335,125,1145,710)

def read_image(path):
    im=cv2.imdecode(np.fromfile(path,np.uint8),cv2.IMREAD_COLOR)
    if im is None:raise ValueError(str(path))
    return im

def translation(a,b):
    """Text/edge features at the same horizontal positions, robust vertical vote."""
    orb=cv2.ORB_create(nfeatures=4000,fastThreshold=12)
    ga,gb=[cv2.cvtColor(x,cv2.COLOR_BGR2GRAY) for x in (a,b)]
    ka,da=orb.detectAndCompute(ga,None);kb,db=orb.detectAndCompute(gb,None)
    if da is None or db is None or len(db)<2:return None
    matches=cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(da,db,k=2)
    votes=[]
    for pair in matches:
        if len(pair)!=2 or pair[0].distance>=.65*pair[1].distance:continue
        m=pair[0];ax,ay=ka[m.queryIdx].pt;bx,by=kb[m.trainIdx].pt
        if abs(ax-bx)<2 and abs(ay-by)<a.shape[0]*.8:votes.append((ay-by,ax,ay))
    if len(votes)<20:return None
    v=np.array(votes);counts=[np.sum(abs(v[:,0]-dy)<2) for dy in v[:,0]]
    support=v[abs(v[:,0]-v[np.argmax(counts),0])<2]
    if len(support)<20 or len(support)<.5*len(v) or np.ptp(support[:,1])<a.shape[1]*.25:return None
    return {'dy':int(round(np.median(support[:,0]))),'support':len(support),'ratio':round(len(support)/len(v),3)}

def groups(indices,gap=15):
    out=[]
    for i in indices:
        if not out or i-out[-1][-1]>gap:out.append([])
        out[-1].append(i)
    return out

def ocr_image(root,file):
    digest=hashlib.sha256((root/file).read_bytes()).hexdigest()[:16]
    cache=root/'ocr'/('key-'+Path(file).stem+'-'+digest+'.json')
    if cache.exists():return json.loads(cache.read_text(encoding='utf-8'))
    result=subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(BASE/'src/vision/windows-ocr.ps1'),'-ImagePath',str((root/file).resolve())],capture_output=True,timeout=30)
    if result.returncode:raise RuntimeError(result.stderr.decode('utf-8',errors='replace')[-500:])
    data=json.loads(result.stdout.decode('utf-8-sig'));cache.write_text(json.dumps(data,ensure_ascii=False),encoding='utf-8');return data

def boxes_for(root,file):
    ocr=ocr_image(root,file);image=read_image(root/file);height,width=image.shape[:2]
    boxes=[];lines=[]
    for line in ocr['lines']:
        words=line['words']
        if not words:continue
        x=min(w['x'] for w in words);y=min(w['y'] for w in words)
        w=max(t['x']+t['width'] for t in words)-x;h=max(t['y']+t['height'] for t in words)-y
        label=re.sub(r'(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])','',line['text'])
        box=dict(x=x,y=y,w=w,h=h,label=label,note='',target='',kind='文字',verified=False)
        boxes.append(box);lines.append(box)
    # Geometric controls are separate from OCR text regions; link left-hand captions.
    edges=cv2.Canny(cv2.cvtColor(image,cv2.COLOR_BGR2GRAY),60,150)
    contours,_=cv2.findContours(edges,cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
    controls=[]
    for c in contours:
        x,y,w,h=cv2.boundingRect(c)
        if not(28<=w<=400 and 22<=h<=85) or cv2.contourArea(c)<w*h*.65:continue
        if any(abs(x-b['x'])+abs(y-b['y'])+abs(w-b['w'])+abs(h-b['h'])<22 for b in controls):continue
        inside=[t for t in lines if x<=t['x']+t['w']/2<=x+w and y<=t['y']+t['h']/2<=y+h]
        left=[t for t in lines if t['x']+t['w']<min(x,width*.5) and abs(t['y']+t['h']/2-y-h/2)<18]
        context=min(left,key=lambda t:abs(t['y']+t['h']/2-y-h/2),default=None)
        label=' · '.join(([context['label']] if context else [])+[t['label'] for t in inside]) or '未识别文字的控件候选'
        controls.append(dict(x=x,y=y,w=w,h=h,label=label,note='轮廓推断，请审核交互性与边界',target='',kind='按钮候选',verified=False))
    # Thin horizontal slider tracks are not rectangular buttons.
    tracks=cv2.HoughLinesP(edges,1,np.pi/180,threshold=80,minLineLength=170,maxLineGap=5)
    for line in np.asarray(tracks).reshape(-1,4) if tracks is not None else []:
        x1,y1,x2,y2=map(int,line);x1,x2=min(x1,x2),max(x1,x2)
        if abs(y1-y2)>1 or x1<width*.43 or x2-x1>400:continue
        if any(abs(y1-b['y']-b['h']/2)<15 and b['kind']=='滑条候选' for b in controls):continue
        left=[t for t in lines if t['x']+t['w']<x1 and abs(t['y']+t['h']/2-y1)<20]
        if not left:continue
        t=min(left,key=lambda t:abs(t['y']+t['h']/2-y1))
        controls.append(dict(x=max(0,x1-15),y=max(0,y1-18),w=min(width-x1+15,x2-x1+30),h=min(36,height-max(0,y1-18)),label=t['label'],note='水平轨道候选；拖动行为请对照动作证据',target='',kind='滑条候选',verified=False))
    controls=[b for b in controls if not any(c is not b and c['x']<=b['x'] and c['y']<=b['y'] and c['x']+c['w']>=b['x']+b['w'] and c['y']+c['h']>=b['y']+b['h'] and c['w']*c['h']>b['w']*b['h']*1.25 for c in controls)]
    if width==1280 and height==720:
        known=[(132,55,88,32,'返回主界面','home'),(996,57,158,31,'重置设置','重置设置（需确认，未执行）')]
        known += [(132,137+j*70,150,60,name,IDS[name]) for j,name in enumerate(NAMES)]
        known += [(132,454,150,62,'用户中心','用户中心（未确认进入）')]
        for x,y,w,h,label,target in known:
            controls=[b for b in controls if not(x<=b['x']+b['w']/2<=x+w and y<=b['y']+b['h']/2<=y+h)]
            controls.append(dict(x=x,y=y,w=w,h=h,label=label,target=target,note='用户说明并经画面核对的固定入口；目标待审',kind='按钮候选',verified=False))
    for i,b in enumerate(boxes+controls):b['id']=i+1
    return boxes+controls

def build(root):
    timeline=json.loads((root/'timeline.json').read_text(encoding='utf-8'));rows=timeline['frames'];n=len(rows)
    (root/'derived').mkdir(exist_ok=True);(root/'ocr').mkdir(exist_ok=True)
    def image(i):return read_image(root/rows[i]['file'])
    # Unknown runs enclosed by the same recognized tab retain context, not a new page.
    pages=[r['pageCandidate'] for r in rows]
    for group in groups([i for i,p in enumerate(pages) if p=='未确定界面'],gap=1):
        a,b=group[0],group[-1]
        if a>0 and b+1<n and pages[a-1]==pages[b+1]:
            for i in group:pages[i]=pages[a-1]
    actions_cache=root/'actions-v2.json'
    if actions_cache.exists():actions=json.loads(actions_cache.read_text(encoding='utf-8'))['frames']
    else:
        template=cv2.Canny(cv2.cvtColor(cv2.resize(image(1200),(640,360)),cv2.COLOR_BGR2GRAY),70,160)[178:203,440:462].copy()
        cap=cv2.VideoCapture(timeline['source']);actions=[]
        for i in range(n):
            ok,frame=cap.read()
            if not ok:raise RuntimeError('Second decode ended early')
            edge=cv2.Canny(cv2.cvtColor(cv2.resize(frame,(640,360)),cv2.COLOR_BGR2GRAY),70,160)
            matched=cv2.matchTemplate(edge,template,cv2.TM_CCOEFF_NORMED)
            _,score,_,point=cv2.minMaxLoc(matched)
            cursor={'x':point[0]*2,'y':point[1]*2,'score':round(score,3)} if score>.55 else None
            r=rows[i]
            actions.append(dict(index=i,timeMs=r['timeMs'],page=pages[i],cursorCandidate=cursor,
                event=r['eventCandidate'],shift=r['rightShift'],shiftResponse=r['shiftResponse'],inputVerified=False))
            if i%500==0:print(f'Continuous action pass {i}/{n}',flush=True)
        cap.release();actions_cache.write_text(json.dumps({'frames':actions},ensure_ascii=False),encoding='utf-8')
    scroll_groups=groups([r['index'] for r in rows if r['eventCandidate']=='右侧垂直滚动候选'])
    events=[];candidates={p:set() for p in NAMES}
    for p in NAMES:
        inds=[i for i in range(n) if pages[i]==p]
        if inds:
            # Choose stable page reference, not transient animation.
            candidates[p].add(min(inds,key=lambda i:rows[i]['rightChangedFraction'] if rows[i]['rightChangedFraction'] is not None else 1))
    for g in scroll_groups:
        a,b=g[0],g[-1];p=pages[a]
        if p not in candidates:continue
        before=max(0,a-2);after=min(n-1,b+8)
        if pages[before]!=p or pages[after]!=p:continue
        candidates[p].update([before,after])
        # Bridge even a full viewport displacement with overlapping intermediate frames.
        # These are stitch evidence, not independent UI nodes.
        candidates[p].update(range(before,after+1,2))
        events.append(dict(kind='滚动候选',page=p,fromFrame=before,toFrame=after,verified=False,evidence='连续帧右侧出现一致垂直位移；不等同于已记录滚轮输入'))
    nodes=[];stitch_records=[]
    x0,y0,x1,y1=ROI
    for p in NAMES:
        refs=sorted(candidates[p]);placements=[]
        for i in refs:
            crop=image(i)[y0:y1,x0:x1];best=None
            for prior in reversed(placements):
                match=translation(prior['image'],crop)
                if match:
                    best={'frame':i,'offset':prior['offset']+match['dy'],'image':crop,'match':match,'against':prior['frame']};break
            if not placements:best={'frame':i,'offset':0,'image':crop,'match':None}
            if best:placements.append(best)
            else:stitch_records.append(dict(page=p,frame=i,status='overlap-unproven-kept-as-evidence'))
        if not placements:continue
        low=min(r['offset'] for r in placements);high=max(r['offset'] for r in placements)
        is_scroll=high-low>50
        ref=placements[0]['frame']
        if is_scroll:
            h=y1-y0
            first=min([r for r in placements if r['offset']==low],key=lambda r:rows[r['frame']]['rightChangedFraction'] or 0)
            chosen=[first];end=low+h
            while end<high+h:
                options=[r for r in placements if chosen[-1]['offset']<r['offset']<=end-100 and r['offset']+h>end]
                if not options:raise RuntimeError('No verified overlapping bridge for mosaic')
                furthest=max(r['offset'] for r in options)
                nxt=min([r for r in options if r['offset']>=furthest-3],key=lambda r:rows[r['frame']]['rightChangedFraction'] or 0)
                chosen.append(nxt);end=nxt['offset']+h
            canvas=np.zeros((high-low+h,x1-x0,3),np.uint8);canvas[:h]=first['image'];end=h
            used=[dict(frame=first['frame'],offset=0,match=first['match'])]
            for r in chosen[1:]:
                start=r['offset']-low;overlap=end-start
                a=cv2.cvtColor(canvas[start:end],cv2.COLOR_BGR2GRAY)
                b=cv2.cvtColor(r['image'][:overlap],cv2.COLOR_BGR2GRAY)
                # Pick a quiet seam inside the overlap, away from text/button edges.
                costs=(np.abs(np.diff(a.astype(float),axis=0)).mean(axis=1)+np.abs(np.diff(b.astype(float),axis=0)).mean(axis=1))
                margin=min(25,overlap//4);seam=margin+int(np.argmin(costs[margin:len(costs)-margin]))
                canvas[start+seam:start+h]=r['image'][seam:];end=start+h
                used.append(dict(frame=r['frame'],offset=start,seamY=start+seam,match=r['match']))
            file=f'derived/{IDS[p]}-scroll.png';cv2.imencode('.png',canvas)[1].tofile(root/file)
            stitch_records.append(dict(page=p,status='feature-overlap-mosaic',pieces=used,coverage='仅录像展示范围，控件状态来自不同时刻'))
        else:file=rows[ref]['file'];canvas=image(ref)
        node=dict(id=IDS[p],label=p+'设置',page=p,file=file,width=canvas.shape[1],height=canvas.shape[0],referenceFrame=ref,
            kind='滚动拼接图' if is_scroll else '独立截图',parent='settings',entry=p,sourceFrames=refs,
            coverage='已录制可见范围；不声称覆盖未展示内容',boxes=boxes_for(root,file))
        nodes.append(node);print(f'Key page {p}: {node["kind"]}, {len(node["boxes"])} OCR/control boxes',flush=True)
    # Navigation evidence is temporal tab transition + cursor near its entry, not a fabricated click log.
    edges=[]
    for target,p in enumerate(NAMES):
        runs=groups([i for i in range(n) if pages[i]==p],gap=1)
        run=max(runs,key=len) if runs else []
        if not run:continue
        start=run[0];rect=(132,137+target*70,282,197+target*70)
        cursors=[a for a in actions[max(0,start-30):start+5] if a['cursorCandidate'] and rect[0]-15<=a['cursorCandidate']['x']<=rect[2] and rect[1]-15<=a['cursorCandidate']['y']<=rect[3]]
        edge=dict(source='settings',target=IDS[p],label='左侧：'+p,kind='点击进入候选',verified=False,frame=start,
            evidence='选中项及右侧内容改变；'+('指针候选位于该入口附近' if cursors else '该时段指针证据不足，点击待确认'))
        edges.append(edge)
    # Explicit visual-review evidence for this exact recording; not automatic click telemetry.
    if root.name=='settings-20260910-005141':
        observed={'game':(172,250,164),'sound':(1474,212,230),'alerts':(2113,226,324),'keys':(2375,198,367)}
        for e in edges:
            f,x,y=observed[e['target']]
            e.update(frame=f,visualReview={'frame':f,'cursorTipApprox':[x,y],'source':'assistant-inspected-original-frame'},
                evidence=f'原图帧 {f} 已目视核对：机械手指针在该入口，选中项及右侧页面已改变。结合连续帧推断点击进入；真实按压时刻仍未证实。')
    bundle=dict(version=2,recording=root.name,decodedFrames=n,expectedFrames=timeline['expectedFrames'],complete=timeline['complete'],
        warning='先动作分段、再归并关键图。OCR与交互框待审核；原视频无法证明物理按压。标称2831帧，实际解码2830帧。',
        hierarchy={'主界面':{'设置':['游戏','声音','提醒','按键','用户中心（未确认进入）']}},nodes=nodes,edges=edges,events=events,stitches=stitch_records,
        frames=[dict(index=i,file=r['file'],timeMs=r['timeMs'],page=pages[i],event=r['eventCandidate']) for i,r in enumerate(rows)])
    (root/'bundle.json').write_text(json.dumps(bundle,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({'keyPages':len(nodes),'scrollEvents':len(events),'cursorFrames':sum(a['cursorCandidate'] is not None for a in actions)},ensure_ascii=True))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('root',type=Path);build(p.parse_args().root)
