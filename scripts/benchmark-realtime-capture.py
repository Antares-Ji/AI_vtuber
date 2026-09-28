"""Finite read-only live capture + generic detector latency probe. No game input."""
import ctypes,json,time,subprocess,statistics,os
from ctypes import wintypes
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
OUT=ROOT/'runtime/vlm/realtime-probe';OUT.mkdir(parents=True,exist_ok=True)
os.environ.setdefault('YOLO_CONFIG_DIR',str(ROOT/'runtime/vlm/yolo-config'))
u=ctypes.WinDLL('user32',use_last_error=True)
u.SetProcessDpiAwarenessContext.argtypes=[ctypes.c_void_p]
u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
u.GetForegroundWindow.restype=wintypes.HWND
u.GetAncestor.argtypes=[wintypes.HWND,wintypes.UINT];u.GetAncestor.restype=wintypes.HWND
u.WindowFromPoint.argtypes=[wintypes.POINT];u.WindowFromPoint.restype=wintypes.HWND
u.GetClientRect.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.RECT)]
u.ClientToScreen.argtypes=[wintypes.HWND,ctypes.POINTER(wintypes.POINT)]
info=json.loads(subprocess.check_output(['node',str(ROOT/'scripts/game-controller-request.js'),'status'],cwd=ROOT,text=True,creationflags=0x08000000))['info']
hwnd=info['handle']
def bounds():
 if u.GetAncestor(u.GetForegroundWindow(),3)!=hwnd: raise RuntimeError('Game is not foreground; stop capture')
 rect=wintypes.RECT();origin=wintypes.POINT(0,0)
 if not u.GetClientRect(hwnd,ctypes.byref(rect)) or not u.ClientToScreen(hwnd,ctypes.byref(origin)): raise RuntimeError('Window unavailable')
 for fx,fy in [(0.02,0.02),(.5,.02),(.98,.02),(.02,.5),(.5,.5),(.98,.5),(.02,.98),(.5,.98),(.98,.98)]:
  hit=u.WindowFromPoint(wintypes.POINT(origin.x+int(rect.right*fx),origin.y+int(rect.bottom*fy)))
  if u.GetAncestor(hit,3)!=hwnd: raise RuntimeError('Game covered; stop capture')
 return dict(left=origin.x,top=origin.y,width=rect.right,height=rect.bottom)
import mss,numpy as np,torch
from ultralytics import YOLO,settings
settings.update({'sync':False})
model=YOLO(str(ROOT/'runtime/vlm/models/YOLO11/yolo11n.pt'))
model.predict(np.zeros((640,640,3),dtype=np.uint8),device=0,verbose=False)
rows=[]
with mss.MSS() as screen:
 for i in range(120):
  start=time.perf_counter();box=bounds();guard_done=time.perf_counter()
  shot=screen.grab(box);frame=np.array(shot)[:,:,:3].copy();capture_done=time.perf_counter()
  torch.cuda.synchronize();result=model.predict(frame,device=0,verbose=False)[0];torch.cuda.synchronize();done=time.perf_counter()
  rows.append(dict(frame=i,guard_ms=(guard_done-start)*1000,capture_ms=(capture_done-guard_done)*1000,
   inference_ms=(done-capture_done)*1000,total_ms=(done-start)*1000,start=start,
   detections=[dict(label=result.names[int(b.cls.item())],confidence=float(b.conf.item()),xyxy=b.xyxy[0].tolist()) for b in result.boxes]))
  if i in (0,119):
   from PIL import Image
   Image.frombytes('RGB',shot.size,shot.rgb).save(OUT/f'frame-{i}.png')
  if i%30==29: print(f'{i+1}/120 frames',flush=True)
  time.sleep(max(0,.05-(time.perf_counter()-start)))
summary={}
for field in ['guard_ms','capture_ms','inference_ms','total_ms']:
 values=sorted(r[field] for r in rows)
 summary[field]=dict(median=statistics.median(values),p95=values[int(.95*(len(values)-1))],maximum=max(values))
summary.update(frames=len(rows),target_sampling_hz=20,achieved_sampling_hz=(len(rows)-1)/(rows[-1]['start']-rows[0]['start']),
 scope='Menu capture and generic COCO detection only. No enemy accuracy, tracking, planning or input measured.')
(OUT/'results.json').write_text(json.dumps(dict(summary=summary,frames=rows),ensure_ascii=False,indent=2),encoding='utf8')
print(json.dumps(summary,indent=2),flush=True)
