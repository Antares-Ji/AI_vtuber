"""Start the optional isolated CPU OCR worker; do not replace an occupied port."""
import json
from pathlib import Path
import socket
import subprocess
import time
import urllib.request

root=Path(__file__).resolve().parents[1]
python=root/'runtime/ocr-env/Scripts/python.exe'
if not python.is_file():raise SystemExit('Create runtime/ocr-env and install scripts/sts2/requirements-ocr.txt first')
with socket.socket() as check:
    if check.connect_ex(('127.0.0.1',17647))==0:raise SystemExit('Port 17647 is occupied; inspect the existing OCR worker before starting another')
(root/'logs').mkdir(exist_ok=True)
with (root/'logs/native-ocr.log').open('ab') as log:
    process=subprocess.Popen([str(python),str(root/'scripts/sts2/native_ocr.py')],cwd=root,stdout=log,stderr=log,creationflags=subprocess.CREATE_NO_WINDOW)
for _ in range(60):
    if process.poll() is not None:raise SystemExit('OCR worker exited; inspect logs/native-ocr.log')
    try:
        with urllib.request.urlopen('http://127.0.0.1:17647/health',timeout=1) as response:state=json.load(response)
        if state.get('ready') and state.get('read_only'):
            print(json.dumps({'pid':process.pid,**state}));break
    except (OSError,ValueError):pass
    time.sleep(.5)
else:raise SystemExit('OCR readiness not observed; process may still be loading; do not start a duplicate')
