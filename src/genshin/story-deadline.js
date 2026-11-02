'use strict';
function frameBudget(request,signal,clock=Date.now){
 const nativeDeadline=Math.min(request.capturedAt+120000,Number.isFinite(request.deadlineAt)?request.deadlineAt:Infinity);
 const deadlineAt=nativeDeadline-10000;
 const remaining=()=>Math.max(0,deadlineAt-clock());
 const error=()=>Object.assign(Error('剧情单帧观察与决策总预算耗尽；没有发送过期输入'),{code:'STORY_FRAME_TIMEOUT'});
 return {deadlineAt,nativeDeadline,remaining,
  check(){signal?.throwIfAborted();if(remaining()<=0)throw error();},
  signal(maxMs=Infinity){signal?.throwIfAborted();if(remaining()<=0)throw error();const timer=AbortSignal.timeout(Math.max(1,Math.floor(Math.min(maxMs,remaining()))));return signal?AbortSignal.any([signal,timer]):timer;},
  expired:()=>remaining()<=0,error};
}
module.exports={frameBudget};
