"""Use local token without placing it in shell history or command arguments."""
import argparse
import json
from pathlib import Path
import urllib.request
import urllib.error

ROOT = Path(__file__).resolve().parents[1]
p = argparse.ArgumentParser()
p.add_argument('operation', choices=['health', 'actions', 'stop'])
p.add_argument('--file', type=Path)
p.add_argument('--port', type=int, default=17651)
a = p.parse_args()
token = (ROOT/'runtime/game-input/token.txt').read_text(encoding='utf-8').strip()
data = None
if a.operation == 'actions':
    if not a.file: p.error('--file is required')
    data = a.file.read_bytes()
elif a.operation == 'stop': data = b'{}'
request = urllib.request.Request(f'http://127.0.0.1:{a.port}/{a.operation}', data=data,
    headers={'Authorization': f'Bearer {token}', 'Content-Type': 'application/json'})
try:
    with urllib.request.urlopen(request, timeout=45) as response: print(response.read().decode('utf-8'))
except urllib.error.HTTPError as ex:
    print(ex.read().decode('utf-8'))
    raise SystemExit(1)
