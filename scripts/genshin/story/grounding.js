// Shared pure OCR grounding. Requiring this file in Node never starts gameplay.
const StoryGrounding=(()=>{
 const normal=s=>String(s||'').replace(/\s/g,'');
 const positioned=texts=>(texts||[]).filter(t=>Array.isArray(t.box)&&t.box.length===4&&t.box.every(Number.isFinite));
 function questInstruction(texts){return positioned(texts).find(t=>/^(前往|前去|寻找|跟随|尝试|抵达|与.+对话)/.test(normal(t.text))&&t.box[0]>=0&&t.box[0]<640&&t.box[1]>=0&&t.box[1]<540)||null;}
 function questMenu(texts){
  const rows=positioned(texts),compact=(texts||[]).map(t=>normal(t.text));
  const legacy=compact.some(t=>t.includes('任务专注模式'))&&compact.some(t=>/进行中|传说任务|完成系列任务/.test(t));
  const header=rows.some(t=>normal(t.text)==='进行中'&&t.box[0]<650&&t.box[1]<150);
  const controls=rows.some(t=>/^(任务总览|追踪目标|停止追踪|开始追踪)$/.test(normal(t.text))&&t.box[1]>900);
  const category=rows.some(t=>/^(委托任务|世界任务|传说任务|魔神任务)$/.test(normal(t.text))&&t.box[0]<650&&t.box[1]>150);
  const titles=rows.filter(t=>t.box[0]>700&&t.box[0]<1500&&t.box[1]>=100&&t.box[1]<165&&t.box[2]>50&&String(t.text).length>=2);
  const complete=legacy||header&&controls&&category&&titles.length===1;
  const tracking=rows.filter(t=>/^(追踪目标|停止追踪|开始追踪)$/.test(normal(t.text))&&t.box[0]>1400&&t.box[0]<1850&&t.box[1]>930&&t.box[1]<1040&&t.box[2]>50&&t.box[2]<300&&t.box[3]<65);
  const stage=rows.some(t=>t.box[0]>800&&t.box[0]<1300&&t.box[1]>=180&&t.box[1]<300&&t.box[2]>50&&/^(前往|前去|寻找|跟随|尝试|抵达|与.+对话)/.test(normal(t.text)));
  const descriptions=rows.filter(t=>t.box[0]>800&&t.box[0]<1100&&t.box[1]>=300&&t.box[1]<700&&t.box[2]>250&&t.box[3]<65&&normal(t.text).length>=12);
  // A partially obscured list is not a selectable list. Recognize only the
  // independently complete right-hand detail panel, retaining no guessed entries.
  const listIncomplete=!complete;
  if(listIncomplete&&!(titles.length===1&&tracking.length===1&&stage&&new Set(descriptions.map(t=>normal(t.text))).size>=2))return null;
  const entries=listIncomplete?[]:rows.filter(t=>t.box[0]<650&&t.box[1]>=100&&t.box[1]<980&&t.box[2]>30&&String(t.text).length>=2&&!/^\d+\s*(m|米)$/i.test(t.text)&&!/^(委托任务|世界任务|传说任务|魔神任务)$/.test(normal(t.text))).map(t=>{
   const labels=rows.filter(d=>/^\d+\s*(m|米)$/i.test(normal(d.text))&&Math.abs(d.box[0]-t.box[0])<45&&d.box[1]>=t.box[1]+t.box[3]-5&&d.box[1]<t.box[1]+t.box[3]+55);
   return {text:t.text,box:t.box,distanceMeters:labels.length===1?Number(normal(labels[0].text).match(/^\d+/)[0]):null};
  });
  return {source:listIncomplete?'bettergi_ocr_quest_detail_layout':'bettergi_ocr_quest_menu_layout',...(listIncomplete?{listIncomplete:true}:{}),title:titles.length===1?titles[0].text:null,entries,controls:(listIncomplete?tracking:rows.filter(t=>/^(任务总览|追踪目标|停止追踪|开始追踪)$/.test(normal(t.text))&&t.box[1]>900)).map(t=>({text:t.text,box:t.box}))};
 }
 function recoveryPrompt(texts){
  const rows=positioned(texts);
  const controls=rows.filter(t=>normal(t.text)==='复苏'&&t.box[0]>=700&&t.box[0]<=1200&&t.box[1]>=900&&t.box[1]<1030&&t.box[2]<250);
  const titles=rows.filter(t=>t.box[0]>=650&&t.box[0]<1200&&t.box[1]>=280&&t.box[1]<500&&t.box[3]>=45&&normal(t.text).length>=2);
  const explanations=rows.filter(t=>t.box[0]>=450&&t.box[0]<1300&&t.box[1]>=490&&t.box[1]<700&&t.box[2]>250&&normal(t.text).length>=10);
  if(controls.length!==1||titles.length!==1||!explanations.length)return null;
  return {source:'bettergi_ocr_recovery_layout',title:titles[0].text,explanations:explanations.map(t=>t.text),controls:controls.map(t=>({text:t.text,box:t.box}))};
 }
 function mapMenu(texts){
  const rows=positioned(texts);
  const coverage=rows.filter(t=>/^探索度\d{1,3}%$/.test(normal(t.text))&&t.box[0]>1400&&t.box[1]>950);
  const region=rows.filter(t=>t.box[0]>1400&&t.box[1]>940&&t.box[1]<1020&&t.box[2]>40&&/^[\u4e00-\u9fff「」·]{2,20}$/.test(normal(t.text)));
  const counter=rows.some(t=>/^\d+\/\d+$/.test(normal(t.text))&&t.box[0]>1300&&t.box[1]<100);
  if(coverage.length===1&&region.length===1&&counter)return {source:'bettergi_ocr_map_layout',kind:'overview',region:region[0].text,controls:[]};
  const close=rows.filter(t=>/^[X×]$/.test(normal(t.text))&&t.box[0]>1800&&t.box[1]<100);
  const travel=rows.filter(t=>/^传送(?:至.{1,20})?$/.test(normal(t.text))&&t.box[0]>1400&&t.box[1]>930);
  const heading=rows.filter(t=>t.box[0]>1400&&t.box[0]<1800&&t.box[1]<90&&t.box[2]>50&&normal(t.text).length>=2);
  const description=rows.filter(t=>t.box[0]>1400&&t.box[1]>140&&t.box[1]<700&&t.box[2]>250&&normal(t.text).length>=10);
  if(close.length===1&&travel.length===1&&heading.length===1&&description.length>=2)return {source:'bettergi_ocr_map_layout',kind:'detail',title:heading[0].text,controls:[{text:travel[0].text,box:travel[0].box}]};
  return null;
 }
 function sceneCue(texts){
  const rows=positioned(texts);
  if(mapMenu(texts))return 'map';
  if(questMenu(texts)||recoveryPrompt(texts))return 'menu';
  if((texts||[]).some(t=>/任务专注模式|队伍配置|商城/.test(t.text)))return 'menu';
  const subtitle=rows.some(t=>t.box[0]>100&&t.box[0]<1600&&t.box[1]>=890&&t.box[1]<1015&&t.box[2]>180&&String(t.text).length>=8&&/[\u4e00-\u9fff]/.test(t.text));
  const cue=rows.some(t=>t.box[0]>650&&t.box[0]<1150&&t.box[1]>=800&&t.box[1]<910&&t.box[2]<250&&/[\u4e00-\u9fff]/.test(t.text)||/^自动(?:播放)?$/.test(t.text)&&t.box[1]<150);
  return subtitle&&cue?'dialogue':null;
 }
 function interaction(texts){
  if(sceneCue(texts))return {state:'not_world',candidates:[]};
  const rows=positioned(texts);
  // BetterGI AutoPick's F area, including its slightly shifted NPC/chat row.
  // Coordinates are OCR rectangles in BetterGI's normalized 1920x1080 frame.
  const anchors=rows.filter(t=>normal(t.text)==='F'&&t.box[0]>=1080&&t.box[0]<=1280&&t.box[1]>=300&&t.box[1]<=780&&t.box[2]<=65&&t.box[3]<=65);
  const candidates=[];
  for(const f of anchors){
   const [x,y,w,h]=f.box;
   const labels=rows.filter(t=>normal(t.text)!=='F'&&t.box[0]>=x+w&&t.box[0]<x+w+220&&t.box[0]+t.box[2]<1850&&Math.abs(t.box[1]+t.box[3]/2-y-h/2)<=18&&normal(t.text).length>=2&&!/^\d+\s*(m|米)$/i.test(t.text)&&!/^UID/.test(t.text));
   if(labels.length===1)candidates.push({text:labels[0].text,box:labels[0].box,anchor:f.box,source:'bettergi_ocr_f_label_pair'});
  }
  return {state:anchors.length===1&&candidates.length===1?'unique':anchors.length?'ambiguous':'absent',candidates};
 }
 function movementStop(texts){return sceneCue(texts)||(['unique','ambiguous'].includes(interaction(texts).state)?'interaction_prompt':null);}
 function detail(step){try{return JSON.parse(step?.detail);}catch{return null;}}
 function navigationFeedback(steps){
  let failures=0;
  for(const step of steps||[]){
   const d=detail(step);
   if(step.action?.kind==='move'&&d?.movedMs>0||step.action?.kind==='advance_quest'&&d?.trace?.length>0||step.action?.kind==='teleport'&&String(step.detail).includes('传送调用返回')){failures=0;continue;}
   if(step.action?.kind!=='follow_marker')continue;
   const legacyMissing=d?.trace?.length>0&&d.trace.every(t=>t.marker===null&&t.matches!==1);
   if(d&&(legacyMissing||['marker_missing_or_ambiguous','alignment_stalled','distance_stalled','distance_increased'].includes(d.stopReason)||d.movedMs===0&&d.stopReason!=='near_label'))failures++;
   else failures=0;
  }
  return {failedFollows:failures,blocked:failures>=2};
 }
 function interactionBlocked(steps,text){
  let attempts=0;
  for(const step of steps||[]){
   const d=detail(step);
   if(d?.kind==='interaction'&&d.sent&&normal(d.target)===normal(text)&&d.outcome==='prompt_unchanged')attempts++;
   else if(d?.kind==='interaction'&&!d.sent&&normal(d.target)===normal(text))continue;
   else if(!['wait','reset_camera'].includes(step.action?.kind))attempts=0;
  }
  return attempts>=2;
 }
 function travelFeedback(steps){
  let failures=0;
  const failedReasons=new Set(['bearing_unavailable','alignment_stalled','position_unavailable','position_unstable','direction_unverified','distance_stalled','distance_increased','leg_timeout','native_api_unavailable','native_error']);
  for(const step of steps||[]){
   const d=detail(step);
   // A sent recovery move permits a new attempt; it is not proof of arrival.
   if(step.action?.kind==='move'&&d?.movedMs>0||step.action?.kind==='advance_quest'&&d?.trace?.length>0||step.action?.kind==='teleport'&&String(step.detail).includes('传送调用返回')){failures=0;continue;}
   if(step.action?.kind!=='travel_quest')continue;
   const p=d?.progress;
   if(p&&normal(p.stageBefore)===normal(p.stageAfter)&&Number.isFinite(p.distanceBefore)&&Number.isFinite(p.distanceAfter)&&p.distanceBefore>p.distanceAfter){failures=0;continue;}
   if(failedReasons.has(d?.stopReason))failures++;
  }
  return {failedTravels:failures,blocked:failures>=2};
 }
  function questHud(texts) {
    const rows = positioned(texts);
    const instructions = rows.filter(row => questInstruction([row]));
    if (new Set(instructions.map(row => normal(row.text))).size !== 1) return null;
    const instruction = instructions[0];
    const [x, y, width, height] = instruction.box;
    const readings = rows.flatMap(row => {
      const match = normal(row.text).match(/^(\d{1,5})(?:m|米)$/i);
      return match && row.box[0] >= x - 30 && row.box[0] < x + Math.min(width, 220)
        && row.box[1] >= y + height - 8 && row.box[1] < y + height + 85
        ? [{ ...row, meters: Number(match[1]) }] : [];
    });
    const crop = readings.filter(row => row.source === 'quest_distance_crop');
    const values = [...new Set((crop.length ? crop : readings).map(row => row.meters))];
    if (values.length !== 1) return null;
    return { stage: instruction.text, distance: values[0], meters: values[0], source: 'bettergi_ocr_quest_hud', verified: false };
  }

  function travelEligibility({ texts, scene, uncertain = false, recentNativeSteps = [] }) {
    const stop = movementStop(texts);
    const hud = questHud(texts);
    const feedback = travelFeedback(recentNativeSteps);
    const reason = uncertain ? 'observation_uncertain' : scene !== 'world' ? 'not_world'
      : stop || (!hud ? 'hud_unavailable' : hud.meters <= 8 ? 'near_distance'
        : hud.meters > 1500 ? 'distance_out_of_range' : feedback.blocked ? 'travel_recovery_required' : null);
    return { ok: reason === null, reason, hud, feedback };
  }

  function questDistanceLabel(texts) {
    if (movementStop(texts)) return null;
    const hud = questHud(texts);
    if (!hud) return null;
    // Only one scene distance is acceptable; another distance is ambiguous even
    // if just one happens to agree. Never reuse the HUD crop itself as a target.
    const labels = positioned(texts).flatMap(row => {
      const match = normal(row.text).match(/^(\d{1,5})(?:m|米)$/i);
      return match && row.source !== 'quest_distance_crop' && row.box[0] > 400
        && row.box[0] + row.box[2] < 1620 && row.box[1] > 110
        && row.box[1] + row.box[3] < 850 ? [{ ...row, meters: Number(match[1]) }] : [];
    });
    if (labels.length !== 1 || Math.abs(labels[0].meters - hud.meters) > 1) return null;
    const label = labels[0];
    return { source: 'bettergi_ocr_hud_world_distance_agreement', meters: hud.meters,
      box: label.box, x: label.box[0] + label.box[2] / 2,
      y: label.box[1] + label.box[3] / 2,
      direction: label.box[0] + label.box[2] / 2 < 880 ? 'left' : label.box[0] + label.box[2] / 2 > 1040 ? 'right' : 'center', verified: false };
  }

 return {interaction,movementStop,sceneCue,navigationFeedback,travelFeedback,interactionBlocked,questMenu,recoveryPrompt,questInstruction,mapMenu,questHud,travelEligibility,questDistanceLabel};
})();

if(typeof module!=='undefined'&&module.exports)module.exports=StoryGrounding;
