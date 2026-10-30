'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = name => fs.readFileSync(path.join(__dirname, '../public', name), 'utf8');
const flush = () => new Promise(resolve => setImmediate(resolve));

function node(id) {
  return { id, value: '', textContent: '', hidden: false, disabled: false, dataset: {}, attributes: {}, handlers: {}, children: [],
    addEventListener(type, handler) { this.handlers[type] = handler; },
    setAttribute(key, value) { this.attributes[key] = value; },
    append(child) { this.children.push(child); }, focus() {}, classList: { toggle() {} } };
}
async function workbenchSwitching() {
  const elements = new Map(); const el = id => elements.get(id) || (elements.set(id, node(id)), elements.get(id));
  const tabs = ['minecraft', 'sts2'].map(game => Object.assign(el(`tab-${game}`), { dataset: { game } }));
  const panels = ['minecraft', 'sts2'].map(game => Object.assign(node(game), { dataset: { gameOnly: game } }));
  const messages = [], requests = [], intervals = []; let previewError = null;
  const stage = el('streamStage'); stage.contentWindow = { postMessage: message => messages.push(message) };
  for (const attribute of ['src', 'srcdoc']) Object.defineProperty(stage, attribute, { set() { throw Error('Switching must never reload the voice iframe'); } });
  el('spireSteps').value = '100';
  el('commandInput').value = '保留目标草稿'; el('audienceInput').value = '保留聊天草稿'; el('audienceMessages').children.push(node('existing-message'));
  const context = { document: { hidden: false, title: '', getElementById: el,
      querySelector: () => node('setup'), querySelectorAll: selector => selector === '[data-game-only]' ? panels : selector === '.engine-panel' ? [] : tabs },
    window: { dispatchEvent() {} }, location: { href: 'http://127.0.0.1:3000/games.html?game=sts2', search: '?game=sts2', origin: 'http://127.0.0.1:3000' },
    history: { replaceState() {} }, localStorage: { getItem() {}, setItem() {} }, URL, URLSearchParams, AbortSignal, Event, setInterval(callback) { intervals.push(callback); },
    fetch: async (route, options) => { requests.push({ route, body: options?.body && JSON.parse(options.body) });
      if (route === '/api/sts2/game-preview' && previewError) return { ok: false, json: async () => ({ error: previewError }) };
      return { ok: true, json: async () => route.endsWith('/status') ? { running: false, streamer: { enabled: true } } : {}, blob: async () => new Blob() }; } };
  context.URL = class extends URL { static createObjectURL() { return 'blob:preview'; } static revokeObjectURL() {} };
  vm.runInNewContext(source('game-workbench.js'), context); await flush(); await context.window.gameWorkbench.ready();
  const identities = ['streamStage', 'commandInput', 'audienceInput', 'audienceMessages'].map(el);
  tabs[0].handlers.click(); tabs[1].handlers.click(); tabs[0].handlers.click();
  await context.window.gameWorkbench.ready(); await flush();
  assert.equal(context.window.gameWorkbench.game, 'minecraft');
  assert.deepEqual(['streamStage', 'commandInput', 'audienceInput', 'audienceMessages'].map(el), identities);
  assert.equal(el('commandInput').value, '保留目标草稿'); assert.equal(el('audienceInput').value, '保留聊天草稿'); assert.equal(el('audienceMessages').children.length, 1);
  assert.equal(panels[0].hidden, false); assert.equal(panels[1].hidden, true);
  assert.deepEqual(requests.filter(r => r.route === '/api/games/active').map(r => r.body.game), ['sts2', 'minecraft', 'sts2', 'minecraft']);
  assert.equal(messages.at(-1).game, 'minecraft');
  assert.equal(requests.some(r => /\/(start|stop|demo|chat)$/.test(r.route)), false, 'switching alone must not start/stop gameplay or send chat');
  tabs[1].handlers.click(); await context.window.gameWorkbench.ready(); await flush();
  assert.equal(el('spirePreview').hidden, false);
  previewError = '无法连接 OBS（127.0.0.1:4455）。请先打开 OBS Studio。';
  await intervals[1]();
  assert.equal(el('spirePreviewHint').textContent, previewError, 'preview must preserve the actual backend diagnosis');
  assert.equal(el('spirePreview').hidden, true, 'a disconnected source must not leave an old frame looking live');
  await el('spireConnect').handlers.click();
  assert.equal(el('workbenchFeedback').textContent, `重连失败：${previewError}`, 'reconnect must not replace the diagnosis with a generic message');
  previewError = null; await intervals[1]();
  assert.equal(el('spirePreview').hidden, false); assert.equal(el('spirePreviewHint').hidden, true);
}

