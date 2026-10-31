"""Confirm defeat text and the visible continue target; never decide to retry."""
from native_selection_ocr import usable_lines,text_key
from native_player_ocr import ocr_lines


def corroborate_terminal(parsed,ocr):
    lines=usable_lines(ocr)
    # Zero HP alone is insufficient: some story/victory scenes also show zero.
    defeat=any(label.rstrip('!！。.') in ('离塔顶还有距离啊','败北','你被击败了') for label,_,_ in lines)
    # Large stylized heading has lower OCR confidence than body text. Only
    # accept exact heading + matching VLM scene summary + the zero-HP check.
    defeat=defeat or ('败北' in parsed.get('summary','') and any(
        text_key(text).rstrip('!！。.')=='败北' and score>=.85 and 100<=box[1]<=300 and box[3]<=350
        for text,score,box in ocr_lines(ocr)))
    zero=any(label.startswith('0/') and label[2:].isdigit() and int(label[2:])>0 for label,_,_ in lines)
    targets=[]
    for target in parsed.get('targets',[]):
        label=text_key(target.get('label'))
        continues=[(x,y) for text,x,y in lines if text==label and label in ('继续','解锁','返回主菜单')]
        point=target.get('point')
        match=defeat and zero and len(continues)==1 and isinstance(point,list) and len(point)==2 and all(type(n) in (int,float) for n in point) and abs(point[0]-continues[0][0])<=80 and abs(point[1]-continues[0][1])<=80
        targets.append({**target,'defeat_continue_checked':bool(match),
                        **({'point':list(continues[0]),'visual_point':point,'point_source':'local_ocr_text_center'} if match else {})})
    return {**parsed,'targets':targets,'terminal_outcome':'defeat' if defeat and zero else 'unknown',
            'ocr_check':{'status':'corroborated' if defeat and zero else 'unknown','scope':'terminal_defeat'}}
