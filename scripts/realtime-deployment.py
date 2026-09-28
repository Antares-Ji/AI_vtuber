"""Finite local 0-1 deployment. Local card YOLO + cached image gates; no chat calls.

Started by the already-authorized native controller, prewarmed before level load.
Qwen confirms the stage in the parent navigation loop; it is not in the gesture loop.
"""
import argparse,ctypes,json,os,time,importlib.util,hashlib,urllib.request
from ctypes import wintypes as W
from pathlib import Path
import cv2,numpy as np,mss
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('reference',ROOT/'scripts/deployment-reference-check.py')
reference=importlib.util.module_from_spec(spec);spec.loader.exec_module(reference)

class MouseInput(ctypes.Structure):
    _fields_=[('dx',W.LONG),('dy',W.LONG),('mouseData',W.DWORD),('dwFlags',W.DWORD),('time',W.DWORD),('dwExtraInfo',ctypes.c_size_t)]
class KeyboardInput(ctypes.Structure):
    _fields_=[('wVk',W.WORD),('wScan',W.WORD),('dwFlags',W.DWORD),('time',W.DWORD),('dwExtraInfo',ctypes.c_size_t)]
class InputUnion(ctypes.Union):_fields_=[('mi',MouseInput),('ki',KeyboardInput)]
class Input(ctypes.Structure):_fields_=[('type',W.DWORD),('data',InputUnion)]

