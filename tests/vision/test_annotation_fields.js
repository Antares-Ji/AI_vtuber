const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
(async()=>{
 const nodes={},saved=new Map();let finishOcr;
 function element(){return {value:'',children:[],style:{},append(...v){this.children.push(...v);},replaceChildren(){this.children=[];},addEventListener(){},querySelector(){return element();},getBoundingClientRect(){return {width:1000};}};}
 for(const id of ['stage','page-title','status','boxes','list','selected','name','coords','uncertain','remove','add','export','next-image','page-label','ocr-labels','annotation-note'])nodes[id]=element();
 const baseline={image:'/sample.jpg',scene:'设置',width:1000,height:800,boxes:[{id:1,x:10,y:20,w:100,h:50,label:'开启',labelSource:'ocr',uncertain:true}]};
 const context={URLSearchParams,structuredClone,JSON,Math,Number,Promise,Error,Blob,URL,setTimeout,
  location:{search:'?kind=page-sessions&id=test&file=frame-001.jpg'},
  document:{getElementById:id=>nodes[id],createElement:element},
  localStorage:{getItem:key=>saved.get(key),setItem:(key,value)=>saved.set(key,value)},
  fetch:async(url,options)=>options?new Promise(resolve=>{finishOcr=()=>resolve({ok:true,json:async()=>({...baseline,boxes:baseline.boxes.map(b=>({...b,suggestedLabel:'OCR晚到的结果'}))})});}):{ok:true,json:async()=>baseline}
 };
 vm.createContext(context);await vm.runInContext(`(async()=>{${fs.readFileSync('public/annotations/home-editor.js','utf8')}\n})()`,context);
 const pending=nodes['ocr-labels'].onclick();await Promise.resolve();
 nodes.name.value='音乐总开关';nodes.name.oninput();
 nodes['annotation-note'].value='关闭后静音';nodes['annotation-note'].oninput();
 finishOcr();await pending;
 const data=JSON.parse([...saved.values()][0]);
 assert.equal(data.boxes[0].label,'音乐总开关');assert.equal(data.boxes[0].labelSource,'manual');assert.equal(data.boxes[0].annotationNote,'关闭后静音');
 assert.equal(nodes.name.value,'音乐总开关');
 console.log('Annotation fields: immediate rename save, independent note and late OCR preserves manual edits passed.');
})().catch(e=>{console.error(e);process.exitCode=1;});
