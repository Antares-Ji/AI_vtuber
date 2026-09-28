"""Draft UI graph from selected frames; visual groups are NOT verified navigation."""
import importlib.util
import json
from pathlib import Path
import shutil
import sys
import tempfile
import cv2
import numpy as np

spec=importlib.util.spec_from_file_location('stitcher',Path(__file__).with_name('stitch-pages.py'))
stitcher=importlib.util.module_from_spec(spec);spec.loader.exec_module(stitcher)


def settings_page(image):
    # Explicitly scoped to the user's sampled Arknights settings layout; unknown layouts stay unknown.
    reference=Path(__file__).resolve().parents[2]/'runtime/vision/page-sessions/3547e303-1fc3-4b55-8e17-98ec3249a2d8/frame-001.jpg'
    if not reference.exists():return None
    template=cv2.imdecode(np.fromfile(reference,np.uint8),0)
    gray=cv2.resize(cv2.cvtColor(image,cv2.COLOR_BGR2GRAY),(1602,1056))
    if template is None:return None
    if (cv2.absdiff(gray[35:128,20:400],template[35:128,20:400])>30).mean()>.16:return None
    scores=[gray[y:y+65,40:250].mean() for y in [190,295,400,505]]
    order=np.argsort(scores)
    if scores[order[-1]]<140 or scores[order[-1]]-scores[order[-2]]<35:return None
    return ['游戏','声音','提醒','按键'][order[-1]]


def build(manifest):
    manifest=Path(manifest);folder=manifest.parent
    data=json.loads(manifest.read_text(encoding='utf-8'))
    candidates=[]
    if 'analysis' in data:
        for action in data['analysis']:
            frames=action['frames']
            before=[f for f in frames if f['phase']=='before']
            after=[f for f in frames if f['phase']=='after'] or [f for f in frames if f['phase']=='release']
            for frame in (before[:1]+after[-1:]):candidates.append((frame,action))
    else:
        candidates=[(f,None) for f in data['frames']]
    total=len(candidates);candidates=candidates[:24]
    nodes=[];edges=[];thumbs=[];previous=None;last_node=None
    for frame,action in candidates:
        file=frame['file'];im=cv2.imdecode(np.fromfile(folder/file,np.uint8),1)
        if im is None:continue
        thumb=cv2.resize(cv2.cvtColor(im,cv2.COLOR_BGR2GRAY),(160,100))
        found=next((i for i,t in enumerate(thumbs) if (cv2.absdiff(t,thumb)>22).mean()<.025),None)
        match=None
        if found is None and previous is not None:
            match=stitcher.alignment(previous,im)
            if match:found=last_node
        if found is None:
            found=len(nodes);page=settings_page(im)
            nodes.append(dict(id=found,label=f'{page or "未知界面"} · 状态候选 {found+1}',parentPage=page,reference=file,frames=[],boxes=[],scrollFrames=[],verified=False));thumbs.append(thumb)
        node=nodes[found]
        if file not in node['frames']:node['frames'].append(file)
        if match:
            if not node['scrollFrames']:node['scrollFrames'].append(nodes[last_node]['frames'][-2] if len(nodes[last_node]['frames'])>1 else node['reference'])
            if file not in node['scrollFrames']:node['scrollFrames'].append(file)
        if action and frame['phase']=='before' and action['start'].get('x') is not None:
            s=action['start'];x=s['x']/max(1,s['width']);y=s['y']/max(1,s['height'])
            node['boxes'].append(dict(gesture=action['id'],frame=file,x=max(0,x-.025),y=max(0,y-.025),w=.05,h=.05,
                label='操作位置候选（非完整控件边界）',verified=False))
        if last_node is not None:
            edge_kind='scroll-overlap-candidate' if match else 'input-associated' if action and frame.get('phase')!='before' else 'sample-order-only'
            source_page=nodes[last_node].get('parentPage');target_page=node.get('parentPage')
            if action and frame.get('phase')!='before' and source_page and target_page:
                s=action['start'];ratio=(s.get('x') or 0)/max(1,s['width'])
                if action['kind']=='wheel':edge_kind='scroll-overlap-candidate' if match else 'scroll-position-candidate'
                elif s.get('x') is not None and ratio<.19 and source_page!=target_page:edge_kind='navigation-candidate'
                elif source_page==target_page:edge_kind='control-state-candidate'
            edges.append(dict(source=last_node,target=found,gesture=action['id'] if action else None,
                kind=edge_kind,sourcePage=source_page,targetPage=target_page,verified=False))
        previous=im;last_node=found
    images=[]
    for node in nodes:
        if len(node['scrollFrames'])<2:continue
        with tempfile.TemporaryDirectory(prefix='flow-work-',dir=folder) as tmp:
            scratch=Path(tmp)
            (scratch/'manifest.json').write_text(json.dumps(dict(frames=[dict(file=str((folder/f).resolve())) for f in node['scrollFrames']])),encoding='utf-8')
            segments=stitcher.stitch(scratch)
            for j,segment in enumerate(segments):
                if segment['kind']!='scroll-content':continue
                name=f'flow-scroll-{node["id"]}-{j}.png';shutil.copyfile(scratch/segment['file'],folder/name)
                images.append(dict(file=name,node=node['id'],kind='scroll-content',verified=False))
    result=dict(parentScene=data.get('parentScene','home'),entryId=data.get('entryId'),entryLabel=data.get('entryLabel'),nodes=nodes,edges=edges,images=images,
                considered=len(candidates),available=total,verified=False,
                note='视觉相似度及重叠区域推断。节点可能是同一页面的不同状态；边不等于已确认跳转。框是操作位置，不是完整控件边界。最多分析24个关键帧，其余原图保留。')
    (folder/'flow.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    return result


if __name__=='__main__':print(json.dumps(build(sys.argv[1]),ensure_ascii=True))
