import json,pathlib,psutil,sys,uuid
root=pathlib.Path(__file__).resolve().parents[2];session=sys.argv[1]
if str(uuid.UUID(session))!=session:raise ValueError('Invalid session')
folder=root/'runtime/genshin/bridge'/session
probe=len(sys.argv)>2 and sys.argv[2]=='--probe'
expected=str(root/'scripts/genshin/bridge-supervisor.py')
if not (folder/'status.json').exists():
 if not probe:raise RuntimeError('Supervisor has no ready receipt')
 # A rejected launcher may never create status.json. Scan exact script/session
 # identities before allowing a later explicit connection attempt.
 found=[]
 for candidate in psutil.process_iter(['pid','name']):
  if (candidate.info['name'] or '').lower() not in ['python.exe','pythonw.exe']:continue
  try:
   command=candidate.cmdline()
   if len(command)==4 and pathlib.Path(command[1]).resolve()==pathlib.Path(expected).resolve() and command[2:]==['--session',session]:found.append(candidate.pid)
  except psutil.NoSuchProcess:pass
 if len(found)>1:raise RuntimeError('Multiple matching supervisors')
 print(json.dumps({'alive':bool(found),'pid':found[0] if found else None,'source':'exact_process_scan'}));raise SystemExit(0)
state=json.loads((folder/'status.json').read_text(encoding='utf-8'))
try:
 p=psutil.Process(state['pid']);args=p.cmdline()
 valid=len(args)==4 and pathlib.Path(args[1]).resolve()==pathlib.Path(expected).resolve() and args[2:]==['--session',session]
except psutil.NoSuchProcess:valid=False
if probe:
 print(json.dumps({'alive':valid,'pid':state['pid']}));raise SystemExit(0)
if not valid:raise RuntimeError('Supervisor identity mismatch or process exited')
if not state.get('ready') or state.get('busy') or state.get('supervisorVersion',0)<6 or (folder/'shutdown').exists():raise RuntimeError('Supervisor not idle/current')
print(json.dumps({'valid':True,'pid':p.pid}))
