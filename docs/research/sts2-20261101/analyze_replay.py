"""Recompute descriptive metrics and figures from recorded requests, no APIs."""
import csv,hashlib,json,statistics,subprocess
from collections import defaultdict
from pathlib import Path
HERE=Path(__file__).resolve().parent
ROOT=HERE.parents[2]
source=sorted(HERE.glob('replay-*/results.json'))[-1]
data=json.loads(source.read_text(encoding='utf-8'))
def percentile(xs,p):
    xs=sorted(xs);i=(len(xs)-1)*p;l=int(i);return xs[l]+(xs[min(l+1,len(xs)-1)]-xs[l])*(i-l)
summary={'source':source.relative_to(ROOT).as_posix(),'complete':data.get('complete',False),'n_unique_cases':len(data.get('cases',[])),'repeats':data.get('repeats'),'warmups_excluded':True,'conditions':[],'cases':[],'cleanup':data.get('cleanup'),'limits':'Selected cases, technical repeats, no independent labels; fixed model order; latency not win rate.'}
csvrows=[]
for c in data['conditions']:
    rows=c['rows'];times=[r['elapsed_s'] for r in rows];bycase=defaultdict(list)
    for r in rows:
        v=r.get('response',{});parsed=v.get('parsed');raw=v.get('raw','').removeprefix('```json').removeprefix('```').removesuffix('```').strip()
        try:json.loads(raw);clean_ok=True
        except (ValueError,TypeError):clean_ok=False
        try:json.loads(v.get('raw',''));raw_ok=True
        except (ValueError,TypeError):raw_ok=False
        simple={'condition':c['label'],'case':r['case'],'repeat':r['repeat'],'elapsed_s':r['elapsed_s'],'generated_tokens':v.get('generated_tokens'),'http_completed':'response' in r,'raw_json_valid':raw_ok,'json_valid_after_fence_removal':clean_ok,'normalized_not_null':parsed is not None,'normalization_error':v.get('normalization_error'),'cache_hit':v.get('perception_cache',{}).get('hit'),'record':v.get('record'),'error':r.get('error')}
        csvrows.append(simple);bycase[r['case']].append((r,simple))
    if not times:continue
    sims=[r for r in csvrows if r['condition']==c['label']]
    summary['conditions'].append({'label':c['label'],'n':len(rows),'total_s':sum(times),'mean_s':statistics.mean(times),'median_s':statistics.median(times),'p95_s':percentile(times,.95),'load_s':c.get('load_seconds'),'warmup_s':c.get('warmup',{}).get('elapsed_s'),'http_completed':sum(r['http_completed'] for r in sims),'raw_json_valid':sum(r['raw_json_valid'] for r in sims),'json_valid_after_fence_removal':sum(r['json_valid_after_fence_removal'] for r in sims),'normalized_not_null':sum(r['normalized_not_null'] for r in sims),'cache_hits':sum(bool(r['cache_hit']) for r in sims),'generated_tokens':sum(r['generated_tokens'] or 0 for r in sims),'gpu_loaded_after':c.get('gpu_loaded_after'),'observed_gpu_mib_max':max((float(r['gpu_after'].split(',')[0]) for r in rows if r.get('gpu_after')),default=None)})
    for name,pairs in bycase.items():
        ts=[p[0]['elapsed_s'] for p in pairs]
        parsed=[p[0].get('response',{}).get('parsed') for p in pairs]
        errors=[p[0].get('response',{}).get('normalization_error') for p in pairs]
        summary['cases'].append({'condition':c['label'],'case':name,'n':len(ts),'mean_s':statistics.mean(ts),'min_s':min(ts),'max_s':max(ts),'parsed':parsed,'normalization_errors':errors})
with (HERE/'replay-requests.csv').open('w',encoding='utf-8-sig',newline='') as f:
    w=csv.DictWriter(f,fieldnames=list(csvrows[0]));w.writeheader();w.writerows(csvrows)
