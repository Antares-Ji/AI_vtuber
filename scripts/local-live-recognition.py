"""Capture -> localhost Qwen+YOLO -> journal, continuously without a chat agent."""
import argparse
import ctypes
import json
import statistics
import subprocess
import time
import urllib.request
from ctypes import wintypes
from pathlib import Path
import mss
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--frames', type=int, default=10)
    parser.add_argument('--strategy', choices=['stage-fast', 'objects'], default='objects')
    args = parser.parse_args()
    if not 1 <= args.frames <= 100:
        parser.error('frames must be 1..100')
    u = ctypes.WinDLL('user32', use_last_error=True)
    u.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    u.GetForegroundWindow.restype = wintypes.HWND
    u.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
    u.GetAncestor.restype = wintypes.HWND
    u.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    u.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
    u.WindowFromPoint.argtypes = [wintypes.POINT]
    u.WindowFromPoint.restype = wintypes.HWND
    info = json.loads(subprocess.check_output(['node',str(ROOT/'scripts/game-controller-request.js'),'status'],
        cwd=ROOT,text=True,creationflags=0x08000000))['info']
    hwnd = info['handle']
    run = str(time.time_ns())
    out = ROOT/'runtime/vision/local-recognition'/run
    out.mkdir(parents=True)
    captures = ROOT/'runtime/vlm/live-20260911'
    rows = []
    with mss.MSS() as screen, (out/'results.jsonl').open('w',encoding='utf-8',buffering=1) as log:
        for i in range(args.frames):
            start = time.perf_counter()
            if u.GetAncestor(u.GetForegroundWindow(),3) != hwnd:
                raise RuntimeError('Game not foreground; no capture submitted')
            origin, rect = wintypes.POINT(), wintypes.RECT()
            if not u.GetClientRect(hwnd,ctypes.byref(rect)) or not u.ClientToScreen(hwnd,ctypes.byref(origin)):
                raise RuntimeError('Game window unavailable')
            for x,y in ((.02,.02),(.5,.5),(.98,.98)):
                hit = u.WindowFromPoint(wintypes.POINT(origin.x+int(rect.right*x),origin.y+int(rect.bottom*y)))
                if u.GetAncestor(hit,3) != hwnd:
                    raise RuntimeError('Game covered; no capture submitted')
            shot = screen.grab(dict(left=origin.x,top=origin.y,width=rect.right,height=rect.bottom))
            name = f'local-{run}-{i}.png'
            Image.frombytes('RGB',shot.size,shot.rgb).save(captures/name)
            captured = time.perf_counter()
            request = urllib.request.Request('http://127.0.0.1:17642/analyze',
                data=json.dumps(dict(image=name,target='识别画面中的物体',mode='hybrid',strategy=args.strategy)).encode(),
                headers={'Content-Type':'application/json'})
            with urllib.request.urlopen(request,timeout=90) as response:
                result = json.load(response)
            done = time.perf_counter()
            row = dict(frame=i,image=str(captures/name),capture_and_save_ms=(captured-start)*1000,
                full_local_ms=(done-start)*1000,recognition=result, label_status='unreviewed_prediction_not_training_truth')
            rows.append(row)
            log.write(json.dumps(row,ensure_ascii=False)+'\n')
            print(json.dumps(dict(frame=i,ms=row['full_local_ms'],parsed=result.get('parsed'),
                errors=result.get('validation_errors')),ensure_ascii=False),flush=True)
    values=sorted(r['full_local_ms'] for r in rows)
    summary=dict(frames=len(rows),strategy=args.strategy,median_ms=statistics.median(values),
        p95_ms=values[min(len(values)-1,int(.95*len(values)))],
        valid=sum(not r['recognition'].get('validation_errors') for r in rows),
        scope='Fresh game capture and PNG encoding through local Qwen+YOLO response. No cloud/chat in frame loop. No mouse input.',
        model='Qwen3-VL-4B-Instruct BF16 + YOLO11n COCO', semantic_accuracy='not measured',directory=str(out))
    (out/'summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(summary,ensure_ascii=False),flush=True)

if __name__ == '__main__': main()
