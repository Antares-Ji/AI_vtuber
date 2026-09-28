const assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const baseline={version:2,recording:'settings-20260910-005141',decodedFrames:1,frames:[{file:'images/frame-000000.png',timeMs:0}],warning:'test',events:[],stitches:[],edges:[{source:'settings',target:'game',label:'游戏',evidence:'candidate'}],nodes:[{id:'game',label:'游戏',kind:'独立截图',file:'images/frame-000000.png',width:1000,height:800,sourceFrames:[0],boxes:[{id:1,x:20,y:20,w:100,h:40,label:'开启',note:'',kind:'按钮候选',target:''}]}]};
function setup(saved){
 const nodes={};function element(){return {value:'',children:[],style:{},dataset:{},classList:{toggle(){}},append(...v){this.children.push(...v);},replaceChildren(){this.children=[];},setAttribute(){},getBoundingClientRect(){return {width:1000,height:800};},setPointerCapture(){}};}
 const context={console,URLSearchParams,JSON,Math,Number,Promise,Error,Blob,URL,setTimeout,location:{search:''},document:{getElementById:id=>nodes[id]??=element(),createElement:element},localStorage:{getItem:k=>saved.get(k),setItem:(k,v)=>saved.set(k,v)},fetch:async()=>({ok:true,json:async()=>structuredClone(baseline)})};
 vm.createContext(context);vm.runInContext(fs.readFileSync('public/annotations/video.js','utf8'),context);return nodes;
}
(async()=>{const saved=new Map(),nodes=setup(saved);await new Promise(r=>setImmediate(r));
 nodes.name.value='音乐开关';nodes.name.oninput();nodes.note.value='关闭后静音';nodes.note.oninput();nodes.target.value='sound';nodes.target.oninput();
 let data=JSON.parse([...saved.values()][0]);assert.equal(data.nodes[0].boxes[0].label,'音乐开关');assert.equal(data.nodes[0].boxes[0].note,'关闭后静音');assert.equal(data.nodes[0].boxes[0].target,'sound');
 nodes.add.onclick();data=JSON.parse([...saved.values()][0]);assert.equal(data.nodes[0].boxes.length,2);nodes.remove.onclick();assert.equal(JSON.parse([...saved.values()][0]).nodes[0].boxes.length,1);
 const restored=setup(saved);await new Promise(r=>setImmediate(r));assert.equal(restored.name.value,'音乐开关');assert.equal(restored.note.value,'关闭后静音');
 const flowRow=restored.flow.children[0];const label=flowRow.children[2];label.value='入口改名';label.oninput();assert.equal(JSON.parse([...saved.values()][0]).edges[0].label,'入口改名');
 console.log('PASS editor rename/note/target, add/delete, reload persistence and relationship edits (isolated DOM tests)');
})().catch(e=>{console.error(e);process.exitCode=1;});
