"""Separate current enemy health fractions from intent/status numerals."""
import re
from native_player_ocr import ocr_lines

def enemy_health(parsed, ocr):
    targets=parsed['targets'];fractions=[]
    for text,score,bounds in ocr_lines(ocr):
        match=re.fullmatch(r'(\d{1,5})[/／](\d{1,5})',text)
        if score<.9 or not match:continue
        hp,maximum=map(int,match.groups())
        if maximum<=0 or hp>maximum:continue
        x0,y0,x1,y1=bounds
        fractions.append((hp,maximum,((x0+x1)/2,(y0+y1)/2)))
    candidates={}
    for i,target in enumerate(targets):
        if target.get('kind')!='enemy':continue
        x,y=target['point']
        candidates[i]=[j for j,(_,_,(fx,fy)) in enumerate(fractions) if abs(x-fx)<=100 and 0<=fy-y<=200]
    result=[];matched=0
    for i,target in enumerate(targets):
        if i not in candidates:
            result.append(target);continue
        hp=maximum=None;status='unknown'
        available=candidates[i]
        if len(available)==1 and sum(available[0] in values for values in candidates.values())==1:
            hp,maximum,_=fractions[available[0]]
            prior=re.findall(r'(?<!\d)(\d{1,5})[/／](\d{1,5})(?!\d)',target.get('label',''))
            if prior and (len(prior)!=1 or tuple(map(int,prior[0]))!=(hp,maximum)):
                hp=maximum=None;status='conflict'
            else:
                status='corroborated' if prior else 'observed_by_ocr';matched+=1
        # Preserve raw visual wording separately. A number above an enemy is
        # not a health fraction and must not become its canonical HP label.
        health=f'{hp}/{maximum}' if hp is not None else '未知'
        result.append({**target,'label':f"敌人 {target['id']}；当前生命{health}；外观和其他数字见视觉描述",
                       'visual_description':target.get('label',''),
                       'enemy':{'hp':hp,'max_hp':maximum,'health_source':'local_ocr','health_status':status}})
    return {**parsed,'targets':result,'ocr_check':{'status':'grounded' if matched==len(candidates) else 'partial_or_unknown',
            'matched_enemy_health':matched,'reason':'unique_fraction_below_observed_enemy'}}
