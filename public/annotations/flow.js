const params=new URLSearchParams(location.search),id=params.get('id'),kind=params.get('kind');
const status=document.getElementById('status');
try {
  if(!/^[a-f0-9-]{36}$/.test(id||'')||!['interactions','page-sessions'].includes(kind))throw new Error('无效采集记录');
  const base=`/api/vision/${kind}/${id}`;
  let response=await fetch(base+'/flow');
  if(response.status===404)response=await fetch(base+'/flow',{method:'POST'});
  const data=await response.json();if(!response.ok)throw new Error(data.error||'分析失败');
  status.textContent=`主界面 → ${data.entryLabel} → ${data.nodes.length} 个界面／状态候选；分析 ${data.considered}/${data.available} 个关键帧。`;
  const key=`ui-flow-${id}`;
  try{const saved=JSON.parse(localStorage.getItem(key));if(saved)for(const n of data.nodes)if(saved[n.id])n.label=saved[n.id];}catch{}
  function edges(){
    const graph=document.getElementById('graph');graph.replaceChildren();
    const tree=document.createElement('pre');tree.textContent=`主界面\n└─ ${data.entryLabel}\n`+[...new Set(data.nodes.map(n=>n.parentPage||'未分类'))].map(name=>`   ├─ ${name}：`+data.nodes.filter(n=>(n.parentPage||'未分类')===name).map(n=>n.id+1).join('、')).join('\n');graph.append(tree);
    const kinds={'scroll-overlap-candidate':'有重叠的同页滚动','scroll-position-candidate':'滚动位置变化，拼接待确认','navigation-candidate':'左侧标签切换右侧页面','control-state-candidate':'页面内控件状态变化','input-associated':'操作相关，关系未知','sample-order-only':'仅采样先后'};
    for(const e of data.edges){const p=document.createElement('p');p.textContent=`${e.source+1} ${data.nodes[e.source].label} → ${e.target+1} ${data.nodes[e.target].label}：`;const select=document.createElement('select');for(const [value,label] of Object.entries(kinds)){const option=document.createElement('option');option.value=value;option.textContent=label;select.append(option);}select.value=e.kind;select.onchange=()=>{e.kind=select.value;e.verified=false;};p.append(select);graph.append(p);}
  }
  for(const node of data.nodes){
    const article=document.createElement('article'),input=document.createElement('input');input.value=node.label;
    input.onchange=()=>{node.label=input.value;edges();try{localStorage.setItem(key,JSON.stringify(Object.fromEntries(data.nodes.map(n=>[n.id,n.label]))));}catch{}};
    article.append(document.createTextNode(`${node.id+1} · `),input);
    const stage=document.createElement('div');stage.className='stage';const img=document.createElement('img');img.src=base+'/'+node.reference;stage.append(img);
    for(const box of node.boxes.filter(b=>b.frame===node.reference)){const div=document.createElement('div');div.className='box';div.textContent=String(box.gesture);div.title=box.label;Object.assign(div.style,{left:box.x*100+'%',top:box.y*100+'%',width:box.w*100+'%',height:box.h*100+'%'});stage.append(div);}
    article.append(stage);
    for(const f of data.images.filter(f=>f.node===node.id)){const a=document.createElement('a');a.href=base+'/'+f.file;a.target='_blank';a.rel='noopener';a.textContent='查看该页滚动拼接候选';article.append(a);}
    document.getElementById('nodes').append(article);
  }
  edges();const button=document.getElementById('export');button.disabled=false;
  button.onclick=()=>{const url=URL.createObjectURL(new Blob([JSON.stringify(data,null,2)],{type:'application/json'}));const a=document.createElement('a');a.href=url;a.download=`ui-flow-${id}-reviewed.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};
}catch(error){status.textContent=error.message;}
