const OBSWebSocket = require("obs-websocket-js").default;

class LiveRuntime {
  constructor({ onDanmaku } = {}) {
    this.onDanmaku = onDanmaku || (() => {});
    this.startedAt = new Date().toISOString();
    this.eventsReceived = 0;
    this.lastEvent = null;
    this.obs = new OBSWebSocket();
    this.obsStatus = { enabled: process.env.OBS_WEBSOCKET_ENABLED === "true", connected: false, lastError: null, currentScene: null };
    this.bilibiliStatus = {
      mode: process.env.BILIBILI_ACCESS_KEY_ID ? "official-configured" : "adapter-only",
      connected: false,
      lastError: process.env.BILIBILI_ACCESS_KEY_ID ? null : "官方开放平台凭据未配置；可通过事件适配接口联调"
    };
    this.bindObsEvents();
  }

  bindObsEvents() {
    this.obs.on("ConnectionClosed", () => { this.obsStatus.connected = false; });
    this.obs.on("CurrentProgramSceneChanged", event => { this.obsStatus.currentScene = event.sceneName; });
  }

  async start() {
    if (!this.obsStatus.enabled) return this.getStatus();
    try {
      const address = process.env.OBS_WEBSOCKET_URL || "ws://127.0.0.1:4455";
      await this.obs.connect(address, process.env.OBS_WEBSOCKET_PASSWORD || undefined);
      this.obsStatus.connected = true;
      this.obsStatus.lastError = null;
      const scene = await this.obs.call("GetCurrentProgramScene");
      this.obsStatus.currentScene = scene.currentProgramSceneName;
    } catch (error) {
      this.obsStatus.connected = false;
      this.obsStatus.lastError = error.message;
    }
    return this.getStatus();
  }

  async setScene(sceneName) {
    if (!this.obsStatus.connected) throw new Error("OBS WebSocket is not connected");
    await this.obs.call("SetCurrentProgramScene", { sceneName });
    this.obsStatus.currentScene = sceneName;
    return this.getStatus();
  }

  ingestBilibiliEvent(payload) {
    const item = normalizeBilibiliEvent(payload);
    this.eventsReceived += 1;
    this.lastEvent = { at: new Date().toISOString(), rawType: payload.cmd || payload.type || "unknown", normalized: item };
    this.bilibiliStatus.connected = true;
    this.bilibiliStatus.lastError = null;
    if (item) this.onDanmaku(item);
    return { accepted: Boolean(item), item, status: this.getStatus() };
  }

  getStatus() {
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor((Date.now() - Date.parse(this.startedAt)) / 1000),
      eventsReceived: this.eventsReceived,
      lastEvent: this.lastEvent,
      obs: { ...this.obsStatus },
      bilibili: { ...this.bilibiliStatus }
    };
  }
}

function normalizeBilibiliEvent(payload = {}) {
  const command = String(payload.cmd || payload.type || "").split(":")[0];
  if (command === "DANMU_MSG") {
    return { user: String(payload.user || payload.uname || payload.info?.[2]?.[1] || "B站观众"), text: String(payload.text || payload.message || payload.info?.[1] || ""), type: "chat", timestamp: new Date().toISOString(), source: "bilibili" };
  }
  if (["SUPER_CHAT_MESSAGE", "superchat"].includes(command)) {
    return { user: String(payload.user || payload.uname || "SC观众"), text: String(payload.text || payload.message || "支持主播"), type: "superchat", timestamp: new Date().toISOString(), source: "bilibili" };
  }
  if (["SEND_GIFT", "gift"].includes(command)) {
    return { user: String(payload.user || payload.uname || "送礼观众"), text: String(payload.text || payload.giftName || "送出礼物"), type: "gift", timestamp: new Date().toISOString(), source: "bilibili" };
  }
  if (["GUARD_BUY", "guard"].includes(command)) {
    return { user: String(payload.user || payload.uname || "舰长"), text: String(payload.text || "开通舰长"), type: "guard", timestamp: new Date().toISOString(), source: "bilibili" };
  }
  return null;
}

module.exports = { LiveRuntime, normalizeBilibiliEvent };
