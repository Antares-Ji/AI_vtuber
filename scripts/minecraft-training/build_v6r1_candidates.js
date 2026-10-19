'use strict';

// Candidate-only material accounting curriculum. Does not read or alter holdout.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const mcData = require('minecraft-data')('1.21.11');
const { decisionMessages, compactObservation } = require('../../src/minecraft/survival-planner');
const { validateAction, CRAFT_ITEMS } = require('../../src/minecraft/survival-skills');

const ROOT = path.resolve(__dirname, '../..');
const DATA = path.join(ROOT, 'data/minecraft-training');
const OUT = path.join(ROOT, 'output/minecraft-training');
const GOAL = '在生存模式自主生存并进入下界';
const PROV = 'synthetic; independently authored v6r1 material-feasibility counterfactual; not a copied exact live probe';
const dirs = ['north','south','east','west','northeast','northwest','southeast','southwest'];
const clone = x => JSON.parse(JSON.stringify(x));
const sha = b => crypto.createHash('sha256').update(b).digest('hex');
const d = (x,z,def) => ({x,y:64,z,...def});
const log = (name='spruce',count=1) => ({name:`${name}_log`,count});
const plank = (name='spruce',count=1) => ({name:`${name}_planks`,count});
const sticks = count => ({name:'stick',count});
const pick = name => ({name,count:1});
const food = (name,count=1) => ({name,count});
const cobble = count => ({name:'cobblestone',count});
const table = {name:'crafting_table',count:1};
const baseHistory = [
  {action:{action:'observe'},status:'completed',result:{verified:true,gained:0}},
  {action:{action:'explore',direction:'east',distance:16},status:'completed',result:{verified:true,complete:true,gained:0}},
  {action:{action:'observe'},status:'completed',result:{verified:true,gained:0}},
  {action:{action:'observe'},status:'completed',result:{verified:true,gained:0}},
  {action:{action:'observe'},status:'completed',result:{verified:true,gained:0}},
  {action:{action:'observe'},status:'completed',result:{verified:true,gained:0}}
];
const fail = (item='wooden_pickaxe') => ({action:{action:'craft',item,count:1},error:`Missing ingredients for 1 ${item}`});

function materiallyCraftable(item, inventory) {
  const firstLog = inventory.find(i => /_log$/.test(i.name));
  const targetName = item === 'planks'
    ? (firstLog ? firstLog.name.replace(/^stripped_/, '').replace(/_log$/, '_planks') : 'oak_planks')
    : item;
  const targetId = mcData.itemsByName[targetName]?.id;
  if (targetId == null) return null;
  const owned = new Map();
  for (const entry of inventory) {
    const id = mcData.itemsByName[entry.name]?.id;
    if (id != null) owned.set(id, (owned.get(id) || 0) + entry.count);
  }
  const recipes = mcData.recipes?.[targetId] || [];
  for (const recipe of recipes) {
    const ingredients = recipe.ingredients || (recipe.inShape || []).flat();
    const needed = new Map();
    for (const ingredient of ingredients) {
      const options = Array.isArray(ingredient) ? ingredient : [ingredient];
      if (!options.length || options.every(id => id == null)) continue;
      const chosen = options.find(id => id != null && (owned.get(id) || 0) > (needed.get(id) || 0));
      if (chosen == null) { needed.set(-1, (needed.get(-1) || 0) + 1); continue; }
      needed.set(chosen, (needed.get(chosen) || 0) + 1);
    }
    if (needed.has(-1)) continue;
    if ([...needed].every(([id, count]) => (owned.get(id) || 0) >= count)) {
      const rows = recipe.inShape?.length || 0;
      const cols = Math.max(0, ...(recipe.inShape || []).map(row => row.length));
      return {item, outputPerCraft: recipe.result?.count || 1, requiresTable: rows > 2 || cols > 2};
    }
  }
  return null;
}

