const {execFile}=require('node:child_process');
const path=require('node:path');
const cache=new Map();
function readText(file){
 if(cache.has(file))return cache.get(file);
 const task=new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'windows-ocr.ps1'),'-ImagePath',file],{windowsHide:true,timeout:25000,maxBuffer:2e6},(e,out)=>{if(e)return reject(e);try{resolve(JSON.parse(out));}catch(e){reject(e);}}));
 cache.set(file,task);task.catch(()=>cache.delete(file));if(cache.size>16)cache.delete(cache.keys().next().value);return task;
}
const clean=text=>text.replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g,'$1').trim();
function labelBoxes(boxes,ocr){
 const lines=(ocr.lines||[]).map(line=>{const words=line.words||[];return {words,text:clean(words.map(w=>w.text).join(' ')),left:Math.min(...words.map(w=>w.x)),right:Math.max(...words.map(w=>w.x+w.width)),cy:words.length?words.reduce((s,w)=>s+w.y+w.height/2,0)/words.length:Infinity};});
 return boxes.map(b=>{
  const text=clean(lines.map(l=>l.words.filter(w=>w.x+w.width/2>=b.x&&w.x+w.width/2<=b.x+b.w&&w.y+w.height/2>=b.y&&w.y+w.height/2<=b.y+b.h).map(w=>w.text).join(' ')).filter(Boolean).join(' '));
  const context=b.x>ocr.width*.4?lines.filter(l=>l.text&&l.right<=Math.min(b.x,ocr.width*.53)&&b.x-l.right<ocr.width*.65&&Math.abs(l.cy-(b.y+b.h/2))<Math.min(30,b.h*.5)).sort((a,c)=>Math.abs(a.cy-(b.y+b.h/2))-Math.abs(c.cy-(b.y+b.h/2))||c.right-a.right)[0]?.text:'';
  return {...b,ocrText:text,contextText:context||'',suggestedLabel:[context,text].filter(Boolean).join(' · ')||`未识别文字（框${b.id}）`};
 });
}
module.exports={readText,labelBoxes};
