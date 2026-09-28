"""Count lit settlement badges only after settlement layout is confirmed."""
import cv2,numpy as np,re

def result_stage_from_text(text):
    normalized=re.sub(r'\s+','',text)
    normalized=re.sub(r'[Oo](?=[-一–—])','0',normalized)
    stages={f'{int(a)}-{int(b)}' for a,b in re.findall(r'(?<![0-9])([0-9]{1,2})[-一–—]([0-9]{1,2})(?![0-9])',normalized) if 1<=int(b)<=99}
    return next(iter(stages)) if len(stages)==1 else None
def lit_result_badges(image):
    b,g,r=cv2.split(image[410:515,65:325].astype(np.float32))
    mask=((b>150)&(g>150)&(b>1.25*r)&(g>1.1*r)).astype(np.uint8)*255
    contours,_=cv2.findContours(mask,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
    badges=[]
    for contour in contours:
        x,y,w,h=cv2.boundingRect(contour)
        if cv2.contourArea(contour)>1000 and 40<=w<=75 and 45<=h<=80:badges.append((x,y,w,h))
    return len(badges) if len(badges)<=3 else None