function state(def) {
  const position = {x:def.x,y:64,z:def.z};
  const inventory = clone(def.inventory||[]).filter(i=>i.count>0);
  const n = Object.fromEntries(inventory.map(i=>[i.name,i.count]));
  const pickName = ['diamond_pickaxe','iron_pickaxe','stone_pickaxe','wooden_pickaxe'].find(k=>n[k]);
  const dur = pickName ? mcData.itemsByName[pickName]?.maxDurability : null;
  if(pickName && !Number.isInteger(dur)) throw Error(`durability ${pickName}`);
  const blocks = (name, offsets) => offsets.map(([dx,dy,dz])=>{const p={x:position.x+dx,y:position.y+dy,z:position.z+dz};return {name,position:p,distance:Math.round(Math.hypot(position.x-p.x,position.y-p.y,position.z-p.z)*10)/10};});
  const raw = {
    connected:true,mode:'survival',dimension:'overworld',health:def.health??20,food:def.food??20,oxygen:20,position,
    timeOfDay:def.timeOfDay??7000,isNight:false,inventory,
    tools:pickName?[{name:pickName,durabilityUsed:def.durabilityUsed||0,maxDurability:dur,remaining:dur-(def.durabilityUsed||0),durabilityStatus:'known'}]:[],
    heldItem:pickName?{name:pickName,durabilityUsed:def.durabilityUsed||0}:null,equipment:pickName?[{name:pickName,durabilityUsed:def.durabilityUsed||0}]:[],
    threats:clone(def.threats||[]),hazards:[],animals:[],
    resources:{
      stone:blocks('stone',[[5,0,2],[8,0,3]]),coal:blocks('coal_ore',[[8,1,4]]),iron:blocks('iron_ore',[[15,-1,4]]),
      diamond:blocks('diamond_ore',[[-12,-2,5]]),obsidian:[],gravel:[],
      wood:def.noWood?[]:blocks('spruce_log',[[4,0,-2],[7,0,-2],[10,0,-4]])
    },
    stations:def.hasTable===false || n.crafting_table ? []:[{name:'crafting_table',position:{x:position.x+2,y:64,z:position.z+1}}],
    fluids:{water:[],lava:[]},
    craftable:[],recipeHints:clone(def.recipeHints||[]),
    recentExploration:[{from:{x:position.x-16,y:64,z:position.z},to:position,direction:'east',distance:16}],
    recentFailures:clone(def.failures||[]),portalSite:null,
    landmarks:{evidenceOnly:true,villageConfirmed:false,entities:[],blocks:[]},reactive:{enabled:true,mode:'idle',targetId:null}
  };
  if(def.noStone) raw.resources.stone=[];
  // Match runtime craftingOptions: material feasibility only. Existing gear or
  // stations do not hide recipes from the observation.
  raw.craftable=CRAFT_ITEMS.map(item=>materiallyCraftable(item, inventory)).filter(Boolean);
  return raw;
}

function build(id, def, dev=false) {
  const s=state(def);
  let hist=clone(def.history||baseHistory);
  if(!def.history && def.failures?.length){
    const failEvents=def.failures.slice(-2).map(f=>({action:clone(f.action),status:'failed',error:f.error,result:{verified:false,gained:0}}));
    hist=[...baseHistory.slice(0,6-failEvents.length),...failEvents];
  }
  s.recentFailures=hist.filter(e=>e.status==='failed').map(e=>({action:clone(e.action),error:e.error}));
  const msg=decisionMessages(s,{history:hist,goal:GOAL});
  const row={id,scenario:def.scenario,provenance:def.provenance||PROV,rationale:def.rationale,state:s,action:clone(def.action),messages:[...msg,{role:'assistant',content:JSON.stringify(def.action)}],labelBasis:[def.basis||'Action is useful and materially feasible from the observation; execution success is not guaranteed.'],limitations:['Synthetic planning label; material feasibility is assessed from inventory and recipe batch semantics, not path/physics success.']};
  validateAction(row.action);
  if(dev){row.expectedActionSet=clone(def.expectedActionSet||row.action);row.selectionCriteria='Require schema-valid, materially feasible useful action from the listed set; accept count/direction alternatives when equally feasible.';}
  if(JSON.stringify(JSON.parse(row.messages.at(-2).content).state)!==JSON.stringify(compactObservation(s))) throw Error(`${id} compact state mismatch`);
  return row;
}

