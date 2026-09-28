"""Local evidence bundle for the supplied 1280x720 OBS recording. No input injection."""
import argparse,json,subprocess,re,importlib.util
from pathlib import Path
import cv2
import numpy as np

BASE=Path(__file__).resolve().parent.parent
def module(name,file):
    spec=importlib.util.spec_from_file_location(name,file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m);return m
stitch=module('stitch',BASE/'src/vision/stitch-pages.py')

def build(root):
    data=json.loads((root/'timeline.json').read_text(encoding='utf-8'));rows=data['frames']
    (root/'derived').mkdir(exist_ok=True);(root/'ocr').mkdir(exist_ok=True)
    def read(i):return cv2.imdecode(np.fromfile(root/rows[i]['file'],np.uint8),cv2.IMREAD_COLOR)
    # Temporal representative selection is explicit: all frame records remain available.
    selected={0,len(rows)-1}
    for start in range(0,len(rows),60):
        choices=rows[start:min(start+60,len(rows))]
        best=min(choices,key=lambda r:r['rightChangedFraction'] if r['rightChangedFraction'] is not None else 1)
        selected.add(best['index'])
    for span in data['spans']:
        if span['lastFrame']-span['firstFrame']>=20:selected.add((span['firstFrame']+span['lastFrame'])//2)
    nodes=[];last=None;last_node=None;edges=[]
    for number,i in enumerate(sorted(selected)):
        image=read(i);page=rows[i]['pageCandidate'];cache=root/'ocr'/f'{i:06}.json'
        if cache.exists():ocr=json.loads(cache.read_text(encoding='utf-8'))
        else:
            r=subprocess.run(['powershell.exe','-NoProfile','-ExecutionPolicy','Bypass','-File',str(BASE/'src/vision/windows-ocr.ps1'),'-ImagePath',str((root/rows[i]['file']).resolve())],capture_output=True,timeout=30)
            try:ocr=json.loads(r.stdout.decode('utf-8-sig')) if r.returncode==0 else {'lines':[],'error':r.stderr.decode('utf-8',errors='replace')[-300:]}
            except ValueError:ocr={'lines':[],'error':'Invalid OCR output'}
            cache.write_text(json.dumps(ocr,ensure_ascii=False),encoding='utf-8')
        boxes=[]
        for line in ocr.get('lines',[]):
            words=line.get('words',[])
            if not words:continue
            x=min(w['x'] for w in words);y=min(w['y'] for w in words)
            right=max(w['x']+w['width'] for w in words);bottom=max(w['y']+w['height'] for w in words)
            label=re.sub(r'(?<=[\u3400-\u9fff])\s+(?=[\u3400-\u9fff])','',line['text'])
            boxes.append(dict(id=len(boxes)+1,x=x,y=y,w=right-x,h=bottom-y,label=label,note='',target='',verified=False,kind='OCR文字区域；交互性待审'))
        node=dict(id=f'frame-{i:06}',frame=i,timeMs=rows[i]['timeMs'],file=rows[i]['file'],page=page,boxes=boxes,ocrError=ocr.get('error'),width=1280,height=720)
        if last_node:
            edge=dict(source=last_node['id'],target=node['id'],kind='连续画面／状态变化待审',verified=False,fromFrame=last_node['frame'],toFrame=i,evidence='录屏时间顺序；没有原生按键事件')
            if page!=last_node['page']:edge['kind']='页面切换候选'
            elif page!='未确定界面':
                # Fixed sidebar/header never enter the scroll composite.
                a=last[125:710,335:1145];b=image[125:710,335:1145]
                match=stitch.alignment(a,b)
                if match:
                    x0,y0,x1,y1=match['roi'];dy=match['dy']
                    canvas=np.concatenate([a[y0:y1,x0:x1],b[y1-dy:y1,x0:x1]],axis=0)
                    file=f'derived/scroll-{last_node["frame"]:06}-{i:06}.png'
                    cv2.imencode('.png',canvas)[1].tofile(root/file)
                    edge.update(kind='滚动重叠已匹配／输入方式待审',stitch=file,alignment=match,evidence='特征平移一致且重叠像素检查通过；不证明使用了滚轮')
            edges.append(edge)
        nodes.append(node);last=image;last_node=node
        print(f'OCR and review {number+1}/{len(selected)} frame {i}',flush=True)
    bundle=dict(version=1,recording=root.name,expectedFrames=data['expectedFrames'],decodedFrames=len(rows),complete=data['complete'],
        warning='全部解码帧有变化记录。精选帧已做OCR；文字框不等于控件边界。点击/长按无法仅凭录像证实。标称帧数比解码多1帧。',
        hierarchy={'主界面':{'设置':['游戏','声音','提醒','按键','用户中心（尚未确认进入）']}},nodes=nodes,edges=edges,
        frames=[dict(index=r['index'],file=r['file'],timeMs=r['timeMs'],page=r['pageCandidate'],event=r['eventCandidate']) for r in rows])
    (root/'bundle.json').write_text(json.dumps(bundle,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(dict(nodes=len(nodes),boxes=sum(len(n['boxes']) for n in nodes),stitchedPairs=sum('stitch' in e for e in edges))))

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('root',type=Path);build(p.parse_args().root)
