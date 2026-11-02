const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const bearing = require('../scripts/genshin/story/vision/minimap-bearing');
const grounding = require('../scripts/genshin/story/grounding');
const travel = require('../scripts/genshin/story/macros/travel-quest');
const hudRows = (stage = '前去查看详情') => [
  { text: stage, box: [76, 246, 153, 35] },
  { text: '184m', box: [80, 281, 49, 19], source: 'quest_distance_crop' }
];
function harness(options = {}) {
  const frames = [], observed = [], projected = [], sleeps = [];
  let clock = 1000, cancelled = false, expired = false;
  const candidate = options.marker || { x: 208, y: 125, center: [208, 125], box: [200, 117, 16, 16],
    scores: [{ template: 'quest-marker.png', score: 0.9 }], source: 'production_threshold' };
  const deps = {
    grounding, now: () => clock, getDeadline: () => expired ? 0 : 100000,
    checkInput() { if (cancelled) throw Object.assign(Error('parent cancelled'), { code: 'STORY_FOCUS_LOST' }); },
    captureGameRegion() {
      if (options.reuse && frames.length) return frames[0];
      const frame = { id: frames.length, width: options.width || 1920, height: 1080, srcMat: {}, disposed: 0,
        dispose() { this.disposed++; } };
      frames.push(frame); return frame;
    },
    readTexts(frame) {
      if (options.cancelAt === 'ocr') cancelled = true;
      if (options.expireAt === 'ocr') expired = true;
      return options.rows ? options.rows(frame.id) : hudRows();
    },
    sleep: async ms => { clock += ms; sleeps.push(ms); if (options.cancelAt === 'sleep') cancelled = true; },
    diagnostics: { observe(frame, args) {
      observed.push({ frame, args });
      if (options.cancelAt === 'diagnostics') cancelled = true;
      return options.observation || { accepted: true, unique: candidate, productionComplete: true,
        candidates: [candidate], peaks: [{ template: 'quest-marker.png', score: 0.9, center: [208, 125] }] };
    } },
    project: async (frame, x, y) => {
      projected.push({ frame, x, y });
      assert.equal(frame.disposed, 0);
      if (options.cancelAt === 'projection') cancelled = true;
      if (options.expireAt === 'projection') expired = true;
      if (options.projectError) throw options.projectError;
      const output = options.projections?.[frame.id] || { ok: true, reason: 'accepted',
        centerGame: { x: 10, y: 20 }, gameDirection: { x: -1, y: 0 },
        centerMap: { x: 1000, y: 2000 }, markerMap: { x: 1040, y: 2000 },
        matchCount: 20, inlierCount: 18, inlierRatio: 0.9, reprojectionError: 0.2, layer: 0,
        crop: { x: 62, y: 19, width: 212, height: 212 }, durationMs: 1 };
      return options.asJson ? JSON.stringify(output) : output;
    }
  };
  if (options.noProjection) delete deps.project;
  return { deps, frames, observed, projected, sleeps, run: stage => bearing.createMinimapBearing(deps).samplePair(stage || '前去查看详情') };
}

