"""Bounded screenshot replay. No gameplay decisions or game-input actions.

Uses a dedicated port, owns and cleans up only processes started here.
One warmup + 3 shuffled passes of six historical difficulty cases per provider.
"""
import argparse, hashlib, json, random, socket, subprocess, sys, time, urllib.request
from pathlib import Path
from datetime import datetime, timezone
ROOT=Path(__file__).resolve().parents[3]
HERE=Path(__file__).resolve().parent
LEARN=ROOT/'runtime/game-input/learning'
BASE='http://127.0.0.1:17656'
OPENER=urllib.request.build_opener(urllib.request.ProxyHandler({}))
CASES=[('hand-cost-conflict','vision-1793416878411412800.json'),('tall-enemy','vision-1793416916499019900.json'),('card-type-conflict','vision-1793413730126034600.json'),('draw-pile-view','vision-1793418119363714300.json'),('occluded-player','vision-1793416050856803800.json'),('expanded-roar-hand','vision-1793417013691414500.json')]
def call(url,body=None,timeout=5):
    req=urllib.request.Request(url,data=None if body is None else json.dumps(body).encode(),headers={'Content-Type':'application/json'})
    with OPENER.open(req,timeout=timeout) as r:return json.load(r)
def free(port):
    with socket.socket() as s:return s.connect_ex(('127.0.0.1',port))!=0
def stopped():
    s=call('http://127.0.0.1:3000/api/game-input/state')
    if not s.get('stopped') or s.get('busy') or s.get('autonomous',{}).get('running'):raise RuntimeError('Director must remain stopped and idle')
    return {k:s.get(k) for k in ['stopped','busy','autonomous']}
def wait_ready(proc,url,seconds=240):
    start=time.monotonic()
    while time.monotonic()-start<seconds:
        if proc.poll() is not None:raise RuntimeError('Worker exited; inspect benchmark logs')
        try:
            h=call(url,timeout=2)
            if h.get('ready') and not h.get('busy'):return h
        except OSError:pass
        time.sleep(1)
    raise TimeoutError('Worker readiness deadline exceeded')
def gpu():
    return subprocess.check_output(['nvidia-smi','--query-gpu=memory.used,utilization.gpu,power.draw','--format=csv,noheader,nounits'],text=True).strip()
def end(proc):
    if proc and proc.poll() is None:
        proc.terminate()
        try:proc.wait(timeout=15)
        except subprocess.TimeoutExpired:proc.kill();proc.wait(timeout=5)
def main():
    p=argparse.ArgumentParser();p.add_argument('--repeats',type=int,default=3);a=p.parse_args()
    if not 1<=a.repeats<=5:raise ValueError('Bounded repeat count required')
    stamp=datetime.now(timezone.utc).strftime('%Y%m%dT%H%M%SZ')
    dest=HERE/f'replay-{stamp}';dest.mkdir()
    result={'started_utc':stamp,'design':'exploratory, six selected historical difficulty cases; paired inputs; repeated timings are not independent images','repeats':a.repeats,'seed':20261101,'cache_disabled':True,'input_sent':False,'ground_truth':'unavailable; OCR agreement is not accuracy','conditions':[],'preflight':stopped()}
    def save(): (dest/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
    ocr=worker=None
    flags=getattr(subprocess,'CREATE_NO_WINDOW',0)
    try:
        # Stop endpoint only reinforces the existing idle stop state; no actions.
        result['stop_receipt']=call('http://127.0.0.1:3000/api/game-input/stop',{},timeout=15)
        result['after_stop']=stopped();save()
        if not free(17656):raise RuntimeError('Dedicated benchmark port occupied')
        if free(17647):
            log=(dest/'ocr.log').open('wb')
            ocr=subprocess.Popen([str(ROOT/'runtime/ocr-env/Scripts/python.exe'),str(ROOT/'scripts/sts2/native_ocr.py')],cwd=ROOT,stdout=log,stderr=log,creationflags=flags)
            result['ocr_health']=wait_ready(ocr,'http://127.0.0.1:17647/health')
        else:
            result['ocr_health']=call('http://127.0.0.1:17647/health')
        if not result['ocr_health'].get('read_only'):raise RuntimeError('Expected read-only OCR')
        cases=[]
        for name,source in CASES:
            old=json.loads((LEARN/source).read_text(encoding='utf-8'))
            body={'image':old['source_image'],'mode':old['mode']}
            if old['mode'] not in ['battle','scene','player-hud']:body['crop']=old.get('crop')
            if old.get('target'):body['target']=old['target']
            cases.append({'name':name,'source':source,'image_sha256':hashlib.sha256(Path(body['image']).read_bytes()).hexdigest(),'request':body})
        result['cases']=cases;save()
        for label,provider,model in [('4B-NF4','local','Qwen3-VL-4B-Instruct'),('8B-NF4','local','Qwen3-VL-8B-Instruct'),('DeepSeek-Flash','deepseek',None)]:
            stopped()
            cmd=[sys.executable,str(HERE/'isolated_vision_worker.py'),'--port','17656','--provider',provider,'--ocr-check']
            if model:cmd+=['--four-bit','--model-dir',str(ROOT/'runtime/vlm/models'/model)]
            cond={'label':label,'command_without_secrets':cmd,'rows':[],'gpu_before':gpu()}
            result['conditions'].append(cond);save()
            log=(dest/f'{label}.log').open('wb');start=time.monotonic()
            worker=subprocess.Popen(cmd,cwd=ROOT,stdout=log,stderr=log,creationflags=flags)
            cond['health']=wait_ready(worker,BASE+'/health');cond['load_seconds']=time.monotonic()-start
            print(json.dumps({'condition':label,'ready':True,'load_s':round(cond['load_seconds'],2)}),flush=True)
            start=time.monotonic();warm=call(BASE+'/read',cases[0]['request'],timeout=120)
            cond['warmup']={'elapsed_s':time.monotonic()-start,'record':warm.get('record')};save()
            rng=random.Random(20261101)
            for rep in range(a.repeats):
                order=list(range(len(cases)));rng.shuffle(order)
                for idx in order:
                    stopped();case=cases[idx];start=time.monotonic()
                    row={'case':case['name'],'repeat':rep+1,'source':case['source']}
                    try:
                        response=call(BASE+'/read',case['request'],timeout=120)
                        row.update({'elapsed_s':time.monotonic()-start,'response':response,'gpu_after':gpu()})
                        if response.get('perception_cache',{}).get('hit'):raise RuntimeError('Unexpected cache hit')
                    except Exception as e:
                        row.update({'elapsed_s':time.monotonic()-start,'error':str(e)})
                    cond['rows'].append(row);save()
                    print(json.dumps({'condition':label,'repeat':rep+1,'case':row['case'],'elapsed_s':round(row['elapsed_s'],3),'error':row.get('error')}),flush=True)
            cond['gpu_loaded_after']=gpu();end(worker);worker=None;log.close();save()
        result['complete']=True
    except Exception as e:
        result['error']=str(e);print(json.dumps({'error':str(e)}),flush=True)
    finally:
        end(worker);end(ocr)
        result['cleanup']={'benchmark_port_free':free(17656),'ocr_port_free':free(17647),'director':stopped()}
        result['ended_utc']=datetime.now(timezone.utc).isoformat();save()
        print(json.dumps({'output':str(dest/'results.json'),'complete':result.get('complete',False)}),flush=True)
if __name__=='__main__':main()
