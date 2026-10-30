"""Call the installed console role pipeline once, without executing input."""
import json
from urllib.request import Request, build_opener, ProxyHandler
import argparse
p=argparse.ArgumentParser();p.add_argument('--start',action='store_true');p.add_argument('--stop',action='store_true');p.add_argument('--resume',action='store_true');p.add_argument('--execute',action='store_true');p.add_argument('--max-steps',type=int,default=1);args=p.parse_args()
opener=build_opener(ProxyHandler({}))
url='http://127.0.0.1:3000/api/game-input/'
route='stop' if args.stop else 'resume' if args.resume else 'agent/start' if args.start else 'state'
request=Request(url+route,data=json.dumps({'execute':args.execute,'maxSteps':args.max_steps}).encode() if route!='state' else None,headers={'Content-Type':'application/json'})
with opener.open(request,timeout=10) as response: result=json.load(response)
print(json.dumps(result if route!='state' else result.get('autonomous'),ensure_ascii=False))
