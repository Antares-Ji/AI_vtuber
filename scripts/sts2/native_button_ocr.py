"""Ground uniquely observed navigation button labels at their OCR text centers."""
from native_selection_ocr import usable_lines,text_key
import re

BUTTONS={'继续','返回','返回主菜单','开始游戏','单人游戏','单人模式','标准模式','新游戏','继续游戏','开始','确认','跳过','完成','解锁','关闭'}

def chapter_story(parsed,ocr):
    lines=usable_lines(ocr)
    header=any(re.fullmatch(r'第[0-9一二三四五六七八九十]+章[-—－]开放',label) for label,_,_ in lines)
    ending=any(label.rstrip('!！。.') in ('败北','胜利','你被击败了') for label,_,_ in lines)
    if parsed.get('scene')=='terminal' and header and not ending:
        return {**parsed,'scene':'event','summary':'章节开放剧情页，尚非冒险胜负结算','scene_source':'local_ocr_chapter_header'}
    return parsed

def ground_buttons(parsed,ocr):
    lines=usable_lines(ocr);targets=[]
    for target in parsed.get('targets',[]):
        label=text_key(target.get('label'))
        matches=[(x,y) for text,x,y in lines if text==label]
        point=target.get('point');matched=len(matches)==1 and isinstance(point,list) and len(point)==2 and all(type(n) in (int,float) for n in point) and abs(point[0]-matches[0][0])<=80 and abs(point[1]-matches[0][1])<=80
        if label not in BUTTONS and not matched:
            targets.append(target);continue
        targets.append({**target,'enabled':target.get('enabled',True) and matched,'button_ocr_checked':matched,
                        **({'point':list(matches[0]),'visual_point':point,'point_source':'local_ocr_text_center'} if matched else {})})
    return {**parsed,'targets':targets}
