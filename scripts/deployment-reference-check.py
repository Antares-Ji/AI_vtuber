"""Local evidence matching for the witnessed 0-1 deployment, no mouse input."""
import argparse,json,sys,time
from functools import lru_cache
from pathlib import Path
import cv2
import numpy as np
ROOT=Path(__file__).resolve().parents[1]
REF=ROOT/'data/vision/deployment-references/0-1'

def read(path):
    im=cv2.imread(str(path))
    if im is None: raise ValueError('Missing image')
    return im if im.shape[:2]==(1024,1600) else cv2.resize(im,(1600,1024))

@lru_cache(maxsize=16)
def _reference_cached(name,mtime):
    return read(REF/name)

def reference(name):
    return _reference_cached(name,(REF/name).stat().st_mtime_ns)

@lru_cache(maxsize=4)
def _map_features(mtime,scale=1,name='selected.png'):
    mask=np.zeros((int(1024*scale),int(1600*scale)),np.uint8)
    mask[int(230*scale):int(730*scale),int(560*scale):int(1450*scale)]=255
    orb=cv2.ORB_create(nfeatures=1000 if scale<1 else 2000)
    image=reference(name)
    if scale<1:image=cv2.resize(image,(mask.shape[1],mask.shape[0]),interpolation=cv2.INTER_AREA)
    keypoints,descriptors=orb.detectAndCompute(image,mask)
    return orb,mask,keypoints,descriptors

def inspect(image,kind):
    return inspect_frame(read(image),kind)

