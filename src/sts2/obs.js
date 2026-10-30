'use strict';
const fs = require('node:fs');
const path = require('node:path');
const OBS = require('obs-websocket-js').default;
const SCENE = 'AI VTuber - Slay the Spire 2';
const GAME = 'STS2 Game Window';
const AVATAR = 'STS2 Live2D Streamer';

class Sts2Obs {
  constructor({ now = Date.now, sleep = ms => new Promise(resolve => setTimeout(resolve, ms)), env = process.env,
    createClient = () => new OBS(), readConfig = file => JSON.parse(fs.readFileSync(file, 'utf8')) } = {}) {
    this.client = null; this.connecting = null; this.shots = new Map(); this.captures = new Map(); this.now = now; this.sleep = sleep; this.settingUp = null;
    this.env = env; this.createClient = createClient; this.readConfig = readConfig;
  }
  async connect() {
    if (this.client) return this.client;
    if (this.connecting) return this.connecting;
    this.connecting = (async () => {
      const configFile = this.env.OBS_CONFIG_FILE || path.join(this.env.APPDATA || '', 'obs-studio/plugin_config/obs-websocket/config.json');
      let config;
      try { config = this.readConfig(configFile); }
      catch (error) {
        if (error.code !== 'ENOENT') throw Error('无法读取 OBS WebSocket 配置，请在 OBS「工具 → WebSocket服务器设置」检查配置。');
        config = {};
      }
      if (config.server_enabled === false && !this.env.OBS_WEBSOCKET_URL) throw Error('OBS 的 WebSocket 服务器未启用。请在 OBS「工具 → WebSocket服务器设置」中启用服务器，然后重连画面。');
      const address = this.env.OBS_WEBSOCKET_URL || `ws://127.0.0.1:${config.server_port || 4455}`;
      let endpoint;
      try { endpoint = new URL(address).host; } catch { throw Error('OBS WebSocket 地址配置无效，请检查 OBS_WEBSOCKET_URL。'); }
      const obs = this.createClient();
      obs.on('ConnectionClosed', () => { if (this.client === obs) { this.client = null; this.shots.clear(); } });
      try { await obs.connect(address, this.env.OBS_WEBSOCKET_PASSWORD || config.server_password); }
      catch (error) {
        if (error.code === 4009 || /authentication|password/i.test(error.message)) throw Error('OBS 连接认证失败。请检查 OBS WebSocket 密码与项目配置是否一致，然后重连画面。');
        if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EHOSTUNREACH/i.test(error.message)) throw Error(`无法连接 OBS（${endpoint}）。请先打开 OBS Studio，并在「工具 → WebSocket服务器设置」确认服务器已启用。重连画面不会自动启动 OBS。`);
        throw Error(`OBS 连接中断（${endpoint}），请确认 OBS 已打开且 WebSocket 服务器可用后重连。`);
      }
      this.client = obs; return obs;
    })().finally(() => { this.connecting = null; });
    return this.connecting;
  }
  async setup() {
    if (this.settingUp) return this.settingUp;
    this.settingUp = this.configure().finally(() => { this.settingUp = null; });
    return this.settingUp;
  }
  async configure() {
    const obs = await this.connect();
    const scenes = await obs.call('GetSceneList');
    if (!scenes.scenes.some(s => s.sceneName === SCENE)) await obs.call('CreateScene', { sceneName: SCENE });
    const { baseWidth: width, baseHeight: height } = await obs.call('GetVideoSettings');
    const { inputs } = await obs.call('GetInputList');
    if (!inputs.some(i => i.inputName === GAME)) await obs.call('CreateInput', { sceneName: SCENE, inputName: GAME, inputKind: 'window_capture', inputSettings: { method: 2, cursor: true, client_area: true }, sceneItemEnabled: true });
    const { propertyItems } = await obs.call('GetInputPropertiesListPropertyItems', { inputName: GAME, propertyName: 'window' });
    const window = propertyItems.find(w => w.itemEnabled && /SlayTheSpire2\.exe/i.test(w.itemValue));
    if (!window) {
      const minimized = propertyItems.some(w => /SlayTheSpire2\.exe/i.test(w.itemValue));
      throw Error(minimized ? '游戏窗口已最小化或暂不可捕获，请先还原“Slay the Spire 2”窗口，再点击重连画面。' : '未找到杀戮尖塔2窗口，请先启动游戏，再点击重连画面。');
    }
    // Keep the capture method selected during live diagnosis. BitBlt can be
    // black after a game restart; WGC can freeze on some sessions.
    const { inputSettings: currentCapture } = await obs.call('GetInputSettings', { inputName: GAME });
    const method = [0, 1, 2].includes(currentCapture.method) ? currentCapture.method : 2;
    await obs.call('SetInputSettings', { inputName: GAME, inputSettings: { window: window.itemValue, method, cursor: true, client_area: true }, overlay: true });
    let items = (await obs.call('GetSceneItemList', { sceneName: SCENE })).sceneItems;
    if (!items.some(i => i.sourceName === GAME)) await obs.call('CreateSceneItem', { sceneName: SCENE, sourceName: GAME, sceneItemEnabled: true });
    const url = `http://127.0.0.1:${Number(process.env.PORT || 3000)}/?game=sts2&overlay=1&voice=gpt-sovits&v=3`;
    const browser = { url, width, height, fps: 30, fps_custom: true, shutdown: false, restart_when_active: false, reroute_audio: true,
      css: 'html,body{background:transparent!important;margin:0;overflow:hidden}' };
    if (!inputs.some(i => i.inputName === AVATAR)) await obs.call('CreateInput', { sceneName: SCENE, inputName: AVATAR, inputKind: 'browser_source', inputSettings: browser, sceneItemEnabled: true });
    else {
      await obs.call('SetInputSettings', { inputName: AVATAR, inputSettings: browser, overlay: true });
      items = (await obs.call('GetSceneItemList', { sceneName: SCENE })).sceneItems;
      if (!items.some(i => i.sourceName === AVATAR)) await obs.call('CreateSceneItem', { sceneName: SCENE, sourceName: AVATAR, sceneItemEnabled: true });
    }
    items = (await obs.call('GetSceneItemList', { sceneName: SCENE })).sceneItems;
    const game = items.find(i => i.sourceName === GAME), avatar = items.find(i => i.sourceName === AVATAR);
    for (const item of [game, avatar]) await obs.call('SetSceneItemEnabled', { sceneName: SCENE, sceneItemId: item.sceneItemId, sceneItemEnabled: true });
    this.shots.clear();
    const transform = (await obs.call('GetSceneItemTransform', { sceneName: SCENE, sceneItemId: game.sceneItemId })).sceneItemTransform;
    const crop = transform.sourceWidth > transform.sourceHeight * 16 / 9 ? Math.floor((transform.sourceWidth - transform.sourceHeight * 16 / 9) / 2) : 0;
    await obs.call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: game.sceneItemId, sceneItemTransform: {
      positionX: 0, positionY: 0, alignment: 5, boundsType: 'OBS_BOUNDS_SCALE_INNER', boundsAlignment: 5,
      boundsWidth: Math.round(width * 0.76), boundsHeight: height, cropLeft: crop, cropRight: crop, cropTop: 0, cropBottom: 0 } });
    await obs.call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: avatar.sceneItemId, sceneItemTransform: { positionX: 0, positionY: 0, alignment: 5, scaleX: 1, scaleY: 1 } });
    await obs.call('SetSceneItemIndex', { sceneName: SCENE, sceneItemId: avatar.sceneItemId, sceneItemIndex: items.length - 1 });
    await obs.call('SetInputAudioMonitorType', { inputName: AVATAR, monitorType: 'OBS_MONITORING_TYPE_MONITOR_AND_OUTPUT' });
    const stream = await obs.call('GetStreamStatus'), record = await obs.call('GetRecordStatus');
    if (!stream.outputActive && !record.outputActive) await obs.call('SetCurrentProgramScene', { sceneName: SCENE });
    await this.waitForGameFrame();
    // Initial transforms may have zero dimensions while WGC is starting.
    const ready = (await obs.call('GetSceneItemTransform', { sceneName: SCENE, sceneItemId: game.sceneItemId })).sceneItemTransform;
    const readyCrop = ready.sourceWidth > ready.sourceHeight * 16 / 9 ? Math.floor((ready.sourceWidth - ready.sourceHeight * 16 / 9) / 2) : 0;
    await obs.call('SetSceneItemTransform', { sceneName: SCENE, sceneItemId: game.sceneItemId, sceneItemTransform: { cropLeft: readyCrop, cropRight: readyCrop } });
    return { scene: SCENE, gameSource: GAME, avatarSource: AVATAR, width, height, streaming: stream.outputActive, recording: record.outputActive, overlayUrl: url, previewReady: true };
  }
  async waitForGameFrame(timeoutMs = 6500) {
    const deadline = this.now() + timeoutMs;
    do {
      try { await this.screenshot(GAME); return; } catch { /* WGC can report zero size until its first frame arrives. */ }
      if (this.now() >= deadline) break;
      await this.sleep(300);
    } while (this.now() <= deadline);
    throw Error('OBS 已找到游戏，但仍没有收到画面。请还原游戏窗口并保持打开，然后重试。');
  }
  async screenshot(source = SCENE) {
    if (![SCENE, GAME].includes(source)) throw Error('Unknown preview source');
    const cached = this.shots.get(source);
    if (cached && Date.now() - cached.at < 700) return cached.image;
    if (this.captures.has(source)) return this.captures.get(source);
    const capturing = (async () => {
      const obs = await this.connect();
      const shot = await obs.call('GetSourceScreenshot', { sourceName: source, imageFormat: 'jpg', imageWidth: 1600, imageCompressionQuality: 82 });
      const image = Buffer.from(shot.imageData.split(',')[1], 'base64'); this.shots.set(source, { image, at: Date.now() }); return image;
    })().finally(() => { this.captures.delete(source); });
    this.captures.set(source, capturing); return capturing;
  }
}
module.exports = { Sts2Obs, SCENE, GAME, AVATAR };
