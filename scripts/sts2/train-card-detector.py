"""Small local UI detector pilot. Synthetic validation is NOT a generalization score."""
import argparse
import hashlib
import json
import random
from pathlib import Path
from PIL import Image, ImageEnhance, ImageFilter

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT/'runtime/sts2/vision'
SOURCE = ROOT/'runtime/sts2/learning'


def generate():
    rng = random.Random(20261021)
    dataset = BASE/'dataset'
    for split in ('train','val'):
        for kind in ('images','labels'):
            (dataset/kind/split).mkdir(parents=True,exist_ok=True)
    detail = Image.open(SOURCE/'card-detail.jpg').convert('RGB')
    deck = Image.open(SOURCE/'deck.jpg').convert('RGB')
    # Human-reviewed boundaries on these exact screenshots, in source pixels.
    detail_box=(550,64,1045,722)
    deck_boxes=[(x,185,x+199,449) for x in (171,381,591,801,1011,1221)]
    deck_boxes += [(x,466,x+199,734) for x in (171,381,591,801,1011)]
    cutouts=[detail.crop(detail_box)]+[deck.crop(b) for b in deck_boxes]
    background=Image.open(SOURCE/'map-ready.jpg').convert('RGB').resize((800,448)).filter(ImageFilter.GaussianBlur(4))
    def save(im, boxes, split, name):
        im.save(dataset/'images'/split/(name+'.jpg'),quality=94)
        w,h=im.size
        lines=[f'0 {(x1+x2)/2/w:.6f} {(y1+y2)/2/h:.6f} {(x2-x1)/w:.6f} {(y2-y1)/h:.6f}' for x1,y1,x2,y2 in boxes]
        (dataset/'labels'/split/(name+'.txt')).write_text('\n'.join(lines),encoding='utf-8')
    for index in range(200):
        im=ImageEnhance.Brightness(background).enhance(rng.uniform(.18,.9))
        boxes=[]
        # Nonoverlapping slots allow exact synthetic labels; no guessed OCR labels.
        count=rng.choice([1,2,3,4])
        for i in range(count):
            crop=rng.choice(cutouts)
            width=rng.randint(80,min(250,760//count))
            height=round(width*crop.height/crop.width)
            x=20+i*(760//count)+rng.randint(0,max(0,760//count-width-10))
            y=rng.randint(5,max(5,440-height))
            im.paste(ImageEnhance.Brightness(crop.resize((width,height))).enhance(rng.uniform(.65,1.15)),(x,y))
            boxes.append((x,y,x+width,y+height))
        save(im,boxes,'train',f'synthetic-{index:03}')
    # Include real grid/detail arrangements; same-source augmentation stays in train.
    for i in range(20):
        save(ImageEnhance.Brightness(detail).enhance(.75+i/80),[detail_box],'train',f'detail-{i}')
        save(ImageEnhance.Brightness(deck).enhance(.75+i/80),deck_boxes,'train',f'deck-{i}')
    for name in ('menu','current','map-ready'):
        save(Image.open(SOURCE/(name+'.jpg')).convert('RGB'),[],'train','negative-'+name)
    # Diagnostic only: upgraded same-card image, never advertised as independent test.
    save(Image.open(SOURCE/'card-upgraded.jpg').convert('RGB'),[detail_box],'val','upgraded-same-session')
    (dataset/'data.yaml').write_text(f'path: {dataset.as_posix()}\ntrain: images/train\nval: images/val\nnames:\n  0: card_panel\n',encoding='utf-8')
    manifest={'scope':'pilot_same_session_not_independent_benchmark','labels':'human-reviewed card panel boxes',
              'training_real_screens':2,'training_synthetic_images':200,'negative_screens':3,
              'validation_note':'same card and same session; diagnostic localization only, no generalization claim',
              'sources':{name:hashlib.sha256((SOURCE/name).read_bytes()).hexdigest() for name in ['card-detail.jpg','deck.jpg','card-upgraded.jpg']}}
    (BASE/'dataset-manifest.json').write_text(json.dumps(manifest,indent=2),encoding='utf-8')
    return dataset/'data.yaml'


def main():
    p=argparse.ArgumentParser();p.add_argument('--epochs',type=int,default=25);args=p.parse_args()
    data=generate()
    from ultralytics import YOLO, settings
    settings.update({'sync':False})
    model=YOLO(str(ROOT/'runtime/vlm/models/YOLO11/yolo11n.pt'))
    model.train(data=str(data),epochs=args.epochs,imgsz=640,batch=16,workers=0,device=0,
                project=str(BASE),name='card-detector-v1',exist_ok=True,seed=20261021,
                patience=0,amp=False,plots=False,verbose=False,cache=False,
                fliplr=0,flipud=0,degrees=0,mosaic=.5,close_mosaic=5)
    print(json.dumps({'weights':str(BASE/'card-detector-v1/weights/best.pt'),'scope':'pilot; same-session only'}),flush=True)


if __name__=='__main__': main()
