"""Recording-specific visual candidates, not a native input log."""
import json
import html
import argparse
from pathlib import Path
import cv2
import numpy as np


def run(root):
    manifest=json.loads((root/'frames.json').read_text(encoding='utf-8'))
    def read(record):
        image=cv2.imdecode(np.fromfile(root/record['file'],dtype=np.uint8),cv2.IMREAD_COLOR)
        if image is None:raise RuntimeError(record['file'])
        return cv2.cvtColor(image,cv2.COLOR_BGR2GRAY)
    reference=read(manifest['frames'][600])
    names=['游戏','声音','提醒','按键']
    rows=[];previous=None;last_page=None;keys=[]
    for rec in manifest['frames']:
        gray=read(rec)
        header_error=float(np.mean(cv2.absdiff(gray[55:87,265:365],reference[55:87,265:365])))
        scores=[float(gray[y:y+50,140:275].mean()) for y in [140,210,280,350]]
        order=np.argsort(scores)
        page=names[order[-1]] if header_error<18 and scores[order[-1]]>135 and scores[order[-1]]-scores[order[-2]]>35 else '未确定界面'
        roi=cv2.resize(gray[140:700,335:1145],(405,280))
        change=None;shift=None;response=None;event='首帧'
        if previous is not None:
            change=float((cv2.absdiff(previous,roi)>22).mean())
            delta,response=cv2.phaseCorrelate(previous.astype(np.float32),roi.astype(np.float32))
            shift=[round(float(x),3) for x in delta]
            event='稳定或局部微变化'
            if page!=last_page:event='界面分类变化候选'
            elif page!='未确定界面' and response>.45 and abs(delta[0])<2 and 1<abs(delta[1])<100:
                event='右侧垂直滚动候选'
            elif change>.02:event='内容变化候选（点击/动画待复核）'
        row=dict(**rec,pageCandidate=page,headerError=round(header_error,3),sidebarScores=scores,
            eventCandidate=event,rightChangedFraction=change,rightShift=shift,shiftResponse=response,
            inputVerified=False,cursorPosition=None)
        rows.append(row)
        if rec['index']%150==0 or page!=last_page:keys.append(row)
        previous=roi;last_page=page
    spans=[]
    for row in rows:
        if not spans or spans[-1]['page']!=row['pageCandidate']:
            spans.append(dict(page=row['pageCandidate'],firstFrame=row['index'],lastFrame=row['index']))
        else:spans[-1]['lastFrame']=row['index']
    report=dict(source=manifest['source'],decodedFrames=len(rows),expectedFrames=manifest['expectedFrames'],
        complete=manifest['complete'],scope='固定录屏布局的逐帧视觉候选；未验证鼠标按压、滚轮事件或控件语义。',
        spans=spans,frames=rows)
    (root/'timeline.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    cards=''.join('<article><a href="'+r['file']+'"><img loading="lazy" src="'+r['file']+'"></a><p>帧 '+str(r['index'])+' · '+str(round(r['timeMs']/1000,2))+' 秒 · '+html.escape(r['pageCandidate'])+'<br>'+html.escape(r['eventCandidate'])+'</p></article>' for r in keys)
    body='<!doctype html><meta charset="utf-8"><title>录屏逐帧检查</title><style>body{background:#17191d;color:#eee;font:16px sans-serif;margin:24px}main{display:grid;grid-template-columns:repeat(2,1fr);gap:20px}img{width:100%}article{background:#252930;padding:12px}a{color:#9cf}</style><h1>设置录屏：视觉候选复核</h1><p>全部 '+str(len(rows))+' 帧已计算；下方为每 5 秒及分类变化时的预览，不代表逐帧人工审查。鼠标按压与滚轮输入尚未证实，未生成已确认逻辑链。</p><p><a href="timeline.json">全部逐帧判断 JSON</a></p><main>'+cards+'</main>'
    (root/'review.html').write_text(body,encoding='utf-8')
    print(json.dumps(dict(frames=len(rows),previewFrames=len(keys),spans=spans),ensure_ascii=True))


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('root',type=Path)
    run(parser.parse_args().root)
