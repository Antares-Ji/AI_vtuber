"""Small, auditable parsers for observed operator UI. No input execution."""
import re
import cv2
import numpy as np

def recovery_kind(text):
    text=re.sub(r'\s+','',text or '')
    if not re.search(r'(回复|获得).{0,8}(?:点)?部署费[用費]?',text):
        return {'kind':'none_or_unknown','evidence':text}
    if '每次攻击' in text or '下次攻击' in text or '造成伤害' in text:
        kind='on_hit'
    elif '击杀' in text:kind='on_kill'
    elif '持续时间内回复' in text:kind='over_time'
    elif '立即回复' in text:kind='immediate'
    else:kind='conditional_unknown'
    return {'kind':kind,'evidence':text,'stops_attacking':'停止攻击' in text}

def selected_skill_box(frame):
    b,g,r=cv2.split(frame[:,:410].astype(np.float32))
    mask=((b>200)&(g>120)&(r<110)).astype(np.uint8)*255;mask[:400]=0
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    boxes=[cv2.boundingRect(c) for c in contours]
    boxes=[(0,y,410,min(frame.shape[0],y+h+3)) for x,y,w,h in boxes if w>300 and h>60]
    return boxes[0] if len(boxes)==1 else None

def range_grid(image):
    gray=cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)[:68]
    mask=(gray>150).astype(np.uint8)*255
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    cells=[]
    for contour in contours:
        x,y,w,h=cv2.boundingRect(contour)
        if 7<=w<=20 and 7<=h<=20 and .7<w/h<1.4:
            cells.append((x+w/2,y+h/2,w,h,float((mask[y:y+h,x:x+w]>0).mean())))
    origins=[c for c in cells if c[4]>.85]
    if len(origins)!=1:return {'verified':False,'reason':'Cannot uniquely locate solid origin square'}
    origin=origins[0]
    if len(cells)==1:return {'verified':False,'candidate_offsets':[[0,0]],'orientation':'right','source':'UI base range diagram'}
    differences=[]
    for axis in (0,1):
        groups=[]
        for value in sorted(c[axis] for c in cells):
            if groups and abs(value-np.mean(groups[-1]))<3:groups[-1].append(value)
            else:groups.append([value])
        centers=[float(np.mean(g)) for g in groups]
        differences.extend(b-a for a,b in zip(centers,centers[1:]))
    step=float(np.median(differences));offsets=[]
    for c in cells:
        dx,dy=(c[0]-origin[0])/step,(c[1]-origin[1])/step
        if max(abs(dx-round(dx)),abs(dy-round(dy)))>.2:
            return {'verified':False,'reason':'Squares do not align to a regular grid'}
        offsets.append([round(dx),round(dy)])
    return {'verified':False,'candidate_offsets':sorted(offsets,key=lambda p:(p[1],p[0])),
        'orientation':'right','source':'UI base range diagram; skill range changes require separate observation'}
