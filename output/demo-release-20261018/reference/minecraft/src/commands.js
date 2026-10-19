// Exact commands only: dialogue/model output cannot become arbitrary game chat.
const aliases = new Map([
  ['status', 'status'], ['状态', 'status'], ['查看状态', 'status'],
  ['workbench', 'workbench'], ['制作工作台', 'workbench'], ['砍树并制作工作台', 'workbench'],
  ['stop', 'stop'], ['停止', 'stop'], ['停止任务', 'stop'],
  ['defend', 'defend'], ['自动防卫', 'defend'], ['打僵尸', 'defend'],
  ['tp', 'tp'], ['传送到我身边', 'tp'],
  ['quit', 'quit'], ['退出游戏', 'quit']
]);
function parseCommand(text) {
  if (typeof text !== 'string') throw new Error('指令必须是文本');
  const command = aliases.get(text.trim());
  if (!command) throw new Error('未支持的指令，请使用状态、制作工作台、打僵尸、停止、传送到我身边或退出游戏');
  return command;
}
function validateCommand(command, state) {
  if (command === 'quit' || command === 'stop') return;
  if (!state.connected) throw new Error('机器人未进入世界');
  if (command === 'workbench' || command === 'tp') {
    if (state.busy) throw new Error('已有任务执行中，请先停止');
  }
  if (command === 'workbench' && state.mode !== 'survival') throw new Error('砍树练习需要生存模式');
}
module.exports = { parseCommand, validateCommand };
