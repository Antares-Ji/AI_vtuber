const fs=require('node:fs/promises'),path=require('node:path'),{execFile}=require('node:child_process'),{randomUUID}=require('node:crypto');
const ROOT=path.resolve(__dirname,'../../runtime/vision');
const UUID=/^[a-f0-9-]{36}$/;
const {readText,labelBoxes}=require('./box-text');
const error=(message,statusCode=400)=>Object.assign(new Error(message),{statusCode});
async function source(kind,id){
 if(!['interactions','page-sessions'].includes(kind)||!UUID.test(id||''))throw error('无效记录');
 const dir=path.join(ROOT,kind,id),data=JSON.parse(await fs.readFile(path.join(dir,'manifest.json'),'utf8'));
 return {dir,data};
}
function run(script,args){return new Promise((resolve,reject)=>execFile(path.join(ROOT,'../vision-env/Scripts/python.exe'),[path.join(__dirname,script),...args],{windowsHide:true,timeout:45000,maxBuffer:2e6},(e,out)=>{if(e)return reject(e);try{resolve(JSON.parse(out));}catch(e){reject(e);}}));}
let busy=false;
async function handleReview(req,res,url,{parseBody,send}){
 if(!url.pathname.startsWith('/api/vision/review/'))return false;
 try{
  if(req.method==='GET'&&url.pathname.endsWith('/sources')){
   const sessions=[];
   for(const kind of ['page-sessions','interactions']){
    const dirs=await fs.readdir(path.join(ROOT,kind),{withFileTypes:true}).catch(()=>[]);
    for(const d of dirs.filter(d=>d.isDirectory()&&UUID.test(d.name))){
     try{const {data}=await source(kind,d.name);if(data.frames?.length)sessions.push({kind,id:d.name,entryLabel:data.entryLabel,createdAt:data.createdAt,frames:data.frames,segments:data.segments||[]});}catch{}
    }
   }
   sessions.sort((a,b)=>new Date(b.createdAt)-new Date(a.createdAt));send(res,200,{sessions});
  }else if(['GET','POST'].includes(req.method)&&url.pathname.endsWith('/annotation')){
   const kind=url.searchParams.get('kind'),id=url.searchParams.get('id'),file=url.searchParams.get('file');
   const {dir,data}=await source(kind,id);
   if(![...(data.frames||[]),...(data.segments||[])].some(f=>f.file===file)||!/^(frame-\d{3,5}\.jpg|segment-\d{3}\.png)$/.test(file||''))throw error('图像不在记录中');
   if(busy)throw error('正在处理另一张图，请稍后重试',409);
   busy=true;try{const candidate=await run('suggest-boxes.py',[path.join(dir,file)]);
    if(req.method==='POST'){
     const body=await parseBody(req);
     if(!Array.isArray(body.boxes)||body.boxes.length>300||body.boxes.some(b=>!['id','x','y','w','h'].every(k=>Number.isFinite(b[k]))||b.x<0||b.y<0||b.w<=0||b.h<=0||b.x+b.w>candidate.width||b.y+b.h>candidate.height))throw error('框坐标无效');
     candidate.boxes=body.boxes;
    }
    let ocrError=null;
    try{candidate.boxes=labelBoxes(candidate.boxes,await readText(path.join(dir,file))).map(b=>({...b,label:b.suggestedLabel,labelSource:'ocr',uncertain:true}));}
    catch{ocrError='本机文字识别失败，框和已有名称保留，可稍后重试。';}
    send(res,200,{schemaVersion:1,...candidate,ocrError,image:`/api/vision/${kind}/${id}/${file}`,scene:data.entryLabel,source:{kind,id,file},parentScene:'home',entryId:data.entryId,note:'本机OCR文字候选，含邻近左侧说明；仍需人工审核。'});
   }finally{busy=false;}
  }else if(req.method==='POST'&&url.pathname.endsWith('/stitch')){
   const body=await parseBody(req),{dir,data}=await source(body.kind,body.id);
   if(!Array.isArray(body.files)||body.files.length<2||body.files.length>24||new Set(body.files).size!==body.files.length)throw error('请选择2–24张不同原图');
   if(body.files.some(f=>!/^frame-\d{3,5}\.jpg$/.test(f)||!data.frames.some(old=>old.file===f)))throw error('只能拼接同一记录中的原图');
   if(busy)throw error('另一批图正在处理',409);
   busy=true;try{
    const id=randomUUID(),dest=path.join(ROOT,'page-sessions',id);await fs.mkdir(dest,{recursive:true});
    const manifest={schemaVersion:1,id,parentScene:'home',entryId:data.entryId,entryLabel:data.entryLabel,createdAt:new Date().toISOString(),status:'processing',frames:[],segments:[],selectionSource:{kind:body.kind,id:body.id}};
    const ordered=data.frames.filter(f=>body.files.includes(f.file));
    for(const [i,f] of ordered.entries()){const file=`frame-${String(i+1).padStart(3,'0')}.jpg`;await fs.copyFile(path.join(dir,f.file),path.join(dest,file));manifest.frames.push({file,original:f.file});}
    await fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2));
    try{manifest.segments=await run('stitch-pages.py',[dest]);manifest.status='complete';}catch(e){manifest.status='failed';throw e;}finally{await fs.writeFile(path.join(dest,'manifest.json'),JSON.stringify(manifest,null,2));}
    send(res,200,{id,kind:'page-sessions',segments:manifest.segments});
   }finally{busy=false;}
  }else throw error('Not found',404);
 }catch(e){send(res,e.code==='ENOENT'?404:e.statusCode||500,{error:e.statusCode?e.message:'处理失败，原图仍保留。'});}
 return true;
}
module.exports={handleReview};
