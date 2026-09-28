"""Current-preview colored portal candidates; color is not route or air-unit proof."""
import cv2,numpy as np

def portal_candidates(image):
    crop=cv2.resize(image,(1600,1024))[210:820,260:1340].astype(np.float32)
    b,g,r=cv2.split(crop);result={}
    masks={'blue':(b>100)&(g>70)&(b>1.4*r)&(g>1.3*r),'red':(r>90)&(r>1.7*g)&(r>1.4*b)}
    for name,mask in masks.items():
        closed=cv2.morphologyEx(mask.astype(np.uint8),cv2.MORPH_CLOSE,np.ones((7,7),np.uint8))
        contours,_=cv2.findContours(closed,cv2.RETR_EXTERNAL,cv2.CHAIN_APPROX_SIMPLE)
        boxes=[]
        for contour in contours:
            x,y,w,h=cv2.boundingRect(contour)
            if cv2.contourArea(contour)<500 or not 50<=w<=230 or not 45<=h<=230:continue
            boxes.append((x,y,w,h))
        # Scenery can split one gate outline into overlapping component boxes.
        merged=[]
        while boxes:
            x,y,w,h=boxes.pop(0)
            changed=True
            while changed:
                changed=False
                for index,(a,b,c,d) in enumerate(boxes):
                    if min(x+w,a+c)>max(x,a) and min(y+h,b+d)>max(y,b):
                        right=max(x+w,a+c);bottom=max(y+h,b+d)
                        x,y=min(x,a),min(y,b);w,h=right-x,bottom-y
                        boxes.pop(index);changed=True;break
            merged.append((x,y,w,h))
        items=[]
        for x,y,w,h in merged:
            horizontal=['左','中','右'][min(2,int((x+w/2)/1080*3))]
            vertical=['上','中','下'][min(2,int((y+h/2)/610*3))]
            items.append({'position':horizontal+vertical,'box':[x+260,y+210,w,h],'color_only':True})
        result[name]=sorted(items,key=lambda item:(item['box'][1],item['box'][0]))
    return result
