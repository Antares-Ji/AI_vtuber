"""Geometry candidates only, never asserted complete or clickable."""
import sys,json
import cv2
import numpy as np
im=cv2.imdecode(np.fromfile(sys.argv[1],np.uint8),1)
if im is None:raise ValueError('Invalid image')
h,w=im.shape[:2]
gray=cv2.cvtColor(im,cv2.COLOR_BGR2GRAY)
contours,_=cv2.findContours(cv2.Canny(gray,60,150),cv2.RETR_LIST,cv2.CHAIN_APPROX_SIMPLE)
boxes=[]
for contour in contours:
    x,y,bw,bh=cv2.boundingRect(contour)
    poly=cv2.approxPolyDP(contour,.025*cv2.arcLength(contour,True),True)
    if not (4<=len(poly)<=8 and 40<=bw<=w*.65 and 20<=bh<=min(150,h*.2) and bw*bh>=1500):continue
    if abs(cv2.contourArea(contour))/(bw*bh)<.65:continue
    if any(abs(x-b['x'])+abs(y-b['y'])+abs(bw-b['w'])+abs(bh-b['h'])<20 for b in boxes):continue
    boxes.append(dict(x=x,y=y,w=bw,h=bh,label='矩形控件候选',uncertain=True))
# Remove inner icon/knob rectangles already covered by a larger candidate.
boxes=[b for b in boxes if not any(p is not b and p['x']<=b['x']+2 and p['y']<=b['y']+2 and p['x']+p['w']>=b['x']+b['w']-2 and p['y']+p['h']>=b['y']+b['h']-2 and p['w']*p['h']>b['w']*b['h']*1.4 for p in boxes)]
boxes=sorted(boxes,key=lambda b:(b['y'],b['x']))[:80]
for i,b in enumerate(boxes):b['id']=i+1
print(json.dumps(dict(width=w,height=h,boxes=boxes),ensure_ascii=True))
