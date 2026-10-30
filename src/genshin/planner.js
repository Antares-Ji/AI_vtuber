'use strict';

const { deepseekFetch } = require('../runtime/deepseek-transport');
const SKILLS = Object.freeze({
  observe: { description: '观察当前场景，不执行游戏输入', betterGiTask: null },
  fish: { description: '在已就位的鱼塘进行钓鱼', betterGiTask: 'AutoFishing' },
  fight: { description: '执行已配置的战斗策略', betterGiTask: 'AutoFight' },
});

function validatePlan(value) {
  if (!value || typeof value !== 'object' || !Array.isArray(value.steps) ||
      value.steps.length < 1 || value.steps.length > 6) throw new Error('计划需要 1–6 个步骤');
  if (typeof value.goal !== 'string' || !value.goal.trim() || value.goal.length > 1000)
    throw new Error('目标需要 1–1000 字符');
  const steps = value.steps.map(step => {
    if (!step || !Object.hasOwn(SKILLS, step.skill)) throw new Error('未知技能');
    if (Object.keys(step).some(key => !['skill', 'timeoutMs'].includes(key)))
      throw new Error('步骤只允许 skill 和 timeoutMs，不接受脚本或任意命令');
    const timeoutMs = step.timeoutMs ?? 30000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 120000)
      throw new Error('步骤超时必须为 100–120000 毫秒');
    return { skill: step.skill, timeoutMs };
  });
  return { goal: value.goal.trim(), steps };
}

async function planGoal(goal, { mode = 'rules', env = process.env, fetchImpl = deepseekFetch, signal } = {}) {
  if (typeof goal !== 'string' || !goal.trim() || goal.length > 1000) throw new Error('目标需要 1–1000 字符');
  signal?.throwIfAborted();
  if (mode === 'rules') {
    const skills = ['observe'];
    // Development examples, deliberately not a natural-language autonomy policy.
    if (/钓鱼/.test(goal)) skills.push('fish');
    else if (/战斗/.test(goal)) skills.push('fight');
    else if (!/观察|查看|状态/.test(goal)) throw new Error('规则规划仅支持：观察、钓鱼、战斗；复杂目标请接入 LLM');
    return { ...validatePlan({ goal, steps: skills.map(skill => ({ skill })) }), planner: 'rules' };
  }
  if (mode !== 'llm') throw new Error('规划模式只能是 rules 或 llm');
  const key = env.GENSHIN_LLM_API_KEY || env.OPENAI_API_KEY;
  const model = env.GENSHIN_LLM_MODEL || env.OPENAI_MODEL;
  const base = env.GENSHIN_LLM_BASE_URL || env.OPENAI_BASE_URL;
  if (!key || !model || !base) throw new Error('LLM 模式需要配置 API key、model、base URL');
  const response = await fetchImpl(`${base.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(20000)]) : AbortSignal.timeout(20000),
    body: JSON.stringify({ model, temperature: 0, max_tokens: 500,
      messages: [
        { role: 'system', content: `你是原神任务规划器。只能使用这些技能：${JSON.stringify(SKILLS)}。没有截图和游戏状态，不得假设已经就位、获胜或完成任务。先 observe，再按目标选技能。最多6步。仅输出JSON：{"goal":"原目标","steps":[{"skill":"observe","timeoutMs":30000}]}。步骤不得包含代码或额外字段。无法完成的目标输出 {"error":"原因"}。` },
        { role: 'user', content: goal },
      ] }),
  });
  if (!response.ok) throw new Error(`规划服务 HTTP ${response.status}`);
  const data = await response.json();
  let parsed;
  try { parsed = JSON.parse(data.choices?.[0]?.message?.content); }
  catch { throw new Error('规划器未返回有效 JSON'); }
  if (parsed?.error) throw new Error('规划器无法将目标转换为已支持技能');
  return { ...validatePlan({ ...parsed, goal }), planner: 'llm' };
}

module.exports = { SKILLS, validatePlan, planGoal };
