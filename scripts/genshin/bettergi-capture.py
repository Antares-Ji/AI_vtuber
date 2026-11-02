"""Use BetterGI's own screenshot hotkey, including outside the world UI."""
import importlib,json,pathlib,shutil,sys,time
ROOT=pathlib.Path(__file__).resolve().parents[2]

def write(file,value):
 temp=file.with_suffix('.capture.tmp');temp.write_text(json.dumps(value,ensure_ascii=False,indent=2),encoding='utf-8');temp.replace(file)

def prepare(directory,script):
 config_file=directory/'User/config.json';config=json.loads(config_file.read_text(encoding='utf-8-sig'));hotkeys=config['hotKeyConfig']
 if any(v=='F9' and k!='takeScreenshotHotkey' for k,v in hotkeys.items()):raise RuntimeError('F9 is already assigned in BetterGI')
 changes=[]
 def change(section,key,value):
  old=config[section].get(key);changes.append([section,key,old,value]);config[section][key]=value
 change('hotKeyConfig','takeScreenshotHotkey','F9');change('hotKeyConfig','takeScreenshotHotkeyType','GlobalRegister')
 # A capture request does not need real-time pickup/dialog automation.
 for section,value in config.items():
  if section.startswith(('auto','quick')) and isinstance(value,dict) and type(value.get('enabled')) is bool:change(section,'enabled',False)
 write(script/'capture-config-restore.json',changes);write(config_file,config);return changes

def restore(directory,changes):
 file=directory/'User/config.json';config=json.loads(file.read_text(encoding='utf-8-sig'))
 for section,key,old,temporary in changes:
  if config.get(section,{}).get(key)==temporary:
   if old is None:config[section].pop(key,None)
   else:config[section][key]=old
 write(file,config)

def capture(directory,script,child,job,cancelled):
 sys.path.insert(0,str(ROOT/'scripts/sts2'));from native_input import NativeInput,KEYS
 KEYS['F9']=0x78
 deadline=time.monotonic()+min(job['timeoutMs']/1000,60)
 def guard():
  if cancelled():raise InterruptedError('Screenshot stopped')
  if child.poll() is not None:raise RuntimeError('BetterGI screenshot owner exited')
  if time.monotonic()>deadline:raise TimeoutError('BetterGI screenshot timed out')
 start=time.monotonic()
 while time.monotonic()-start<8:guard();time.sleep(.15)
 source=directory/'log/screenshot';source.mkdir(parents=True,exist_ok=True)
 for name in ['before.png','after.png']:
  if name=='after.png':
   until=time.monotonic()+.6
   while time.monotonic()<until:guard();time.sleep(.1)
  guard();existing={p.name for p in source.glob('*.png')};sent=time.time()
  controller=NativeInput('YuanShen.exe',stop_file=script/'STOP',restore_minimized=False)
  controller.focus()
  try:
   guard();controller.key('F9',True);time.sleep(.08);controller.key('F9',False)
  finally:controller.release_all()
  until=time.monotonic()+8;captured=None;retried=False
  while time.monotonic()<until:
   guard()
   candidates=[p for p in source.glob('*.png') if p.name not in existing and p.stat().st_mtime>=sent-1]
   if len(candidates)>1:raise RuntimeError('Ambiguous BetterGI screenshot receipt')
   if candidates:
    candidate=candidates[0]
    try:
     from PIL import Image
     with Image.open(candidate) as im:im.verify()
     captured=candidate;break
    except OSError:pass
   elif not retried and time.time()-sent>3:
    # A screenshot is read-only; retry a dropped hotkey once within the budget.
    controller.focus()
    try:controller.key('F9',True);time.sleep(.08);controller.key('F9',False)
    finally:controller.release_all()
    retried=True
   time.sleep(.1)
  if captured is None:raise RuntimeError('BetterGI screenshot hotkey produced no image')
  shutil.copyfile(captured,script/name)
 receipt={'id':job['id'],'state':'returned','operation':'capture','source':'bettergi_screenshot_hotkey','verified':False,'finishedAt':int(time.time()*1000)}
 write(script/'receipt.json',receipt);return receipt
