// Execute one observed UI action, then produce a half-size inspection copy.
const cp=require('node:child_process'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const result=JSON.parse(cp.execFileSync(process.execPath,[path.join(__dirname,'game-controller-request.js'),...process.argv.slice(2)],{encoding:'utf8'}));
if(!result.ok||!result.path)throw Error('No fresh game image');
const preview=path.join(root,'runtime/vision/captures/arknights/_preview.png');
cp.execFileSync(path.join(root,'runtime/vlm-env/Scripts/python.exe'),['-c','from PIL import Image;import sys;Image.open(sys.argv[1]).resize((800,512)).save(sys.argv[2])',result.path,preview],{windowsHide:true});
console.log(JSON.stringify({ok:result.ok,evidence:result.evidence,preview,client:result.info.client}));
