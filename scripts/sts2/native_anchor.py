"""Mark the existing API pointer for visual membership validation, not planning."""
import math


def anchor_geometry(anchor, crop_bounds, original):
    if not isinstance(anchor, dict) or not isinstance(anchor.get('cardName'), str) or not 1 <= len(anchor['cardName']) <= 100:
        raise ValueError('Named pointer anchor required')
    point=anchor.get('point')
    if not isinstance(point,list) or len(point)!=2 or any(type(n) not in (int,float) or not math.isfinite(n) or not 0<=n<=1 for n in point):
        raise ValueError('Bounded pointer anchor required')
    left,top,right,bottom=crop_bounds
    x=(point[0]*original[0]-left)/(right-left)
    y=(point[1]*original[1]-top)/(bottom-top)
    if not 0<=x<=1 or not 0<=y<=1:
        raise ValueError('Pointer anchor outside crop')
    return [x,y]


def annotate_anchor(image, point):
    from PIL import ImageDraw
    image=image.copy();draw=ImageDraw.Draw(image)
    x,y=point[0]*image.width,point[1]*image.height
    draw.ellipse((x-7,y-7,x+7,y+7),outline='#00ffff',width=2)
    draw.line((x-10,y,x+10,y),fill='#00ffff',width=1)
    draw.line((x,y-10,x,y+10),fill='#00ffff',width=1)
    draw.text((x+10,y-14),'A',fill='#00ffff',stroke_width=1,stroke_fill='black')
    return image


def anchor_result(parsed, anchor, relative):
    confirmed=isinstance(parsed,dict) and parsed.get('anchor_inside') is True and parsed.get('card_name')==anchor['cardName']
    return {'target_visible':confirmed,'target_point':[n*1000 for n in relative] if confirmed else None,
            'anchor_confirmed':confirmed,'anchor_card_name':anchor['cardName'] if confirmed else None}
