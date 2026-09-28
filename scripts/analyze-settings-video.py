"""Local, exhaustive decode pass. Never inject input or upload video."""
import argparse
import json
from pathlib import Path
import cv2
import numpy as np


def audit(output):
    """Judge every saved frame; blank evidence must not produce UI claims."""
    manifest=json.loads((output/'frames.json').read_text(encoding='utf-8'))
    judgments=[]
    for record in manifest['frames']:
        frame=cv2.imdecode(np.fromfile(output/record['file'],dtype=np.uint8),cv2.IMREAD_COLOR)
        if frame is None:raise RuntimeError('Unreadable frame: '+record['file'])
        maximum=int(frame.max())
        judgments.append(dict(**record,maximumPixel=maximum,meanPixel=float(frame.mean()),
            judgment='black-frame' if maximum==0 else 'requires-visual-analysis',
            page=None,cursor=None,click=None,scroll=None))
    black=sum(j['judgment']=='black-frame' for j in judgments)
    result=dict(totalFrames=len(judgments),blackFrames=black,
        status='blocked-black-video' if black==len(judgments) else 'requires-visual-analysis',
        note='Pixel checks are exhaustive. No mouse or UI transitions are inferred from blank frames.',
        logicalEdges=[],frames=judgments)
    (output/'analysis.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps({k:v for k,v in result.items() if k!='frames'}),flush=True)


def extract(video, output):
    output.mkdir(parents=True, exist_ok=False)
    frames_dir=output/'images';frames_dir.mkdir()
    cap=cv2.VideoCapture(str(video))
    if not cap.isOpened():raise RuntimeError('Cannot open video')
    fps=cap.get(cv2.CAP_PROP_FPS);expected=int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    records=[];total=0;previous=None
    try:
        while True:
            ok,frame=cap.read()
            if not ok:break
            index=len(records);name=f'frame-{index:06}.png'
            encoded=cv2.imencode('.png',frame,[cv2.IMWRITE_PNG_COMPRESSION,3])[1]
            if total+encoded.nbytes>16_000_000_000:raise RuntimeError('16GB output budget reached; original video preserved')
            encoded.tofile(frames_dir/name);total+=encoded.nbytes
            gray=cv2.cvtColor(cv2.resize(frame,(320,180)),cv2.COLOR_BGR2GRAY)
            change=float((cv2.absdiff(previous,gray)>22).mean()) if previous is not None else None
            records.append(dict(index=index,file='images/'+name,timeMs=round(cap.get(cv2.CAP_PROP_POS_MSEC),3),adjacentChangedFraction=change))
            previous=gray
            if (index+1)%200==0:print(f'Decoded and saved {index+1}/{expected}',flush=True)
    finally:
        cap.release()
        summary=dict(source=str(video.resolve()),fps=fps,expectedFrames=expected,decodedFrames=len(records),complete=len(records)==expected,imageBytes=total,frames=records)
        (output/'frames.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    if len(records)!=expected:raise RuntimeError(f'Decode incomplete: {len(records)}/{expected}')
    print(json.dumps({k:v for k,v in summary.items() if k!='frames'},ensure_ascii=True),flush=True)


if __name__=='__main__':
    parser=argparse.ArgumentParser();parser.add_argument('video',type=Path);parser.add_argument('output',type=Path)
    parser.add_argument('--audit-only',action='store_true')
    args=parser.parse_args()
    if not args.audit_only:extract(args.video,args.output)
    audit(args.output)
