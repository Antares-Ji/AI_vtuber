const {test}=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
const {StoryQuestFocus,completionEvidence}=require('../src/genshin/story-quest-focus');
const memory=(quest,at=100)=>({quest,details:[quest,'任务详情'],source:'test-menu-evidence',at,verification:'historical_bettergi_ocr_recheck_current_step'});
function fixture(t){const root=fs.mkdtempSync(path.join(os.tmpdir(),'genshin-focus-'));t.after(()=>fs.rmSync(root,{recursive:true,force:true}));return root;}
function row(root,folder,seq,quest,at){
 const directory=path.join(root,'runtime/genshin/story',folder);fs.mkdirSync(directory,{recursive:true});
 fs.writeFileSync(path.join(directory,`step-${seq}.json`),JSON.stringify({at,decision:{quest},request:{texts:[{text:'任务专注模式'},{text:'进行中'},{text:quest,box:[800,120,250,35]}]}}));
}
test('first migration anchors earliest valid menu after checkpoint start, never latest mistaken selection',t=>{
 const root=fixture(t);row(root,'old',1,'更早旧任务',90);row(root,'later-folder',1,'紧急修理',110);row(root,'earlier-folder',2,'古云有螭',150);
 const focus=new StoryQuestFocus({root,sessionId:'training-a',startedAt:100,initialMemory:memory('古云有螭',150)});
 assert.equal(focus.snapshot().memory.quest,'紧急修理');
 assert.throws(()=>focus.select(memory('古云有螭',160)),e=>e.code==='QUEST_FOCUS_CONFLICT');
 assert.equal(focus.snapshot().memory.quest,'紧急修理');
});
test('provided memory is used only without qualifying historical evidence and session identities are isolated',t=>{
 const root=fixture(t),a=new StoryQuestFocus({root,sessionId:'training-a',startedAt:100,initialMemory:memory('紧急修理')});
 const b=new StoryQuestFocus({root,sessionId:'training-b',startedAt:100,initialMemory:memory('古云有螭')});
 assert.equal(a.snapshot().memory.quest,'紧急修理');assert.equal(b.snapshot().memory.quest,'古云有螭');assert.notEqual(a.file,b.file);
 const resumed=new StoryQuestFocus({root,sessionId:'training-a',startedAt:100,initialMemory:memory('古云有螭')});
 assert.equal(resumed.snapshot().memory.quest,'紧急修理');
});
test('completion needs exact unique task-complete text and anchored quest name outside the task menu',()=>{
 const good=[{text:'任务完成'},{text:'紧急修理'}];assert.equal(completionEvidence(good,'紧急修理').quest,'紧急修理');
 const bad=[
  [{text:'完成系列任务'},{text:'紧急修理'}],
  [{text:'任务完成：紧急修理'}],
  [{text:'紧急修理'},{text:'模型判断任务完成'}],
  [{text:'任务完成'},{text:'古云有螭'}],
  [...good,{text:'紧急修理'}],
  [...good,{text:'任务完成'}],
  [...good,{text:'任务专注模式'},{text:'进行中'}],
  [...good,{text:'完成系列任务'}],
  [{text:'任务完成 '},{text:'紧急修理'}]
 ];
 for(const texts of bad)assert.equal(completionEvidence(texts,'紧急修理'),null);
 assert.equal(completionEvidence(null,'紧急修理'),null);
});
test('completion persists an audit and clears focus once, while restart never reimports the completed quest',t=>{
 const root=fixture(t);row(root,'session',1,'紧急修理',110);
 const focus=new StoryQuestFocus({root,sessionId:'same-session',startedAt:100});
 const acknowledged=focus.acknowledgeCompletion({id:'native',seq:5,texts:[{text:'任务完成',box:[600,300,200,40]},{text:'紧急修理',box:[600,360,200,40]}]});
 assert.equal(acknowledged.acknowledged,true);assert.equal(acknowledged.memory,null);assert.equal(acknowledged.completions.length,1);
 assert.equal(acknowledged.completions[0].requestId,'native');assert.equal(acknowledged.completions[0].memory.quest,'紧急修理');
 const resumed=new StoryQuestFocus({root,sessionId:'same-session',startedAt:100,initialMemory:memory('紧急修理')});
 assert.equal(resumed.snapshot().memory,null);
 assert.equal(resumed.acknowledgeCompletion({id:'native',seq:5,texts:[{text:'任务完成'},{text:'紧急修理'}]}).duplicate,true);
 assert.throws(()=>resumed.select(memory('古云有螭',150)),/fresh menu evidence/);
 const next=resumed.select(memory('古云有螭',acknowledged.completions[0].at+1));assert.equal(next.memory.quest,'古云有螭');assert.equal(next.completions.length,1);
});
test('invalid completion does not clear focus and same quest may refresh menu details',t=>{
 const root=fixture(t),focus=new StoryQuestFocus({root,sessionId:'stable',startedAt:100,initialMemory:memory('紧急修理')});
 assert.equal(focus.acknowledgeCompletion({id:'native',seq:1,texts:[{text:'完成系列任务'},{text:'紧急修理'}]}).acknowledged,false);
 assert.equal(focus.snapshot().memory.quest,'紧急修理');
 const updated={...memory('紧急修理',120),details:['紧急修理','新的任务详情']};assert.deepEqual(focus.select(updated).memory.details,updated.details);
 assert.equal(focus.select(memory('紧急修理',110)).memory.at,120);
 assert.throws(()=>focus.select({quest:'假任务'}),/validated quest-menu evidence/);
});
test('corrupt focus fails closed and atomic writes leave no temporary file',t=>{
 const root=fixture(t),focus=new StoryQuestFocus({root,sessionId:'disk',startedAt:100,initialMemory:memory('紧急修理')});
 assert.equal(fs.readdirSync(path.dirname(focus.file)).length,1);
 fs.writeFileSync(focus.file,'{bad');
 assert.throws(()=>new StoryQuestFocus({root,sessionId:'disk',startedAt:100,initialMemory:memory('古云有螭')}),/refusing to choose another quest/);
 assert.equal(fs.readFileSync(focus.file,'utf8'),'{bad');
});
