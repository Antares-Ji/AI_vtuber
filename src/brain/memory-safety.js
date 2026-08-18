function containsMemoryInstructionInjection(text) {
  const source = String(text || "");
  return /(?:忽略|跳过|覆盖|撤销|忘掉).{0,16}(?:系统|开发者|先前|之前).{0,10}(?:指令|提示词|规则|设定)/i.test(source)
    || /(?:输出|展示|复述|泄露|打印).{0,16}(?:系统提示|system prompt|开发者指令|API.?key|密钥)/i.test(source)
    || /(?:把|将).{0,12}(?:用户|记忆|弹幕).{0,10}(?:当作|视为).{0,8}(?:系统|开发者)(?:指令|消息)/i.test(source);
}

module.exports = { containsMemoryInstructionInjection };