test('projected game directions map all four axes and rotation to PathExecutor headings', () => {
  for (const direction of [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 },
    { x: Math.cos(0.7), y: Math.sin(0.7) }]) {
    const heading = bearing.headingForDirection(direction);
    const target = travel.targetForHeading({ x: 10, y: 20 }, heading, 25);
    assert.ok(Math.abs(target.x - (10 + direction.x * 25)) < 1e-8);
    assert.ok(Math.abs(target.y - (20 + direction.y * 25)) < 1e-8);
  }
  assert.throws(() => bearing.headingForDirection({ x: 0, y: 0 }));
  assert.throws(() => bearing.headingForDirection({ x: NaN, y: 1 }));
});
test('two fresh frames separated by 100ms produce plain receipts without ROI offset duplication', async () => {
  const h = harness({ asJson: true }), result = await h.run();
  assert.equal(result.ok, true); assert.equal(result.source, 'minimap_projection');
  assert.equal(result.samples.length, 2); assert.equal(result.samples[1].at - result.samples[0].at, 100);
  assert.deepEqual(h.sleeps, [100]); assert.notEqual(h.frames[0], h.frames[1]);
  assert.deepEqual(h.projected.map(p => [p.x, p.y]), [[208, 125], [208, 125]]);
  assert.ok(h.frames.every(frame => frame.disposed === 1));
  assert.deepEqual(result.from, { x: 10, y: 20 });
  assert.deepEqual(result.positionSamples, [{ x: 10, y: 20 }, { x: 10, y: 20 }]);
  assert.deepEqual(h.observed[0].args, { templateNames: ['quest-marker.png', 'quest-marker-blue.png', 'minimap-commission.png'],
    roi: [62, 19, 212, 212], productionThreshold: 0.8, kind: 'minimap' });
  assert.deepEqual(JSON.parse(JSON.stringify(result)), result);
});
test('native projection rotation supplies direction, never screen offset or camera north assumption', async () => {
  const projections = [0, 1].map(() => ({ ok: true, centerGame: { x: 0, y: 0 }, gameDirection: { x: 0, y: 1 } }));
  const h = harness({ projections });
  h.deps.genshin = { getCameraOrientation() { throw Error('must never read camera'); } };
  const result = await h.run();
  assert.equal(result.heading, -90);
  assert.ok(Math.abs(travel.targetForHeading(result.from, result.heading, 25).y - 25) < 1e-8);
});
test('minimap ROI uses capped frame-width scaling and rounds each BGI rectangle member', async () => {
  assert.deepEqual(bearing.minimapRoi(1280), [41, 13, 141, 141]);
  assert.deepEqual(bearing.minimapRoi(1440), [46, 14, 159, 159]);
  assert.deepEqual(bearing.minimapRoi(960), [31, 10, 106, 106]);
  assert.deepEqual(bearing.minimapRoi(3840), [62, 19, 212, 212]);
  const marker = { center: [140, 83.5], scores: [{ score: 0.9 }] };
  const h = harness({ width: 1280, marker });
  assert.equal((await h.run()).ok, true);
  assert.deepEqual(h.observed[0].args.roi, [41, 13, 141, 141]);
});
test('same captured object cannot count as independent evidence', async () => {
  const h = harness({ reuse: true });
  assert.equal((await h.run()).reason, 'capture_not_independent');
  assert.equal(h.projected.length, 1);
});
test('position drift greater than ten and direction change greater than ten degrees reject pair', async () => {
  for (const [second, reason] of [
    [{ centerGame: { x: 10.01, y: 0 }, gameDirection: { x: -1, y: 0 } }, 'position_unstable'],
    [{ centerGame: { x: 0, y: 0 }, gameDirection: { x: -Math.cos(11 * Math.PI / 180), y: Math.sin(11 * Math.PI / 180) } }, 'minimap_direction_unstable']
  ]) {
    const h = harness({ projections: [{ ok: true, centerGame: { x: 0, y: 0 }, gameDirection: { x: -1, y: 0 } }, { ok: true, ...second }] });
    assert.equal((await h.run()).reason, reason); assert.ok(h.frames.every(frame => frame.disposed === 1));
  }
});
test('ten-unit drift and ten-degree direction boundary are accepted', async () => {
  const h = harness({ projections: [
    { ok: true, centerGame: { x: 0, y: 0 }, gameDirection: { x: -1, y: 0 } },
    { ok: true, centerGame: { x: 10, y: 0 }, gameDirection: { x: -Math.cos(Math.PI / 18), y: Math.sin(Math.PI / 18) } }
  ] });
  assert.equal((await h.run()).ok, true);
});
test('ambiguous, blurred, incomplete, and low-score candidates never reach projection', async () => {
  const candidate = { center: [208, 125], scores: [{ score: 0.79 }] };
  for (const observation of [
    { accepted: false, productionComplete: true, candidates: [], unique: null, peaks: [{ score: 0.79 }] },
    { accepted: false, productionComplete: true, candidates: [candidate, candidate], unique: null },
    { accepted: true, productionComplete: false, candidates: [candidate], unique: candidate },
    { accepted: true, productionComplete: true, candidates: [candidate], unique: candidate }
  ]) {
    const h = harness({ observation });
    assert.equal((await h.run()).ok, false); assert.equal(h.projected.length, 0);
    assert.equal(h.frames[0].disposed, 1);
  }
});
test('marker outside valid circle or too close to center cannot project', async () => {
  for (const [center, reason] of [[[65, 22], 'minimap_marker_outside_circle'], [[170, 125], 'minimap_marker_near_center'], [[500, 125], 'minimap_marker_outside_circle']]) {
    const h = harness({ marker: { center, scores: [{ score: 0.9 }] } });
    assert.equal((await h.run()).reason, reason); assert.equal(h.projected.length, 0);
  }
});
test('projection rejection, unavailable API, malformed DTO and native errors remain explicit', async () => {
  for (const [options, reason] of [
    [{ noProjection: true }, 'projection_api_unavailable'],
    [{ projections: [{ ok: false, reason: 'homography_weak' }] }, 'homography_weak'],
    [{ projections: [{ ok: true, centerGame: { x: 1, y: 2 }, gameDirection: { x: 0, y: 0 } }] }, 'minimap_projection_invalid'],
    [{ projectError: Error('native failed') }, 'minimap_observation_error']
  ]) {
    const h = harness(options), result = await h.run();
    assert.equal(result.reason, reason); assert.equal(result.stop, false);
    assert.ok(h.frames.every(frame => frame.disposed === 1));
  }
});
test('first or second sample F/menu/dialogue/missing HUD/stage changes stop fallback and projection', async () => {
  const cases = [
    [[...hudRows(), { text: 'F', box: [1100, 500, 20, 20] }, { text: '法拉', box: [1140, 500, 100, 20] }], 'interaction_prompt'],
    [[{ text: '商城', box: [170, 440, 50, 20] }], 'menu'],
    [[{ text: '这是一个当前剧情的对话字幕', box: [300, 940, 600, 40] }, { text: '派蒙', box: [850, 850, 80, 30] }], 'dialogue'],
    [[], 'hud_unavailable'], [hudRows('寻找另一目标'), 'stage_changed']
  ];
  for (const [rows, reason] of cases) for (const index of [0, 1]) {
    const h = harness({ rows: id => id === index ? rows : hudRows() }), result = await h.run();
    assert.equal(result.reason, reason); assert.equal(result.stop, true);
    assert.equal(h.projected.length, index); assert.ok(h.frames.every(frame => frame.disposed === 1));
  }
});
test('parent cancellation during OCR, diagnostics, sleep and projection propagates and disposes frames', async () => {
  for (const cancelAt of ['ocr', 'diagnostics', 'sleep', 'projection']) {
    const h = harness({ cancelAt });
    await assert.rejects(h.run(), { code: 'STORY_FOCUS_LOST' });
    assert.ok(h.frames.every(frame => frame.disposed === 1));
    assert.equal(h.frames.length, 1);
  }
});
test('deadline expiry after OCR or native projection propagates and disposes captures', async () => {
  for (const expireAt of ['ocr', 'projection']) {
    const h = harness({ expireAt });
    await assert.rejects(h.run(), { travelReason: 'deadline' });
    assert.ok(h.frames.every(frame => frame.disposed === 1));
  }
});
test('native cancellation result and thrown cancellation are never treated as fallback evidence', async () => {
  for (const options of [{ projections: [{ ok: false, reason: 'cancelled' }] },
    { projectError: Object.assign(Error('cancelled'), { name: 'OperationCanceledException' }) }]) {
    const h = harness(options);
    await assert.rejects(h.run(), /cancel/); assert.equal(h.frames[0].disposed, 1);
  }
});
test('provided shared guards are invoked and helper disposal does not dispose shared diagnostics', async () => {
  const h = harness(); let guards = 0;
  h.deps.budgetCheck = () => { guards++; };
  h.deps.currentStop = () => 'shared_guard_stop';
  h.deps.diagnostics.dispose = () => { throw Error('shared owner only'); };
  const observer = bearing.createMinimapBearing(h.deps);
  assert.equal((await observer.samplePair('x')).reason, 'shared_guard_stop'); assert.ok(guards >= 4);
  observer.dispose(); assert.equal((await observer.samplePair('x')).reason, 'minimap_observer_disposed');
});
test('UMD exports with no require, capture or input globals at load time', () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../scripts/genshin/story/vision/minimap-bearing'), 'utf8')
    + '\nthis.api = StoryMinimapBearing;', context);
  assert.equal(typeof context.api.createMinimapBearing, 'function');
});