class Native:
    def __init__(self,hwnd,cancel):
        self.hwnd=hwnd;self.cancel=cancel;self.pressed=False;self.focus_epoch=0;self.u=ctypes.WinDLL('user32',use_last_error=True)
        u=self.u
        u.SetThreadDpiAwarenessContext.argtypes=[ctypes.c_void_p];u.SetThreadDpiAwarenessContext.restype=ctypes.c_void_p
        u.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        u.GetForegroundWindow.restype=W.HWND
        u.GetAncestor.argtypes=[W.HWND,W.UINT];u.GetAncestor.restype=W.HWND
        u.GetClientRect.argtypes=[W.HWND,ctypes.POINTER(W.RECT)]
        u.ClientToScreen.argtypes=[W.HWND,ctypes.POINTER(W.POINT)]
        u.GetCursorPos.argtypes=[ctypes.POINTER(W.POINT)]
        u.WindowFromPoint.argtypes=[W.POINT];u.WindowFromPoint.restype=W.HWND
        u.SendInput.argtypes=[W.UINT,ctypes.POINTER(Input),ctypes.c_int];u.SendInput.restype=W.UINT
        u.mouse_event.argtypes=[W.DWORD,W.DWORD,W.DWORD,W.DWORD,ctypes.c_size_t]
        u.GetAsyncKeyState.argtypes=[ctypes.c_int];u.GetAsyncKeyState.restype=ctypes.c_short
        if ctypes.sizeof(Input)!=40:raise RuntimeError('Unexpected native INPUT layout')
    def bounds(self):
        if self.cancel.exists():raise RuntimeError('Local deployment cancelled')
        u=self.u
        u.SetThreadDpiAwarenessContext(ctypes.c_void_p(-4))
        if u.GetAncestor(u.GetForegroundWindow(),3)!=self.hwnd:
            was_pressed=self.pressed;self.release()
            checkpoint=self.cancel.parent/('focus-interruption-'+str(time.time_ns())+'.json')
            detail=dict(event='focus_lost',hwnd=self.hwnd,gesture_interrupted=was_pressed,replayed=False)
            checkpoint.write_text(json.dumps(detail),encoding='utf8')
            if was_pressed:raise RuntimeError('Focus lost during gesture; released, no replay; reobserve checkpoint required')
            token=(ROOT/'runtime/vlm/controller/token.txt').read_text().strip()
            deadline=time.perf_counter()+8
            while time.perf_counter()<deadline:
                if self.cancel.exists():raise RuntimeError('Local deployment cancelled')
                request=urllib.request.Request('http://127.0.0.1:17644/capture',data=b'{}',headers={'Content-Type':'application/json','Authorization':'Bearer '+token})
                try:
                    with urllib.request.urlopen(request,timeout=2) as response:status=json.load(response)
                    if status.get('ok') and status.get('info',{}).get('handle')==self.hwnd and u.GetAncestor(u.GetForegroundWindow(),3)==self.hwnd:
                        self.focus_epoch+=1;detail.update(event='focus_recovered',focus_epoch=self.focus_epoch,capture_path=status.get('path'))
                        checkpoint.write_text(json.dumps(detail),encoding='utf8');break
                except Exception:pass
                time.sleep(.15)
            else:raise RuntimeError('Game focus not recovered within bounded wait; checkpoint preserved')
        rect=W.RECT();origin=W.POINT()
        if not u.GetClientRect(self.hwnd,ctypes.byref(rect)) or not u.ClientToScreen(self.hwnd,ctypes.byref(origin)):raise RuntimeError('Game unavailable')
        if rect.bottom<512 or rect.right<800 or abs(rect.right/rect.bottom-1600/1024)>.01:raise RuntimeError('Client aspect ratio does not match validated game layout')
        return {'left':origin.x,'top':origin.y,'width':rect.right,'height':rect.bottom}
    def send(self,flags,x=0,y=0):
        item=Input(0,InputUnion(MouseInput(x,y,0,flags,0,0)))
        if self.u.SendInput(1,ctypes.byref(item),ctypes.sizeof(Input))!=1:raise RuntimeError('Native input rejected')
        if flags==0x0002:self.pressed=True
    def move(self,point):
        u=self.u;vx,vy,vw,vh=[u.GetSystemMetrics(i) for i in (76,77,78,79)]
        if vw<=1 or vh<=1:raise RuntimeError('Virtual display unavailable')
        self.send(0xC001,round((point[0]-vx)*65535/(vw-1)),round((point[1]-vy)*65535/(vh-1)))
    def pixel(self,p,box):
        if len(p)!=2 or any(not np.isfinite(v) or not 0<=v<=1 for v in p):raise ValueError('Invalid point')
        return (box['left']+round(p[0]*(box['width']-1)),box['top']+round(p[1]*(box['height']-1)))
    def verify(self,expected):
        p=W.POINT();self.u.GetCursorPos(ctypes.byref(p))
        if abs(p.x-expected[0])>32 or abs(p.y-expected[1])>32:raise RuntimeError('Cursor did not reach target')
        if self.u.GetAncestor(self.u.WindowFromPoint(p),2)!=self.hwnd:raise RuntimeError('Pointer is over another window')
    def release(self):
        if self.pressed:self.u.mouse_event(0x0004,0,0,0,0);self.pressed=False
    def tap_scan(self,scan):
        if scan not in (0x21,0x12,0x01,0x39):raise ValueError('Unsupported game shortcut')
        epoch=self.focus_epoch;self.bounds()
        if self.focus_epoch!=epoch:raise RuntimeError('Focus recovered before key; reobserve before any input')
        def key(flags):
            item=Input(1,InputUnion(ki=KeyboardInput(0,scan,flags,0,0)))
            if self.u.SendInput(1,ctypes.byref(item),ctypes.sizeof(Input))!=1:raise RuntimeError('Keyboard input rejected')
        try:key(0x0008);time.sleep(.04)
        finally:key(0x000A)
    def tap_f(self):self.tap_scan(0x21)
    def tap_e(self):self.tap_scan(0x12)
    def tap_escape(self):self.tap_scan(0x01)
    def tap_space(self):self.tap_scan(0x39)
    def click(self,p):
        epoch=self.focus_epoch;box=self.bounds()
        if self.focus_epoch!=epoch:raise RuntimeError('Focus recovered before click; reobserve before any input')
        target=self.pixel(p,box);self.move(target);time.sleep(.005);self.verify(target)
        try:self.send(0x0002);time.sleep(.060)
        finally:self.release()
    def drag(self,a,b,duration):
        epoch=self.focus_epoch;box=self.bounds()
        if self.focus_epoch!=epoch:raise RuntimeError('Focus recovered before drag; reobserve before any input')
        start=self.pixel(a,box);end=self.pixel(b,box)
        self.move(start);time.sleep(.005);self.verify(start)
        try:
            self.send(0x0002);time.sleep(.020)
            steps=8
            for i in range(1,steps+1):
                if self.bounds()!=box:raise RuntimeError('Window moved during drag')
                self.move((round(start[0]+(end[0]-start[0])*i/steps),round(start[1]+(end[1]-start[1])*i/steps)))
                time.sleep(duration/steps)
            time.sleep(.016);self.verify(end)
        finally:self.release()
        return {'releaseMethod':'mouse_event','leftButtonReleased':not bool(self.u.GetAsyncKeyState(1)&0x8000)}