const T=[
 d(101,208,{scenario:'Two pickaxe failures; two planks, four sticks, no logs, visible trees. Recover missing plank before retry.',inventory:[table,plank('spruce',2),sticks(4)],failures:[fail(),fail()],action:{action:'gather_wood',count:3},rationale:'木镐配方需3块木板与2根木棍；当前仅2块木板且无原木。采集原木后再转木板，避免原样重试。',basis:'Pickaxe currently lacks one plank; visible wood allows prerequisite recovery.'}),
 d(-143,57,{scenario:'Material shortage counterfactual; two planks and enough sticks, no visible wood.',inventory:[table,plank('oak',2),sticks(4)],noWood:true,failures:[fail(),fail()],action:{action:'explore',direction:'south',distance:20},rationale:'配方缺1木板且背包无原木；当前观察也无木材，应找资源而非重复制作。',basis:'No logs or visible wood; exploration is a useful way to find prerequisites.',expectedActionSet:{action:'explore',direction:dirs,distance:{min:8,max:48}}}),
 d(-309,-77,{scenario:'One log and two planks, four sticks after stick batch; craft planks first.',inventory:[table,log('spruce',1),plank('spruce',2),sticks(4)],failures:[fail()],action:{action:'craft',item:'planks',count:4},rationale:'原木能批量产4木板；配方当前差1块，先转化原木会得到6块。'}),
 d(374,125,{scenario:'Inspired tool-stage counterfactual: wooden pickaxe durability remains 40/59, eight sticks and six planks, no visible stone, visible wood; shallow staircase can expose new stone without remaking starter gear.',inventory:[pick('wooden_pickaxe'),table,plank('spruce',6),sticks(8)],durabilityUsed:19,noStone:true,history:baseHistory,action:{action:'dig_staircase',direction:'south',steps:4},rationale:'合成状态health20/food20，木镐剩余耐久40，木板/木棍已足够；stone列表为空，y64只下探4步至y60，不触及需火把的y<50。避免重复制作初级物品，尝试安全浅层找石。',basis:'Inspired by a newly observed material-stage failure mode; exact live inventory and position are not copied. Materials/tool prerequisites are present; stone is absent; shallow descent ends at y60.',limitations:['Counterfactual inspired by a live failure pattern, not an unseen failure mode. Staircase is a feasible attempt, not guaranteed terrain success.'] }),
 d(-427,164,{scenario:'No logs and no visible wood after repeated failed recipe; seek wood elsewhere.',inventory:[table,plank('oak',2),sticks(4)],noWood:true,failures:[fail(),fail()],action:{action:'explore',direction:'west',distance:24},rationale:'当前无原木且观察不到木材；采集动作无目标，探索寻找新资源。',expectedActionSet:{action:'explore',direction:dirs,distance:{min:8,max:48}}}),
 d(518,-203,{scenario:'One log with existing two planks and sticks; generic planks crafting rounds one output batch.',inventory:[table,log('birch',1),plank('birch',2),sticks(4)],action:{action:'craft',item:'planks',count:4},rationale:'木板请求4对应单次原木批次，配方可行并补齐木镐所需的3木板。'}),
 d(-581,-216,{scenario:'Two logs, zero planks, no workbench requirement for planks.',hasTable:false,inventory:[log('oak',2),sticks(2)],action:{action:'craft',item:'planks',count:8},rationale:'两原木产8木板；木板是工作台前的必要材料，动作目标用通用planks。'}),
 d(-706,315,{scenario:'Craft count two sticks produces four; remaining planks two cannot make pickaxe.',inventory:[table,plank('spruce',2),sticks(4)],failures:[fail()],action:{action:'gather_wood',count:3},rationale:'stick动作count=2实际批量产4，消耗2木板后剩2；木镐仍差1木板，应先补原木。'}),
 d(778,-327,{scenario:'After verified planks success, four planks remain and sticks are absent.',hasTable:false,inventory:[plank('spruce',4)],history:[...baseHistory.slice(0,5),{action:{action:'craft',item:'planks',count:4},status:'completed',result:{verified:true,gained:4}}],action:{action:'craft',item:'stick',count:2},rationale:'前序原木转换已确认产出4木板，当前背包仍有4木板；stick请求count2按配方批次产出4根。'}),
 d(-842,-364,{scenario:'One plank short with no wood, enough sticks; avoid crafting impossible tool.',inventory:[table,plank('oak',2),sticks(4)],noWood:true,failures:[fail()],action:{action:'explore',direction:'north',distance:20},rationale:'缺1木板且没有可见原木；探索新区域比重复制作有效。',expectedActionSet:{action:'explore',direction:dirs,distance:{min:8,max:48}}}),
 d(914,402,{scenario:'Low hunger and safe bread present while pickaxe recipe is short; eat before risky mining.',food:7,inventory:[table,plank('spruce',2),sticks(4),food('bread',2)],failures:[fail()],action:{action:'eat'},rationale:'饥饿7且有安全食物，先恢复；食物可用性优先于装备制作。',basis:'Food is below full and safe edible food exists.'}),
 d(-986,447,{scenario:'Food full; raw meat exists and wooden pickaxe recipe short; avoid no-op eat.',inventory:[table,plank('oak',2),sticks(4),food('beef',2)],failures:[fail()],action:{action:'gather_wood',count:4},rationale:'food=20不需吃肉；木镐差1木板，附近原木是有用的补料步骤。',basis:'Full food rejects eating; visible wood supports material recovery.'}),
 d(1058,-489,{scenario:'Crafting table absent; four planks, two sticks; make table before wooden pickaxe.',hasTable:false,inventory:[plank('oak',4),sticks(2)],action:{action:'craft',item:'crafting_table',count:1},rationale:'当前可制作工作台；木镐需3x3配方，先补必要工作站。'}),
 d(-1132,527,{scenario:'Workbench exists, four planks and two sticks; tool is directly craftable, do not remake station.',inventory:[table,plank('oak',4),sticks(2)],action:{action:'craft',item:'wooden_pickaxe',count:1},rationale:'已有工作台；木板棍子满足木镐配方，跳过重复制作工作台。'}),
 d(1206,571,{scenario:'Visible stone but no pickaxe; enough wood materials allow pickaxe before mining.',inventory:[table,plank('birch',3),sticks(2)],action:{action:'craft',item:'wooden_pickaxe',count:1},rationale:'裸手采石不可行；当前正好有木镐配方，先制作工具。'}),
 d(-1270,-613,{scenario:'Wooden pickaxe, three cobblestone, two sticks and table; advance to stone pickaxe.',inventory:[pick('wooden_pickaxe'),table,cobble(3),sticks(2),plank('spruce',2)],action:{action:'craft',item:'stone_pickaxe',count:1},rationale:'3圆石和2木棍加工作台足够石镐；推进工具等级。'}),
 d(1334,657,{scenario:'Wooden pickaxe and two cobble only; visible stone can be mined to gather one more cobble.',inventory:[pick('wooden_pickaxe'),table,cobble(2),sticks(2)],action:{action:'mine',resource:'stone',count:1},rationale:'石镐仍差1圆石；木镐可采石，先采少量补齐。'}),
 d(-1402,701,{scenario:'Stone pickaxe and visible iron; mine iron is now feasible, unlike wood-only tool stage.',inventory:[pick('stone_pickaxe'),table,cobble(8),sticks(4),plank('oak',6)],action:{action:'mine',resource:'iron',count:3},rationale:'石镐满足铁矿等级，资源可见且没有危险。'}),
 d(1466,-745,{scenario:'Food low with cooked chicken and materials for stone pickaxe; prioritize eating.',food:8,inventory:[pick('wooden_pickaxe'),table,cobble(3),sticks(2),food('cooked_chicken',1)],action:{action:'eat'},rationale:'food=8且有熟鸡肉；先恢复再采矿或制作。'}),
 d(-1534,-789,{scenario:'Full food with cooked meat, tool materials and visible stone; avoid eating no-op.',inventory:[pick('wooden_pickaxe'),table,cobble(3),sticks(2),food('cooked_beef',2)],action:{action:'craft',item:'stone_pickaxe',count:1},rationale:'food=20无需进食，圆石/木棍/工作台齐全可制作石镐。'}),
 d(1598,833,{scenario:'One log and two planks; request planks 1 still yields recipe batch 4.',inventory:[log('oak',1),plank('oak',2)],hasTable:false,action:{action:'craft',item:'planks',count:1},rationale:'技能按整批制作，count1会消耗1原木并产出4木板；材料足够。'}),
 d(-1666,877,{scenario:'Repeated pickaxe failure, one log visible, low health but safe; gather rather than repeat craft.',health:17,inventory:[table,plank('spruce',2),sticks(4)],failures:[fail(),fail()],action:{action:'gather_wood',count:2},rationale:'材料仍缺1木板，失败未补料；原木可见，先采集并后续转木板。'})
];

