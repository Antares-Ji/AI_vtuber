"""Local CPU OCR API. Accepts existing native frames; never sends input."""
import json
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import threading
import time
import socket
from PIL import Image
from rapidocr import RapidOCR
import rapidocr

ROOT=Path(__file__).resolve().parents[2]
RUNS=(ROOT/'runtime/game-input/runs').resolve()
OUT=ROOT/'runtime/game-input/learning'
models=Path(rapidocr.__file__).parent/'models'
params={'Global.log_level':'warning','EngineConfig.onnxruntime.intra_op_num_threads':2,'EngineConfig.onnxruntime.inter_op_num_threads':1}
for task,name in [('Det','PP-OCRv6_det_small.onnx'),('Cls','ch_ppocr_mobile_v2.0_cls_mobile.onnx'),('Rec','PP-OCRv6_rec_small.onnx')]:
    path=models/name
    if not path.is_file():raise RuntimeError('Missing bundled model: '+name)
    params[task+'.model_path']=str(path)
engine=RapidOCR(params=params)
lock=threading.Lock()
class Handler(BaseHTTPRequestHandler):
    def log_message(self,*args):pass
    def reply(self,code,data):
        payload=json.dumps(data,ensure_ascii=False).encode()
        self.send_response(code);self.send_header('Content-Type','application/json');self.send_header('Content-Length',str(len(payload)));self.end_headers();self.wfile.write(payload)
    def trusted(self):return self.headers.get('Host') in ('127.0.0.1:17647','localhost:17647') and not self.headers.get('Origin')
    def do_GET(self):
        if not self.trusted():return self.reply(403,{'error':'Local clients only'})
        if self.path!='/health':return self.reply(404,{'error':'Unknown route'})
        self.reply(200,{'ready':True,'busy':lock.locked(),'model':'RapidOCR PP-OCRv6 small','provider':'CPU','read_only':True})
    def do_POST(self):
        if not self.trusted():return self.reply(403,{'error':'Local clients only'})
        if self.path!='/read':return self.reply(404,{'error':'Unknown route'})
        if not lock.acquire(False):return self.reply(409,{'error':'Busy'})
        try:
            self.connection.settimeout(10)
            size=int(self.headers.get('Content-Length',0))
            if not 0<size<=8192:raise ValueError('Bounded JSON required')
            body=json.loads(self.rfile.read(size));path=Path(body['image']).resolve()
            if not path.is_relative_to(RUNS) or path.suffix.lower() not in ('.jpg','.png'):raise ValueError('Only native screenshots')
            im=Image.open(path).convert('RGB');width,height=im.size
            crop=body.get('crop',[0,0,1,1])
            if len(crop)!=4 or any(type(v) not in (int,float) or not 0<=v<=1 for v in crop) or crop[0]>=crop[2] or crop[1]>=crop[3]:raise ValueError('Invalid crop')
            bounds=(round(crop[0]*width),round(crop[1]*height),round(crop[2]*width),round(crop[3]*height))
            im=im.crop(bounds);scale=body.get('scale',1)
            if scale not in (1,2):raise ValueError('Scale must be 1 or 2')
            if scale==2:im=im.resize((im.width*2,im.height*2),Image.Resampling.LANCZOS)
            started=time.monotonic();result=engine(im,use_cls=False)
            lines=[]
            if result.boxes is not None:
                for box,txt,score in zip(result.boxes,result.txts,result.scores):
                    lines.append({'text':txt,'confidence':float(score),'box':[[round((float(x)/scale+bounds[0])/width*1000,2),round((float(y)/scale+bounds[1])/height*1000,2)] for x,y in box]})
            data={'source_image':str(path),'crop':crop,'scale':scale,'model':'RapidOCR PP-OCRv6 small CPU','seconds':round(time.monotonic()-started,3),'lines':lines,'verification':'unverified_local_ocr','training_performed':False}
            OUT.mkdir(parents=True,exist_ok=True)
            record=OUT/f'ocr-{time.time_ns()}.json';record.write_text(json.dumps(data,ensure_ascii=False,indent=2),encoding='utf-8');data['record']=str(record)
            self.reply(200,data)
        except Exception as error:self.reply(500,{'error':str(error)})
        finally:lock.release()
class LocalServer(ThreadingHTTPServer):
    allow_reuse_address=False
    def server_bind(self):
        if hasattr(socket,'SO_EXCLUSIVEADDRUSE'):self.socket.setsockopt(socket.SOL_SOCKET,socket.SO_EXCLUSIVEADDRUSE,1)
        super().server_bind()
server=LocalServer(('127.0.0.1',17647),Handler)
print(json.dumps({'port':17647,'read_only':True}),flush=True)
server.serve_forever()
