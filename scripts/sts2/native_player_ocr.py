"""Corroborate local VLM player readings; never infer a missing value."""
import math
import re

def ocr_lines(ocr):
    """Return validated text and original-image bounds, shared by readers."""
    lines=[]
    for line in (ocr or {}).get('lines',[]):
        if not isinstance(line,dict):continue
        box=line.get('box');score=line.get('confidence')
        if type(score) not in (int,float) or not math.isfinite(score) or not .8<=score<=1:continue
        if not isinstance(box,list) or len(box)!=4:continue
        if any(not isinstance(p,list) or len(p)!=2 or any(type(n) not in (int,float) or not math.isfinite(n) or not 0<=n<=1000 for n in p) for p in box):continue
        if not isinstance(line.get('text'),str):continue
        xs,ys=zip(*box);bounds=(min(xs),min(ys),max(xs),max(ys))
        if bounds[0]>=bounds[2] or bounds[1]>=bounds[3]:continue
        lines.append((re.sub(r'\s+','',line['text']),score,bounds))
    return lines

def corroborate_player(parsed, ocr):
    player=(parsed or {}).get('player') or {}
    result={'hp':None,'max_hp':None,'block':None}
    def number(n):return type(n) is int and 0<=n<=99999
    lines=ocr_lines(ocr)
    # A single slash-containing text line anchors the health row, even if its
    # noisy OCR cannot corroborate the exact fraction. Ambiguity stays unknown.
    anchors=[line for line in lines if re.search(r'\d.*[/／].*\d',line[0])]
    if len(anchors)!=1:return {'player':result,'ocr_check':{'status':'unknown','reason':'ambiguous_or_missing_health_text'}}
    text,score,anchor=anchors[0]
    match=re.fullmatch(r'(\d{1,5})[/／](\d{1,5})',text)
    hp,maximum=player.get('hp'),player.get('max_hp')
    if match and score>=.9 and number(hp) and number(maximum) and maximum>0 and hp<=maximum and (hp,maximum)==tuple(map(int,match.groups())):
        result.update(hp=hp,max_hp=maximum)
    # Shield text is to the left of and vertically aligned with the HP fraction.
    # Buff counters below it and card costs elsewhere cannot corroborate block.
    ax0,ay0,ax1,ay1=anchor
    digits=[]
    for text,score,(x0,y0,x1,y1) in lines:
        overlap=max(0,min(ay1,y1)-max(ay0,y0))
        if re.fullmatch(r'\d{1,5}',text) and score>=.9 and 0<=ax0-x1<=3*(ay1-ay0) and overlap>=.5*min(y1-y0,ay1-ay0):digits.append(int(text))
    block=player.get('block')
    if len(digits)==1 and number(block) and block==digits[0]:result['block']=block
    return {'player':result,'ocr_check':{'status':'corroborated' if all(result[k] is not None for k in result) else 'partial_or_unknown','reason':'independent_text_and_layout_check'}}
