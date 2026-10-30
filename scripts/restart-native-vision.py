"""Restart this project's local screenshot reader without opening a console."""
import os
import argparse
import sys
from pathlib import Path
import subprocess
import psutil

root = Path(__file__).resolve().parents[1]
sys.path.insert(0,str(root/'scripts/sts2'))
from native_model_config import resolve_model_dir
parser=argparse.ArgumentParser()
parser.add_argument('--model-dir',default=os.environ.get('AI_VTUBER_VISION_MODEL_DIR'))
args=parser.parse_args()
# Check a requested checkpoint before terminating any existing service.
model_dir=resolve_model_dir(root,args.model_dir)
target = root/'scripts/sts2/native_vision.py'
victims = []
for p in psutil.process_iter(['name', 'cmdline', 'cwd']):
    try:
        if p.info['name'].lower() != 'python.exe': continue
        for arg in (p.info['cmdline'] or [])[1:]:
            if arg.startswith('-'): continue
            candidate = Path(arg)
            if not candidate.is_absolute(): candidate = Path(p.info['cwd'])/candidate
            if os.path.normcase(str(candidate.resolve())) == os.path.normcase(str(target)):
                victims.append(p)
                break
    except (psutil.Error, OSError, TypeError): pass
for p in victims:
    try: p.terminate()
    except psutil.NoSuchProcess: pass
psutil.wait_procs(victims, timeout=10)
with (root/'logs/native-vision-nf4.out.log').open('ab') as out, (root/'logs/native-vision-nf4.err.log').open('ab') as err:
    p = subprocess.Popen([str(root/'runtime/vlm-env/Scripts/python.exe'),str(target),'--four-bit','--model-dir',str(model_dir)],cwd=root,stdout=out,stderr=err,creationflags=subprocess.CREATE_NO_WINDOW)
print('Vision worker launched:',p.pid,'model:',model_dir.name)
