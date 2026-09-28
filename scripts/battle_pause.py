"""Read the actual battle pause control rather than trusting an input history."""
import cv2
import numpy as np

def read_pause(image):
    region=image[25:95,1480:1555].astype(np.int16)
    threshold=max(40,float(region.max())*.6)
    mask=((region.min(axis=2)>threshold)&(region.max(axis=2)-region.min(axis=2)<35)).astype(np.uint8)
    _,_,stats,_=cv2.connectedComponentsWithStats(mask)
    parts=[r.tolist() for r in stats[1:] if r[4]>120 and r[3]>20 and r[2]>7]
    if len(parts)==1 and 28<=parts[0][2]<=44 and 25<=parts[0][3]<=38:return True,parts
    if len(parts)==2 and all(10<=p[2]<=26 and 25<=p[3]<=38 for p in parts):return False,parts
    raise RuntimeError('Pause glyph ambiguous; refusing blind toggle')
