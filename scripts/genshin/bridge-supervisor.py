"""Bounded BetterGI owner. Fixed operations, file receipts and native cleanup.

The parent heartbeat is mandatory. Only this supervisor's child is terminated.
It never attaches to an already running BetterGI instance or launches shell code.
"""
import argparse, ctypes, hashlib, json, os, pathlib, shutil, subprocess, sys, time, uuid
from ctypes import wintypes
ROOT = pathlib.Path(__file__).resolve().parents[2]
TASKS = {'AutoGeniusInvokation','AutoWood','AutoFight','AutoDomain','AutoBoss','AutoFishing','AutoCook','AutoEat','CountInventoryItem'}
SUPERVISOR_VERSION = 9

def write(file, data):
    # Windows readers/AV can briefly deny replace even to the owning admin.
    # Keep the old complete document until replacement succeeds. Do not restart
    # the privileged owner (or request UAC) for a transient sharing violation.
    temp = file.with_name(file.name+'.'+uuid.uuid4().hex+'.tmp')
    try:
        temp.write_text(json.dumps(data, ensure_ascii=False), encoding='utf-8')
        for attempt in range(40):
            try:
                os.replace(temp, file)
                return
            except PermissionError:
                if attempt == 39: raise
                time.sleep(.05)
    finally:
        try:temp.unlink(missing_ok=True)
        except OSError:pass

def read(file):
    return json.loads(file.read_text(encoding='utf-8-sig'))

def release_input():
    sys.path.insert(0, str(ROOT/'scripts/sts2'))
    from native_input import NativeInput, KEYS, BUTTONS, Input
    KEYS.update(SHIFT=0x10, CONTROL=0x11, ALT=0x12)
    # Cleanup must work even if the user has closed the game window.
    controller = NativeInput.__new__(NativeInput)
    controller.user = ctypes.WinDLL('user32',use_last_error=True)
    controller.user.SendInput.argtypes=[wintypes.UINT,ctypes.POINTER(Input),ctypes.c_int]
    controller.user.SendInput.restype=wintypes.UINT
    controller.held_keys = set(KEYS)
    controller.held_buttons = set(BUTTONS)
    controller.release_all()
    time.sleep(.1)
    held = [name for name, vk in KEYS.items() if controller.user.GetAsyncKeyState(vk) & 0x8000]
    held += [name for name, vk in [('left',1),('right',2),('middle',4)] if controller.user.GetAsyncKeyState(vk) & 0x8000]
    if held: raise RuntimeError('Keys/buttons still held after native release')
    return True

def input_is_idle():
    """Read current key state after the owned process has exited; send no input."""
    sys.path.insert(0,str(ROOT/'scripts/sts2'))
    from native_input import KEYS
    user=ctypes.WinDLL('user32',use_last_error=True)
    values=set(KEYS.values())|{1,2,4,0x10,0x11,0x12}
    return not any(user.GetAsyncKeyState(vk)&0x8000 for vk in values)

def route_file(directory, route):
    if not isinstance(route, str) or ':' not in route: raise ValueError('Route id required')
    source, name = route.split(':',1)
    folders = {'user':'User/AutoPathing','builtin_leyline':'GameTask/AutoLeyLineOutcrop/Assets/pathing'}
    if source not in folders or '\\' in name or ':' in name: raise ValueError('Invalid route source')
    base = (directory/folders[source]).resolve()
    target = (base/name).resolve(strict=True)
    if not target.is_relative_to(base) or target.suffix.lower() != '.json' or not target.is_file(): raise ValueError('Route outside installation')
    if target.stat().st_size > 8*1024*1024: raise ValueError('Route too large')
    value=read(target)
    if not isinstance(value,dict) or not isinstance(value.get('positions'),list) or not value['positions']: raise ValueError('Invalid pathing route')
    return target

