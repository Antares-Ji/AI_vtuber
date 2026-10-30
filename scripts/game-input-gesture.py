"""Short CLI for the native executor. All coordinates are normalized CLIENT coordinates."""
import argparse
import json
from pathlib import Path
import subprocess
import sys
import time

ROOT=Path(__file__).resolve().parents[1]
p=argparse.ArgumentParser()
p.add_argument('--exe',default='SlayTheSpire2.exe')
g=p.add_mutually_exclusive_group(required=True)
g.add_argument('--drag',nargs=4,type=float,metavar=('X1','Y1','X2','Y2'))
g.add_argument('--click',nargs=2,type=float)
g.add_argument('--hover',nargs=2,type=float)
g.add_argument('--scroll',type=int,help='Positive up, negative down; cursor moves to client center')
g.add_argument('--key')
p.add_argument('--execute',action='store_true')
a=p.parse_args()
if a.drag:
    x,y,tx,ty=a.drag
    actions=[{'action':'move','to':[x,y],'duration':.4},{'action':'wait','duration':.35},
             {'action':'down'},{'action':'wait','duration':.15},
             {'action':'move','to':[tx,ty],'duration':.8},{'action':'wait','duration':.2},
             {'action':'up'},{'action':'wait','duration':.8},{'action':'move','to':[.5,.35],'duration':.2}]
elif a.click: actions=[{'action':'click','to':a.click,'duration':.35,'hold':.1},{'action':'wait','duration':1}]
elif a.hover: actions=[{'action':'move','to':a.hover,'duration':.35},{'action':'wait','duration':.5}]
elif a.scroll: actions=[{'action':'scroll','to':[.5,.5],'steps':a.scroll,'duration':.3},{'action':'wait','duration':.5}]
elif a.key: actions=[{'action':'key','key':a.key,'hold':.1},{'action':'wait','duration':1}]
else: p.error('Scroll cannot be zero')
sys.path.insert(0,str(ROOT/'scripts/sts2'))
from native_input import validate
validate(actions)
if not a.execute:
    print(json.dumps({'validated':True,'actions':actions}));raise SystemExit()
folder=ROOT/'runtime/game-input/requests';folder.mkdir(parents=True,exist_ok=True)
path=folder/(str(time.time_ns())+'.json');path.write_text(json.dumps(actions),encoding='utf-8')
raise SystemExit(subprocess.call([sys.executable,str(ROOT/'scripts/game-input-run.py'),'--exe',a.exe,'--actions',str(path),'--execute']))
