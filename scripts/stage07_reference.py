"""Reproject reviewed 0-7 drop points onto current selected-operator frames."""
from pathlib import Path
import json,cv2,numpy as np
ROOT=Path(__file__).resolve().parents[1]
BANK=ROOT/'data/vision/deployment-references/0-7'

def align(image,name):
    meta=json.loads((BANK/'selected-targets.json').read_text(encoding='utf8'))
    entry=meta[name];source=cv2.imdecode(np.fromfile(BANK/entry['image'],dtype=np.uint8),cv2.IMREAD_COLOR)
    if source is None or image.shape!=source.shape:raise RuntimeError('Reference image dimensions differ')
    mask=np.zeros(image.shape[:2],np.uint8);mask[170:820,520:1460]=255
    mask[415:580,560:1040]=0
    orb=cv2.ORB_create(nfeatures=3500)
    a,da=orb.detectAndCompute(cv2.cvtColor(source,cv2.COLOR_BGR2GRAY),mask)
    b,db=orb.detectAndCompute(cv2.cvtColor(image,cv2.COLOR_BGR2GRAY),mask)
    if da is None or db is None:raise RuntimeError('No current map features')
    matches=[pair[0] for pair in cv2.BFMatcher(cv2.NORM_HAMMING).knnMatch(da,db,k=2) if len(pair)==2 and pair[0].distance<.72*pair[1].distance]
    if len(matches)<25:raise RuntimeError('Insufficient same-stage matches')
    src=np.float32([a[m.queryIdx].pt for m in matches]);dst=np.float32([b[m.trainIdx].pt for m in matches])
    h,inliers=cv2.findHomography(src,dst,cv2.RANSAC,3)
    if h is None or int(inliers.sum())<25 or float(inliers.mean())<.45:raise RuntimeError('Unreliable map transform')
    old=np.array(entry['point'])*[1600,1024]
    new=cv2.perspectiveTransform(np.float32([[old]]),h)[0,0]
    if not np.isfinite(new).all() or np.linalg.norm(new-old)>180:raise RuntimeError('Map transform too large')
    x,y=map(int,new);patch=image[max(0,y-6):y+7,max(0,x-6):x+7].astype(float)
    if patch.size==0:raise RuntimeError('Empty target patch')
    bb,gg,rr=patch.mean(axis=(0,1))
    if not (gg>rr*1.15 and gg>bb*1.05 and gg>18):raise RuntimeError('Reprojected cell is not currently green')
    return dict(point=[float(new[0]/1600),float(new[1]/1024)],inliers=int(inliers.sum()),matches=len(matches),source=entry['image'])
