const { getSingingStatus } = require("../singing/provider");

const CAPABILITIES = [
  { id: "conversation", name: "中文对话", status: "ready", boundary: "可以进行文字与语音识别驱动的对话" },
  { id: "memory", name: "分层记忆", status: "ready", boundary: "可以读取已审核长期记忆；新长期记忆需要人工确认" },
  { id: "speech", name: "语音朗读", status: "ready", boundary: "可以把台词朗读出来，但朗读不是演唱" },
  { id: "singing", name: "唱歌", status: "unavailable", boundary: "当前没有歌声合成、旋律控制和合法曲库模块，不能声称已经会唱" },
  { id: "osu-vision", name: "osu! 画面理解", status: "limited", boundary: "只能进行第一版画面候选识别和人工结算数据分析，不能实时看懂全部谱面，也不能代打" },
  { id: "bilibili", name: "B站直播连接", status: "limited", boundary: "已有事件适配层；没有开放平台凭据时不能声称已连接真实直播间" },
  { id: "live-time", name: "实时时间", status: "ready", boundary: "涉及当前时间时必须先读取时间工具结果" },
  { id: "internet", name: "互联网检索", status: "unavailable", boundary: "角色运行时没有通用联网搜索工具，不能假装刚刚查过网络" }
];

function evaluateCapabilityRequest(text) {
  const source = String(text || "");
  const rules = [
    { pattern: /唱(?:一首|首|歌)|唱给|翻唱|清唱/, id: "singing" },
    { pattern: /帮我打|自动打|代打|你来玩.*osu|直接玩.*osu/i, id: "osu-vision" },
    { pattern: /看(?:到|懂).*(?:屏幕|画面|谱面)|分析.*(?:屏幕|画面)/, id: "osu-vision" },
    { pattern: /连接.*B站|正在B站直播|真实弹幕/, id: "bilibili" },
    { pattern: /上网|搜索|查一下网络|网上看看/, id: "internet" }
  ];
  const match = rules.find(rule => rule.pattern.test(source));
  return match ? capabilityInventory().find(capability => capability.id === match.id) : null;
}

function capabilityPrompt(request = null) {
  const inventory = capabilityInventory().map(item => `${item.name}=${item.status}（${item.boundary}）`).join("；");
  return `能力清单：${inventory}。${request ? `本轮触发能力“${request.name}”，状态为 ${request.status}：${request.boundary}。必须诚实说明当前边界，可以表达未来愿望，但不得把愿望说成已经具备的能力。` : "没有触发特殊能力请求。"}`;
}

function capabilityInventory() {
  const singing = getSingingStatus();
  return CAPABILITIES.map(item => item.id === "singing" && singing.ready
    ? { ...item, status: "ready", boundary: "歌声引擎、合法模型与至少一首授权曲目均已通过检查；仍只能演唱授权清单内曲目" }
    : item);
}

module.exports = { CAPABILITIES, capabilityInventory, evaluateCapabilityRequest, capabilityPrompt };
