"""Local STS2 YOLO -> cropped Qwen OCR -> evidence/memory worker. No input actions."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, build_opener, ProxyHandler

# All HTTP destinations in this worker are loopback services. A proxy inherited
# from the launcher must not send these requests outside this machine.
_local_http = build_opener(ProxyHandler({}))
urlopen = _local_http.open

ROOT = Path(__file__).resolve().parents[2]
BASE = ROOT/'runtime/sts2/vision'
ALLOWED = [(ROOT/'runtime/sts2').resolve(), (ROOT/'output/sts2').resolve()]
os.environ.setdefault('HF_HUB_OFFLINE','1')
os.environ.setdefault('HF_HOME',str(ROOT/'runtime/vlm/hf-cache'))


def digest(file): return hashlib.sha256(file.read_bytes()).hexdigest()


def commentary_prompt(card):
    upgraded=card.get('upgraded') or {}
    return (f'读牌助手刚核对：{card["name"]}，{card["base"]["cost"]}费，{card["base"]["description"]}。'
        f'升级后：{upgraded.get("description", "无")}。'
        '请主播只结合牌面自然吐槽一句，不念技术进度，不沿用旧行动计划，不说是你操作的，不说已经赢了。')[:490]


class Engine:
    def __init__(self, gpu_gib):
        import torch
        from transformers import AutoProcessor, Qwen3VLForConditionalGeneration
        from ultralytics import YOLO, settings
        settings.update({'sync':False})
        self.torch=torch
        weights=BASE/'card-detector-v1/weights/best.pt'
        if not weights.exists(): raise RuntimeError('Train the STS2 card detector first')
        self.detector=YOLO(str(weights)); self.weights=str(weights); self.weights_hash=digest(weights)
        model_path=ROOT/'runtime/vlm/models/Qwen3-VL-4B-Instruct'
        self.processor=AutoProcessor.from_pretrained(model_path,local_files_only=True)
        self.processor.image_processor.size={'shortest_edge':65536,'longest_edge':262144}
        self.model=Qwen3VLForConditionalGeneration.from_pretrained(model_path,local_files_only=True,dtype=torch.bfloat16,
            device_map='auto',max_memory={0:f'{gpu_gib}GiB','cpu':'32GiB'},attn_implementation='sdpa')
        self.lock=threading.Lock(); self.cache={};self.said=set();self.last_speech=0;self.speech_lock=threading.Lock()
        self.capture_evidence=None
        self.status={'enabled':True,'ready':True,'busy':False,'watch':False,'frames':0,'ocr_cards':0,
            'detector':'STS2-YOLO11n-card-pilot','detector_scope':'same-session pilot, not broadly validated',
            'vlm':'Qwen3-VL-4B-Instruct local','last_error':None,'last_result':None,'commentary':True,
            'commentary_busy':False,'commentary_error':None}

    def speak(self, card):
        # Speech failures must not undo successful OCR or hold the vision model lock.
        if not self.speech_lock.acquire(blocking=False): return
        self.status['commentary_busy']=True
        try:
            request=Request('http://127.0.0.1:3000/api/sts2/chat',data=json.dumps({'text':commentary_prompt(card)}).encode(),headers={'Content-Type':'application/json'})
            with urlopen(request,timeout=30) as response: response.read()
            self.said.add(card['id']);self.status['commentary_error']=None
        except Exception as ex:
            self.status['commentary_error']=str(ex)
        finally:
            self.status['commentary_busy']=False;self.speech_lock.release()

    def analyze(self, file, read_ui=False):
        from PIL import Image
        file=Path(file).resolve()
        if not any(file.is_relative_to(p) for p in ALLOWED) or file.suffix.lower() not in ('.jpg','.jpeg','.png'):
            raise ValueError('Only STS2 screenshot files are accepted')
        if file.stat().st_size>12*1024*1024: raise ValueError('Image too large')
        sha=digest(file)
        cache_key=(sha,read_ui)
        if cache_key in self.cache: return self.cache[cache_key]
        if not self.lock.acquire(blocking=False): raise BlockingIOError('Vision model is busy')
        self.status['busy']=True
        started=time.monotonic()
        try:
            with Image.open(file) as src:
                if src.width*src.height>10_000_000: raise ValueError('Image dimensions too large')
                im=src.convert('RGB')
            prediction=self.detector.predict(im,imgsz=960,conf=.5,device=0,verbose=False)[0]
            boxes=[{'label':'card_panel','confidence':round(float(b.conf.item()),4),'xyxy':[round(float(v)) for v in b.xyxy[0].tolist()]} for b in prediction.boxes]
            boxes.sort(key=lambda b:(b['xyxy'][2]-b['xyxy'][0])*(b['xyxy'][3]-b['xyxy'][1]),reverse=True)
            # A large inspection card takes precedence over dimmed cards behind it.
            chosen=boxes[:1] if boxes and (boxes[0]['xyxy'][2]-boxes[0]['xyxy'][0])*(boxes[0]['xyxy'][3]-boxes[0]['xyxy'][1])>im.width*im.height*.15 else boxes[:3]
            observations=[]
            if not chosen and read_ui: chosen=[{'label':'full_frame_fallback','confidence':None,'xyxy':[0,0,im.width,im.height]}]
            for index,box in enumerate(chosen):
                x1,y1,x2,y2=box['xyxy'];pad=max(8,round((x2-x1)*.035))
                bounds=[max(0,x1-pad),max(0,y1-pad),min(im.width,x2+pad),min(im.height,y2+pad)]
                crop=im.crop(bounds);target=BASE/'captures'/f'{sha[:16]}-{index}.png';target.parent.mkdir(parents=True,exist_ok=True);crop.save(target)
                prompt=('逐字读取图中最主要、明亮且完整的卡牌，不读取背景暗掉的卡牌，不凭知识补全。'
                    '只输出JSON，格式{"visible_text":[],"cards":[{"name":"实际牌名含+号","cost":"实际费用",'
                    '"description":"技能原文，保留数字、标点和关键词","uncertain":false}],"uncertain_text":[]}。'
                    '不清楚的字段为null，uncertain为true。没有卡牌时cards为空。不要输出占位例文。')
                messages=[{'role':'user','content':[{'type':'image','image':crop},{'type':'text','text':prompt}]}]
                inputs=self.processor.apply_chat_template(messages,tokenize=True,add_generation_prompt=True,return_dict=True,return_tensors='pt').to(self.model.device)
                with self.torch.inference_mode(): tokens=self.model.generate(**inputs,max_new_tokens=500,do_sample=False)
                raw=self.processor.batch_decode(tokens[:,inputs.input_ids.shape[1]:],skip_special_tokens=True)[0]
                try: parsed=json.loads(raw.removeprefix('```json').removeprefix('```').removesuffix('```').strip())
                except json.JSONDecodeError: parsed=None
                observations.append({'image':str(target),'sha256':digest(target),'parent_image':str(file),'parent_sha256':sha,
                    'crop_xyxy':bounds,'detector':box,'detector_weights_sha256':self.weights_hash,'model':'Qwen3-VL-4B-Instruct local',
                    'raw':raw,'parsed':parsed,'status':'unverified_ocr','captured_at':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())})
            report={'schema':1,'source_image':str(file),'source_sha256':sha,'seconds':round(time.monotonic()-started,2),
                'detections':boxes,'observations':observations,'scope':'card-detector pilot; OCR must match versioned catalog'}
            result_file=BASE/'records'/f'{sha[:16]}.json';result_file.parent.mkdir(parents=True,exist_ok=True)
            result_file.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            if observations:
                saved=subprocess.run(['node',str(ROOT/'scripts/sts2/learn.cjs'),'--ocr',str(result_file),'--memory'],cwd=ROOT,capture_output=True,text=True,encoding='utf-8',timeout=45)
                if saved.returncode: raise RuntimeError('Memory import failed: '+saved.stderr[-350:])
                (result_file.with_suffix('.memory.log')).write_text(saved.stdout,encoding='utf-8')
                knowledge=json.loads((ROOT/'data/sts2/knowledge.json').read_text(encoding='utf-8'))
                evidence=[o for o in knowledge['observations'] if o.get('parent_sha256')==sha]
                matches=[m for o in evidence for m in o.get('matches',[]) if m['status']=='exact_text_and_cost']
                if self.status['commentary'] and matches and time.time()-self.last_speech>60:
                    cid=matches[0]['card_id']
                    if cid not in self.said:
                        card=next(c for c in knowledge['cards'] if c['id']==cid)
                        self.last_speech=time.time()
                        threading.Thread(target=self.speak,args=(card,),daemon=True).start()
                report['verified_matches']=len(matches)
            result_file.write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
            self.status['frames']+=1;self.status['ocr_cards']+=len(observations);self.status['last_error']=None
            self.status['last_result']={'record':str(result_file),'detections':len(boxes),'ocr_regions':len(observations),'verified_matches':report.get('verified_matches',0),'seconds':report['seconds']}
            self.cache[cache_key]=report
            if len(self.cache)>100: self.cache.pop(next(iter(self.cache)))
            return report
        except Exception as ex:
            self.status['last_error']=str(ex);raise
        finally:
            self.status['busy']=False;self.lock.release()
            (BASE/'status.json').write_text(json.dumps(self.status,ensure_ascii=False,indent=2),encoding='utf-8')

    def capture(self):
        target=BASE/'captures'/f'live-{int(time.time())}.jpg';target.parent.mkdir(parents=True,exist_ok=True)
        with urlopen('http://127.0.0.1:15526/api/v1/singleplayer',timeout=8) as r:
            game_state=json.dumps(json.loads(r.read()),sort_keys=True,ensure_ascii=False)
        with urlopen('http://127.0.0.1:3000/api/sts2/game-preview',timeout=8) as r: target.write_bytes(r.read())
        frame_hash=digest(target)
        if self.capture_evidence and self.capture_evidence[0]==frame_hash and self.capture_evidence[1]!=game_state:
            raise RuntimeError('游戏状态已变化，但捕获画面未更新；本帧不作实时读牌证据')
        self.capture_evidence=(frame_hash,game_state)
        return self.analyze(target)


def main():
    p=argparse.ArgumentParser();p.add_argument('--gpu-gib',type=int,default=5);p.add_argument('--port',type=int,default=17645);args=p.parse_args()
    BASE.mkdir(parents=True,exist_ok=True);engine=Engine(args.gpu_gib)
    class Handler(BaseHTTPRequestHandler):
        def log_message(self,*args): pass
        def trusted(self):
            return self.headers.get('Host') in (f'127.0.0.1:{args.port}',f'localhost:{args.port}') and self.headers.get('Origin') in (None,'http://127.0.0.1:3000','http://localhost:3000')
        def send_json(self,status,body):
            data=json.dumps(body,ensure_ascii=False).encode();self.send_response(status)
            self.send_header('Content-Type','application/json; charset=utf-8');self.send_header('Content-Length',str(len(data)))
            if self.trusted() and self.headers.get('Origin'): self.send_header('Access-Control-Allow-Origin',self.headers['Origin'])
            self.end_headers();self.wfile.write(data)
        def do_OPTIONS(self):
            if not self.trusted(): return self.send_json(403,{'error':'local console only'})
            self.send_response(204);self.send_header('Access-Control-Allow-Origin',self.headers.get('Origin','http://127.0.0.1:3000'));self.send_header('Access-Control-Allow-Methods','GET, POST, OPTIONS');self.send_header('Access-Control-Allow-Headers','Content-Type');self.end_headers()
        def do_GET(self):
            if not self.trusted(): return self.send_json(403,{'error':'local console only'})
            self.send_json(200,engine.status) if self.path=='/health' else self.send_json(404,{'error':'not found'})
        def do_POST(self):
            if not self.trusted(): return self.send_json(403,{'error':'local console only'})
            try:
                length=int(self.headers.get('Content-Length','0'))
                if length>8192 or 'application/json' not in self.headers.get('Content-Type',''): return self.send_json(400,{'error':'bounded JSON required'})
                body=json.loads(self.rfile.read(length) or b'{}')
                if self.path=='/read': return self.send_json(200,engine.analyze(body['image'],body.get('read_ui') is True))
                if self.path=='/capture': return self.send_json(200,engine.capture())
                if self.path=='/watch':
                    if type(body.get('enabled')) is not bool: raise ValueError('enabled must be boolean')
                    engine.status['watch']=body['enabled'];return self.send_json(200,engine.status)
                if self.path=='/stop':
                    engine.status['enabled']=False;self.send_json(200,{'stopping':True});threading.Thread(target=server.shutdown,daemon=True).start();return
                self.send_json(404,{'error':'not found'})
            except BlockingIOError as ex: self.send_json(409,{'error':str(ex)})
            except Exception as ex: self.send_json(500,{'error':str(ex)})
    server=ThreadingHTTPServer(('127.0.0.1',args.port),Handler)
    def watcher():
        while engine.status['enabled']:
            if engine.status['watch'] and not engine.status['busy']:
                try: engine.capture()
                except Exception as ex: engine.status['last_error']=str(ex)
            time.sleep(35)
    threading.Thread(target=watcher,daemon=True).start()
    print(json.dumps({'ready':True,'port':args.port,'models':[engine.status['vlm'],engine.status['detector']]}),flush=True)
    server.serve_forever()


if __name__=='__main__': main()
