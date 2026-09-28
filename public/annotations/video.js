'use strict';
const $=id=>document.getElementById(id);
const run=new URLSearchParams(location.search).get('run')||'settings-20260910-005141';
const base='/api/vision/video-runs/'+encodeURIComponent(run)+'/';
const key='video-keypages-v2:'+run;
let data,node,selected;
const el=(tag,text)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;return e;};
function save(){try{localStorage.setItem(key,JSON.stringify(data));$('save-state').textContent='修改已保存到当前浏览器；可导出 JSON 备份。';}catch{$('save-state').textContent='浏览器保存失败，请立即导出 JSON。';}}
function fieldState(){const b=selected;$('selected').textContent=b?'框 '+b.id+' · '+b.kind:'未选中';for(const id of ['name','note','kind','target','verified'])$(id).disabled=!b;$('name').value=b?.label||'';$('note').value=b?.note||'';$('target').value=b?.target||'';$('kind').value=b?.kind||'按钮候选';$('verified').checked=!!b?.verified;$('coords').replaceChildren();if(b)for(const k of ['x','y','w','h']){const label=el('label',k+' ');label.style.display='inline';const input=el('input');input.type='number';input.className='coord';input.value=Math.round(b[k]);input.onchange=()=>{const value=Number(input.value);if(Number.isFinite(value)){b[k]=value;clamp(b);save();draw();fieldState();}};label.append(input);$('coords').append(label);}}
function clamp(b){b.x=Math.max(0,Math.min(node.width-1,b.x));b.y=Math.max(0,Math.min(node.height-1,b.y));b.w=Math.max(1,Math.min(node.width-b.x,b.w));b.h=Math.max(1,Math.min(node.height-b.y,b.h));}
function draw(){
 $('boxes').replaceChildren();$('box-list').replaceChildren();
 for(const b of node.boxes){
  const item=el('button',`${b.id}. ${b.label}`);item.onclick=()=>{selected=b;fieldState();draw();};$('box-list').append(item);
  if(b.kind==='文字'&&!$('show-text').checked&&b!==selected)continue;
  const box=el('div');box.className='box'+(b.kind==='文字'?' text':'')+(b===selected?' selected':'');box.style.cssText=`left:${b.x/node.width*100}%;top:${b.y/node.height*100}%;width:${b.w/node.width*100}%;height:${b.h/node.height*100}%`;
  box.title=b.label;box.append(el('b',String(b.id)));const handle=el('span');handle.className='handle';box.append(handle);
  box.onpointerdown=e=>{e.preventDefault();selected=b;fieldState();const resize=e.target===handle;const rect=$('page-image').getBoundingClientRect(),start={...b},sx=e.clientX,sy=e.clientY;box.setPointerCapture(e.pointerId);box.onpointermove=move=>{const dx=(move.clientX-sx)*node.width/rect.width,dy=(move.clientY-sy)*node.height/rect.height;if(resize){b.w=start.w+dx;b.h=start.h+dy;}else{b.x=start.x+dx;b.y=start.y+dy;}clamp(b);box.style.left=b.x/node.width*100+'%';box.style.top=b.y/node.height*100+'%';box.style.width=b.w/node.width*100+'%';box.style.height=b.h/node.height*100+'%';};const end=()=>{box.onpointermove=null;save();fieldState();draw();};box.onpointerup=end;box.onpointercancel=end;};
  $('boxes').append(box);
 }
}
function selectNode(n){node=n;selected=n.boxes[0];$('title').textContent=n.label+' · '+n.kind;$('coverage').textContent=n.coverage+'；来源帧 '+n.sourceFrames.join('、');$('page-image').src=base+n.file;fieldState();draw();for(const b of $('pages').children)b.classList.toggle('active',b.dataset.id===n.id);}
function renderFlow(){
 $('flow').replaceChildren();
 for(const edge of data.edges){const row=el('div');row.append(el('span',edge.source+' → '));const target=el('select');for(const n of data.nodes){const opt=el('option',n.label);opt.value=n.id;target.append(opt);}target.value=edge.target;target.onchange=()=>{edge.target=target.value;save();};const name=el('input');name.value=edge.label;name.setAttribute('aria-label','入口名称');name.oninput=()=>{edge.label=name.value;save();};const note=el('input');note.value=edge.note||'';note.placeholder='关系注释';note.oninput=()=>{edge.note=note.value;save();};const label=el('label','已确认 ');label.style.display='inline';const check=el('input');check.type='checkbox';check.checked=!!edge.verified;check.onchange=()=>{edge.verified=check.checked;save();};label.append(check);row.append(target,name,note,label,el('p',edge.evidence));$('flow').append(row);}
}
function render(){
 $('pages').replaceChildren();$('targets').replaceChildren();
 for(const n of data.nodes){const button=el('button',n.label+' · '+n.kind);button.dataset.id=n.id;button.onclick=()=>selectNode(n);$('pages').append(button);const option=el('option');option.value=n.id;$('targets').append(option);}
 $('summary').textContent=`${data.nodes.length} 张关键图 · ${data.decodedFrames} 张原始帧 · ${data.events.length} 段滚动候选`;$('status').textContent=data.warning;renderFlow();$('events').replaceChildren();
 for(const event of data.events){const row=el('p',`${event.page}：帧 ${event.fromFrame}–${event.toFrame}，${event.evidence} `);for(const f of [event.fromFrame,event.toFrame]){const a=el('a','查看帧 '+f+' ');a.href=base+data.frames[f].file;a.target='_blank';a.rel='noopener';row.append(a);}$('events').append(row);}
 for(const s of data.stitches){$('events').append(el('p',s.page+' · '+s.status+' · '+(s.pieces?s.pieces.map(p=>p.frame+'@'+p.offset).join(' → '):'帧 '+s.frame)));}
 $('frame-index').max=data.decodedFrames-1;selectNode(data.nodes[0]);
}
for(const [id,prop] of [['name','label'],['note','note'],['kind','kind'],['target','target']])$(id).oninput=()=>{if(selected){selected[prop]=$(id).value;save();if(id==='kind')draw();}};
$('verified').onchange=()=>{if(selected){selected.verified=$('verified').checked;save();}};
$('show-text').onchange=draw;
$('add').onclick=()=>{selected={id:Math.max(0,...node.boxes.map(b=>b.id))+1,x:node.width*.4,y:40,w:100,h:40,label:'新控件',note:'',target:'',kind:'按钮候选',verified:false};node.boxes.push(selected);save();fieldState();draw();};
$('remove').onclick=()=>{if(!selected)return;node.boxes=node.boxes.filter(b=>b!==selected);selected=node.boxes[0];save();fieldState();draw();};
$('export').onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=el('a');a.href=url;a.download=run+'-reviewed.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
$('import').onchange=async()=>{try{const file=$('import').files[0];if(!file)return;const d=JSON.parse(await file.text());if(d.recording!==run||d.version!==2||!Array.isArray(d.nodes)||!Array.isArray(d.edges)||d.nodes.length!==data.nodes.length)throw Error('不是当前录屏的导出文件');for(const n of d.nodes){const orig=data.nodes.find(x=>x.id===n.id);if(!orig||n.file!==orig.file||n.width!==orig.width||n.height!==orig.height||!Array.isArray(n.boxes)||n.boxes.length>1000||n.boxes.some(b=>!['x','y','w','h'].every(k=>Number.isFinite(b[k]))||b.x<0||b.y<0||b.w<=0||b.h<=0||b.x+b.w>n.width||b.y+b.h>n.height))throw Error('框坐标或图片无效');}data.nodes=d.nodes;data.edges=d.edges;save();render();}catch(e){$('status').textContent='导入失败：'+e.message;}};
$('view-frame').onclick=()=>{const i=Number($('frame-index').value);const r=data.frames[i];if(!r)return;$('frame-image').src=base+r.file;$('frame-info').textContent=`帧 ${i} · ${(r.timeMs/1000).toFixed(2)} 秒 · ${r.page} · ${r.event}`;};
(async()=>{try{const response=await fetch(base+'bundle.json');if(!response.ok)throw Error('分析结果尚未生成或服务未更新');data=await response.json();try{const saved=JSON.parse(localStorage.getItem(key));if(saved?.version===2&&saved.recording===run){for(const n of data.nodes){const old=saved.nodes.find(x=>x.id===n.id&&x.file===n.file);if(old)n.boxes=old.boxes;}data.edges=saved.edges;}}catch{}render();}catch(e){$('status').textContent=e.message;}})();
