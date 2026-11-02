'use strict';
const {questMenu,recoveryPrompt,questInstruction,mapMenu,sceneCue,questDistanceLabel}=require('../../scripts/genshin/story-main');
function dialogueEvidence(texts,modelScene){
 const positioned=texts.filter(t=>Array.isArray(t.box)&&t.box.length===4&&t.box.every(Number.isFinite));
 const subtitle=positioned.find(t=>t.box[0]>100&&t.box[0]<1600&&t.box[1]>=890&&t.box[1]<1015&&t.box[2]>180&&String(t.text).length>=8&&/[\u4e00-\u9fff]/.test(t.text));
 const speaker=positioned.find(t=>t.box[0]>650&&t.box[0]<1150&&t.box[1]>=800&&t.box[1]<910&&t.box[2]<250&&/[\u4e00-\u9fff]/.test(t.text));
 const auto=positioned.some(t=>/^自动(?:播放)?$/.test(t.text)&&t.box[1]<150);
 if(!subtitle||!speaker&&!auto)return null;
 const options=positioned.filter(t=>t.box[0]>1080&&t.box[0]<1800&&t.box[1]>250&&t.box[1]<850&&t.box[2]>30&&String(t.text).length>=2&&!/UID/.test(t.text)).map(t=>({text:t.text,box:t.box}));
 // Loading tips share the lower-centre heading/body geometry. A title alone
 // must not override the local model's menu/loading observation as dialogue.
 if(!auto&&!options.length&&!['dialog','dialogue'].includes(modelScene))return null;
 return {source:'bettergi_ocr_dialogue_layout',speaker:speaker?.text||null,subtitle:subtitle.text,options};
}
// VLM text alone must not turn a misread distance into reported progress.
function corroborateDistances(observation,texts,previous=null){
 const compact=texts.map(t=>String(t.text).replace(/\s/g,''));
 const taskMenu=questMenu(texts);
 const recovery=recoveryPrompt(texts);
 const map=mapMenu(texts);
 const paimonMenu=compact.includes('队伍配置')&&compact.includes('商城')&&compact.some(t=>/冒险等阶|世界等级/.test(t));
 const partialMenu=!taskMenu&&!recovery&&!map&&!paimonMenu&&sceneCue(texts)==='menu';
 if(taskMenu)observation={...observation,scene:'menu',questMenu:taskMenu,summary:'BetterGI OCR确认任务菜单已打开。'+observation.summary,navigation:{marker:'not_visible',terrain:'unknown',movement:'unknown',evidence:'任务菜单文字已核对，不能作为世界导航'}};
 if(paimonMenu&&!taskMenu)observation={...observation,scene:'menu',summary:'BetterGI OCR确认派蒙菜单已打开。'+observation.summary,navigation:{marker:'not_visible',terrain:'unknown',movement:'unknown',evidence:'派蒙菜单文字已核对'}};
 if(partialMenu)observation={...observation,scene:'menu',summary:'当前OCR有菜单线索，具体菜单类型尚未确认。'+observation.summary,navigation:{marker:'not_visible',terrain:'unknown',movement:'unknown',evidence:'与原生动作检查使用相同菜单线索，不能据背景判断大世界可行走'}};
 if(recovery)observation={...observation,scene:'menu',recoveryPrompt:recovery,summary:'BetterGI OCR确认复苏提示界面：'+recovery.title+'。'+recovery.explanations.join(' '),navigation:{marker:'not_visible',terrain:'unknown',movement:'unknown',evidence:'复苏按钮、居中标题及说明文字布局已核对，不能作为大世界导航'}};
 if(map)observation={...observation,scene:'map',map,summary:'BetterGI OCR确认地图'+(map.kind==='detail'?'详情界面：'+map.title:'总览界面：'+map.region),navigation:{marker:'not_visible',terrain:'unknown',movement:'unknown',evidence:'地图布局不能作为大世界行走地形或角色方位'}};
 const dialogue=!taskMenu&&!paimonMenu&&!partialMenu&&!recovery&&!map?dialogueEvidence(texts,observation.scene):null;
 if(dialogue)observation={...observation,scene:'dialogue',dialogue,summary:'BetterGI OCR确认剧情对话：'+dialogue.subtitle,navigation:{marker:'not_visible',terrain:'unknown',movement:'unknown',evidence:'对话字幕与说话人/自动标识已核对'}};
 if(observation.scene!=='world')observation={...observation,questArea:undefined};
 const searchText=/已到达任务区域|在此区域内搜索目标/;
 if(observation.scene==='world'&&!observation.uncertain&&(compact.some(t=>searchText.test(t))||observation.visible_text.some(t=>searchText.test(t))))observation.questArea={state:'search_area',source:compact.some(t=>searchText.test(t))?'bettergi_ocr':'local_vision',rule:'已经进入区域搜索；没有距离或精确追踪点是此阶段的正常情况，不是必须等待的故障。依据当前开阔地形有界探索，转镜头寻找NPC或交互提示；不要反复跟随没有精确目标的模板，也不要用ESC打开菜单。到搜索区域不等于找到目标。'};
 const pattern=/\b(\d{1,6})\s*(?:m\b|米)/gi;
 const distances=s=>[...String(s).matchAll(pattern)].map(m=>Number(m[1]));
 // Ping is at the top right; OCR can drop the final "s" from "24ms".
 // Keep it in raw text for auditing, but never use that HUD region as distance.
 const distanceTexts=texts.filter(t=>!(Array.isArray(t.box)&&t.box[0]>=1600&&t.box[1]<160));
 const rawMeters=[...new Set(distanceTexts.flatMap(t=>distances(t.text)))];
 // Full-frame OCR can drop a leading digit while the distance crop retains it.
 // Do not arbitrarily choose the smallest reading, or turn a sudden truncated
 // reading into arrival. A second fresh agreeing frame can confirm a change.
 const conflicting=observation.scene==='world'&&rawMeters.length>1;
 const prior=previous?.distanceEvidence?.rawMeters||previous?.distanceEvidence?.meters||[];
 const sudden=observation.scene==='world'&&rawMeters.length===1&&prior.length===1&&
  previous?.observation?.scene==='world'&&previous?.decision?.action?.kind!=='teleport'&&Math.abs(rawMeters[0]-prior[0])>30;
 const ocr=conflicting||sudden?[]:rawMeters;
 const label=observation.scene==='world'&&!observation.uncertain?questDistanceLabel(texts):null;
 if(label)observation={...observation,navigation:{...observation.navigation,marker:label.direction,evidence:'BetterGI OCR在当前帧找到与左上任务距离一致的唯一场景距离标签；这是标签方位，不证明路线可达。'},questDistanceLabel:label};
 const reported=[...new Set([...observation.visible_text,observation.summary].flatMap(distances))];
 const unsupported=reported.filter(n=>!ocr.includes(n));
 const scrub=s=>s.replace(pattern,(match,n)=>ocr.includes(Number(n))?match:'距离未核对');
 return {observation:{...observation,summary:scrub(observation.summary),visible_text:observation.visible_text.map(scrub)},
  distanceEvidence:{source:'bettergi_ocr',meters:ocr,rawMeters,unsupportedModelMeters:unsupported,status:conflicting?'conflicting_ocr':sudden?'unconfirmed_distance_jump':ocr.length?'ocr_read_not_arrival_proof':'unknown'},sceneEvidence:map?'bettergi_map_layout':recovery?'bettergi_recovery_layout':taskMenu?'bettergi_task_menu_text':paimonMenu?'bettergi_paimon_menu_text':partialMenu?'bettergi_partial_menu_text':'local_model'};
}
function trackingEvidence(observation,texts,selectedQuest){
 const menu=questMenu(texts),controls=menu?.controls.map(t=>t.text)||[];
 const hudStage=observation.scene==='world'?questInstruction(texts)?.text||null:null;
 let state=hudStage?'current_hud_text':'unconfirmed';
 if(menu&&menu.title===selectedQuest){
  const enabled=controls.filter(t=>t==='停止追踪'),disabled=controls.filter(t=>t==='追踪目标'||t==='开始追踪');
  if(enabled.length===1&&!disabled.length)state='menu_tracking_enabled';
  else if(disabled.length===1&&!enabled.length)state='menu_not_tracking';
 }
 return {selectedQuest:selectedQuest||null,hudStage,menuControls:controls,state,source:menu?'bettergi_ocr_quest_menu_layout':hudStage?'bettergi_ocr_quest_hud':'no_current_tracking_evidence',rule:'menu_tracking_enabled表示当前选中任务的按钮为停止追踪，当前已启用追踪；不能为刷新界面点停止追踪，也不需再找不存在的追踪目标。menu_not_tracking才表示当前菜单可启用追踪。current_hud_text是当前左上任务指令，不是历史任务名。没有当前HUD阶段/标记/距离且跟标失败时可由模型核对同一任务，不能仅凭历史地名反复换锚点。菜单按钮状态不是任务进展；仍须新大世界帧定位方向。'};
}
module.exports={corroborateDistances,questDistanceLabel,dialogueEvidence,trackingEvidence};
