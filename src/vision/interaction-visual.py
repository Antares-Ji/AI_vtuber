"""Local visual evidence only; never assert semantic control types from a click."""
import json
import sys
from pathlib import Path
import cv2
import numpy as np


def load(folder, frame):
    image = cv2.imdecode(np.fromfile(folder / frame['file'], np.uint8), 0)
    return cv2.resize(image, (320, 240)) if image is not None else None


def fraction(a, b):
    return float((cv2.absdiff(a, b) > 25).mean())


def analyze(manifest):
    manifest = Path(manifest)
    data = json.loads(manifest.read_text(encoding='utf-8'))
    output, pairs = [], []
    for action in data.get('analysis', []):
        before = sorted([f for f in action['frames'] if f['phase']=='before' and f['capturedAt'] <= action['start']['at']], key=lambda f:f['capturedAt'])
        after = sorted([f for f in action['frames'] if f['phase']=='after'], key=lambda f:f['capturedAt'])
        item = dict(id=action['id'], verified=False, controlType='unknown')
        if not before or not after or action['kind']=='incomplete':
            item['description']='前后画面不足或操作中断，无法判断控件变化。'
            output.append(item)
            continue
        a, b = load(manifest.parent, before[-1]), load(manifest.parent, after[-1])
        if a is None or b is None:
            item['description']='无法读取对比帧；请人工核验原图。'
            output.append(item)
            continue
        # Ignore a small area around the pointer, whose hover/pressed artwork may change.
        s=action['start']
        x=int((s['x'] or 0)/max(1,s['width'])*320); y=int((s['y'] or 0)/max(1,s['height'])*240)
        a[max(0,y-10):y+11,max(0,x-10):x+11]=0
        b[max(0,y-10):y+11,max(0,x-10):x+11]=0
        delta=fraction(a,b)
        item['changedFraction']=round(delta,4)
        item['description']=f'前后画面变化约 {delta*100:.1f}%；' + ('可见变化候选，可能来自控件、动画或页面切换。' if delta>.005 else '未发现明显变化，小控件变化仍可能漏检。')
        if action['kind']=='short-click' and delta>.005:
            for old, pa, pb, px, py in pairs:
                if abs(x-px)<5 and abs(y-py)<5 and fraction(a,pb)<.008 and fraction(b,pa)<.008:
                    item['controlType']='two-state-candidate'
                    item['description']+=' 同位置重复短按出现 A→B→A 画面往返，列为双态候选，尚不能确认是开关。'
                    item['relatedGesture']=old
                    break
        if action['kind']=='drag':
            item['description']+=' 按住移动已记录；是否音量滑块及0–100范围不能仅凭轨迹确认。'
        pairs.append((action['id'],a,b,x,y))
        output.append(item)
    return output


if __name__=='__main__':
    print(json.dumps(analyze(sys.argv[1]),ensure_ascii=True))
