"""Start the fixed supervisor with normal Windows consent only if required."""
import ctypes,json,pathlib,subprocess,sys,uuid,psutil,time
from ctypes import wintypes
ROOT=pathlib.Path(__file__).resolve().parents[2]
session=sys.argv[1]
if str(uuid.UUID(session))!=session:raise ValueError('Invalid session')
script=ROOT/'scripts/genshin/bridge-supervisor.py'
# BetterGI's manifest requires administrator; this probe confirms WinError 740
# without launching a game task before requesting the matching Windows consent.
config=json.loads((ROOT/'data/genshin.local.json').read_text(encoding='utf-8-sig'))
exe=pathlib.Path(config['bettergiExecutable']).resolve(strict=True)
if exe.name.lower()!='bettergi.exe':raise ValueError('Invalid BetterGI executable')
# This persisted flag is set only after an observed Windows access denial.
denied=config.get('bettergiRequiresElevation') is True
kernel=ctypes.WinDLL('kernel32',use_last_error=True)
kernel.OpenProcess.argtypes=[wintypes.DWORD,wintypes.BOOL,wintypes.DWORD];kernel.OpenProcess.restype=wintypes.HANDLE
kernel.CloseHandle.argtypes=[wintypes.HANDLE]
for p in psutil.process_iter(['pid','name']):
 if (p.info['name'] or '').lower() not in ['yuanshen.exe','genshinimpact.exe']:continue
 handle=kernel.OpenProcess(0x00100001,False,p.pid)
 if handle:kernel.CloseHandle(handle)
 elif ctypes.get_last_error()==5:denied=True
 else:raise ctypes.WinError(ctypes.get_last_error())
if not denied:
 try:
  probe=subprocess.Popen([str(exe)],cwd=exe.parent,creationflags=0x4|subprocess.CREATE_NO_WINDOW,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
  probe.terminate();probe.wait(timeout=5)
 except OSError as error:
  if getattr(error,'winerror',None)!=740:raise
  denied=True
if not denied:
 child=subprocess.Popen([sys.executable,str(script),'--session',session],cwd=ROOT,creationflags=subprocess.CREATE_NO_WINDOW,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
 print(json.dumps({'pid':child.pid,'consent':'not required'}));raise SystemExit(0)
class SEI(ctypes.Structure):
 _fields_=[('cbSize',wintypes.DWORD),('fMask',wintypes.ULONG),('hwnd',wintypes.HWND),('lpVerb',wintypes.LPCWSTR),('lpFile',wintypes.LPCWSTR),('lpParameters',wintypes.LPCWSTR),('lpDirectory',wintypes.LPCWSTR),('nShow',ctypes.c_int),('hInstApp',wintypes.HINSTANCE),('lpIDList',ctypes.c_void_p),('lpClass',wintypes.LPCWSTR),('hkeyClass',wintypes.HKEY),('dwHotKey',wintypes.DWORD),('hIcon',wintypes.HANDLE),('hProcess',wintypes.HANDLE)]
info=SEI();info.cbSize=ctypes.sizeof(info);info.fMask=0x40|0x100;info.lpVerb='runas';info.lpFile=sys.executable
info.lpParameters=subprocess.list2cmdline([str(script),'--session',session]);info.lpDirectory=str(ROOT);info.nShow=0
shell=ctypes.WinDLL('shell32',use_last_error=True);shell.ShellExecuteExW.argtypes=[ctypes.POINTER(SEI)];shell.ShellExecuteExW.restype=wintypes.BOOL
if not shell.ShellExecuteExW(ctypes.byref(info)):
 code=ctypes.get_last_error()
 (ROOT/'runtime/genshin/bridge'/session/'launch-result.json').write_text(json.dumps({'launched':False,'winerror':code,'finishedAt':time.time()}),encoding='utf-8')
 raise ctypes.WinError(code)
kernel=ctypes.WinDLL('kernel32');kernel.GetProcessId.argtypes=[wintypes.HANDLE];kernel.GetProcessId.restype=wintypes.DWORD;kernel.CloseHandle.argtypes=[wintypes.HANDLE]
receipt={'pid':kernel.GetProcessId(info.hProcess),'launched':True,'consent':'Windows normal UAC','accessDeniedConfirmed':True}
(ROOT/'runtime/genshin/bridge'/session/'launch-result.json').write_text(json.dumps(receipt),encoding='utf-8')
print(json.dumps(receipt));kernel.CloseHandle(info.hProcess)