def inspect_frame(current,kind):
    if current.shape[:2]!=(1024,1600):current=cv2.resize(current,(1600,1024))
    if kind=='profile':
        b,g,r=cv2.split(current[440:505,:550].astype(np.float32))
        blue=(b>150)&(b>r*1.5)&(g>80)&(g<210)
        span=int(blue.sum(axis=1).max())
        return {'ok':span>300,'blue_hp_line_pixels':span}
    if kind=='battle-card':
        template=reference('battle-ready.png')[921:1009,20:100]
        patch=current[921:1009,20:100]
        score=float(cv2.matchTemplate(cv2.cvtColor(patch,cv2.COLOR_BGR2GRAY),cv2.cvtColor(template,cv2.COLOR_BGR2GRAY),cv2.TM_CCOEFF_NORMED)[0,0])
        brightness=float(patch.mean()/max(1,template.mean()))
        color_error=float(np.abs(patch.astype(float)-template).mean())
        def digit(im):return cv2.cvtColor(im[824:857,1556:1595],cv2.COLOR_BGR2GRAY).astype(float)
        counter_error=float(np.abs(digit(current)-digit(reference('battle-ready.png'))).mean())
        # The counter's backdrop pulses independently of card affordability.
        # Keep its error as telemetry; the caller confirms this portrait with
        # trained card YOLO, and separately verifies 8->7 after the gesture.
        visible=score>.80
        return {'ok':visible,'portrait_visible':visible,'ready':score>.93 and brightness>.90 and color_error<18,'score':score,'brightness':brightness,'color_error':color_error,'counter_error':counter_error,'target_point':[.04,.932]}
    if kind=='result':
        # The result-page title must actually be present, not just named by VLM.
        def title(im):
            hsv=cv2.cvtColor(im[305:389,68:540],cv2.COLOR_BGR2HSV)
            return (hsv[:,:,2]>220)&(hsv[:,:,1]<70)
        expected=title(reference('result.png'));observed=title(current)
        positive=float(observed[expected].mean());negative=float(observed[~expected].mean())
        return {'ok':positive>.88 and negative<.16,'title_recall':positive,'background_white':negative}
    if kind=='stage-select':
        template=cv2.cvtColor(reference('stage-select.png')[462:518,700:876],cv2.COLOR_BGR2GRAY)
        roi=cv2.cvtColor(current[380:630,620:1030],cv2.COLOR_BGR2GRAY)
        _,score,_,point=cv2.minMaxLoc(cv2.matchTemplate(roi,template,cv2.TM_CCOEFF_NORMED))
        return {'ok':score>.85,'score':score,'target_point':[(620+point[0]+88)/1600,(380+point[1]+28)/1024]}
    if kind in ('tile','fast-tile','multi-tile-2','multi-tile-3','profile-dismiss'):
        name,point={'multi-tile-2':('multi-2-green.png',[.533125,.4716796875]),'multi-tile-3':('multi-3-green.png',[.57625,.43359375]),'profile-dismiss':('skill-ready.png',[.45,.73])}.get(kind,('selected.png',[.675,.425]))
        scale=1 if kind=='tile' else .5
        orb,mask,ka,da=_map_features((REF/name).stat().st_mtime_ns,scale,name)
        image=cv2.resize(current,(800,512),interpolation=cv2.INTER_AREA) if scale<1 else current
        kb,db=orb.detectAndCompute(image,mask)
        if da is None or db is None:return {'ok':False,'reason':'no_features'}
        pairs=cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(da,db,k=2)
        matches=[m for pair in pairs if len(pair)==2 for m,n in [pair] if m.distance < .7*n.distance]
        if len(matches)<20:return {'ok':False,'reason':'insufficient_map_matches'}
        a=np.float32([ka[m.queryIdx].pt for m in matches]);b=np.float32([kb[m.trainIdx].pt for m in matches])
        H,inliers=cv2.findHomography(a,b,cv2.RANSAC,3*scale)
        if H is None or int(inliers.sum())<20:return {'ok':False,'reason':'map_alignment_failed'}
        p=cv2.perspectiveTransform(np.float32([[[point[0]*1600*scale,point[1]*1024*scale]]]),H)[0,0]/scale
        x,y=map(int,p)
        if kind=='profile-dismiss':
            return {'ok':bool(.35*1600<x<.63*1600 and .58*1024<y<.85*1024 and inspect_frame(current,'profile')['ok']),
                'target_point':[float(p[0]/1600),float(p[1]/1024)],'inliers':int(inliers.sum()),'source':'empty platform in reviewed skill-panel frame'}
        min_x=650 if kind in ('multi-tile-2','multi-tile-3') else 800
        if not min_x<x<1450 or not 280<y<650:return {'ok':False,'reason':'unexpected_map_transform'}
        patch=current[y-5:y+6,x-5:x+6].astype(float)
        B,G,R=patch.mean(axis=(0,1))
        green=G>R*1.15 and G>B*1.05
        return {'ok':bool(green),'target_point':[float(p[0]/1600),float(p[1]/1024)],
            'inliers':int(inliers.sum()),'green_bgr':[B,G,R], 'source':'aligned successful local deployment reference'}
    if kind=='direction':
        # A lower-left tile puts two diamond edges outside the old central crop.
        # The operator profile is required to reject result-page white artwork.
        # The red cancel panel can occlude part of the blue profile HP rule.
        if inspect_frame(current,'profile')['blue_hp_line_pixels']<250:
            return {'ok':False,'target_point':None,'source':'operator profile absent'}
        # Deployed operator skill panels also contain a white diamond. Only the
        # pending deployment has a broad solid-red cancellation panel.
        b,g,r=cv2.split(current.astype(np.float32))
        red=((r>90)&(r>1.8*g)&(r>1.5*b)).astype(np.uint8)
        red[:80]=0;red[950:]=0;red[:,:180]=0
        _,_,regions,_=cv2.connectedComponentsWithStats(red)
        if not any(area>4000 and w>50 and h>50 for x,y,w,h,area in regions[1:]):
            return {'ok':False,'target_point':None,'source':'pending deployment cancel panel absent'}
        hsv=cv2.cvtColor(current[100:950,100:1600],cv2.COLOR_BGR2HSV)
        mask=cv2.inRange(hsv,np.array([0,0,205]),np.array([179,70,255]))
        lines=cv2.HoughLinesP(mask,1,np.pi/180,100,minLineLength=200,maxLineGap=25)
        diagonal=[]
        if lines is not None:
            for x1,y1,x2,y2 in np.asarray(lines).reshape(-1,4):
                dx=x2-x1;dy=y2-y1
                if dx and .35<abs(dy/dx)<2:diagonal.append([int(x1)+100,int(y1)+100,int(x2)+100,int(y2)+100])
        positive=sum((y2-y1)/(x2-x1)>0 for x1,y1,x2,y2 in diagonal)
        negative=len(diagonal)-positive
        center=None
        if diagonal:
            xs=[x for x1,y1,x2,y2 in diagonal for x in (x1,x2)];ys=[y for x1,y1,x2,y2 in diagonal for y in (y1,y2)]
            center=[(min(xs)+max(xs))/3200,(min(ys)+max(ys))/2048]
        return {'ok':positive>=2 and negative>=2,'target_point':center,'positive_edges':positive,'negative_edges':negative,'source':'visible white direction diamond edges'}
    if kind=='landed':
        yes=reference('landed.png');no=reference('selected.png')
        # The remaining-deployment digit is witnessed as 7 (yes) versus 8 (no).
        def crop(im):return cv2.cvtColor(im[824:857,1556:1595],cv2.COLOR_BGR2GRAY).astype(float)
        region=crop(current);dy=float(np.abs(region-crop(yes)).mean());dn=float(np.abs(region-crop(no)).mean())
        counter_changed=dy<20 and dn-dy>5
        diamond=inspect_frame(current,'direction')['ok'] if counter_changed else None
        return {'ok':counter_changed and not diamond,'distance_to_7':dy,'distance_to_8':dn,'direction_visible':diamond,
            'source':'same-layout remaining-deployment counter reference, 8 to 7'}
    raise ValueError('Unknown reference check')

def serve():
    for name in ['selected.png','landed.png','stage-select.png','result.png','battle-ready.png']:reference(name)
    _map_features((REF/'selected.png').stat().st_mtime_ns)
    print(json.dumps({'ready':True}),flush=True)
    for line in sys.stdin:
        request={};started=time.perf_counter()
        try:
            request=json.loads(line)
            result=inspect(request['image'],request['kind'])
            response={'id':request['id'],'result':result,'server_ms':(time.perf_counter()-started)*1000}
        except Exception as error:response={'id':request.get('id'),'error':str(error)}
        print(json.dumps(response),flush=True)

if __name__=='__main__':
    if sys.argv[1:]==['--serve']:
        serve();sys.exit(0)
    p=argparse.ArgumentParser();p.add_argument('kind',choices=['tile','fast-tile','multi-tile-2','multi-tile-3','profile','profile-dismiss','direction','landed','result','stage-select','battle-card']);p.add_argument('image');a=p.parse_args()
    print(json.dumps(inspect(a.image,a.kind)))
