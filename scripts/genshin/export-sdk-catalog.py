"""Export public BetterGI JS host signatures from the pinned source checkout."""
import json,re,subprocess
from pathlib import Path
root=Path(__file__).resolve().parents[2]
repo=root/'runtime/genshin/bettergi-source'
ref='0af68c28f6b0e714d5304625ce644736d508022e'
def read(file):return subprocess.check_output(['git','-C',str(repo),'show',ref+':'+file],text=True,encoding='utf-8')
prefix='BetterGenshinImpact/Core/Script/'
engine=read(prefix+'EngineExtend.cs')
engine=re.sub(r'//[^\n]*','',engine)
entries=[]
for name,cls in re.findall(r'engine.AddHostObject\("(\w+)", new (?:Dependence\.)?(\w+)\(',engine):
    if cls=='HostTypeCollection': continue
    file=('BetterGenshinImpact/GameTask/CharacterDevelopment/CharacterDevelopmentTask.cs' if cls=='CharacterDevelopmentTask' else prefix+'Dependence/'+cls+'.cs')
    try: source=read(file)
    except subprocess.CalledProcessError: continue
    source=re.sub(r'/\*.*?\*/|//[^\n]*','',source,flags=re.S)
    for method,args in re.findall(r'public\s+(?:static\s+)?(?:async\s+)?[\w<>?,\[\].]+\s+(\w+)\s*\(([^)]*)\)',source):
        entries.append(dict(namespace=name,method=method,signature=' '.join(args.split()),source=file,status='catalogued',executable=False))
for name,method in re.findall(r'engine.AddHostObject\("(\w+)", GlobalMethod\.(\w+)\)',engine):
    entries.append(dict(namespace='global',method=name,signature=method,source=prefix+'Dependence/GlobalMethod.cs',status='catalogued',executable=False))
dispatcher=read(prefix+'Dependence/Dispatcher.cs')
tasks=re.findall(r'case "(\w+)":',dispatcher)
value=dict(version='0.66.0',commit=ref,entries=entries,soloTasks=tasks,
           note='接口目录依据本机版本源码生成。catalogued 表示已核对签名，不表示已实现远程调用或通过实机验证。')
(root/'data/genshin-sdk-catalog.json').write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
print(json.dumps({'interfaces':len(entries),'soloTasks':tasks},ensure_ascii=False))
