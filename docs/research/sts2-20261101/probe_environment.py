"""Read-only inventory; never sends input or exposes credentials."""
import json, subprocess, platform, urllib.request
from pathlib import Path
ROOT=Path(__file__).resolve().parents[3]
out={'platform':platform.platform(),'python':platform.python_version(),'services':{},'models':[]}
opener=urllib.request.build_opener(urllib.request.ProxyHandler({}))
for name,url in [('director','http://127.0.0.1:3000/api/game-input/state'),('vision','http://127.0.0.1:17646/health'),('ocr','http://127.0.0.1:17647/health')]:
    try:
        with opener.open(url,timeout=5) as r: data=json.load(r)
        if name=='director':
            data={k:data.get(k) for k in ['stopped','busy','autonomous','heldKeys','heldButtons','keysDown','buttonsDown']}
        elif name=='vision': data={k:v for k,v in data.items() if k!='last'}
        out['services'][name]=data
    except Exception as e: out['services'][name]={'error':str(e)}
for p in (ROOT/'runtime/vlm/models').glob('*/config.json'):
    d=json.loads(p.read_text(encoding='utf-8'))
    out['models'].append({'directory':str(p.parent),'model_type':d.get('model_type'),'text_config':{k:d.get('text_config',d).get(k) for k in ['num_hidden_layers','hidden_size','num_attention_heads']},'weight_bytes':sum(f.stat().st_size for f in p.parent.glob('*.safetensors'))})
try:
    out['gpu']=subprocess.check_output(['nvidia-smi','--query-gpu=name,memory.total,memory.used,driver_version,utilization.gpu','--format=csv,noheader'],text=True).strip()
except Exception as e: out['gpu_error']=str(e)
try:
    import importlib.metadata as m
    out['packages']={n:m.version(n) for n in ['torch','transformers','accelerate','bitsandbytes','Pillow']}
except Exception as e:out['package_error']=str(e)
path=Path(__file__).with_name('environment.json');path.write_text(json.dumps(out,ensure_ascii=False,indent=2),encoding='utf-8')
print(json.dumps(out,ensure_ascii=False))
