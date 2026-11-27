'use strict';
const { respond } = require('./model-provider');
const { SKILLS, validatePlan } = require('./planner');

async function planWithApi(goal, options = {}) {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 1000) throw Error('目标需要 1–1000 字符');
  const answer = await respond(goal, { ...options,
    instructions: `你是原神主播的任务规划器。仅可用技能：${JSON.stringify(SKILLS)}。必须先 observe。当前没有游戏画面，不能假定已经就位或完成任务。最多6步。不得执行代码，不把计划说成结果。`,
    schema: { type: 'object', additionalProperties: false, required: ['goal', 'steps'], properties: {
      goal: { type: 'string' }, steps: { type: 'array', minItems: 1, maxItems: 6, items: {
        type: 'object', additionalProperties: false, required: ['skill', 'timeoutMs'], properties: {
          skill: { type: 'string', enum: Object.keys(SKILLS) }, timeoutMs: { type: 'integer', minimum: 100, maximum: 120000 }
        } } }
    } } });
  let value; try { value = JSON.parse(answer.text); } catch { throw Error('模型未返回有效计划 JSON'); }
  const plan = validatePlan({ ...value, goal });
  if (plan.steps[0].skill !== 'observe') throw Error('模型计划必须先观察当前场景');
  return { ...plan, planner: 'llm', provider: answer.provider, model: answer.model, usage: answer.usage };
}
module.exports = { planWithApi };
