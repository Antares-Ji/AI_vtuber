"""Advance verified stages using local navigation and the resident battle worker.

An unresolved failure yields a concrete checkpoint for code/strategy correction;
it is never silently counted as a victory or advanced past.
"""
import argparse,json,subprocess,sys,time,urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]

def main():
    sys.stdout.reconfigure(encoding='utf8')
    p=argparse.ArgumentParser()
    p.add_argument('--start',type=int,required=True);p.add_argument('--through',type=int,default=8)
    p.add_argument('--chapter',type=int,default=0)
    p.add_argument('--previous-summary',type=Path,required=True);a=p.parse_args()
    if not 0<=a.chapter<=99 or not 1<=a.start<=a.through<=99:raise ValueError('Invalid numbered mainline range')
    directory=ROOT/'runtime/vision/campaign-20260926'/('loop-'+str(time.time_ns()))
    directory.mkdir();previous=a.previous_summary.resolve()
    token=(ROOT/'runtime/vlm/controller/token.txt').read_text().strip()
    state={'previous_summary':str(previous),'status':'running'}
    def checkpoint(**fields):
        state.update(fields);state['updated_at']=time.strftime('%Y-%m-%d %H:%M:%S')
        (directory/'checkpoint.json').write_text(json.dumps(state,ensure_ascii=False,indent=2),encoding='utf8')
        print(json.dumps(state,ensure_ascii=False),flush=True)
    try:
        for n in range(a.start,a.through+1):
            stage=f'{a.chapter}-{n}';checkpoint(stage=stage,phase='navigation')
            with (directory/(stage+'-navigation.log')).open('w',encoding='utf8') as log:
                navigation=subprocess.run([sys.executable,str(ROOT/'scripts/local-campaign-navigate.py'),'--stage',stage,'--previous-summary',str(previous)],cwd=ROOT,stdout=log,stderr=subprocess.STDOUT)
            if navigation.returncode:raise RuntimeError('Navigation needs correction: '+stage)
            resume=None
            for attempt in range(4):
                body={'stage':stage}
                if resume:body['resumeSummary']=str(resume)
                request=urllib.request.Request('http://127.0.0.1:17644/stage07-local',data=json.dumps(body).encode(),headers={'Authorization':'Bearer '+token,'Content-Type':'application/json'})
                for lock_wait in range(12):
                    try:
                        with urllib.request.urlopen(request,timeout=30) as response:worker=json.load(response)
                        break
                    except urllib.error.HTTPError as error:
                        detail=error.read().decode('utf8',errors='replace')
                        if error.code==400 and 'experiment is already active' in detail and lock_wait<11:
                            checkpoint(phase='waiting_previous_worker_exit',wait_attempt=lock_wait+1)
                            time.sleep(1);continue
                        raise RuntimeError('Controller launch rejected: '+detail) from error
                run=Path(worker['jobDirectory']);checkpoint(phase='battle',worker_directory=str(run),placement_attempt=attempt+1)
                deadline=time.monotonic()+480
                while not (run/'summary.json').exists():
                    if time.monotonic()>deadline:
                        (run/'cancel').touch();raise RuntimeError('Worker completion timeout; cancellation requested')
                    time.sleep(2)
                summary=json.loads((run/'summary.json').read_text(encoding='utf8'))
                if summary.get('ok'):break
                if summary.get('error')!='Actual direction selector missing' or not summary.get('paused_on_exit') or not summary.get('rejected_placements'):break
                resume=run/'summary.json'
                checkpoint(phase='retrying_rejected_placement',resume_summary=str(resume),optimization='Exclude previously rejected current-stage cells; verify a new legal drop')
                time.sleep(.5) # Let the resident worker release its active-process lock.
            if not summary.get('ok') or summary.get('outcome',{}).get('stage')!=stage:
                raise RuntimeError('Same-stage correction required: '+str(summary.get('error')))
            previous=run/'summary.json';checkpoint(phase='verified_result',previous_summary=str(previous),outcome=summary['outcome'])
            subprocess.run([sys.executable,str(ROOT/'scripts/report-arknights-campaign.py')],cwd=ROOT,check=True)
        checkpoint(status='completed_supported_range')
    except Exception as error:
        checkpoint(status='needs_correction',error=str(error));raise
if __name__=='__main__':main()
