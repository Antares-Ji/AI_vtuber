"""Reversible 16:9 client sizing for BetterGI. No game keyboard/mouse input."""
import ctypes as C,json,pathlib,sys,time,psutil
from ctypes import wintypes as W
ROOT=pathlib.Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/'scripts/sts2'))
from native_input import NativeInput

class _RestoreBackend:
 """Window-only adapter; no SendInput calls and no implicit constructor restore."""
 def __init__(self):
  self.user=C.WinDLL('user32',use_last_error=True);self.kernel=C.WinDLL('kernel32',use_last_error=True)
  u,k=self.user,self.kernel
  for name in ('IsWindowVisible','IsIconic','IsWindow'):
   getattr(u,name).argtypes=[W.HWND];getattr(u,name).restype=W.BOOL
  u.GetWindowThreadProcessId.argtypes=[W.HWND,C.POINTER(W.DWORD)]
  u.ShowWindow.argtypes=[W.HWND,C.c_int];u.ShowWindow.restype=W.BOOL
  u.GetAsyncKeyState.argtypes=[C.c_int];u.GetAsyncKeyState.restype=W.SHORT
  k.CreateMutexW.argtypes=[C.c_void_p,W.BOOL,W.LPCWSTR];k.CreateMutexW.restype=W.HANDLE
  k.WaitForSingleObject.argtypes=[W.HANDLE,W.DWORD];k.WaitForSingleObject.restype=W.DWORD
  k.ReleaseMutex.argtypes=[W.HANDLE];k.CloseHandle.argtypes=[W.HANDLE]
  k.OpenProcess.argtypes=[W.DWORD,W.BOOL,W.DWORD];k.OpenProcess.restype=W.HANDLE
  self.mutex=None;self.acquired=False
 def acquire(self):
  self.mutex=self.kernel.CreateMutexW(None,False,'Local\\AI_vtuber_native_game_input')
  if not self.mutex:raise C.WinError(C.get_last_error())
  self.acquired=self.kernel.WaitForSingleObject(self.mutex,0) in (0,0x80)
  if not self.acquired:raise RuntimeError('Native input busy; game window was not restored')
 def close(self):
  if self.acquired:self.kernel.ReleaseMutex(self.mutex)
  if self.mutex:self.kernel.CloseHandle(self.mutex)
 def emergency(self):return bool(self.user.GetAsyncKeyState(0x77)&0x8000)
 def target(self):
  candidates=[]
  callback_type=C.WINFUNCTYPE(W.BOOL,W.HWND,W.LPARAM)
  def visit(hwnd,_):
   if self.user.IsWindowVisible(hwnd):
    pid=W.DWORD();self.user.GetWindowThreadProcessId(hwnd,C.byref(pid))
    try:
     p=psutil.Process(pid.value)
     if p.name().lower()=='yuanshen.exe':candidates.append((hwnd,pid.value,p.create_time()))
    except (psutil.NoSuchProcess,psutil.AccessDenied):pass
   return True
  self.user.EnumWindows(callback_type(visit),0)
  if len(candidates)!=1:raise RuntimeError(f'Expected one visible YuanShen.exe window; found {len(candidates)}')
  return candidates[0]
 def check_identity(self,target):
  hwnd,pid,created=target;actual=W.DWORD()
  self.user.GetWindowThreadProcessId(hwnd,C.byref(actual))
  if not self.user.IsWindow(hwnd) or actual.value!=pid or psutil.Process(pid).create_time()!=created:
   raise RuntimeError('Game window identity changed; restore cancelled')
 def privileges(self,target):
  probe=NativeInput.__new__(NativeInput);probe.kernel=self.kernel;probe.pid=target[1]
  return probe.privileges()
 def minimized(self,target):return bool(self.user.IsIconic(target[0]))
 def restore(self,target):
  # ShowWindow returns prior visibility, not success. Verify IsIconic afterwards.
  self.user.ShowWindow(target[0],9);time.sleep(.3)
 def focus(self,target,cancel_file):
  c=NativeInput('YuanShen.exe',stop_file=cancel_file,restore_minimized=False)
  if c.pid!=target[1] or c.hwnd!=target[0]:raise RuntimeError('Game window changed before activation')
  c.focus()
  return list(c.client_rect())

def restore(cancel_file, cancelled=lambda:False, *, backend=None, stop_marker=None):
 """Explicit startup operation, called under the director desktop lease.

 STOP_INPUT must remain present (other native game input is stopped). The
 operation's own cancel file and F8 can revoke restoration independently.
 Nothing clears either stop file. Acquire the shared mutex before inspecting
 or changing the window, and check actual token compatibility before restore.
 """
 stop_marker=pathlib.Path(stop_marker or ROOT/'runtime/game-input/STOP_INPUT')
 cancel_file=pathlib.Path(cancel_file)
 def check():
  if not stop_marker.exists():raise RuntimeError('Stop native input first')
  if cancel_file.exists() or cancelled() or (backend is not None and backend.emergency()):
   raise InterruptedError('Window restore cancelled; no further window changes')
 check();backend=backend or _RestoreBackend()
 try:
  backend.acquire();check()
  target=backend.target();backend.check_identity(target)
  permissions=backend.privileges(target)
  if not permissions.get('privilege_compatible'):raise RuntimeError('Game window privilege mismatch; window was not restored')
  check();was_minimized=backend.minimized(target)
  if was_minimized:backend.restore(target)
  check();backend.check_identity(target)
  if backend.minimized(target):raise RuntimeError('Game remained minimized after explicit restore')
  client=backend.focus(target,cancel_file)
  check();backend.check_identity(target)
  return {'pid':target[1],'restored':was_minimized,'focused':True,'client':client,'inputSent':False,'verified':False,'permissions':permissions}
 finally:backend.close()

