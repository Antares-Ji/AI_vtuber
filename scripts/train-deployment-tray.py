"""Reviewed first-three-card detector for the user's existing 0-1 team."""
import argparse,json,importlib.util
from pathlib import Path
import cv2,numpy as np
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'runtime/vlm/training/deployment-tray-v1'
spec=importlib.util.spec_from_file_location('ref',ROOT/'scripts/deployment-reference-check.py')
ref=importlib.util.module_from_spec(spec);spec.loader.exec_module(ref)

def prepare():
    rows=json.loads((ROOT/'runtime/vlm/training/deployment-card-v1/manifest.json').read_text(encoding='utf8'))
    template=ref.reference('tray-affordable.png');entries=[];cells=[]
    for row in rows:
        frame=ref.read(row['source']);crop=frame[850:1024,:400].copy();boxes=[]
        for slot in range(3):
            left=slot*133;face=template[921:1009,left+20:left+100]
            roi=frame[850:1024,left:left+133]
            _,score,_,point=cv2.minMaxLoc(cv2.matchTemplate(cv2.cvtColor(roi,cv2.COLOR_BGR2GRAY),cv2.cvtColor(face,cv2.COLOR_BGR2GRAY),cv2.TM_CCOEFF_NORMED))
            if score>.80:
                y1=max(0,point[1]-37);y2=min(174,y1+140)
                boxes.append(dict(slot=slot,xyxy=[left+2,y1,left+131,y2],score=score))
        split=row['split'];name=row['image']
        for folder in ['images','labels']:(OUT/'dataset'/folder/split).mkdir(parents=True,exist_ok=True)
        cv2.imwrite(str(OUT/'dataset/images'/split/name),crop)
        labels=[]
        for box in boxes:
            x1,y1,x2,y2=box['xyxy'];labels.append(f'0 {(x1+x2)/800:.6f} {(y1+y2)/348:.6f} {(x2-x1)/400:.6f} {(y2-y1)/174:.6f}')
            cv2.rectangle(crop,(x1,y1),(x2,y2),(0,255,0),2)
        (OUT/'dataset/labels'/split/name.replace('.png','.txt')).write_text('\n'.join(labels),encoding='utf8')
        entries.append(dict(index=row['index'],image=name,source=row['source'],session=row['session'],split=split,boxes=boxes,reviewed=False))
        cell=np.zeros((200,400,3),np.uint8);cell[:174]=crop
        cv2.putText(cell,f'{row["index"]:03d} {split} cards={len(boxes)}',(5,192),cv2.FONT_HERSHEY_SIMPLEX,.5,(255,255,255),1);cells.append(cell)
    for start in range(0,len(cells),24):
        subset=cells[start:start+24];canvas=np.zeros((((len(subset)+3)//4)*200,1600,3),np.uint8)
        for i,cell in enumerate(subset):y,x=divmod(i,4);canvas[y*200:(y+1)*200,x*400:(x+1)*400]=cell
        cv2.imwrite(str(OUT/f'review-{start//24}.jpg'),canvas)
    (OUT/'manifest.json').write_text(json.dumps(entries,indent=2),encoding='utf8')
    import yaml
    (OUT/'dataset/data.yaml').write_text(yaml.safe_dump(dict(path=str(OUT/'dataset'),train='images/train',val='images/val',names={0:'operator_card'})),encoding='utf8')
    print(json.dumps({'samples':len(entries),'boxes':sum(len(x['boxes']) for x in entries),'reviews':len(list(OUT.glob('review-*.jpg')))}))

def train():
    entries=json.loads((OUT/'manifest.json').read_text(encoding='utf8'))
    if not all(e['reviewed'] for e in entries):raise RuntimeError('Review every label before training')
    from ultralytics import YOLO,settings
    settings.update({'sync':False})
    detector=YOLO(str(ROOT/'runtime/vlm/models/YOLO11/yolo11n.pt'))
    detector.train(data=str(OUT/'dataset/data.yaml'),epochs=100,imgsz=320,batch=4,workers=0,amp=False,plots=False,seed=31,fliplr=0,mosaic=0,degrees=0,translate=.03,scale=.1,hsv_v=.25,project=str(OUT),name='fit',exist_ok=True,patience=25)
    (OUT/'training-report.json').write_text(json.dumps({'epochs_requested':100,'weights':str(detector.trainer.best),'metrics':detector.metrics.results_dict,'scope':'First three cards of the existing team only; separate entire validation run. Not enemies or tile detection.'},indent=2),encoding='utf8')

if __name__=='__main__':
    p=argparse.ArgumentParser();p.add_argument('command',choices=['prepare','train']);a=p.parse_args()
    prepare() if a.command=='prepare' else train()
