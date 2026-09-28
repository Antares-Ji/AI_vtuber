"""Local Qwen roster/profile evidence and explicit, bounded navigation targets."""
import argparse,json,time,urllib.request,uuid,shutil,sys,subprocess,re,ctypes
from pathlib import Path
from PIL import Image
ROOT=Path(__file__).resolve().parents[1]
def read_profile_evidence(image,out):
    source=Image.open(image).resize((1600,1024))
    regions={'name':(18,90,240,155),'cost':(305,262,390,289),'block':(305,289,390,312),
             'skills':(0,400,420,965)}
    result={}
    for label,box in regions.items():
        crop=source.crop(box);crop=crop.resize((crop.width*3,crop.height*3));path=out/(label+'-ocr.png');crop.save(path)
        done=subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(ROOT/'src/vision/windows-ocr.ps1'),'-ImagePath',str(path)],capture_output=True,timeout=20,creationflags=subprocess.CREATE_NO_WINDOW)
        if done.returncode:raise RuntimeError('Profile OCR failed')
        result[label]=json.loads(done.stdout.decode('utf-8-sig'))
    source.crop((20,240,155,335)).save(out/'attack-range.png')
    values={key:re.sub(r'\s+','',value['text']) for key,value in result.items()}
    for key in ('cost','block'):
        values[key]=int(values[key]) if re.fullmatch(r'\d{1,2}',values[key]) else None
    (out/'ocr-evidence.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf8')
    (out/'profile-evidence.json').write_text(json.dumps(dict(values=values,status='candidate_requires_review',range_image='attack-range.png'),ensure_ascii=False,indent=2),encoding='utf8')
    return values
def request(url,data,token=None):
    headers={'Content-Type':'application/json'}
    if token:headers['Authorization']='Bearer '+token
    req=urllib.request.Request(url,data=json.dumps(data,ensure_ascii=False).encode('utf8'),headers=headers)
    with urllib.request.urlopen(req,timeout=90) as response:return json.load(response)
def main():
    sys.stdout.reconfigure(encoding='utf8')
    p=argparse.ArgumentParser();p.add_argument('--click');p.add_argument('--strategy',choices=['roster','operator-profile','observe'],default='observe');a=p.parse_args()
    out=ROOT/'runtime/vision/roster'/str(time.time_ns());out.mkdir(parents=True)
    token=(ROOT/'runtime/vlm/controller/token.txt').read_text().strip()
    def capture(label):
        r=request('http://127.0.0.1:17644/move',dict(profile='responsive',waitMs=50,xRatio=.965,yRatio=.95),token)
        if not r.get('ok'):raise RuntimeError('Capture failed')
        image=out/(label+'.png');shutil.copy2(r['path'],image)
        preview=Image.open(image);preview.thumbnail((1200,800));preview.save(out/(label+'-preview.png'))
        return image
    image=capture('before')
    if a.strategy=='operator-profile' and not a.click:
        print(json.dumps(dict(directory=str(out),ocr=read_profile_evidence(image,out)),ensure_ascii=False),flush=True)
    if a.click or a.strategy!='observe':
        name='roster-'+uuid.uuid4().hex+'.png'
        if a.strategy=='operator-profile' and not a.click:
            source=Image.open(image);source.crop((0,0,int(source.width*.265),source.height)).save(ROOT/'runtime/vlm/live-20260911'/name)
        else:shutil.copy2(image,ROOT/'runtime/vlm/live-20260911'/name)
        r=request('http://127.0.0.1:17642/analyze',dict(image=name,target=a.click or '读取当前干员',mode='vlm',strategy='grounded' if a.click else a.strategy))
        (out/'analysis.json').write_text(json.dumps(r,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(dict(directory=str(out),parsed=r.get('parsed'),errors=r.get('validation_errors')),ensure_ascii=False),flush=True)
        if r.get('validation_errors'):raise RuntimeError('Invalid local model proposal')
        if a.click:
            point=r['parsed'].get('target_point')
            if not r['parsed'].get('target_visible') or not isinstance(point,list) or len(point)!=2 or any(type(v) not in (int,float) or not 0<=v<=1000 for v in point):raise RuntimeError('Target not found')
            click=request('http://127.0.0.1:17644/click',dict(profile='responsive',waitMs=300,xRatio=point[0]/1000,yRatio=point[1]/1000),token)
            (out/'input.json').write_text(json.dumps(click,ensure_ascii=False,indent=2),encoding='utf8')
            time.sleep(.4);capture('after')
    else:print(str(out))
if __name__=='__main__':main()
