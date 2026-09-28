const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const source = fs.readFileSync('public/page-capture.js', 'utf8').replace(/^import .*;\r?\n/, '');
async function harness() {
  const nodes = {}, timers = [], requests = [];
  let now = 0, encode, uploadRelease;
  const element = () => ({ disabled: false, value: '1', children: [], addEventListener(e, f) { this[e] = f; },
    append(...items) { this.children.push(...items); }, replaceChildren() { this.children=[]; }, querySelector() { return this.children.find(c => c.href); },querySelectorAll(){return this.children.filter(c=>c.href);} });
  for (const id of ['preview','page-entry','page-start','page-end','page-status','page-results']) nodes[id] = element();
  Object.assign(nodes.preview, { srcObject: { getVideoTracks: () => [{ readyState: 'live' }] }, videoWidth: 800, videoHeight: 600, readyState: 2 });
  const session = { id: '00000000-0000-0000-0000-000000000001', entryId:1, entryLabel:'设置', frames:[], segments:[] };
  const context = { Uint8Array, Math, Promise, Error, JSON, AbortSignal,
    StableFrames: class { consider() { return now >= 1000; } saved() {} },
    performance: { now: () => now },
    localStorage: { setItem() {}, getItem() { return null; } },
    window: { addEventListener() {}, interactionRecorder:{async begin(){requests.push('interaction-begin');},async finish(){requests.push('interaction-finish');}} },
    setTimeout(fn) { timers.push(fn); return fn; }, clearTimeout(fn) { const i=timers.indexOf(fn); if(i>=0)timers.splice(i,1); },
    document: { getElementById: id => nodes[id], createElement(type) {
      if (type !== 'canvas') return element();
      return { getContext: () => ({ drawImage() {}, getImageData: () => ({ data: new Uint8Array(64000) }) }), toBlob(fn) { encode = fn; } };
    } },
    fetch: async (url) => {
      requests.push(url);
      if (url.includes('home-reviewed')) return {ok:true,json:async()=>({boxes:[{id:1,label:'设置'}]})};
      if (url.includes('/frames')) { await new Promise(r => uploadRelease = r); session.frames.push({file:'frame-001.jpg'}); }
      return { ok:true,json:async()=>structuredClone(session) };
    }
  };
  vm.createContext(context); await vm.runInContext(`(async()=>{${source}\n})()`, context);
  const flush = async () => { for(let i=0;i<15;i++)await Promise.resolve(); };
  return { nodes, requests, flush, async tick() { now=1200; timers.shift()(); await flush(); }, encode() { encode({}); }, release() { uploadRelease(); } };
}
(async () => {
  const h = await harness(); await h.nodes['page-start'].click(); await h.flush(); await h.tick();
  const ending = h.nodes['page-end'].click(); h.encode(); await ending;
  assert(!h.requests.some(u=>u.includes('/frames')), 'end during encoding must not upload');
  assert(h.requests.some(u=>u.endsWith('/finish')));
  const j = await harness(); await j.nodes['page-start'].click(); await j.flush(); await j.tick(); j.encode(); await j.flush();
  const end = j.nodes['page-end'].click(); await j.flush();
  assert(!j.requests.some(u=>u.endsWith('/finish')), 'finish must wait for upload');
  j.release(); await end;
  assert(j.requests.some(u=>u.endsWith('/finish')));
  const k = await harness(); k.nodes.preview.srcObject=null; await k.nodes['page-start'].click();
  assert.equal(k.requests.length,1,'no capture without shared window');
  console.log('Page capture lifecycle: no stream, stop during encode, drain upload before finish passed.');
})().catch(error => { console.error(error); process.exitCode=1; });
