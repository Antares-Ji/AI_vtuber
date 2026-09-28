"""Local-only visual session utilities; saves model proposals and input evidence."""
import argparse,json,time,uuid,shutil,subprocess,sys,urllib.request,hashlib
from pathlib import Path
import cv2
import numpy as np
ROOT=Path(__file__).resolve().parents[1]

class Session:
    def __init__(self,out=None):
        self.out=out or ROOT/'runtime/vision/stage-0-7'/str(time.time_ns())
        self.out.mkdir(parents=True,exist_ok=True)
        self.token=(ROOT/'runtime/vlm/controller/token.txt').read_text().strip()
        print(str(self.out),flush=True)
    def log(self,event,**data):
        row=dict(event=event,utc_ns=time.time_ns(),**data)
        with (self.out/'events.jsonl').open('a',encoding='utf8') as f:f.write(json.dumps(row,ensure_ascii=False)+'\n')
        print(json.dumps(row,ensure_ascii=False),flush=True)
    def request(self,url,data,auth=False):
        headers={'Content-Type':'application/json'}
        if auth:headers['Authorization']='Bearer '+self.token
        r=urllib.request.Request(url,data=json.dumps(data,ensure_ascii=False).encode('utf8'),headers=headers)
        try:
            with urllib.request.urlopen(r,timeout=90) as response:return json.load(response)
        except urllib.error.HTTPError as e:
            raise RuntimeError(e.read().decode('utf8')) from e
    def control(self,action,**body):
        requested_ns=time.time_ns()
        self.log('control_requested',action=action,body=body)
        try:
            r=self.request('http://127.0.0.1:17644/'+action,dict({'profile':'responsive','waitMs':150},**body),True)
        except Exception as error:
            self.log('control_failed',action=action,body=body,error=str(error),outcome='unknown')
            raise
        if r.get('path') and Path(r['path']).is_file():
            evidence=self.out/(str(time.time_ns())+'-'+action+'.png')
            shutil.copyfile(r['path'],evidence)
            r['evidence_path']=str(evidence)
            r['evidence_sha256']=hashlib.sha256(evidence.read_bytes()).hexdigest()
        if action=='drag':
            r['drag_frames']=[]
            for phase in ('before-release','after-release'):
                source=ROOT/'runtime/vlm/controller'/('drag-'+phase+'.png')
                if source.exists() and source.stat().st_mtime_ns>=requested_ns:
                    evidence=self.out/(str(time.time_ns())+'-drag-'+phase+'.png');shutil.copyfile(source,evidence)
                    r['drag_frames'].append({'phase':phase,'path':str(evidence),'sha256':hashlib.sha256(evidence.read_bytes()).hexdigest()})
        self.log('control',action=action,body=body,response=r)
        if not r.get('ok'):raise RuntimeError(r.get('error','Input failed'))
        return r
    def capture(self,label='capture'):
        r=self.control('move',xRatio=.965,yRatio=.95)
        frame=cv2.resize(cv2.imread(r['evidence_path']),(1600,1024))
        path=self.out/(label+'-'+str(time.time_ns())+'.png')
        if not cv2.imwrite(str(path),frame):raise RuntimeError('Screenshot write failed')
        self.log('capture',label=label,path=str(path),sha256=hashlib.sha256(path.read_bytes()).hexdigest())
        # Compatibility alias for roster readers; journal always uses immutable evidence.
        shutil.copyfile(path,self.out/(label+'.png'))
        return frame
    def analyze(self,frame,target,label,strategy='tactical',crop=None,mode='hybrid'):
        if crop:
            x1,y1,x2,y2=crop;frame=frame[y1:y2,x1:x2]
        label=label+'-'+str(time.time_ns())
        name='stage07-'+uuid.uuid4().hex+'.png'
        cv2.imwrite(str(ROOT/'runtime/vlm/live-20260911'/name),frame)
        cv2.imwrite(str(self.out/(label+'-input.png')),frame)
        self.log('analysis_requested',label=label,target=target,crop=crop,mode=mode,strategy=strategy,input_path=str(self.out/(label+'-input.png')))
        try:
            response=self.request('http://127.0.0.1:17642/analyze',dict(image=name,target=target,mode=mode,strategy=strategy))
        except Exception as error:
            self.log('analysis_failed',label=label,error=str(error))
            raise
        (self.out/(label+'-qwen.json')).write_text(json.dumps(response,ensure_ascii=False,indent=2),encoding='utf8')
        self.log('local_analysis',label=label,input_path=str(self.out/(label+'-input.png')),response_path=str(self.out/(label+'-qwen.json')),input_sha256=hashlib.sha256((self.out/(label+'-input.png')).read_bytes()).hexdigest(),parsed=response.get('parsed'),errors=response.get('validation_errors'),vlm_ms=response.get('vlm_ms'),yolo_ms=response.get('yolo_ms'))
        if response.get('validation_errors') or not isinstance(response.get('parsed'),dict):raise RuntimeError('Invalid local analysis')
        return response['parsed']
    def locate(self,frame,target,label,crop=None):
        p=self.analyze(frame,target,label,'grounded',crop)
        if not p.get('target_visible'):p=self.analyze(frame,target,label+'-vlm','grounded',crop,'vlm')
        point=p.get('target_point')
        if not p.get('target_visible') or not isinstance(point,list) or len(point)!=2 or any(type(v) not in (int,float) or not 0<=v<=1000 for v in point):return None
        if crop:
            x1,y1,x2,y2=crop
            return [(x1+point[0]/1000*(x2-x1))/1600,(y1+point[1]/1000*(y2-y1))/1024]
        return [v/1000 for v in point]
    def click_target(self,target,crop=None,surface=False):
        frame=self.capture('before');p=self.locate(frame,target,'target',crop)
        if p is None and surface:
            r=self.analyze(frame,'请给出'+target+'的横坐标和纵坐标。输出JSON对象包含两个字段：x（横坐标数字）,y（纵坐标数字）。当前输入图左上角为0,0，右下角为1000,1000。','surface',crop=crop,mode='vlm')
            point=[r.get('x'),r.get('y')]
            if isinstance(point,list) and len(point)==2 and all(type(v) in (int,float) and 0<=v<=1000 for v in point):
                if crop:
                    x1,y1,x2,y2=crop;p=[(x1+point[0]/1000*(x2-x1))/1600,(y1+point[1]/1000*(y2-y1))/1024]
                else:p=[v/1000 for v in point]
        if p is None:raise RuntimeError('Local target absent: '+target)
        self.control('click',xRatio=p[0],yRatio=p[1]);time.sleep(.5)
        return self.capture('after')
    def ocr(self,frame,box,label,scale=2):
        x1,y1,x2,y2=box;path=self.out/(label+'-'+str(time.time_ns())+'-ocr.png')
        cv2.imwrite(str(path),cv2.resize(frame[y1:y2,x1:x2],None,fx=scale,fy=scale))
        p=subprocess.run(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(ROOT/'src/vision/windows-ocr.ps1'),'-ImagePath',str(path)],capture_output=True,timeout=20,creationflags=subprocess.CREATE_NO_WINDOW)
        if p.returncode:raise RuntimeError('OCR failed')
        r=json.loads(p.stdout.decode('utf-8-sig'));self.log('ocr',label=label,path=str(path),text=r['text']);return ''.join(r['text'].split())

def main():
    sys.stdout.reconfigure(encoding='utf8')
    p=argparse.ArgumentParser();p.add_argument('--click');p.add_argument('--read');p.add_argument('--surface',action='store_true');p.add_argument('--crop',nargs=4,type=int);a=p.parse_args();s=Session()
    frame=s.click_target(a.click,a.crop,a.surface) if a.click else s.capture('current')
    if a.read:s.analyze(frame,a.read,'read')
if __name__=='__main__':main()
