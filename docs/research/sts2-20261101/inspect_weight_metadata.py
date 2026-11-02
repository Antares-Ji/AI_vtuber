"""Read safetensors headers, not weight payloads; no GPU model loading."""
import collections,datetime,hashlib,json,math,platform,struct,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
out={'retrieved_utc':datetime.datetime.now(datetime.timezone.utc).isoformat(),'method':'safetensors header shape products; stored tensor elements, not deduplicated trainable parameters','models':[]}
for name in ['Qwen3-VL-4B-Instruct','Qwen3-VL-8B-Instruct']:
    d=ROOT/'runtime/vlm/models'/name;cfg=json.loads((d/'config.json').read_text(encoding='utf-8'))
    row={'name':name,'config':cfg,'config_sha256':hashlib.sha256((d/'config.json').read_bytes()).hexdigest(),'shards':[]}
    total=0;types=collections.Counter();parts=collections.Counter();ntensors=0
    for f in sorted(d.glob('*.safetensors')):
        with f.open('rb') as stream:
            n=struct.unpack('<Q',stream.read(8))[0]
            if n>100_000_000:raise ValueError('Unexpected header size')
            raw=stream.read(n);header=json.loads(raw)
        count=0
        for k,v in header.items():
            if k=='__metadata__':continue
            num=math.prod(v['shape']);count+=num;types[v['dtype']]+=num;ntensors+=1
            parts['vision' if 'visual' in k else 'language_or_other']+=num
        total+=count
        row['shards'].append({'filename':f.name,'bytes':f.stat().st_size,'header_sha256':hashlib.sha256(raw).hexdigest(),'stored_elements':count})
    row.update({'stored_elements':total,'tensor_count':ntensors,'dtype_elements':dict(types),'component_elements':dict(parts),'bytes':sum(s['bytes'] for s in row['shards'])})
    out['models'].append(row)
if sys.platform=='win32':
    import winreg,psutil
    with winreg.OpenKey(winreg.HKEY_LOCAL_MACHINE,r'HARDWARE\DESCRIPTION\System\CentralProcessor\0') as key:out['cpu']=winreg.QueryValueEx(key,'ProcessorNameString')[0].strip()
    out['ram_bytes']=psutil.virtual_memory().total
    out['logical_cpu_count']=psutil.cpu_count();out['physical_cpu_count']=psutil.cpu_count(logical=False)
path=Path(__file__).with_name('weight-metadata.json');path.write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps({**{k:v for k,v in out.items() if k!='models'},'models':[{k:v for k,v in m.items() if k not in ['config','shards']} for m in out['models']]},ensure_ascii=False,indent=2))
