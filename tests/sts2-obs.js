'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Sts2Obs, GAME, SCENE } = require('../src/sts2/obs');
const { EventEmitter } = require('node:events');

test('OBS unavailable reports the missing dependency and can reconnect after OBS opens', async () => {
  let available = false, clients = 0;
  const obs = new Sts2Obs({ env: { APPDATA: 'test' }, readConfig: () => ({ server_port: 4456, server_password: 'test-only' }),
    createClient: () => {
      clients++;
      const client = new EventEmitter();
      client.connect = async (address, password) => {
        assert.equal(address, 'ws://127.0.0.1:4456'); assert.equal(password, 'test-only');
        if (!available) throw Error('connect ECONNREFUSED 127.0.0.1:4456');
      };
      return client;
    } });
  await assert.rejects(obs.connect(), /无法连接 OBS.*4456.*先打开 OBS Studio.*不会自动启动 OBS/);
  assert.equal(obs.connecting, null); assert.equal(obs.client, null);
  available = true;
  const connected = await obs.connect(); assert.equal(clients, 2);
  obs.shots.set(GAME, { image: Buffer.from('old frame'), at: Date.now() });
  connected.emit('ConnectionClosed'); assert.equal(obs.client, null); assert.equal(obs.shots.size, 0);
  await obs.connect(); assert.equal(clients, 3);
});

test('explicit OBS endpoint works without a local OBS config file and auth errors stay actionable', async () => {
  const obs = new Sts2Obs({ env: { APPDATA: 'test', OBS_WEBSOCKET_URL: 'ws://localhost:4457', OBS_WEBSOCKET_PASSWORD: 'test-secret' },
    readConfig: () => { throw Object.assign(Error('missing'), { code: 'ENOENT' }); },
    createClient: () => {
      const client = new EventEmitter();
      client.connect = async (address, password) => {
        assert.equal(address, 'ws://localhost:4457'); assert.equal(password, 'test-secret');
        throw Object.assign(Error('Authentication Failed'), { code: 4009 });
      };
      return client;
    } });
  await assert.rejects(obs.connect(), error => /认证失败.*密码/.test(error.message) && !error.message.includes('test-secret'));
});

test('disabled OBS WebSocket is diagnosed before attempting a connection', async () => {
  const obs = new Sts2Obs({ env: { APPDATA: 'test' }, readConfig: () => ({ server_enabled: false }),
    createClient: () => { throw Error('Must not attempt a disabled server'); } });
  await assert.rejects(obs.connect(), /WebSocket 服务器未启用/);
});

test('reconnect waits through zero-size startup until an actual game frame renders', async () => {
  let time = 0, attempts = 0;
  const obs = new Sts2Obs({ now: () => time, sleep: async ms => { time += ms; } });
  obs.screenshot = async source => { assert.equal(source, GAME); if (++attempts < 4) throw Error('Failed to render screenshot.'); return Buffer.from('frame'); };
  await obs.waitForGameFrame(); assert.equal(attempts, 4); assert.equal(time, 900);
});
test('reconnect gives a bounded actionable error when no frame arrives', async () => {
  let time = 0;
  const obs = new Sts2Obs({ now: () => time, sleep: async ms => { time += ms; } });
  obs.screenshot = async () => { throw Error('Failed to render screenshot.'); };
  await assert.rejects(obs.waitForGameFrame(600), /还原游戏窗口/); assert.equal(time, 600);
});
test('concurrent reconnect clicks share a single OBS configuration attempt', async () => {
  const obs = new Sts2Obs(); let finish, calls = 0;
  obs.configure = () => { calls++; return new Promise(resolve => { finish = resolve; }); };
  const first = obs.setup(), second = obs.setup(); assert.equal(calls, 1);
  finish({ previewReady: true }); assert.deepEqual(await first, await second); assert.equal(obs.settingUp, null);
});
test('a minimized game window produces a specific recovery instruction', async () => {
  const obs = new Sts2Obs();
  obs.connect = async () => ({ call: async name => {
    if (name === 'GetSceneList') return { scenes: [{ sceneName: SCENE }] };
    if (name === 'GetVideoSettings') return { baseWidth: 1920, baseHeight: 1080 };
    if (name === 'GetInputList') return { inputs: [{ inputName: GAME }] };
    if (name === 'GetInputPropertiesListPropertyItems') return { propertyItems: [{ itemEnabled: false, itemValue: 'Slay the Spire 2:Engine:SlayTheSpire2.exe' }] };
    throw Error('Unexpected OBS mutation: ' + name);
  } });
  await assert.rejects(obs.setup(), /最小化.*还原/);
});
