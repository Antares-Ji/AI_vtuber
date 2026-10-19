'use strict';
// Factual narration is rendered from telemetry, never from a model paraphrase.
const REACTIONS = ['', '慢慢来，稳一点。', '这段有点考验耐心。', '谢谢大家陪着我。', '这下心情好多了。', '先别急，我们一步一步来。'];
const activities = { gather_wood: '采集木头', mine: '采矿', craft: '制作物品', hunt: '寻找食物', eat: '进食', flee: '避险', explore: '探索', observe: '观察环境', collect: '拾取物品', build_home: '建造住所', build_portal: '搭建传送门' };
function factualSpeech(context) {
  if (!context?.connected || context.stale) return '暂时收不到游戏实时状态，还不能确认当前进度。';
  if (context.phase === '死亡') return '刚刚倒下了，游戏状态需要重新确认。';
  if (context.phase === '避险') return '正在处理附近危险，目前还不能确认安全。';
  const execution = context.execution;
  const result = context.result;
  const activity = action => activities[action?.action] || '这一步';
  if (execution?.status === 'running') return `正在尝试${activity(execution.action)}，还没有完成确认。`;
  if (execution?.status === 'cancelled') return '刚才的动作已停止，不能把它算作完成。';
  if (execution?.status === 'rejected' || context.error) return '这次尝试没有顺利完成，需要重新检查计划。';
  if (result?.partial) return `刚才${activity(result.action)}只完成了一部分，目标尚未完成。`;
  if (result?.verified) return `刚才${activity(result.action)}这一步已核验完成。`;
  if (result && ['failed', 'rejected', 'cancelled'].includes(result.status)) return '刚才这一步未完成，需要重新检查计划。';
  if (context.phase === '暂停') return '游戏任务目前暂停，可以继续聊天。';
  if (execution?.status === 'proposed') return `准备尝试${activity(execution.action)}，还未执行。`;
  return '正在检查下一阶段的计划，还没有新的完成结果。';
}
function composeFactSpeech(context, reaction) {
  if (!Number.isInteger(reaction) || reaction < 0 || reaction >= REACTIONS.length) reaction = 0;
  // A cheerful outcome reaction cannot accompany an unverified result.
  if (reaction === 4 && !context?.result?.verified) reaction = 0;
  return factualSpeech(context) + REACTIONS[reaction];
}
module.exports = { REACTIONS, factualSpeech, composeFactSpeech };
