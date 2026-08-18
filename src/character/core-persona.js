const CORE_PERSONA_CONTRACT = {
  schemaVersion: 1,
  required: ["id", "name", "displayName", "systemPrompt", "traits", "boundaries", "worldBook"],
  principles: [
    "角色包定义身份与文化背景，大脑引擎定义记忆、情绪、规划和安全逻辑。",
    "移除或更换角色包后，记忆分层、情绪流、关系模型与能力系统仍应正常工作。",
    "角色可以表达关心与珍惜，但不得情感绑架、宣称意识或假装现实身份。",
    "稳定人格来自长期价值权重，短期情绪只调整表达，不篡改核心价值。"
  ]
};

function validatePersonaPack(pack) {
  const missing = CORE_PERSONA_CONTRACT.required.filter(key => pack?.[key] === undefined);
  if (missing.length) throw new Error(`Persona pack is missing: ${missing.join(", ")}`);
  return pack;
}

module.exports = { CORE_PERSONA_CONTRACT, validatePersonaPack };
