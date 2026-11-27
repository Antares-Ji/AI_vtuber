"""Deploy console fixes, reuse the authorized helper, and resume the saved goal.

Invoke --resume-goal only when the user has authorized continuing after repair.
Never disconnect the helper or change Windows security settings here.
"""
import argparse,json,pathlib,subprocess,time,urllib.request,threading
ROOT=pathlib.Path(__file__).resolve().parents[2]
op=urllib.request.build_opener(urllib.request.ProxyHandler({}))
def req(route,data=None):
 r=urllib.request.Request('http://127.0.0.1:3000'+route,data=None if data is None else json.dumps(data).encode(),headers={'Content-Type':'application/json'})
 with op.open(r,timeout=10) as out:return json.load(out)
def idle():
 runs=req('/api/skills/runs')['runs'];s=req('/api/game-input/state');v=req('/api/game-input/vision-state');mc=req('/api/minecraft/loop')
 return not any(r['state'] in ['RUNNING','STOPPING'] for r in runs) and not s.get('busy') and not s['autonomous'].get('running') and not v.get('busy') and not mc.get('enabled') and not mc.get('running')
def main():
 parser=argparse.ArgumentParser();parser.add_argument('--resume-goal',action='store_true');parser.add_argument('--preserve-story',action='store_true');args=parser.parse_args()
 before=req('/api/genshin/status');goal=(before.get('goal') or {}).get('goal');bridge=before['bridge']
 file=ROOT/'runtime/genshin/repair-resume.json'
 if args.resume_goal and not goal and file.exists():
  saved=json.loads(file.read_text(encoding='utf-8'))
  if saved.get('phase') in ['restarting','connected'] and time.time()-saved.get('at',0)<3600:goal=saved.get('goal')
 if args.resume_goal and not goal:raise RuntimeError('No saved Genshin goal; refusing to invent one')
 if not bridge.get('ready'):raise RuntimeError('Authorized helper is not ready; no automatic elevation attempted')
 foreign=[r for r in req('/api/skills/runs')['runs'] if r.get('game')!='genshin' and r['state'] in ['RUNNING','STOPPING']]
 if foreign:raise RuntimeError('Another game task is active; not restarting')
 checkpoint={'goal':goal,'session':bridge['session'],'pythonPid':bridge['pid'],'phase':'stopping','at':time.time()}
 def save():file.write_text(json.dumps(checkpoint,ensure_ascii=False,indent=2),encoding='utf-8')
 save();req('/api/genshin/story/pause-for-repair' if args.preserve_story else '/api/genshin/stop',{});req('/api/game-input/stop',{})
 for _ in range(60):
  if idle():break
  time.sleep(.5)
 else:raise RuntimeError('Input or vision did not become idle; no restart')
 clean=req('/api/genshin/status')['bridge']
 if clean.get('busy') or clean.get('active') or clean.get('lastResult') and not (clean['lastResult'].get('inputReleased') and clean['lastResult'].get('processStopped')):raise RuntimeError('BetterGI cleanup not confirmed')
 # Validate before stopping the old heartbeat owner, not after it has exited.
 probe=subprocess.run([str(ROOT/'runtime/vlm-env/Scripts/python.exe'),str(ROOT/'scripts/genshin/bridge-identify.py'),bridge['session']],capture_output=True,text=True)
 if probe.returncode:raise RuntimeError('Helper preflight failed; console kept running: '+probe.stderr[-1000:])
 checkpoint['phase']='restarting';save()
 stopped=threading.Event();folder=ROOT/'runtime/genshin/bridge'/bridge['session']
 def handoff():
  # Bounded heartbeat handoff while all game tasks are idle. If repair fails,
  # stop pulsing; the original 12-second watchdog remains in force.
  deadline=time.monotonic()+45
  while not stopped.is_set() and time.monotonic()<deadline:
   state=json.loads((folder/'status.json').read_text(encoding='utf-8'))
   if state.get('pid')!=bridge['pid'] or state.get('closedAt') or (folder/'shutdown').exists():break
   (folder/'heartbeat').write_text(str(time.time()))
   stopped.wait(1)
 thread=threading.Thread(target=handoff,daemon=True);thread.start()
 try:
  subprocess.run([str(ROOT/'runtime/vlm-env/Scripts/python.exe'),str(ROOT/'scripts/restart-main.py')],check=True)
  req('/api/games/active',{'game':'genshin'});req('/api/genshin/bridge/start',{'reuseSession':bridge['session']})
  for _ in range(20):
   current=req('/api/genshin/status')['bridge']
   if current.get('ready'):break
   time.sleep(.2)
  else:raise RuntimeError('Existing helper reconnection did not finish')
  if current.get('pid')!=bridge['pid'] or current.get('session')!=bridge['session']:raise RuntimeError('Helper changed unexpectedly; goal not resumed')
 finally:stopped.set();thread.join(timeout=2)
 checkpoint.update(phase='connected',sameAuthorizedHelper=True);save()
 if args.resume_goal:
  run=req('/api/genshin/run-goal',{'goal':goal});checkpoint.update(phase='resumed',runId=run['id']);save()
 print(json.dumps(checkpoint,ensure_ascii=False))
if __name__=='__main__':main()
