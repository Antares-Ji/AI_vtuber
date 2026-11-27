import json,pathlib,urllib.request,hashlib,concurrent.futures,zipfile,os
root=pathlib.Path(__file__).resolve().parent
version=json.load(open(root.parent/'research/version-1.16.5.json'))
cache=root/'libraries';cache.mkdir(exist_ok=True);natives=root/'natives';natives.mkdir(exist_ok=True)
mc=pathlib.Path.home()/'Library/Application Support/minecraft'
def get(url,path,sha=None):
 path=pathlib.Path(path);path.parent.mkdir(parents=True,exist_ok=True)
 if path.exists() and (not sha or hashlib.sha1(path.read_bytes()).hexdigest()==sha):return path
 for attempt in range(3):
  try:
   data=urllib.request.urlopen(url,timeout=60).read()
   if sha and hashlib.sha1(data).hexdigest()!=sha:raise ValueError('hash mismatch')
   path.write_bytes(data);return path
  except Exception:
   if attempt==2:raise
cp=[];jobs=[]
for lib in version['libraries']:
 rules=lib.get('rules',[]);allowed=not rules
 for rule in rules:
  osrule=rule.get('os',{})
  if not osrule or osrule.get('name')=='osx':allowed=rule['action']=='allow'
 if not allowed:continue
 group,artifact,ver=lib['name'].split(':')[:3]
 if group=='org.lwjgl':
  ver='3.3.1';base=f'https://repo.maven.apache.org/maven2/org/lwjgl/{artifact}/{ver}/{artifact}-{ver}'
  p=cache/f'{artifact}-{ver}.jar';cp.append(str(p));jobs.append((base+'.jar',p,None));jobs.append((base+'-natives-macos-arm64.jar',cache/f'{artifact}-{ver}-natives-macos-arm64.jar',None));continue
 if artifact=='jna':
  p=cache/'jna-5.13.0.jar';cp.append(str(p));jobs.append(('https://repo.maven.apache.org/maven2/net/java/dev/jna/jna/5.13.0/jna-5.13.0.jar',p,None));continue
 art=lib.get('downloads',{}).get('artifact')
 if art:
  p=cache/art['path'];cp.append(str(p));jobs.append((art['url'],p,art.get('sha1')))
client=version['downloads']['client'];cp.append(str(root/'client.jar'));jobs.append((client['url'],root/'client.jar',client['sha1']))
with concurrent.futures.ThreadPoolExecutor(max_workers=6) as ex:list(ex.map(lambda args:get(*args),jobs))
for jar in cache.glob('*natives-macos-arm64.jar'):
 with zipfile.ZipFile(jar) as z:
  for name in z.namelist():
   if name.endswith('.dylib'):(natives/pathlib.Path(name).name).write_bytes(z.read(name))
idx=version['assetIndex'];indexPath=get(idx['url'],root/'assets/indexes'/f'{idx["id"]}.json',idx['sha1']);assets=json.load(open(indexPath))['objects'];jobs=[]
for a in assets.values():
 h=a['hash'];p=root/'assets/objects'/h[:2]/h;local=mc/'assets/objects'/h[:2]/h
 if local.exists() and not p.exists():p.parent.mkdir(parents=True,exist_ok=True);os.link(local,p)
 else:jobs.append((f'https://resources.download.minecraft.net/{h[:2]}/{h}',p,h))
with concurrent.futures.ThreadPoolExecutor(max_workers=8) as ex:list(ex.map(lambda args:get(*args),jobs))
(root/'classpath.txt').write_text(':'.join(cp));(root/'config.json').write_text(json.dumps({'mainClass':version['mainClass'],'assetIndex':idx['id']}))
print('Native client dependencies ready',len(assets),'assets')
