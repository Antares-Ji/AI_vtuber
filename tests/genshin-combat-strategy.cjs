const test=require('node:test'),assert=require('node:assert/strict');
const {validateStrategy,prepareStrategy,compileNativeStrategy}=require('../src/genshin/combat-strategy');
const party=['甲','乙','丙','丁'];
function plan(){const actions=party.map((character,i)=>({name:character,character,action:'e,wait(0.2)',condition:{expression:'since>6 && e-ready'},index:i+1,ensureCast:true}));actions[3]={...actions[3],action:'attack(1)',condition:{expression:'since>2'},ensureCast:false};return {reason:'test',actions};}
test('requires coverage of every locally recognized party member',()=>{const p=plan();p.actions[3].character='甲';assert.throws(()=>validateStrategy(p,party),/遗漏/);});
test('rejects unbounded holds, unsupported conditions and missing rate limits',()=>{for(const action of ['keydown(w)','wait(999)','eval(x)']){const p=plan();p.actions[0].action=action;assert.throws(()=>validateStrategy(p,party));}for(const expression of ['true','dead-count>2','since>0']){const p=plan();p.actions[0].condition.expression=expression;assert.throws(()=>validateStrategy(p,party));}});
test('wait-only placeholder cannot count as character combat coverage',()=>{const p=plan();p.actions[3].action='wait(2)';p.actions[3].ensureCast=false;assert.throws(()=>validateStrategy(p,party),/等待占位/);});
test('accepts bounded strategy and discards extra model fields',()=>{const p=plan();p.actions[0].execute='evil';const r=validateStrategy(p,party);assert.equal(r.actions.length,4);assert.equal(r.actions[0].execute,undefined);});
test('display labels compile to the upstream letter/digit identifier subset, without underscores',()=>{const p=plan();p.actions[0].name='荧(CWXR) 实际技能';p.actions[1].name='true';p.actions[2].name='action_1';const r=validateStrategy(p,party);assert.equal(new Set(r.actions.map(a=>a.name)).size,4);for(const a of r.actions)assert.match(a.name,/^[A-Za-z][A-Za-z0-9]*$/);});
test('costume suffix in recognition log is not part of JSON runtime character name',()=>{const p=plan();p.actions[3].character='荧(CWXR)';const r=validateStrategy(p,['甲','乙','丙','荧(CWXR)']);assert.equal(r.actions[3].character,'荧');});
test('rejects combat loops that only normal-attack at low HP or preempt skills',()=>{const p=plan();p.actions[3].condition.expression='since>5 && low-hp';assert.throws(()=>validateStrategy(p,party),/普攻/);p.actions[3].condition.expression='since>2';p.actions[3].index=0;assert.throws(()=>validateStrategy(p,party));p.actions[3].index=1;p.actions[0].index=4;assert.throws(()=>validateStrategy(p,party),/抢占/);});
test('generated strategy must include E and Q for all four characters, including protagonist',async()=>{
 const candidate={reason:'model fixture',actions:party.flatMap((character,i)=>[
 {name:'E'+i,character,action:'e',condition:{expression:'since>8 && e-ready'},index:i*2+1,ensureCast:true},
 {name:'Q'+i,character,action:'wait(0.3),q',condition:{expression:'since>8 && q-ready'},index:i*2+2,ensureCast:false}
 ])};
 for(const [i,character] of party.entries())candidate.actions.push({name:'fallback'+i,character,action:'attack(0.5),dash(0.2)',condition:{expression:'since>2'},index:90+i,ensureCast:false});
 const options={respond:async()=>({text:JSON.stringify(candidate),provider:'deepseek',model:'test'})};
 const accepted=await prepareStrategy({party},options);assert.equal(accepted.strategy.actions.length,12);
 const missingFallback=structuredClone(candidate);missingFallback.actions=missingFallback.actions.filter(a=>a.name!=='fallback0');
 await assert.rejects(prepareStrategy({party},{respond:async()=>({text:JSON.stringify(missingFallback)})}),/遗漏甲的普攻/);
 const tooFast=structuredClone(candidate);tooFast.actions[0].condition.expression='since>2 && e-ready';
 await assert.rejects(prepareStrategy({party},{respond:async()=>({text:JSON.stringify(tooFast)})}),/限频至少6秒/);
 const movementOnly=structuredClone(candidate);for(const action of movementOnly.actions)if(action.name.startsWith('fallback'))action.action='a(0.5),dash(0.2)';
 await assert.rejects(prepareStrategy({party},{respond:async()=>({text:JSON.stringify(movementOnly)})}),/普攻/);
 candidate.actions=candidate.actions.filter(a=>a.name!=='Q3');
 await assert.rejects(prepareStrategy({party},options),/遗漏丁的Q/);
});
test('backup normal attacks form a tail group and cannot preempt a skill or duplicate a character',()=>{
 const p=plan();p.actions.push({name:'backup',character:party[0],action:'attack(0.5)',condition:{expression:'since>2'},index:5,ensureCast:false});
 assert.equal(validateStrategy(p,party).actions.length,5);
 p.actions[0].index=6;assert.throws(()=>validateStrategy(p,party),/抢占/);
 p.actions[0].index=1;p.actions.at(-1).character=party[3];assert.throws(()=>validateStrategy(p,party),/只能有一个/);
});
test('Q compilation preserves the local readiness gate and emits one mapped press with animation wait',()=>{
 const p=plan();p.actions.push({name:'burst',character:party[3],action:'wait(0.3),q',condition:{expression:'since>8 && q-ready'},index:0,ensureCast:false});
 p.actions.at(-1).index=5;p.actions[3].index=99;
 const valid=validateStrategy(p,party),native=compileNativeStrategy(valid);
 const q=native.actions.find(a=>a.index===5);assert.equal(q.action,'wait(0.3),keypress(VK_Q),wait(1.8)');assert.equal(q.condition.expression,'since>8 && q-ready');
 assert.equal(valid.actions.find(a=>a.index===5).action,'wait(0.3),q');
 p.actions.at(-1).condition.expression='since>8';assert.throws(()=>validateStrategy(p,party),/Q 动作/);
 p.actions.at(-1).action='keypress(VK_Q)';assert.throws(()=>validateStrategy(p,party),/未允许/);
});
