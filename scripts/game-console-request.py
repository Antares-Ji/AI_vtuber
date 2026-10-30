"""WSL interop friendly client for the director's native game controls."""
import argparse
import json
from urllib.request import Request, build_opener, ProxyHandler
from urllib.error import HTTPError

p=argparse.ArgumentParser()
g=p.add_mutually_exclusive_group(required=True)
g.add_argument('--capture',action='store_true');g.add_argument('--click',nargs=2,type=float);g.add_argument('--hover',nargs=2,type=float);g.add_argument('--drag',nargs=4,type=float);g.add_argument('--scroll',type=int);g.add_argument('--key');g.add_argument('--read-frame');g.add_argument('--state',action='store_true');g.add_argument('--vision-state',action='store_true')
p.add_argument('--crop',nargs=4,type=float);p.add_argument('--target');a=p.parse_args()
opener=build_opener(ProxyHandler({}))
def call(route,body=None):
    request=Request('http://127.0.0.1:3000/api/game-input/'+route,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    try:
        with opener.open(request,timeout=190) as r:return json.load(r)
    except HTTPError as ex:return json.loads(ex.read())
if a.vision_state:result=call('vision-state')
elif a.state:result=call('state')
elif a.read_frame:result=call('read-card',{'frameId':a.read_frame,'crop':a.crop,'target':a.target})
else:
    if a.capture:body={'kind':'capture'}
    elif a.click:body={'kind':'click','to':a.click}
    elif a.hover:body={'kind':'hover','to':a.hover}
    elif a.drag:body={'kind':'drag','from':a.drag[:2],'to':a.drag[2:]}
    elif a.scroll is not None:body={'kind':'scroll','steps':a.scroll}
    else:body={'kind':'key','key':a.key}
    state=call('state');body['frameId']=state['runs'][0]['id'] if state.get('runs') else None
    result=call('action',body)
print(json.dumps(result,ensure_ascii=False))
