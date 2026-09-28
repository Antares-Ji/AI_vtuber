"""Single-operator card detector; reference-proposed labels require contact-sheet review."""
import argparse,json,importlib.util
from pathlib import Path
import cv2,numpy as np
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'runtime/vlm/training/deployment-card-v1'
RUNS=['1789189299267','1789190955228','1789191085417','1789191329699','1789191508275']
spec=importlib.util.spec_from_file_location('ref',ROOT/'scripts/deployment-reference-check.py');ref=importlib.util.module_from_spec(spec);spec.loader.exec_module(ref)

def prepare():
    OUT.mkdir(parents=True,exist_ok=True);entries=[];cells=[]
    for run in RUNS:
        events=[json.loads(x) for x in (ROOT/'runtime/vision/local-deployment'/run/'events.jsonl').read_text(encoding='utf8').splitlines()]
        files=list(dict.fromkeys(e['image'] for e in events if e['event']=='control'))
        candidates={'positive':[],'negative':[]}
        for file in files:
            frame=ref.read(file);state=ref.inspect_frame(frame,'battle-card')
            # Only unambiguous portrait matches/nonmatches are proposed.
            if state['score']>.90:label='positive'
            elif state['score']<.55:label='negative'
            else:continue
            candidates[label].append((file,frame,state))
        for label in ['positive','negative']:
            values=candidates[label];indices=np.linspace(0,len(values)-1,min(12,len(values)),dtype=int) if values else []
            for index in indices:
                file,frame,state=values[index];number=len(entries);split='val' if run==RUNS[-1] else 'train'
                name=f'{number:03d}.png';crop=frame[850:1024,:400].copy()
                for folder in ['images','labels']:(OUT/'dataset'/folder/split).mkdir(parents=True,exist_ok=True)
                cv2.imwrite(str(OUT/'dataset/images'/split/name),crop)
                box='0 0.165000 0.586207 0.320000 0.781609' if label=='positive' else ''
                (OUT/'dataset/labels'/split/name.replace('.png','.txt')).write_text(box,encoding='utf8')
                entries.append(dict(index=number,image=name,source=file,session=run,split=split,label=label,score=state['score'],reviewed=False))
                if label=='positive':cv2.rectangle(crop,(2,34),(130,170),(0,255,0),2)
                cell=np.zeros((200,400,3),np.uint8);cell[:174]=crop
                cv2.putText(cell,f'{number:03d} {split} {label}',(5,192),cv2.FONT_HERSHEY_SIMPLEX,.5,(255,255,255),1);cells.append(cell)
    for start in range(0,len(cells),24):
        subset=cells[start:start+24];canvas=np.zeros((((len(subset)+3)//4)*200,1600,3),np.uint8)
        for i,cell in enumerate(subset):y,x=divmod(i,4);canvas[y*200:(y+1)*200,x*400:(x+1)*400]=cell
        cv2.imwrite(str(OUT/f'review-{start//24}.jpg'),canvas)
    (OUT/'manifest.json').write_text(json.dumps(entries,indent=2),encoding='utf8')
    import yaml
    (OUT/'dataset/data.yaml').write_text(yaml.safe_dump(dict(path=str(OUT/'dataset'),train='images/train',val='images/val',names={0:'bagpipe_card'})),encoding='utf8')
    print(json.dumps({'samples':len(entries),'positive':sum(e['label']=='positive' for e in entries),'train':sum(e['split']=='train' for e in entries),'val':sum(e['split']=='val' for e in entries),'review_sheets':len(list(OUT.glob('review-*.jpg')))}))

def train(epochs):
    entries=json.loads((OUT/'manifest.json').read_text(encoding='utf8'))
    if not all(e['reviewed'] for e in entries):raise RuntimeError('Review every proposed label before training')
    from ultralytics import YOLO,settings
    settings.update({'sync':False})
    detector=YOLO(str(ROOT/'runtime/vlm/models/YOLO11/yolo11n.pt'))
    detector.train(data=str(OUT/'dataset/data.yaml'),epochs=epochs,imgsz=320,batch=4,workers=0,amp=False,plots=False,seed=29,fliplr=0,mosaic=0,degrees=0,translate=.03,scale=.1,hsv_v=.25,project=str(OUT),name='fit',exist_ok=True,patience=30)
    (OUT/'training-report.json').write_text(json.dumps({'epochs_requested':epochs,'weights':str(detector.trainer.best),'metrics':detector.metrics.results_dict,'scope':'Cropped left tray, Bagpipe portrait only, same 0-1 team/UI. Held-out entire two-play run. Not enemies, tiles, or general CV.'},indent=2),encoding='utf8')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('command',choices=['prepare','train']);p.add_argument('--epochs',type=int,default=100);a=p.parse_args()
    prepare() if a.command=='prepare' else train(a.epochs)