def main():
    p=argparse.ArgumentParser();p.add_argument('--hwnd',type=int,required=True);p.add_argument('--out',type=Path,required=True);p.add_argument('--seconds',type=int,default=90)
    p.add_argument('--operators',type=int,choices=[1,3],default=1);p.add_argument('--speed',type=int,choices=[1,2],default=1);p.add_argument('--skill',action='store_true')
    p.add_argument('--resume-deployed',type=int,choices=[3]);a=p.parse_args()
    if not 1<=a.seconds<=180:raise ValueError('Invalid duration')
    out=a.out.resolve();allowed=(ROOT/'runtime/vision/realtime-deployment').resolve()
    if not out.is_relative_to(allowed):raise ValueError('Invalid output directory')
    out.mkdir(parents=True,exist_ok=True)
    started=time.perf_counter_ns();events=(out/'events.jsonl').open('w',encoding='utf8',buffering=1)
    saves=[];native=Native(a.hwnd,out/'cancel')
    def elapsed():return (time.perf_counter_ns()-started)/1e9
    def log(event,**data):events.write(json.dumps(dict(event=event,t=elapsed(),utc_ns=time.time_ns(),**data))+'\n')
    def save(frame,label):
        # Keep evidence in RAM during the gesture; PNG encoding can wait.
        name=f'{label}.png';saves.append((out/name,frame.copy()));return name
    result={'ok':False};battle_seen=None;ready_seen=None
    try:
        os.environ.setdefault('YOLO_CONFIG_DIR',str(ROOT/'runtime/vlm/yolo-config'))
        from ultralytics import YOLO,settings
        settings.update({'sync':False})
        training=ROOT/'runtime/vlm/training/deployment-card-v1'
        gate=json.loads((training/'deployment-gate.json').read_text(encoding='utf8'))
        if not gate.get('approved_for_reference_gated_0_1'):raise RuntimeError('Card detector did not pass the deployment gate')
        detector=YOLO(str(training/'fit/weights/best.pt'))
        detector.predict(np.zeros((174,400,3),np.uint8),imgsz=320,device=0,verbose=False)
        # Warm all expensive reference data before the parent starts the level.
        reference.inspect_frame(reference.reference('selected.png'),'fast-tile')
        reference.inspect_frame(reference.reference('direction.png'),'direction')
        reference.inspect_frame(reference.reference('landed.png'),'landed')
        reference.inspect_frame(reference.reference('battle-ready.png'),'battle-card')
        log('warm_ready',client=native.bounds(),analysis_size=[1600,1024],protocol='card-local-v2',
            sha256={str(file.relative_to(ROOT)):hashlib.sha256(file.read_bytes()).hexdigest() for file in [Path(__file__),ROOT/'scripts/deployment-reference-check.py',training/'fit/weights/best.pt']})
        (out/'ready.json').write_text(json.dumps({'ready':True,'t':elapsed(),'model':str(training/'fit/weights/best.pt')}),encoding='utf8')
        with mss.MSS() as screen:
            def capture():
                box=native.bounds();frame=np.asarray(screen.grab(box))[:,:,:3].copy()
                if frame.shape[:2]!=(box['height'],box['width']):raise RuntimeError('Capture coordinate scale changed')
                if frame.shape[:2]!=(1024,1600):frame=cv2.resize(frame,(1600,1024))
                return frame,elapsed()
            if a.resume_deployed:
                from local_battle_followup import run_followup
                result={'ok':True,'scope':'Resume confirmed three-operator battle; no new first-deployment timing.',
                    'followup':run_followup(native,capture,log,out,3,a.speed,a.skill,start_deployed=3)}
                return
            deadline=elapsed()+a.seconds
            card=None;last_report=-1
            while elapsed()<deadline:
                frame,at=capture();state=reference.inspect_frame(frame,'battle-card')
                if state['portrait_visible'] and battle_seen is None:
                    battle_seen=at;log('battle_seen',frame_time=at,state=state,image=save(frame,'battle-seen'))
                if state['ready']:
                    detection_start=elapsed();prediction=detector.predict(frame[850:1024,:400],imgsz=320,conf=.70,device=0,verbose=False)[0]
                    candidates=[]
                    for b in prediction.boxes:
                        x1,y1,x2,y2=b.xyxy[0].tolist();center=[(x1+x2)/3200,(850+(y1+y2)/2)/1024]
                        if 0<center[0]<.085 and .87<center[1]<.99:candidates.append({'point':center,'confidence':float(b.conf.item()),'box':[x1,y1,x2,y2]})
                    if candidates:
                        card=max(candidates,key=lambda b:b['confidence'])['point'];ready_seen=at
                        log('card_ready',frame_time=at,state=state,yolo=candidates,yolo_wall_ms=(elapsed()-detection_start)*1000,image=save(frame,'card-ready'));break
                if int(elapsed())!=last_report:
                    last_report=int(elapsed());log('watch',state=state)
                time.sleep(.025)
            if card is None:raise RuntimeError('No verified affordable Bagpipe card before timeout')
            native.click(card);log('card_click')
            until=elapsed()+2;previous=None;stable=0;tile=None
            while elapsed()<until:
                frame,at=capture();check=reference.inspect_frame(frame,'fast-tile')
                if check['ok']:
                    target=check['target_point'];distance=np.linalg.norm((np.array(target)-previous)*[1600,1024]) if previous is not None else 1e9
                    stable=stable+1 if distance<4 else 0;previous=np.array(target)
                    if stable>=1:tile=target;log('green_stable',frame_time=at,check=check,image=save(frame,'selected'));break
                time.sleep(.01)
            if tile is None:raise RuntimeError('No stable green tile after card selection')
            released=native.drag(card,tile,.09);log('drop_released',**released)
            until=elapsed()+1;diamond=None
            while elapsed()<until:
                frame,at=capture();check=reference.inspect_frame(frame,'direction')
                if check['ok']:diamond=check['target_point'];log('direction_visible',frame_time=at,check=check,image=save(frame,'direction'));break
                time.sleep(.01)
            if diamond is None:raise RuntimeError('No actual direction selector after release')
            if diamond[0]>.85:raise RuntimeError('Direction endpoint outside safe region')
            released=native.drag(diamond,[diamond[0]+.12,diamond[1]],.05);log('direction_released',**released)
            until=elapsed()+1
            while elapsed()<until:
                frame,at=capture();check=reference.inspect_frame(frame,'landed')
                if check['ok']:
                    log('landed',frame_time=at,check=check,image=save(frame,'landed'))
                    result={'ok':True,'battle_seen_to_landed_s':at-battle_seen,'ready_to_landed_s':at-ready_seen,'landed_t':at,'scope':'Local single-card YOLO, cached map/direction/counter checks. Qwen stage navigation occurs in parent. Independent recording still required.'};break
                time.sleep(.01)
            if not result['ok']:raise RuntimeError('Deployment not visually confirmed')
            if a.operators>1 or a.speed==2 or a.skill:
                from local_battle_followup import run_followup
                # First-deployment timings remain independent of this extension.
                first_result=result.copy()
                try:
                    result['followup']=run_followup(native,capture,log,out,a.operators,a.speed,a.skill)
                except Exception as error:
                    progress=out/'followup-progress.json'
                    result['followup']=json.loads(progress.read_text(encoding='utf8')) if progress.exists() else {}
                    result['followup'].update(ok=False,error=str(error));log('followup_failure',error=str(error))
                    try:
                        frame,_=capture()
                        dismiss=reference.inspect_frame(frame,'profile-dismiss')
                        if dismiss['ok']:
                            native.click(dismiss['target_point']);log('selection_dismissed_on_failure')
                    except Exception as cleanup_error:log('selection_cleanup_failed',error=str(cleanup_error))
                result['first_deployment']=first_result
    except Exception as error:
        result={'ok':False,'error':str(error)};log('failure',error=str(error))
    finally:
        native.release()
        for filename,frame in saves:
            if not cv2.imwrite(str(filename),frame):result.setdefault('evidence_errors',[]).append(str(filename))
        result['output']=str(out);result['elapsed_s']=elapsed()
        temporary=out/'summary.tmp';temporary.write_text(json.dumps(result,indent=2),encoding='utf8');temporary.replace(out/'summary.json')
        events.close()

if __name__=='__main__':main()
