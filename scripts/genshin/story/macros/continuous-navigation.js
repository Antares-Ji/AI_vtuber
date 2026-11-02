// Local feedback owns held movement; cloud inference runs only at intent boundaries.
const StoryContinuousNavigation = (() => {
  function create(deps) {
    const {grounding, read, sleep, checkInput, keyDown, keyUp, now = Date.now} = deps;
    return async function navigate(action) {
      if (!['W','A','S','D'].includes(action.key) || !Number.isInteger(action.ms)
          || action.ms < 400 || action.ms > 8000) throw Error('Invalid continuous navigation budget');
      const initial = read(), stage = grounding.questInstruction(initial)?.text;
      const result = {kind:'continuous-navigation', movementMsSent:0, checks:[], stopReason:null, verified:false};
      const stop = grounding.movementStop(initial);
      if (stop || !stage) return {...result, stopReason:stop || 'stage_missing'};
      let heldAt = null, missing = 0, stalledSince = now();
      let position = deps.position ? deps.position() : null, positionAt = now(), lastPositionProgressAt = now();
      if (deps.position && (!position || !Number.isFinite(position.x) || !Number.isFinite(position.y)))
        return {...result, stopReason:'position_unavailable'};
      let previousDistance = grounding.questHud(initial)?.meters ?? null;
      let bestDistance=previousDistance;
      result.progress={stageBefore:stage,stageAfter:stage,distanceBefore:previousDistance,distanceAfter:previousDistance};
      try {
        checkInput(); keyDown('VK_' + action.key); heldAt = now();
        while (now() - heldAt < action.ms) {
          await sleep(Math.min(200, action.ms - (now() - heldAt)));
          checkInput();
          const rows = read(), at = now(), instruction = grounding.questInstruction(rows);
          const distance = grounding.questHud(rows)?.meters ?? null;
          result.progress.stageAfter=instruction?.text??null;result.progress.distanceAfter=distance;
          result.checks.push({at, distance});
          result.stopReason = grounding.movementStop(rows);
          if (!result.stopReason && deps.world && !deps.world()) result.stopReason = 'native_world_changed';
          if (!result.stopReason && instruction && instruction.text !== stage) result.stopReason = 'stage_changed';
          missing = instruction ? 0 : missing + 1;
          if (!result.stopReason && missing >= 2) result.stopReason = 'stage_missing';
          if (distance !== null && previousDistance !== null) {
            if (distance <= 5) result.stopReason ||= 'near_distance';
            if (distance > bestDistance + 2) result.stopReason ||= 'distance_increased';
            if (distance < previousDistance) stalledSince = at;
            else if (at - stalledSince > 1800) result.stopReason ||= 'distance_stalled';
          }
          if (distance !== null) {previousDistance = distance;bestDistance=bestDistance===null?distance:Math.min(bestDistance,distance);}
          if (!result.stopReason && deps.position && at-positionAt >= 600) {
            const next=deps.position();positionAt=now();
            if (!next || !Number.isFinite(next.x) || !Number.isFinite(next.y)) result.stopReason='position_unavailable';
            else if (Math.hypot(next.x-position.x,next.y-position.y)>30) result.stopReason='position_unstable';
            else if (Math.hypot(next.x-position.x,next.y-position.y)>=1) {position=next;lastPositionProgressAt=now();}
            else if (now()-lastPositionProgressAt>=1800) result.stopReason='position_stalled';
          }
          if (result.stopReason) break;
        }
        result.stopReason ||= 'duration_budget';
      } finally {
        keyUp('VK_' + action.key);
        if (heldAt !== null) result.movementMsSent = now() - heldAt;
      }
      return result;
    };
  }
  // Join both tasks before returning: cancellation cannot leave pathing behind.
  async function monitorPath({run, cts, read, checkInput, sleep, now = Date.now, inspect}) {
    let done = false, error = null, stopReason = null;
    const samples = [];
    const running = (async () => { try { await run(); } catch (e) { error = e; }
      finally { done = true; } })();
    try {
      while (!done) {
        await sleep(250);
        if (done) break;
        checkInput();
        const rows = read();
        const sample = inspect(rows); samples.push({at:now(), ...sample});
        if (sample.stopReason) {stopReason = sample.stopReason; cts.cancel(); break;}
      }
    } finally { if (!done) cts.cancel(); await running; }
    if (error) throw error;
    return {stopReason, samples};
  }
  async function advanceDialogue({grounding,read,checkInput,keyDown,keyUp,sleep,now=Date.now}) {
    const startedAt=now(),result={kind:'dialogue-advance',advances:0,stopReason:null,verified:false};
    let previous=null,stale=0;
    while(result.advances<20&&now()-startedAt<30000){
      checkInput();const rows=read();
      if(grounding.sceneCue(rows)!=='dialogue'){result.stopReason='scene_changed';break;}
      const options=rows.filter(t=>t.box?.[0]>1080&&t.box[0]<1800&&t.box[1]>250&&t.box[1]<850&&t.box[2]>30&&/[\u4e00-\u9fff]/.test(t.text));
      if(options.length){result.stopReason='options';break;}
      const subtitle=rows.filter(t=>t.box?.[1]>=890&&t.box[1]<1015).map(t=>t.text).join('|');
      stale=subtitle===previous?stale+1:0;previous=subtitle;
      if(stale>=3){result.stopReason='subtitle_stalled';break;}
      keyDown('VK_SPACE');try{await sleep(80);}finally{keyUp('VK_SPACE');}
      result.advances++;await sleep(800);
    }
    result.stopReason||='budget';return result;
  }
  async function seek({navigate,checkInput,now=Date.now}) {
    const result={kind:'quest-seek',movementMsSent:0,segments:[],stopReason:null,verified:false};
    const startedAt=now(),directions=['W','S','A','D'];let index=0;
    for(let n=0;n<8&&now()-startedAt<60000&&index<directions.length;n++){
      checkInput();const step=await navigate({key:directions[index],ms:8000});
      result.segments.push({key:directions[index],...step});result.movementMsSent+=step.movementMsSent||0;
      if(!result.progress&&step.progress)result.progress={...step.progress};
      else if(step.progress&&result.progress)Object.assign(result.progress,{distanceAfter:step.progress.distanceAfter,stageAfter:step.progress.stageAfter});
      if(['distance_increased','distance_stalled','position_stalled'].includes(step.stopReason)){index++;continue;}
      if(step.stopReason!=='duration_budget'){result.stopReason=step.stopReason;break;}
      // A decreasing HUD permits another continuous run in this direction;
      // never continue an unmeasurable search as if it were an approach.
      if(!Number.isFinite(step.progress?.distanceAfter)){result.stopReason='hud_unavailable';break;}
    }
    result.stopReason||=index>=directions.length?'directions_exhausted':'duration_budget';return result;
  }
  return {create, monitorPath, advanceDialogue, seek};
})();
if (typeof module !== 'undefined' && module.exports) module.exports = StoryContinuousNavigation;
