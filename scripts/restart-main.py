"""Restart only this project's main Node server, without a shell window."""
import json
import os
from pathlib import Path
import shutil
import subprocess
import time
import uuid
from urllib.request import build_opener, ProxyHandler
import psutil

root = Path(__file__).resolve().parents[1]
script = root / 'src/server.js'
opener = build_opener(ProxyHandler({}))
owners = {c.pid for c in psutil.net_connections(kind='tcp')
          if c.status == 'LISTEN' and c.laddr.port == 3000}
for pid in owners:
    p = psutil.Process(pid)
    if p.name().lower() != 'node.exe' or not any(
        os.path.normcase(os.path.abspath(a)) == os.path.normcase(str(script))
        for a in p.cmdline()[1:]):
        raise RuntimeError('Port 3000 belongs to another application; refusing restart')
for pid in owners:
    p = psutil.Process(pid)
    p.terminate()
    p.wait(timeout=10)
instance = str(uuid.uuid4())
env = dict(os.environ, AI_VTUBER_INSTANCE_ID=instance)
(root / 'logs').mkdir(exist_ok=True)
with (root/'logs/server.out.log').open('ab') as out, (root/'logs/server.err.log').open('ab') as err:
    process = subprocess.Popen([shutil.which('node'), str(script)], cwd=root, env=env,
                               stdout=out, stderr=err, creationflags=subprocess.CREATE_NO_WINDOW)
for _ in range(60):
    if process.poll() is not None:
        raise RuntimeError('Server exited; inspect logs/server.err.log')
    try:
        with opener.open('http://127.0.0.1:3000/api/health', timeout=2) as response:
            health = json.load(response)
        if health.get('ok') and health.get('instance', {}).get('id') == instance:
            print(json.dumps({'ready': True, 'pid': process.pid, 'instance': instance}))
            break
    except Exception:
        pass
    time.sleep(.5)
else:
    raise RuntimeError('Server readiness timed out')
