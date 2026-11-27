"""Import an audited upstream JSON as bounded teleport-to-first-fight routes.

No downloaded JS or shell is executed. Coordinates and traversal order are
preserved; each segment ends at its first fight. Keep provenance and authors.
"""
import hashlib, json, pathlib, sys

ROOT = pathlib.Path(__file__).resolve().parents[2]
EXPECTED_BLOB = '35c47589f781381e0a6f479b06be31ce3b277ac7'
SOURCE_URL = 'https://github.com/babalae/bettergi-scripts-list/blob/main/repo/pathing/敌人与魔物/史莱姆/史莱姆速刷.json'

def segments(value):
    if set(value) != {'info', 'positions'}: raise ValueError('Unexpected route fields')
    if value['info'].get('bgi_version') != '0.52.0': raise ValueError('Unexpected route version')
    result, current = [], None
    for p in value['positions']:
        if set(p) != {'id','x','y','type','move_mode','action'}: raise ValueError('Unexpected position fields')
        if any(type(p[k]) not in (int,float) or not -50000 < p[k] < 50000 for k in ['x','y']): raise ValueError('Invalid coordinates')
        if p['type'] not in ['teleport','path'] or p['move_mode'] not in ['walk','run','fly','climb'] or p['action'] not in ['', 'fight','stop_flying']: raise ValueError('Unsupported route action')
        if p['type'] == 'teleport': current = []
        if current is not None:
            current.append(p)
            if p['action'] == 'fight':
                result.append(current); current = None
    return result

def main():
    source=pathlib.Path(sys.argv[1]); raw=source.read_bytes()
    # GitHub text tools may normalize CRLF or the final newline.
    variants=[raw,raw.rstrip(b'\r\n'),raw.rstrip(b'\r\n')+b'\n',raw.replace(b'\r\n',b'\n').replace(b'\n',b'\r\n')]
    if not any(hashlib.sha1(b'blob '+str(len(b)).encode()+b'\0'+b).hexdigest()==EXPECTED_BLOB for b in variants): raise ValueError('Upstream blob hash mismatch')
    data=json.loads(raw.decode('utf-8-sig')); parts=segments(data)
    config=json.loads((ROOT/'data/genshin.local.json').read_text(encoding='utf-8'))
    destination=pathlib.Path(config['bettergiExecutable']).parent/'User/AutoPathing/AI-VTuber-Hunting'
    destination.mkdir(parents=True,exist_ok=True)
    manifest=[]
    for i,points in enumerate(parts,1):
        name=f'史莱姆速刷-短线{i:02d}'
        route={'info':{**data['info'],'name':name,'description':'由官方仓库史莱姆速刷拆分：传送至本段起点，沿原路线抵达首个战斗点后结束。'},'positions':[{**p,'id':j+1} for j,p in enumerate(points)]}
        target=destination/(name+'.json'); content=json.dumps(route,ensure_ascii=False,indent=2)+'\n'
        if target.exists() and target.read_text(encoding='utf-8')!=content: raise ValueError('Refusing to overwrite changed route: '+target.name)
        target.write_bytes(content.encode('utf-8'))
        manifest.append({'id':'user:AI-VTuber-Hunting/'+target.name,'category':'hunting','map':'Teyvat','sourceUrl':SOURCE_URL,'sourceBlob':EXPECTED_BLOB,'sha256':hashlib.sha256(content.encode()).hexdigest(),'firstFight':{'x':points[-1]['x'],'y':points[-1]['y']},'points':len(points)})
    (ROOT/'data/genshin-hunting-routes.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n',encoding='utf-8')
    print(json.dumps({'installed':len(manifest),'sourceBlob':EXPECTED_BLOB,'maxPoints':max(x['points'] for x in manifest)},ensure_ascii=False))

if __name__ == '__main__': main()