def ensure_visible(controller):
 """Keep the entire client on its monitor; screen capture clips offscreen UI."""
 u=controller.user
 class MONITORINFO(C.Structure):
  _fields_=[('cbSize',W.DWORD),('rcMonitor',W.RECT),('rcWork',W.RECT),('dwFlags',W.DWORD)]
 u.MonitorFromWindow.argtypes=[W.HWND,W.DWORD];u.MonitorFromWindow.restype=W.HANDLE
 u.GetMonitorInfoW.argtypes=[W.HANDLE,C.POINTER(MONITORINFO)];u.GetMonitorInfoW.restype=W.BOOL
 info=MONITORINFO();info.cbSize=C.sizeof(info)
 if not u.GetMonitorInfoW(u.MonitorFromWindow(controller.hwnd,2),C.byref(info)):raise C.WinError(C.get_last_error())
 x,y,w,h=controller.client_rect();area=info.rcWork
 if w>area.right-area.left or h>area.bottom-area.top:raise RuntimeError('Game client exceeds monitor work area; select a supported resolution')
 dx=max(area.left,min(x,area.right-w))-x;dy=max(area.top,min(y,area.bottom-h))-y
 if dx or dy:
  rect=W.RECT();u.GetWindowRect.argtypes=[W.HWND,C.POINTER(W.RECT)];u.GetWindowRect(controller.hwnd,C.byref(rect))
  u.SetWindowPos.argtypes=[W.HWND,W.HWND,C.c_int,C.c_int,C.c_int,C.c_int,W.UINT];u.SetWindowPos.restype=W.BOOL
  if not u.SetWindowPos(controller.hwnd,None,rect.left+dx,rect.top+dy,0,0,0x15):raise C.WinError(C.get_last_error())
  time.sleep(.3)
 return {'moved':bool(dx or dy),'client':controller.client_rect()}

def adjust():
 if not (ROOT/'runtime/game-input/STOP_INPUT').exists():raise RuntimeError('Stop native input first')
 c=NativeInput('YuanShen.exe',restore_minimized=False);u=c.user;k=c.kernel
 if not c.privileges()['privilege_compatible']:raise RuntimeError('Game window privilege mismatch')
 k.CreateMutexW.argtypes=[C.c_void_p,W.BOOL,W.LPCWSTR];k.CreateMutexW.restype=W.HANDLE;k.WaitForSingleObject.argtypes=[W.HANDLE,W.DWORD];k.ReleaseMutex.argtypes=[W.HANDLE]
 mutex=k.CreateMutexW(None,False,'Local\\AI_vtuber_native_game_input');acquired=False
 try:
  acquired=k.WaitForSingleObject(mutex,0) in [0,0x80]
  if not acquired:raise RuntimeError('Native input busy')
  before=c.client_rect();u.GetWindowRect.argtypes=[W.HWND,C.POINTER(W.RECT)];outer=W.RECT();u.GetWindowRect(c.hwnd,C.byref(outer))
  backup=ROOT/'runtime/genshin/window-before.json'
  if not backup.exists():backup.write_text(json.dumps({'pid':c.pid,'created':psutil.Process(c.pid).create_time(),'outer':[outer.left,outer.top,outer.right,outer.bottom],'client':before}),encoding='utf-8')
  # Installed AutoFight strategy/HP regions use the 1920x1080 reference frame.
  # A merely 16:9 window at 1600x900 still produces out-of-bounds task crops.
  width,height=1920,1080
  u.SetWindowPos.argtypes=[W.HWND,W.HWND,C.c_int,C.c_int,C.c_int,C.c_int,W.UINT];u.SetWindowPos.restype=W.BOOL
  if not u.SetWindowPos(c.hwnd,None,0,0,width+(outer.right-outer.left-before[2]),height+(outer.bottom-outer.top-before[3]),0x16):raise C.WinError(C.get_last_error())
  time.sleep(.5);ensure_visible(c);after=c.client_rect()
  if abs(after[2]*9-after[3]*16)>2:raise RuntimeError('Game did not accept 16:9 client sizing; restore point retained')
  return {'before':before,'after':after,'inputSent':False,'aspect':'16:9','pid':c.pid}
 finally:
  if acquired:k.ReleaseMutex(mutex)
  if mutex:k.CloseHandle(mutex)
if __name__=='__main__':
 try:print(json.dumps(adjust()))
 except Exception as error:print(json.dumps({'error':str(error),'inputSent':False}));raise SystemExit(1)
