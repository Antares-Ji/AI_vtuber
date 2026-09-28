// Compare identical event boundaries; independent video timing is kept separate.
const fs=require('node:fs'),path=require('node:path');
const root=path.resolve(__dirname,'..');
const runs=process.argv.slice(2);
if(!runs.length)throw Error('Pass local-deployment run directory names');
const report=[];
for(const run of runs){
 const directory=path.join(root,'runtime/vision/local-deployment',run);
 const events=fs.readFileSync(path.join(directory,'events.jsonl'),'utf8').trim().split(/\r?\n/).map(JSON.parse);
 let began=null,rows=[];
 for(const event of events){
  if(event.event==='battle_recognized'){began=event;rows=[];continue;}
  if(!began)continue;
  if(event.event==='trial_result'){
   const sum=predicate=>rows.filter(predicate).reduce((n,r)=>n+(r.ms||0),0);
   const totals={click_ms:sum(r=>r.event==='control'&&r.action==='click'),drag_ms:sum(r=>r.event==='control'&&r.action==='drag'),
    capture_ms:sum(r=>r.event==='control'&&r.action==='capture'),model_ms:sum(r=>r.event==='local_model'),reference_ms:sum(r=>r.event==='reference_check')};
   const total=event.elapsed_ms-began.elapsed_ms;
   report.push({run,round:event.round,status:event.status,recognized_to_verification_ms:total,...totals,
    other_or_uninstrumented_ms:total-Object.values(totals).reduce((a,b)=>a+b,0)});
   began=null;
  }else rows.push(event);
 }
}
console.log(JSON.stringify(report,null,2));
