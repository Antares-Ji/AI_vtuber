const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/vision.js', 'utf8');
function harness() {
  const nodes = {};
  for (const id of ['start', 'stop', 'save', 'analyze', 'analysis', 'preview', 'status', 'scene', 'saved']) nodes[id] = { disabled: false, textContent: '', value: 'home', addEventListener(event, fn) { this[event] = fn; } };
  nodes.preview.play = async () => {};
  nodes.preview.videoWidth = 1920;
  nodes.preview.videoHeight = 1080;
  const streams = [];
  let encode, requests = 0, lastUrl;
  const context = { AbortController, AbortSignal, Math, Promise,
    window: { addEventListener() {} },
    document: { querySelector: selector => nodes[selector.slice(1)], createElement: () => ({ getContext: () => ({ drawImage() {} }), toBlob(fn) { encode = fn; } }) },
    navigator: { mediaDevices: { getDisplayMedia: async () => {
      const track = { stopped: false, stop() { this.stopped = true; }, getSettings: () => ({ displaySurface: 'window' }), addEventListener(event, fn) { this[event] = fn; } };
      streams.push(track);
      return { getTracks: () => [track], getVideoTracks: () => [track] };
    } } },
    fetch: async url => { requests++; lastUrl = url; return { ok: true, json: async () => ({ file: 'sample.jpg', description: '无法可靠确定', text: '<img onerror=bad()>', latencyMs: 2 }) }; }
  };
  vm.createContext(context);
  vm.runInContext(source, context);
  return { nodes, streams, encode: () => encode({}), requests: () => requests, lastUrl: () => lastUrl };
}
(async () => {
  const h = harness();
  await h.nodes.start.click();
  const saving = h.nodes.save.click();
  h.nodes.stop.click();
  assert.match(h.nodes.analysis.textContent, /已取消/);
  h.encode();
  await saving;
  assert.equal(h.requests(), 0, 'stopped capture must not upload late encoded frame');
  await h.nodes.start.click();
  h.streams[0].ended();
  assert.equal(h.streams[1].stopped, false, 'old track ended must not stop new session');
  const nextSave = h.nodes.save.click();
  h.encode();
  await nextSave;
  assert.equal(h.requests(), 1);
  assert.match(h.nodes.saved.textContent, /sample.jpg/);
  const recognizing = h.nodes.analyze.click();
  h.encode();
  await recognizing;
  assert.equal(h.lastUrl(), '/api/vision/arknights');
  assert.match(h.nodes.analysis.textContent, /<img onerror=bad\(\)>/);
  h.nodes.stop.click();
  assert.equal(h.streams[1].stopped, true);
  console.log('Vision capture UI: stale track isolation, stop-during-encode, normal save passed.');
})().catch(error => { console.error(error); process.exitCode = 1; });
