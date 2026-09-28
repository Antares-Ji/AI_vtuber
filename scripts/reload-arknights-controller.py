"""Gracefully reload the already elevated game controller after a finished battle.

Launched as its existing worker's child, so no elevation prompt is requested.
"""
import json,subprocess,time,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
folder=ROOT/'runtime/vlm/controller'
token=(folder/'token.txt').read_text().strip()
def request(path,data=None):
    r=urllib.request.Request('http://127.0.0.1:17644/'+path,data=data,headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    with urllib.request.urlopen(r,timeout=5) as response:return json.load(response)
time.sleep(1)
request('shutdown',b'{}')
time.sleep(1)
with (folder/'native-reloaded.log').open('w') as stdout,(folder/'native-reloaded-error.log').open('w') as stderr:
    process=subprocess.Popen(['powershell','-NoProfile','-ExecutionPolicy','Bypass','-File',str(ROOT/'scripts/arknights-native-worker.ps1')],cwd=ROOT,stdout=stdout,stderr=stderr,creationflags=subprocess.CREATE_NO_WINDOW)
    for attempt in range(40):
        try:
            status=request('status')
            if status.get('ok') and status.get('isAdministrator'):
                (folder/'reload-after-0-8.json').unlink(missing_ok=True)
                print(json.dumps({'ok':True,'controller_process_id':process.pid,'mainline_scope':'numbered stages; TR excluded'}),flush=True)
                break
        except Exception:pass
        time.sleep(.5)
    else:raise RuntimeError('Reloaded controller did not become ready; inspect native-reloaded-error.log')
