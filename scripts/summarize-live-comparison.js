const fs=require('node:fs'),path=require('node:path');
const dir=path.resolve(__dirname,'../runtime/vlm/live-20260911');
const specs=[
 [1789141139688,1789141154816,'vlm','关卡列表 → 活动页'],
 [1789141161127,1789141173850,'hybrid','活动页 → 终端'],
 [1789141179187,1789141193582,'vlm','终端 → 主页'],
 [1789141204219,1789141218566,'hybrid','主页 → 设置'],
 [1789141224399,1789141242666,'vlm','游戏 → 声音'],
 [1789141248140,1789141261786,'hybrid','声音 → 提醒'],
 [1789141266659,1789141296826,'vlm','提醒 → 按键',1789141282744],
 [1789141304563,1789141354330,'vlm','按键 → 游戏',1789141336691],
 [1789141359916,1789141373864,'vlm','设置 → 主页'],
 [1789141379831,1789141392992,'hybrid','主页 → 设置']
];
const read=id=>JSON.parse(fs.readFileSync(path.join(dir,`compare-${id}.comparison.json`),'utf8'));
const rows=specs.map(([id,after,mode,transition,retry],i)=>({
 round:i+1,transition,comparison:read(id),retry:retry?read(retry):null,
 selected_mode:mode,first_target_proposal_correct:!retry,
 input_executed:true,transition_verified_by:'Codex screenshot inspection',
 result:'target reached after supervised validation',
 after_image:path.resolve(dir,`../controller/${after}-click.png`)
}));
const stats={};
for(const mode of ['vlm','yolo','hybrid']){
 const values=rows.map(r=>r.comparison.find(x=>x.mode===mode));
 stats[mode]={mean_request_ms:values.reduce((a,x)=>a+x.request_ms,0)/values.length,
 mean_inference_ms:values.reduce((a,x)=>a+(x.vlm_ms||0)+(x.yolo_ms||0),0)/values.length};
}
fs.writeFileSync(path.join(dir,'supervised-ten-rounds.json'),JSON.stringify({
 scope:'10 supervised single-action navigation rounds; not battles or autonomous loops',
 first_proposal_target_hits:8,supervised_transitions:10,yolo_ui_proposals:0,
 comparison_note:'All three modes ran on identical input per round. Only selected mode clicked; no independent 10-click run for each mode. No cloud API latency benchmark.',
 stats,rows},null,2));
console.log(JSON.stringify(stats,null,2));
