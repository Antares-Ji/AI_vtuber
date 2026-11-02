"""Start the configured Windows speech service without a visible shell window."""
import json,os,pathlib,socket,subprocess
ROOT=pathlib.Path(__file__).resolve().parents[1]
config=json.loads(subprocess.check_output([str(ROOT/'runtime/node/node.exe'),str(ROOT/'scripts/voice-launch-config.js')],text=True))
port=int(config['port'])
with socket.socket() as probe:
 if probe.connect_ex(('127.0.0.1',port))==0:
  print(json.dumps({'alreadyListening':True,'port':port}));raise SystemExit(0)
service=pathlib.Path(config['root']);python=pathlib.Path(config['python'])
for file in [python,pathlib.Path(config['config']),service/'api_v2.py']:
 if not file.is_file():raise RuntimeError('Missing configured voice file: '+str(file))
env=os.environ.copy();env['PATH']=str(service/'runtime')+os.pathsep+str(service)+os.pathsep+env['PATH']
env['HF_HOME']=str(ROOT/'runtime/huggingface');env['MPLCONFIGDIR']=str(ROOT/'runtime/matplotlib')
log=ROOT/'runtime/gpt-sovits/story-service.log';log.parent.mkdir(parents=True,exist_ok=True)
with log.open('ab',buffering=0) as output:
 process=subprocess.Popen([str(python),'api_v2.py','-a','127.0.0.1','-p',str(port),'-c',config['config']],cwd=service,env=env,stdin=subprocess.DEVNULL,stdout=output,stderr=output,creationflags=subprocess.CREATE_NO_WINDOW)
print(json.dumps({'pid':process.pid,'port':port,'log':str(log)}))
