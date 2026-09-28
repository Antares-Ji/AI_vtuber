"""Inventory recordings and extract auditable review samples, without inventing labels."""
import json, hashlib
from pathlib import Path
import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[1]
OUT = ROOT / 'output/arknights-review-20260926'
OUT.mkdir(parents=True, exist_ok=True)
rows, cells = [], []
for directory in sorted((ROOT/'runtime/vision/timing-recordings').iterdir()):
    video = directory/'recording.avi'
    if not video.exists(): continue
    summary = directory/'summary.json'
    timeline = directory/'timeline.jsonl'
    row = dict(recording_id=directory.name, video=str(video), status='pending_visual_review',
               stage=None, outcome='unknown', training_eligible=False, sampled_frames=[],
               existing_reviews=[str(p) for p in directory.glob('*.json') if p.name != 'summary.json'])
    if summary.exists(): row['recording_metadata'] = json.loads(summary.read_text(encoding='utf-8-sig'))
    frames = []
    if timeline.exists():
        for line in timeline.read_text(encoding='utf-8-sig').splitlines():
            try:
                event = json.loads(line)
                if event.get('event') == 'frame': frames.append(event)
            except json.JSONDecodeError: row['timeline_incomplete'] = True
    cap = cv2.VideoCapture(str(video))
    for fraction in (.15, .6, .98):
        cell = np.zeros((230, 400, 3), np.uint8)
        if frames and summary.exists():
            target = frames[-1]['capture_end_s'] * fraction
            event = min(frames, key=lambda f: abs(f['capture_end_s']-target))
            index = event['index']
            seek = cap.set(cv2.CAP_PROP_POS_FRAMES, index)
            ok, image = cap.read()
            if seek and ok and abs(cap.get(cv2.CAP_PROP_POS_FRAMES)-(index+1)) <= 1:
                file = OUT/f'{directory.name}-{index}.jpg'
                cv2.imwrite(str(file), image)
                row['sampled_frames'].append(dict(path=str(file), index=index,
                    elapsed_s=event['capture_end_s'], sha256=hashlib.sha256(file.read_bytes()).hexdigest()))
                cell[:204] = cv2.resize(image, (400, 204))
                cv2.putText(cell, f'{directory.name} T+{event["capture_end_s"]:.1f}', (4,220), cv2.FONT_HERSHEY_SIMPLEX,.4,(255,255,255),1)
            else: row['decode_error'] = True
        cells.append(cell)
    cap.release()
    rows.append(row)
for offset in range(0,len(cells),24):
    group=cells[offset:offset+24]
    canvas=np.zeros((((len(group)+2)//3)*230,1200,3),np.uint8)
    for i,cell in enumerate(group):
        y,x=divmod(i,3);canvas[y*230:(y+1)*230,x*400:(x+1)*400]=cell
    cv2.imwrite(str(OUT/f'overview-{offset//24+1}.jpg'),canvas)
(OUT/'recordings.json').write_text(json.dumps(rows,ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(dict(recordings=len(rows), samples=sum(len(r['sampled_frames']) for r in rows),output=str(OUT))))