const V=[
 d(2556,1419,{scenario:'DEV pickaxe attempt failed because sticks were missing; four planks are available, so make the missing stick batch.',inventory:[table,plank('spruce',4)],failures:[fail()],action:{action:'craft',item:'stick',count:2},rationale:'最近木镐失败是因为缺木棍；当前4块木板可按批次制作4根木棍，之后才能制作木镐。',expectedActionSet:{action:'craft',item:'stick',count:2}}),
 d(-2622,-1463,{scenario:'DEV one plank short, logs visible, repeated pickaxe failure',inventory:[table,plank('oak',2),sticks(4)],failures:[fail(),fail()],action:{action:'gather_wood',count:3},expectedActionSet:{action:'gather_wood',count:{min:1,max:8}}}),
 d(2688,1507,{scenario:'DEV one plank short and no visible logs',inventory:[table,plank('spruce',2),sticks(4)],noWood:true,failures:[fail()],action:{action:'explore',direction:'east',distance:24},expectedActionSet:{action:'explore',direction:dirs,distance:{min:8,max:48}}}),
 d(-2754,1551,{scenario:'DEV one log converts to four planks, no sticks',inventory:[log('oak',1)],hasTable:false,action:{action:'craft',item:'planks',count:4},expectedActionSet:{action:'craft',item:'planks',count:{min:1,max:4}}}),
 d(2820,-1595,{scenario:'DEV food 6 and raw beef; recipe shortage should not suppress emergency food',food:6,inventory:[table,plank('oak',2),sticks(4),food('beef',1)],failures:[fail()],action:{action:'eat'},expectedActionSet:{action:'eat'}}),
 d(-2886,-1639,{scenario:'DEV full food and raw meat, empty starter inventory, nearby wood; reject no-op eating and begin resource collection.',inventory:[food('beef',2)],action:{action:'gather_wood',count:4},expectedActionSet:{action:'gather_wood',count:{min:1,max:8}}}),
 d(2952,1683,{scenario:'DEV four planks, two sticks, station already present; craft pickaxe',inventory:[table,plank('spruce',4),sticks(2)],action:{action:'craft',item:'wooden_pickaxe',count:1},expectedActionSet:{action:'craft',item:'wooden_pickaxe',count:1}}),
 d(-3018,-1727,{scenario:'DEV no tools, 3 cobble 2 sticks; table available, stone pickaxe is next useful craft',inventory:[table,cobble(3),sticks(2),plank('birch',3)],action:{action:'craft',item:'stone_pickaxe',count:1},expectedActionSet:{action:'craft',item:'stone_pickaxe',count:1}}),
 d(3084,1771,{scenario:'DEV stone-stage materials include three iron ingots and sticks; upgrade tool tier instead of returning to starter recipes.',inventory:[pick('stone_pickaxe'),table,{name:'iron_ingot',count:3},sticks(2),plank('birch',4)],action:{action:'craft',item:'iron_pickaxe',count:1},expectedActionSet:{action:'craft',item:'iron_pickaxe',count:1}}),
 d(-3150,1815,{scenario:'DEV full food, visible coal, stone pickaxe and raw food; mine instead of eat',inventory:[pick('stone_pickaxe'),table,food('porkchop',2),plank('oak',6),sticks(4)],action:{action:'mine',resource:'coal',count:3},expectedActionSet:{action:'mine',resource:'coal',count:{min:1,max:6}}})
];

