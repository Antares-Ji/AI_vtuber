"""REAL game stop test: waits for recorded frames, then cancels a held W.

Requires --execute. This does not classify visual success; review the evidence.
"""
import argparse
from concurrent.futures import ThreadPoolExecutor
import json
from pathlib import Path
import time
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('--execute', action='store_true')
a = p.parse_args()
if not a.execute: p.error('Real game input requires --execute and a safe foreground scene')
folder = ROOT/'runtime/game-input'
token = (folder/'token.txt').read_text().strip()
def call(route, body=None):
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request('http://127.0.0.1:17651/'+route, data=data,
        headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
    try:
        with urllib.request.urlopen(req, timeout=15) as response: return json.load(response)
    except urllib.error.HTTPError as ex: return json.load(ex)
if call('health').get('busy'): raise RuntimeError('Controller is busy')
existing = set((folder/'runs').iterdir())
body = json.loads((ROOT/'scripts/game-input-trials/cancel.json').read_text())
with ThreadPoolExecutor(max_workers=1) as pool:
    future = pool.submit(call, 'actions', body)
    deadline = time.monotonic()+5
    ready = False
    while time.monotonic() < deadline and not future.done():
        for candidate in set((folder/'runs').iterdir())-existing:
            if (candidate/'frame-0010.jpg').exists(): ready = True
        if ready: break
        time.sleep(.02)
    sent = time.perf_counter_ns()
    stop = call('stop', {})
    response = time.perf_counter_ns()
    result = future.result(timeout=10)
    audit = {'frame_10_seen_before_stop':ready,'stop_requested_ns':sent,
             'stop_response_ns':response,'action_response_ns':time.perf_counter_ns(),
             'stop_reply':stop,'result':result,'game_verified':False}
    if result.get('directory'):
        (Path(result['directory'])/'cancel-client.json').write_text(json.dumps(audit,indent=2),encoding='utf-8')
    print(json.dumps(audit))
