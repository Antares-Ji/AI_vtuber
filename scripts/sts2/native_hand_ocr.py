"""Ground partial hand titles in current-frame OCR; never grant playability."""
import re
from functools import lru_cache
from native_player_ocr import ocr_lines

_NON_TITLES={'攻击','技能','能力','格挡','力量','敏捷','能量','消耗','保留','虚无','不可打出','回合结束','结束回合','易伤','虚弱','脆弱'}

def corroborate_hand(parsed, ocr):
    # A status tooltip can cover a card and fool both readers. Do not turn a
    # known UI/status heading into a card target, even if both models agree.
    targets=[t for t in parsed['targets'] if t['card'].get('name') not in _NON_TITLES]
    rejected=len(parsed['targets'])-len(targets)
    titles=[]
    for text,score,(x0,y0,x1,y1) in ocr_lines(ocr):
        if score<.9 or y0<550 or y1>900 or text in _NON_TITLES:continue
        if not re.fullmatch(r'[\u4e00-\u9fffA-Za-z]{2,16}[+＋]?',text):continue
        titles.append((text,[(x0+x1)/2,(y0+y1)/2]))
    distances={}
    for i,target in enumerate(targets):
        x,y=target['point']
        for j,(_,point) in enumerate(titles):
            dx=abs(x-point[0]);dy=y-point[1]
            if dx<=70 and -35<=dy<=180:distances[i,j]=dx+.25*abs(dy)
    # Preserve left-to-right hand order. Independent nearest-neighbour matching
    # confuses adjacent duplicate cards when one model point is off-centre.
    ordered_targets=sorted(range(len(targets)),key=lambda i:targets[i]['point'][0])
    ordered_titles=sorted(range(len(titles)),key=lambda j:titles[j][1][0])
    def assignment(forbidden=None):
        @lru_cache(None)
        def solve(a,b):
            if a==len(ordered_targets) or b==len(ordered_titles):return (0,0,())
            choices=[solve(a+1,b),solve(a,b+1)]
            pair=ordered_targets[a],ordered_titles[b]
            if pair in distances and pair!=forbidden:
                count,cost,pairs=solve(a+1,b+1)
                choices.append((count+1,cost+distances[pair],(pair,)+pairs))
            return min(choices,key=lambda item:(-item[0],item[1]))
        return solve(0,0)
    count,cost,pairs=assignment()
    confirmed={}
    for i,j in pairs:
        alt_count,alt_cost,_=assignment((i,j))
        if alt_count<count or alt_cost-cost>=15:confirmed[i]=j
    result=[];matched=0
    for i,target in enumerate(targets):
        j=confirmed.get(i)
        # An unmatched or ambiguous VLM name remains unknown. OCR titles are
        # data only; no costs, rules, frame authority or actions are inferred.
        name=None;point=target['point']
        if j is not None:
            name,point=titles[j];matched+=1
        result.append({**target,'label':name or '未读清的手牌','point':point,
                       'card':{'name':name,'cost':target['card'].get('cost'),'type':None,'description':None},
                       'name_source':'local_ocr' if name else 'unknown'})
    return {**parsed,'targets':result,'ocr_check':{'status':'corroborated' if matched==len(targets) and not rejected else 'partial_or_unknown',
            'matched_titles':matched,'rejected_status_targets':rejected,'reason':'unique_current_frame_title_association'}}
