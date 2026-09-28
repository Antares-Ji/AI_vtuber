"""Independent wall-clock game recorder. No model, OCR or object detection."""
import argparse
import ctypes
import json
import time
from ctypes import wintypes
from pathlib import Path
import cv2
import mss
import numpy as np

ROOT = Path(__file__).resolve().parents[1]

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--hwnd', type=int, required=True)
    parser.add_argument('--seconds', type=int, default=180)
    parser.add_argument('--fps', type=int, default=20)
    args = parser.parse_args()
    if not 1 <= args.seconds <= 600 or not 1 <= args.fps <= 30:
        parser.error('seconds 1..600, fps 1..30')
    out = ROOT/'runtime/vision/timing-recordings'/str(time.time_ns())
    out.mkdir(parents=True)
    u = ctypes.WinDLL('user32', use_last_error=True)
    u.SetProcessDpiAwarenessContext.argtypes = [ctypes.c_void_p]
    u.SetProcessDpiAwarenessContext(ctypes.c_void_p(-4))
    u.GetForegroundWindow.restype = wintypes.HWND
    u.GetAncestor.argtypes = [wintypes.HWND, wintypes.UINT]
    u.GetAncestor.restype = wintypes.HWND
    u.GetClientRect.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.RECT)]
    u.ClientToScreen.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.POINT)]
    u.GetCursorPos.argtypes = [ctypes.POINTER(wintypes.POINT)]
    u.GetAsyncKeyState.argtypes = [ctypes.c_int]
    u.GetAsyncKeyState.restype = ctypes.c_short
    u.WindowFromPoint.argtypes = [wintypes.POINT]
    u.WindowFromPoint.restype = wintypes.HWND
    writer = cv2.VideoWriter(str(out/'recording.avi'), cv2.VideoWriter_fourcc(*'MJPG'), args.fps, (800, 544))
    if not writer.isOpened():
        raise RuntimeError('Cannot open video writer')
    start = time.perf_counter_ns()
    wall_start = time.time_ns()
    count = 0
    previous_keys = {}
    previous_pixels = None
    previous_visible = None
    input_edges = 0
    def elapsed(): return (time.perf_counter_ns()-start)/1e9
    log = (out/'timeline.jsonl').open('w', encoding='utf-8', buffering=1)
    def event(kind, **fields):
        log.write(json.dumps(dict(event=kind, elapsed_s=elapsed(), **fields))+'\n')
    (out.parent/'active.json').write_text(json.dumps(dict(directory=str(out), hwnd=args.hwnd)), encoding='utf-8')
    event('recording_started', utc_unix_ns=wall_start, clock='perf_counter_ns', fps=args.fps)
    print(str(out), flush=True)
    try:
        with mss.MSS() as screen:
            while elapsed() < args.seconds and not (out/'stop').exists():
                tick = time.perf_counter()
                origin, rect = wintypes.POINT(), wintypes.RECT()
                visible = u.GetAncestor(u.GetForegroundWindow(), 3) == args.hwnd
                if not u.GetClientRect(args.hwnd, ctypes.byref(rect)) or not u.ClientToScreen(args.hwnd, ctypes.byref(origin)):
                    raise RuntimeError('Game window unavailable')
                width, height = rect.right, rect.bottom
                for x,y in ((.02,.02),(.5,.5),(.98,.98)):
                    hit = u.WindowFromPoint(wintypes.POINT(origin.x+int(width*x), origin.y+int(height*y)))
                    visible = visible and u.GetAncestor(hit, 3) == args.hwnd
                if visible != previous_visible:
                    event('visibility', visible=bool(visible))
                    previous_visible = visible
                if visible:
                    capture_start = elapsed()
                    shot = np.asarray(screen.grab(dict(left=origin.x, top=origin.y, width=width, height=height)))[:,:,:3]
                    capture_end = elapsed()
                    cursor = wintypes.POINT()
                    u.GetCursorPos(ctypes.byref(cursor))
                    keys = {name:bool(u.GetAsyncKeyState(code)&0x8000) for name,code in [('left',1),('F8',0x77),('F9',0x78)]}
                    for name, down in keys.items():
                        if down != previous_keys.get(name, False):
                            input_edges += 1
                            event('input_edge', key=name, down=down, cursor=[cursor.x-origin.x,cursor.y-origin.y])
                    previous_keys = keys
                    # Raw RGB triplets only. A change is NOT automatically a battle/deployment event.
                    pixels = [shot[int(height*y),int(width*x)].astype(int).tolist() for x,y in ((.4,.03),(.54,.03),(.94,.82))]
                    if previous_pixels is not None and max(abs(a-b) for p,q in zip(pixels,previous_pixels) for a,b in zip(p,q)) >= 40:
                        event('three_point_change_candidate', bgr=pixels)
                    previous_pixels = pixels
                    frame = np.zeros((544,800,3),dtype=np.uint8)
                    frame[:512] = cv2.resize(shot,(800,512))
                    cv2.putText(frame,f'T+{capture_end:09.3f}s | frame {count} | LMB poll {int(keys["left"])} (unverified)',
                        (8,534),cv2.FONT_HERSHEY_SIMPLEX,.55,(255,255,255),1)
                    writer.write(frame)
                    log.write(json.dumps(dict(event='frame',index=count,capture_start_s=capture_start,
                        capture_end_s=capture_end,left=keys['left'],cursor=[cursor.x-origin.x,cursor.y-origin.y]))+'\n')
                    count += 1
                time.sleep(max(0,1/args.fps-(time.perf_counter()-tick)))
    finally:
        event('recording_stopped', frames=count)
        writer.release()
        log.close()
        (out/'summary.json').write_text(json.dumps(dict(frames=count,elapsed_s=elapsed(),fps=args.fps,
            measurement='Use per-frame capture timestamps; AVI playback rate is not the wall clock if frames were skipped.',
            markers='F8/F9 edges optional manual markers. Three-point changes require video review. No semantic inference.',
            input_edges=input_edges, input_telemetry='unverified polling; zero edges does not prove no input',
            input_resolution_ms=1000/args.fps),indent=2),encoding='utf-8')

if __name__ == '__main__': main()