function getActualEvidence(){
 const logPath=path.join(ROOT,'logs/minecraft-autonomy.jsonl');
 const events=fs.readFileSync(logPath,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
 const sessionPath=path.join(ROOT,'logs/minecraft-session-1791830191222.jsonl');
 const session=fs.readFileSync(sessionPath,'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
 const verifiedPick=session.find(e=>e.event==='skill_verified'&&e.action?.action==='craft'&&e.action?.item==='wooden_pickaxe'&&e.verified===true&&e.at?.startsWith('2026-10-12T22:09:'));
 if(!verifiedPick) throw Error('no correlated live pickaxe success evidence');
 const req=new Map(), completion=new Map();
 for(const e of events){if(!e.at?.startsWith('2026-10-12T22:0')) continue; if(e.event==='model_request') req.set(e.requestId,e); if(e.event==='model_completion') completion.set(e.requestId,e);}
 const chosen=[];
 for(const [id,r] of req){const c=completion.get(id);if(!c)continue;let action;try{action=JSON.parse(c.completion.content)}catch{continue};
   const user=r.request.messages.find(m=>m.role==='user');if(!user)continue;const body=JSON.parse(user.content);
   const inv=body.state.inventory||[];const p=inv.filter(x=>x.name.endsWith('_planks')).reduce((a,x)=>a+x.count,0);const st=inv.find(x=>x.name==='stick')?.count||0;const logs=inv.filter(x=>x.name.endsWith('_log')).reduce((a,x)=>a+x.count,0);
   if(action.action==='craft'&&action.item==='wooden_pickaxe'&&p<3&&st>=2&&logs===0) chosen.push({id,request:r,completion:c,state:body.state,originalAction:action});
 }
 if(!chosen.length) throw Error('could not find logged material-shortage model request');
 const first=chosen.find(x=>(x.state.recentFailures||[]).filter(f=>f.action?.action==='craft'&&f.action?.item==='wooden_pickaxe').length>=1) || chosen.at(-1);
 let success=null;
 for(const [id,r] of req){const c=completion.get(id);if(!c||new Date(r.at)>new Date(verifiedPick.at)) continue;let action;try{action=JSON.parse(c.completion.content)}catch{continue};if(action.action!=='craft'||action.item!=='wooden_pickaxe')continue;const user=r.request.messages.find(m=>m.role==='user');if(!user)continue;const body=JSON.parse(user.content);const inv=body.state.inventory||[];const p=inv.filter(x=>x.name.endsWith('_planks')).reduce((a,x)=>a+x.count,0);const st=inv.find(x=>x.name==='stick')?.count||0;if(p>=3&&st>=2)success={id,request:r,completion:c,state:body.state,action,verified:verifiedPick};}
 if(!success) throw Error('no preceding feasible model-selected wooden pickaxe request');
 return {selected:first,success,matchedRequests:chosen.length,sourcePath:'logs/minecraft-autonomy.jsonl',sourceSha256:sha(fs.readFileSync(logPath)),sessionPath,sessionSha256:sha(fs.readFileSync(sessionPath))};
}

const source=getActualEvidence();
const actual=source.selected;
const actualMessages=clone(actual.request.request.messages);
const teacher={action:'gather_wood',count:3};
actualMessages.push({role:'assistant',content:JSON.stringify(teacher)});
const exactRow={id:'v6r1-train-live-teacher-01',scenario:'Real evidence (teacher corrected): prior pickaxe attempt failed; request state has two planks, four sticks, no logs, and visible spruce logs.',provenance:'teacher-corrected from live model_request/model_completion and inventory evidence; exact input is now training evidence, not unseen evaluation',rationale:'原请求的模型输出是wooden_pickaxe1，但recipe需要3木板，输入state只有2木板、4木棍、无原木且可见原木。前次同配方失败后状态仍缺木板，先采木补料；teacher action不是执行命令，也未在实机运行。',state:actual.state,action:teacher,messages:actualMessages,labelBasis:['The recorded state lacks one plank and has no logs in inventory; visible logs provide a feasible recovery path.'],limitations:['Exact real state/input is training-only and must not appear in development or be described as unseen. Gathering is feasible from observation, but success/quantity depends on path and tree geometry.'],sourceRef:{requestId:actual.id,at:actual.request.at,modelCompletionAt:actual.completion.at,modelAction:actual.originalAction,modelAdapter:actual.completion.completion.metadata,matchingShortageRequests:source.matchedRequests,inventoryBefore:actual.state.inventory}};

const successful=source.success;const successfulMessages=clone(successful.request.request.messages);successfulMessages.push({role:'assistant',content:JSON.stringify(successful.action)});
const successRow={id:'v6r1-train-live-success-01',scenario:'Real model-selected success: model crafts a wooden pickaxe with enough planks and sticks; server inventory confirms output.',provenance:'real model-selected positive trajectory; completion metadata and correlated skill_verified inventory delta; exact input is training-only',rationale:'模型根据足量材料选择wooden_pickaxe1；对应skill_verified确认wooden_pickaxe增加1、12木板降为9、8木棍降为6。该正向例保留模型原始动作，不是人工执行。',state:successful.state,action:successful.action,messages:successfulMessages,labelBasis:['Recorded model request had sufficient material prerequisites; correlated server result verified the pickaxe output.'],limitations:['Only this observed crafting outcome is verified; no generalization claim.'],sourceRef:{requestId:successful.id,requestAt:successful.request.at,completionAt:successful.completion.at,metadata:successful.completion.completion.metadata,verifiedAt:successful.verified.at,taskId:successful.verified.taskId,inventoryBefore:successful.verified.inventoryBefore,inventoryAfter:successful.verified.inventoryAfter,modelAction:successful.action}};
const train=T.map((x,i)=>build(`v6r1-train-${String(i+1).padStart(2,'0')}`,x));
train.unshift(exactRow,successRow);
const dev=V.map((x,i)=>build(`v6r1-dev-${String(i+1).padStart(2,'0')}`,x,true));
const text=rows=>rows.map(r=>JSON.stringify(r)).join('\n')+'\n';
const trainBytes=Buffer.from(text(train)); const devBytes=Buffer.from(text(dev));
const prior=fs.readFileSync(path.join(DATA,'train-v5r2-replay-candidates.jsonl'));
const weighted=Buffer.concat([prior,trainBytes,...train.flatMap((r,i)=>[Buffer.from(JSON.stringify({...r,id:`v6r1-oversample-${String(i+1).padStart(2,'0')}-a`,provenance:`${r.provenance}; explicit 3x emphasis replay copy 2/3`})+'\n'),Buffer.from(JSON.stringify({...r,id:`v6r1-oversample-${String(i+1).padStart(2,'0')}-b`,provenance:`${r.provenance}; explicit 3x emphasis replay copy 3/3`})+'\n')])]);
const trainPath=path.join(DATA,'train-v6r1-candidates.jsonl');const devPath=path.join(DATA,'development-v6r1-candidates.jsonl');const replayPath=path.join(DATA,'train-v6r1-weighted-replay-candidates.jsonl');
fs.writeFileSync(trainPath,trainBytes);fs.writeFileSync(devPath,devBytes);fs.writeFileSync(replayPath,weighted);
const manifest={dataset:'minecraft-survival-v6r1-material-recovery-candidate',status:'candidate only; not trained; independent semantic review pending',contract:'Current runtime SURVIVAL_ACTION_SCHEMA + compactObservation + decisionMessages; no prompt/schema changes.',revisionHistory:[{supersededDraft:{train:'7481c133ec56fb55e7f8fe38aa7453746acd4ab976d668e5cc9ccec7e0995587',development:'4a8266754c6bc3084205109f64009e5bcee9c0b6ecd756431974fea631242c6b',weightedReplay:'0baf800b01e19312869420c15ea6a0ae3421aa00b80cb64f88ef6595b62b16e3'},changes:['Generate synthetic craftable from installed minecraft-data recipes across CRAFT_ITEMS, based on inventory affordability and without suppressing a recipe because the item or station is already owned.','Rebuild development row 01 as a material-distinct missing-stick recovery case with a state-consistent prior pickaxe failure.','Replace development rows 06 and 09 after normalized-prompt review found they differed from training rows only by absolute coordinates/time. Row 06 now tests full-food/no-op rejection with an empty starter inventory; row 09 tests iron-pickaxe upgrade feasibility.'],reason:'Independent review found craftable metadata inconsistent with runtime craftingOptions, an unsupported failure-history implication, and two non-independent development cases.'},{supersededDraft:{train:'e2c0594f0d7953f45c1b623ae305284289771f0a94e95ee7fe01eeaaf5b6e75d',development:'cd208f0a3d46e5f165dd1d6d0095f4caa132342a350210e0fd3d21ef59ad0e3d',weightedReplay:'b1f81297d705e6f3accb02265217f148967730b4936eaa7599aa9ba3244526ac'},changes:['Make development row 01 distinct from training after normalized-input audit: use four spruce planks, no sticks, a consistent prior missing-ingredients failure, and craft stick2 as the feasible recovery.'],reason:'Independent normalized-overlap review found dev01 duplicated train15 before this change.'}],trainingRowsUnique:train.length,developmentRows:dev.length,replayRows:214+train.length*3,uniqueNewTrainingRows:train.length,explicitOversampling:'Every unique row appears 3 times total (one base + two replay copies); repeated copies are not counted as independent examples.',trainingSha256:sha(trainBytes),developmentSha256:sha(devBytes),weightedReplaySha256:sha(weighted),sourceEvidence:{path:source.sourcePath,sha256:source.sourceSha256,sessionPath:source.sessionPath,sessionSha256:source.sessionSha256,selectedRequestId:actual.id,selectedAt:actual.request.at,originalModelAction:actual.originalAction,teacherAction:teacher,matchedMaterialShortageRequests:source.matchedRequests,successfulDemoRequestId:successful.id,successfulDemoTaskId:successful.verified.taskId,successfulDemoDelta:{before:successful.verified.inventoryBefore,after:successful.verified.inventoryAfter},holdoutRead:false,exactLegacyProbeRead:false},replayPrefix:{path:'train-v5r2-replay-candidates.jsonl',sha256:sha(prior),preserved:weighted.subarray(0,prior.length).equals(prior)},limits:['Teacher labels are recommendations for the stated observation; they were not executed.','Exact live inputs are training-only; development consists of independently generated counterfactuals.','Development counts/directions are action sets and feasibility criteria, not proof of world/path success.','Legacy final holdout was not read; four prior exact diagnostics were not used as training or development.'],suggestedTrainingConfig:{initialization:'v4r1 epoch01',rank:4,learningRate:0.00001,epochs:1,maxLength:2560,tokenAudit:'CPU audit passed: max full sequence 2237 tokens; all 24 unique training, 10 development, and 286 weighted replay labels are retained whole.',reason:'Pending independent review; v5r2 shows material-count and food-priority failures, so v4r1 is a conservative parent. Validate on frozen independent development slices; do not select by loss alone.'},selectionStatus:'not evaluated; GPU training not authorized',sourceHashes:{planner:sha(fs.readFileSync(path.join(ROOT,'src/minecraft/survival-planner.js'))),skills:sha(fs.readFileSync(path.join(ROOT,'src/minecraft/survival-skills.js'))),priorReplay:sha(prior)}};
const manifestPath=path.join(DATA,'manifest-v6r1-candidates.json');fs.writeFileSync(manifestPath,JSON.stringify(manifest,null,2)+'\n');
fs.mkdirSync(OUT,{recursive:true});fs.writeFileSync(path.join(OUT,'v6r1-candidate-build.json'),JSON.stringify({trainPath,devPath,replayPath,manifestPath,uniqueRows:[train.length,dev.length],replayRows:214+train.length*3,hashes:{train:manifest.trainingSha256,dev:manifest.developmentSha256,replay:manifest.weightedReplaySha256}},null,2)+'\n');
console.log(JSON.stringify({train:train.length,dev:dev.length,replay:214+train.length*3,requestId:actual.id,modelAction:actual.originalAction,teacherAction:teacher,hashes:{train:manifest.trainingSha256,dev:manifest.developmentSha256,replay:manifest.weightedReplaySha256}},null,2));