function listenerBody(text, start, end) { const a = text.indexOf(start), b = text.indexOf(end, a); assert(a >= 0 && b > a); return text.slice(a, b); }
async function sharedRouting() {
  const panel = source('minecraft-panel.js');
  for (const game of ['minecraft', 'sts2']) {
    const elements = new Map(); const el = selector => elements.get(selector) || (elements.set(selector, node(selector)), elements.get(selector));
    const calls = [], messages = [];
    el('#commandInput').value = '完成当前目标'; el('#audienceInput').value = '现在情况怎么样'; el('#influenceGame').checked = true;
    const harness = { $: el, state: { busy: false }, audienceSending: false, setText() {}, renderLoop() {}, refresh: async () => {}, addAudienceMessage: text => messages.push(text),
      window: { gameWorkbench: { game, ready: async () => {}, submitGoal: async text => { calls.push({ route: 'spire-goal', body: { goal: text } }); } } },
      api: async (route, options) => { calls.push({ route, body: JSON.parse(options.body) }); return { goal: '完成当前目标' }; } };
    vm.runInNewContext(listenerBody(panel, '$("#commandForm").addEventListener', '\nasync function loadPersona'), harness);
    await el('#commandForm').handlers.submit({ preventDefault() {} });
    assert.equal(calls[0].route, game === 'sts2' ? 'spire-goal' : '/api/minecraft/demo'); assert.equal(el('#commandInput').value, '');
    vm.runInNewContext(listenerBody(panel, "$('#audienceForm').addEventListener", "\ndocument.querySelectorAll('[data-chat]')"), harness);
    await el('#audienceForm').handlers.submit({ preventDefault() {} });
    assert.equal(calls[1].route, `/api/${game}/chat`); assert.equal(calls[1].body.text, '现在情况怎么样');
    assert(messages.includes('现在情况怎么样'));
  }
}

async function pendingGoalSwitch() {
  const elements = new Map(), el = selector => elements.get(selector) || (elements.set(selector, node(selector)), elements.get(selector));
  const workbench = { game: 'minecraft' }; let complete, renders = 0;
  const harness = { $: el, state: { busy: false }, window: { gameWorkbench: workbench }, setText() {}, refresh: async () => {}, renderLoop() { renders++; },
    api: () => new Promise(resolve => { complete = resolve; }) };
  el('#commandInput').value = '原来的我的世界目标';
  const panel = source('minecraft-panel.js');
  vm.runInNewContext(listenerBody(panel, '$("#commandForm").addEventListener', '\nasync function loadPersona'), harness);
  const pending = el('#commandForm').handlers.submit({ preventDefault() {} });
  workbench.game = 'sts2'; el('#commandInput').value = '正在编辑的尖塔目标'; complete({ goal: '原来的我的世界目标' }); await pending;
  assert.equal(el('#commandInput').value, '正在编辑的尖塔目标', 'a late response must not erase a new draft');
  assert.equal(renders, 0, 'a Minecraft response must not replace the currently selected Spire goal');
}

function voiceMode() {
  const text = source('stream.js'); const handlers = {};
  const parent = {}; const harness = { URLSearchParams, location: { search: '', origin: 'http://127.0.0.1:3000' }, window: { parent, __workbenchGame: 'minecraft', addEventListener: (type, handler) => { handlers[type] = handler; } } };
  vm.runInNewContext(text.slice(text.indexOf('const streamParameters'), text.indexOf('\nconst subtitle')), harness);
  const mode = () => vm.runInNewContext('spireMode', harness);
  handlers.message({ source: {}, origin: harness.location.origin, data: { type: 'workbench-game', game: 'sts2' } }); assert.equal(mode(), false);
  handlers.message({ source: parent, origin: 'https://example.com', data: { type: 'workbench-game', game: 'sts2' } }); assert.equal(mode(), false);
  handlers.message({ source: parent, origin: harness.location.origin, data: { type: 'workbench-game', game: 'sts2' } }); assert.equal(mode(), true);
  handlers.message({ source: parent, origin: harness.location.origin, data: { type: 'workbench-game', game: 'minecraft' } }); assert.equal(mode(), false);
}

(async () => { await workbenchSwitching(); await sharedRouting(); await pendingGoalSwitch(); voiceMode(); console.log('Game workbench passed: persistent stage/chat/drafts, ordered context switching, game routing, late response isolation, trusted voice mode messages.'); })().catch(error => { console.error(error); process.exitCode = 1; });