(HERE/'replay-summary.json').write_text(json.dumps(summary,ensure_ascii=False,indent=2),encoding='utf-8')
lines=['# 新增回放：可重算描述统计','',f'原始文件：`{summary["source"]}`；完成标志：{summary["complete"]}。每条件6个固定样本×3次，预热不计入。没有独立标注，结构可用数不是准确率。','', '| 条件 | 请求数 | 均值秒 | 中位数秒 | 描述性P95秒 | HTTP完成 | 原文JSON可解析 | 去围栏JSON可解析 | 规范结果非空 | 缓存命中 |','|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|']
for c in summary['conditions']:lines.append(f'| {c["label"]} | {c["n"]} | {c["mean_s"]:.3f} | {c["median_s"]:.3f} | {c["p95_s"]:.3f} | {c["http_completed"]} | {c["raw_json_valid"]} | {c["json_valid_after_fence_removal"]} | {c["normalized_not_null"]} | {c["cache_hits"]} |')
lines+=['','P95仅由18个混合模式请求线性插值得到，不估计生产尾延迟。错误仍进入请求分母；非空规范结果可含全部未知字段。','', '| 样本 | 4B均值秒 | 8B均值秒 | 云端均值秒 |','|---|---:|---:|---:|']
for case in data.get('cases',[]):
    vals=[]
    for label in ['4B-NF4','8B-NF4','DeepSeek-Flash']:
        found=[c for c in summary['cases'] if c['case']==case['name'] and c['condition']==label]
        vals.append(f'{found[0]["mean_s"]:.3f}' if found else '未完成')
    lines.append('| '+case['name']+' | '+' | '.join(vals)+' |')
(HERE/'replay-tables.md').write_text('\n'.join(lines)+'\n',encoding='utf-8')
hashes={}
for pattern in ['scripts/sts2/*.py','src/sts2/cloud-vision.cjs','src/sts2/native-autonomy.js','docs/research/sts2-20261101/*.py']:
    for f in ROOT.glob(pattern):hashes[f.relative_to(ROOT).as_posix()]=hashlib.sha256(f.read_bytes()).hexdigest()
(HERE/'source-hashes.json').write_text(json.dumps(hashes,indent=2),encoding='utf-8')
try:
    import matplotlib
    matplotlib.use('Agg')
    import matplotlib.pyplot as plt
    cases=[c['name'] for c in data['cases']]
    fig,ax=plt.subplots(figsize=(11,5.8));colors=['#2563a6','#e98b2a','#21856a']
    for j,c in enumerate(data['conditions']):
        vals=[];lo=[];hi=[]
        for case in cases:
            ts=[r['elapsed_s'] for r in c['rows'] if r['case']==case]
            if not ts:break
            mean=statistics.mean(ts);vals.append(mean);lo.append(mean-min(ts));hi.append(max(ts)-mean)
        if len(vals)==len(cases):ax.bar([i+(j-1)*.25 for i in range(len(cases))],vals,width=.24,color=colors[j],label=c['label'],yerr=[lo,hi],capsize=3)
    ax.set_xticks(range(len(cases)),['Hand costs','Enemy','Card detail','Draw pile','Occluded HP','Expanded hand'])
    ax.set_ylabel('Read API wall time (seconds)');ax.set_ylim(bottom=0)
    ax.set_title('STS2 saved-frame replay on RTX 5080\nSix selected cases; 3 repeats per condition; cache disabled',loc='left',fontweight='bold')
    ax.spines[['top','right']].set_visible(False);ax.grid(axis='y',alpha=.15);ax.set_axisbelow(True);ax.legend(frameon=False)
    fig.text(.08,.025,'Bars: means. Whiskers: observed min-max, not confidence intervals. No accuracy or win-rate inference.',fontsize=9)
    fig.tight_layout(rect=[0,.06,1,1]);fig.savefig(HERE/'replay-latency.png',dpi=180);fig.savefig(HERE/'replay-latency.svg');plt.close(fig)
except ImportError:summary['plot']='matplotlib unavailable'
print(json.dumps({k:v for k,v in summary.items() if k!='cases'},ensure_ascii=False,indent=2))