def restore_window(cancel_file, owner_alive, restore=None):
    """Fixed startup operation: no BetterGI script, screenshot or key input."""
    cancel_file=pathlib.Path(cancel_file)
    def cancelled():return not owner_alive() or cancel_file.exists()
    if cancelled():raise InterruptedError('Cancelled before window restore')
    if restore is None:
        from window import restore
    receipt=restore(cancel_file,cancelled=cancelled)
    if cancelled():raise InterruptedError('Stopped during window restore')
    if not isinstance(receipt,dict) or receipt.get('inputSent') is not False or receipt.get('verified') is not False or receipt.get('focused') is not True:
        raise RuntimeError('Invalid window restore receipt')
    return receipt

def main():
    import psutil
    parser=argparse.ArgumentParser();parser.add_argument('--session',required=True);args=parser.parse_args()
    if str(uuid.UUID(args.session)) != args.session: raise ValueError('Invalid session')
    session=ROOT/'runtime/genshin/bridge'/args.session
    config=read(ROOT/'data/genshin.local.json')
    executable=pathlib.Path(config['bettergiExecutable']).resolve(strict=True)
    if executable.name.lower()!='bettergi.exe':raise ValueError('Invalid executable')
    directory=executable.parent
    if config.get('bettergiRequiresElevation') and not ctypes.windll.shell32.IsUserAnAdmin():raise RuntimeError('BetterGI requires matching elevated ownership')
    def alive():
        try:
            healthy=time.time()-(session/'heartbeat').stat().st_mtime<12 and not (session/'shutdown').exists()
            if healthy and time.time()-status['heartbeatAt']>2:
                status['heartbeatAt']=time.time();write(session/'status.json',status)
            return healthy
        except OSError:return False
    def others():
        return [p for p in psutil.process_iter(['name']) if (p.info['name'] or '').lower()=='bettergi.exe']
    # Cross-runtime lease: same mutex as the project native input runner.
    kernel=ctypes.WinDLL('kernel32',use_last_error=True)
    kernel.CreateMutexW.argtypes=[ctypes.c_void_p,wintypes.BOOL,wintypes.LPCWSTR];kernel.CreateMutexW.restype=wintypes.HANDLE
    kernel.WaitForSingleObject.argtypes=[wintypes.HANDLE,wintypes.DWORD]
    kernel.ReleaseMutex.argtypes=[wintypes.HANDLE];kernel.CloseHandle.argtypes=[wintypes.HANDLE]
    mutex=kernel.CreateMutexW(None,False,'Local\\AI_vtuber_native_game_input')
    if not mutex:raise RuntimeError('Native input mutex unavailable')
    status={'ready':True,'pid':os.getpid(),'elevated':bool(ctypes.windll.shell32.IsUserAnAdmin()),'busy':False,'supervisorVersion':SUPERVISOR_VERSION,'heartbeatAt':time.time()}
    write(session/'status.json',status)
    seen=set()
    try:
      while alive():
        if time.time()-status['heartbeatAt']>2:
          status['heartbeatAt']=time.time();write(session/'status.json',status)
        for job_file in sorted(session.glob('job-*.json')):
          if job_file.name in seen:continue
          seen.add(job_file.name);child=None;acquired=False;owned=False;native_owned=False;script=None;capture_config=None
          result={'id':job_file.stem[4:],'verified':False,'inputReleased':False,'processStopped':False}
          try:
            job=read(job_file)
            if set(job)-{'id','operation','routeId','task','timeoutMs'}:raise ValueError('Unexpected command fields')
            if str(uuid.UUID(job['id']))!=job['id'] or job['id']!=result['id']:raise ValueError('Invalid job id')
            if job['operation'] not in ['capture','path','task','cancelProbe','window','restore_window','dismiss_menu','locate','story']:raise ValueError('Unsupported operation')
            if job['operation']=='story' and ('task' in job or 'routeId' in job):raise ValueError('Story session cannot carry another task or path')
            if job['operation']=='locate' and ('task' in job or 'routeId' in job):raise ValueError('Location must be fixed')
            if job['operation']=='dismiss_menu' and ('task' in job or 'routeId' in job):raise ValueError('Menu return must be fixed')
            if job['operation']=='restore_window' and ('task' in job or 'routeId' in job):raise ValueError('Window restoration cannot carry another task or path')
            if job['operation']=='task' and job.get('task') not in TASKS:raise ValueError('Unsupported task')
            budget=job.get('timeoutMs',120000)
            if type(budget) is not int or not 1000<=budget<=600000:raise ValueError('Invalid timeout')
            if others():raise RuntimeError('BetterGI already running outside this command; stop it before using owned bridge')
            acquired=kernel.WaitForSingleObject(mutex,0) in [0,0x80]
            if not acquired:raise RuntimeError('Native game input is busy')
            if not alive() or (session/('cancel-'+job['id'])).exists():raise InterruptedError('Cancelled before launch')
            status.update(busy=True,jobId=job['id']);write(session/'status.json',status)
            if job['operation']=='dismiss_menu':
              import importlib
              native_owned=True
              result['receipt']=importlib.import_module('menu-recovery').return_one_level(session/('cancel-'+job['id']),lambda:not alive() or (session/('cancel-'+job['id'])).exists())
              result.update(state='returned');continue
            if job['operation']=='window':
              from window import adjust
              result.update(state='returned',window=adjust());continue
            if job['operation']=='restore_window':
              result.update(state='returned',window=restore_window(session/('cancel-'+job['id']),alive));continue
            if job['operation'] in ['capture','path','task','locate','story']:
              sys.path.insert(0,str(ROOT/'scripts/sts2'))
              from native_input import NativeInput
              from window import ensure_visible
              controller=NativeInput('YuanShen.exe',stop_file=session/('cancel-'+job['id']),restore_minimized=False)
              result['window']=ensure_visible(controller)
              controller.focus()
            if job['operation'] in ['path','task','story']:
              sys.path.insert(0,str(ROOT/'scripts/sts2'))
              from native_input import NativeInput
              geometry=NativeInput('YuanShen.exe',restore_minimized=False).client_rect()
              if abs(geometry[2]*9-geometry[3]*16)>2:raise RuntimeError('BetterGI automation requires 16:9 game client; use the window sizing command first')
            name='AI-VTuber-Bridge-'+job['id']
            script=directory/'User/JsScript'/name;script.mkdir(parents=True,exist_ok=False)
            shutil.copyfile(ROOT/'scripts/genshin'/('story-main.js' if job['operation']=='story' else 'bridge-main.js'),script/'main.js')
            write(script/'manifest.json',{'manifest_version':1,'name':name,'version':'1.0.0','bgi_version':'0.66.0','main':'main.js','description':'AI VTuber bounded command','authors':[{'name':'AI VTuber'}]})
            write(script/'command.json',job)
            if job['operation']=='path':shutil.copyfile(route_file(directory,job.get('routeId')),script/'route.json')
            group={'name':name,'index':0,'config':{'pathingConfig':{'enabled':True,'jsScriptUseEnabled':True,'autoPickEnabled':False,'autoSkipEnabled':False,'autoRunEnabled':False,'autoEatEnabled':False,'autoFightEnabled':False},'enableShellConfig':False},
              'projects':[{'name':name,'folderName':name,'type':'Javascript','status':'Enabled','schedule':'Daily','runNum':1,'index':0,'allowJsNotification':False,'allowJsHTTPHash':''}]}
            group_file=directory/'User/ScriptGroup'/(name+'.json');group_file.parent.mkdir(exist_ok=True)
            write(group_file,group)
            status.update(busy=True,jobId=job['id']);write(session/'status.json',status)
            if job['operation']=='capture':
              import importlib
              capture_module=importlib.import_module('bettergi-capture')
              capture_config=capture_module.prepare(directory,script)
            arguments=['start'] if job['operation']=='capture' else ['--startGroups',name]
            child=subprocess.Popen([str(executable),*arguments],cwd=directory,stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
            owned=True;result['pid']=child.pid;deadline=time.monotonic()+budget/1000
            if job['operation']=='capture':
              result['receipt']=capture_module.capture(directory,script,child,job,lambda:not alive() or (session/('cancel-'+job['id'])).exists())
              result['state']='returned';continue
            while True:
              if not alive() or (session/('cancel-'+job['id'])).exists():raise InterruptedError('Stopped by director/watchdog')
              if time.monotonic()>deadline:raise TimeoutError('BetterGI command exceeded runtime budget')
              receipt=script/'receipt.json'
              if receipt.exists():
                try:
                  r=read(receipt)
                  result['scriptStarted']=r.get('id')==job['id']
                  if r.get('id')==job['id'] and r.get('state') in ['returned','error']:
                    result['receipt']=r;result['state']=r['state'];break
                except (OSError,json.JSONDecodeError):pass
              if child.poll() is not None:raise RuntimeError('Owned BetterGI exited before script receipt')
              time.sleep(.15)
          except InterruptedError as error:result.update(state='stopped',error=str(error))
          except Exception as error:result.update(state='error',error=str(error)[:500])
          finally:
            if child is not None:
              try:
                descendants=[p for p in psutil.process_iter(['ppid','name']) if p.info['ppid']==child.pid and (p.info['name'] or '').lower()=='bettergi.exe']
                for p in descendants:
                  if pathlib.Path(p.exe()).resolve()!=executable:raise RuntimeError('Unexpected BetterGI descendant installation')
                  p.terminate();p.wait(timeout=10)
                if child.poll() is None:child.terminate()
                child.wait(timeout=10);result['processStopped']=True
              except Exception as error:result['cleanupError']=str(error)
            elif not owned:result.update(processStopped=True,inputReleased=not native_owned)
            if native_owned:
              try:result['inputReleased']=release_input()
              except Exception as error:result['cleanupError']=str(error)
            if owned and result['processStopped']:
              try:result['inputReleased']=release_input()
              except Exception as error:result['cleanupError']=str(error)
            if capture_config is not None and result['processStopped']:
              try:capture_module.restore(directory,capture_config)
              except Exception as error:result.update(state='error',error='Screenshot configuration restore failed: '+str(error))
            if script:
              evidence=session/('evidence-'+result['id']);evidence.mkdir(exist_ok=True)
              for name in ['before.png','after.png','receipt.json']:
                if (script/name).is_file():shutil.copyfile(script/name,evidence/name)
              result['images']=[p.name for p in evidence.glob('*.png')]
              result['captures']=[]
              from PIL import Image
              for file in evidence.glob('*.png'):
                try:
                  with Image.open(file) as im:
                    width,height=im.size;im.verify()
                  result['captures'].append({'name':file.name,'width':width,'height':height,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()})
                except Exception as error:result.update(state='error',error='Invalid screenshot evidence: '+str(error))
              if (evidence/'receipt.json').exists():
                try:result['receipt']=read(evidence/'receipt.json')
                except (OSError,json.JSONDecodeError):pass
              if result.get('state')=='returned' and job['operation']!='window' and len(result['captures'])!=2:result.update(state='error',error='BetterGI did not produce both valid screenshots')
            result['finishedAt']=time.time();write(session/('result-'+result['id']+'.json'),result)
            if acquired:
              # Never advertise idle after cleanup failure; retain lease until
              # watchdog teardown and make the failure visible to the director.
              if not(result['processStopped'] and result['inputReleased']):
                status.update(ready=False,busy=True,cleanupError=result.get('cleanupError'));write(session/'status.json',status)
                idle_since=None
                while alive():
                  if result['processStopped'] and input_is_idle():
                    if idle_since is None:idle_since=time.monotonic()
                    elif time.monotonic()-idle_since>=.5:
                      result.update(inputReleased=True,cleanupRecovered=True,cleanupRecoveredAt=time.time())
                      result.pop('cleanupError',None);write(session/('result-'+result['id']+'.json'),result)
                      status.update(ready=True);status.pop('cleanupError',None)
                      break
                  else:idle_since=None
                  time.sleep(.2)
                if not result['inputReleased']:
                  kernel.ReleaseMutex(mutex);return
              kernel.ReleaseMutex(mutex)
            status.update(busy=False);status.pop('jobId',None);write(session/'status.json',status)
        time.sleep(.2)
    finally:
      status.update(ready=False,closedAt=time.time());write(session/'status.json',status);kernel.CloseHandle(mutex)

if __name__=='__main__':
    main()
