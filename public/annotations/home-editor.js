const $ = id => document.getElementById(id);
const params=new URLSearchParams(location.search),multi=params.has('file');
const key = multi?`vision-annotation-${params.get('kind')}-${params.get('id')}-${params.get('file')}`:'arknights-home-boxes-20260907-reviewed-v1';
const baseline = await fetch(multi?'/api/vision/review/annotation?'+params.toString():'home-reviewed.json').then(r => { if (!r.ok) throw new Error('标注加载失败，请稍后刷新重试'); return r.json(); });
if(multi){$('stage').querySelector('img').src=baseline.image;$('stage').querySelector('img').alt='待校对采集图片';$('page-title').textContent=`${baseline.scene} · ${params.get('file')}`;}
let data = structuredClone(baseline), selected = 1, drag = null;
try { const saved = JSON.parse(localStorage.getItem(key)); if (saved?.image === baseline.image && Array.isArray(saved.boxes)) data = saved; } catch {}
function persist() { try { localStorage.setItem(key, JSON.stringify(data)); $('status').textContent='已保存到本浏览器；还未提交给助手'; } catch { $('status').textContent='本地保存失败，请导出 JSON'; } }
function current() { return data.boxes.find(b => b.id === selected); }
function clamp(b) { b.w=Math.min(data.width,Math.max(12,Math.round(b.w)));b.h=Math.min(data.height,Math.max(12,Math.round(b.h)));b.x=Math.max(0,Math.min(data.width-b.w,Math.round(b.x)));b.y=Math.max(0,Math.min(data.height-b.h,Math.round(b.y))); }
function draw() {
  $('boxes').replaceChildren(); $('list').replaceChildren();
  // Large ambiguous regions beneath smaller buttons so nested items remain selectable.
  for(const b of [...data.boxes].sort((a,b)=>b.w*b.h-a.w*a.h)) {
    const node=document.createElement('div');node.className=`box ${b.uncertain?'uncertain':''} ${b.id===selected?'selected':''}`;
    Object.assign(node.style,{left:`${b.x/data.width*100}%`,top:`${b.y/data.height*100}%`,width:`${b.w/data.width*100}%`,height:`${b.h/data.height*100}%`});
    node.title=`${b.id}. ${b.label}`; const tag=document.createElement('span');tag.className='tag';tag.textContent=b.id;node.append(tag);
    const handle=document.createElement('span');handle.className='handle';node.append(handle);
    node.addEventListener('pointerdown',e=>{if(e.button!==0)return;selected=b.id;const rect=$('stage').getBoundingClientRect();drag={b,resize:e.target===handle,x:e.clientX,y:e.clientY,original:{...b},scale: data.width/rect.width};node.setPointerCapture(e.pointerId);e.preventDefault();editFields();});
    node.addEventListener('pointermove',e=>{if(!drag||drag.b!==b)return;const dx=(e.clientX-drag.x)*drag.scale,dy=(e.clientY-drag.y)*drag.scale;Object.assign(b,drag.resize?{w:drag.original.w+dx,h:drag.original.h+dy}:{x:drag.original.x+dx,y:drag.original.y+dy});clamp(b);Object.assign(node.style,{left:`${b.x/data.width*100}%`,top:`${b.y/data.height*100}%`,width:`${b.w/data.width*100}%`,height:`${b.h/data.height*100}%`});editFields();});
    const finish=()=>{if(!drag)return;drag=null;persist();draw();};node.addEventListener('pointerup',finish);node.addEventListener('pointercancel',finish);
    $('boxes').append(node);
  }
  for(const b of data.boxes){const button=document.createElement('button');button.textContent=`${b.id}. ${b.label}${b.uncertain?' [?]':''}`;button.onclick=()=>{selected=b.id;draw();};$('list').append(button);}
  editFields();
  if($('next-image'))$('next-image').value=current()?.targetImage||'';
  if($('annotation-note'))$('annotation-note').value=current()?.annotationNote||'';
}
function editFields(){const b=current();$('selected').textContent=b?`选中 ${b.id}`:'未选中';$('name').value=b?.label||'';$('uncertain').checked=Boolean(b?.uncertain);$('coords').replaceChildren();for(const k of ['x','y','w','h']){const label=document.createElement('label');label.textContent=k;const input=document.createElement('input');input.type='number';input.value=b?.[k]||0;input.onchange=()=>{if(!b||!Number.isFinite(Number(input.value)))return;b[k]=Number(input.value);clamp(b);persist();draw();};label.append(input);$('coords').append(label);}}
function saveName(){const b=current();if(!b)return;b.label=$('name').value;b.labelSource='manual';persist();const index=data.boxes.indexOf(b);const item=$('list').children[index];if(item)item.textContent=`${b.id}. ${b.label}${b.uncertain?' [?]':''}`;}
$('name').oninput=saveName;
$('name').onchange=saveName;
if($('annotation-note')){
  $('annotation-note').onfocus=()=>{$('annotation-note').value=current()?.annotationNote||'';};
  $('annotation-note').oninput=()=>{if(current()){current().annotationNote=$('annotation-note').value;persist();}};
}
$('uncertain').onchange=()=>{if(current()){current().uncertain=$('uncertain').checked;persist();draw();}};
$('remove').onclick=()=>{data.boxes=data.boxes.filter(b=>b.id!==selected);selected=data.boxes[0]?.id;persist();draw();};
$('add').onclick=()=>{selected=Math.max(0,...data.boxes.map(b=>b.id))+1;const b={id:selected,label:'新增待命名',x:Math.round(data.width/3),y:Math.round(data.height/3),w:140,h:80,uncertain:true};clamp(b);data.boxes.push(b);persist();draw();};
$('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=multi?`${params.get('file')}-reviewed.json`:'arknights-home-reviewed.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
if($('next-image')){
  $('next-image').onfocus=()=>{$('next-image').value=current()?.targetImage||'';};
  $('next-image').onchange=()=>{if(current()){current().targetImage=$('next-image').value;persist();}};
}
if($('page-label')){$('page-label').value=data.pageLabel||data.scene;$('page-label').onchange=()=>{data.pageLabel=$('page-label').value;persist();};}
if(multi){try{localStorage.setItem(key,JSON.stringify(data));}catch{}}
draw();
const canAutoLabel=b=>b.labelSource!=='manual'&&(b.labelSource==='ocr'||['矩形控件候选','新增待命名'].includes(b.label)||/^未识别文字/.test(b.label));
async function recognizeLabels(){
  const button=$('ocr-labels');if(button)button.disabled=true;
  $('status').textContent='正在本机识别框内文字及邻近说明，已有人工名称不会覆盖…';
  try{
    const response=await fetch('/api/vision/review/annotation?'+params.toString(),{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({boxes:data.boxes})});
    const result=await response.json();if(!response.ok||result.ocrError)throw new Error(result.ocrError||result.error||'OCR失败');
    let count=0;
    for(const b of data.boxes){const recognized=result.boxes.find(r=>r.id===b.id&&r.x===b.x&&r.y===b.y&&r.w===b.w&&r.h===b.h);if(recognized&&canAutoLabel(b)){b.label=recognized.suggestedLabel;b.ocrText=recognized.ocrText;b.contextText=recognized.contextText;b.labelSource='ocr';count++;}}
    persist();draw();$('status').textContent=`已自动填写${count}个框的文字候选，请审核；人工名称已保留。`;
  }catch(error){$('status').textContent=error.message;}finally{if(button)button.disabled=false;}
}
if($('ocr-labels'))$('ocr-labels').onclick=recognizeLabels;
if(multi&&data.boxes.some(b=>canAutoLabel(b)&&b.labelSource!=='ocr'))await recognizeLabels();
else if(multi&&baseline.ocrError)$('status').textContent=baseline.ocrError;
