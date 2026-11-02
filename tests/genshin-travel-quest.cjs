const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const travel = require('../scripts/genshin/story/macros/travel-quest');
const grounding = require('../scripts/genshin/story-main');

const hudRows = (distance = 184, stage = '前去查看详情') => [
  { text: stage, box: [76, 246, 153, 35] },
  { text: distance + 'm', box: [80, 281, 49, 19], source: 'quest_distance_crop' }
];
function harness(options = {}) {
  let clock = 1000, calls = 0, samples = 0, pending = false, yawTurns = 0;
  const events = [], routes = [], tokens = [], positionCalls = [];
  const distances = options.distances || [184, 184];
  const getRows = () => {
    if (options.rowsAtYaw) return options.rowsAtYaw(yawTurns, calls);
    if (calls && options.afterRows) return options.afterRows;
    const rows = hudRows(distances[Math.min(calls, distances.length - 1)]);
    if (options.label !== false) rows.push({ text: distances[Math.min(calls, distances.length - 1)] + 'm', box: [930, 300, 50, 20] });
    return rows;
  };
  const deps = {
    grounding: options.grounding || grounding, now: () => clock, getDeadline: () => options.deadline || 1000000,
    sleep: async ms => { clock += ms; },
    checkInput() {
      if (options.cancelDuringScan && yawTurns >= 1) throw Object.assign(Error('focus lost'), { code: 'STORY_FOCUS_LOST' });
      if (options.cancelParent && calls) throw Object.assign(Error('parent cancelled'), { code: 'STORY_DEADLINE_EXPIRED' });
    },
    keyDown: key => events.push('down:' + key),
    keyUp: key => { assert.equal(pending, false, 'never release/return before joining path'); events.push('up:' + key); },
    moveMouseBy: (x, y) => { if (y === 0) yawTurns++; events.push(['turn', x, y]); }, middleButtonClick: () => events.push('reset'),
    captureGameRegion: () => ({ dispose() {}, findMulti() {
      if (options.templates === false) return { count: 0 };
      if (options.ambiguous) return { count: 2, 0: { x: 800, y: 200, width: 20, height: 20 }, 1: { x: 1100, y: 200, width: 20, height: 20 } };
      return { count: 1, 0: { x: 950, y: 200, width: 20, height: 20 } };
    } }),
    readTexts: getRows, file: { readImageMatSync: () => {
      if (options.templateLoadError) throw Error('fixture template unavailable');
      return { dispose() {} };
    } },
    RecognitionObject: { templateMatch: () => ({}) },
    genshin: {
      getPositionFromMap(...args) { positionCalls.push(args); samples++; return options.position === null ? null : { X: options.unstable && samples % 2 === 0 ? 100 : 0, Y: 0 }; },
      getCameraOrientation: () => options.theta ?? 0
    },
    createCancellationTokenSource() {
      const cts = { token: {}, isCancellationRequested: false,
        cancelAfter(ms) { this.budget = ms; }, cancel() { this.isCancellationRequested = true; events.push('cancel'); }, dispose() { events.push('dispose'); } };
      tokens.push(cts); return cts;
    },
    pathingScript: { async run(json, token) {
      pending = true; events.push('path-start'); routes.push(JSON.parse(json)); calls++;
      assert.equal(token, tokens.at(-1).token);
      await Promise.resolve(); clock += 4000;
      if (options.timeout) tokens.at(-1).isCancellationRequested = true;
      pending = false; events.push('path-end');
      if (options.pathError) throw Error('path failed');
    } }
  };
  return { deps, events, routes, tokens, positionCalls, run: travel.createTravelQuest(deps) };
}

test('heading is degrees and both game axes invert image-space direction', () => {
  for (const [degrees, x, y] of [[0, -25, 0], [90, 0, -25], [180, 25, 0], [270, 0, 25]]) {
    const result = travel.targetForHeading({ x: 0, y: 0 }, degrees, 25);
    assert.ok(Math.abs(result.x - x) < 1e-8); assert.ok(Math.abs(result.y - y) < 1e-8);
  }
  for (const args of [[null, 0, 25], [{ x: 1, y: 2 }, NaN, 25], [{ x: 1, y: 2 }, 0, 61]])
    assert.throws(() => travel.targetForHeading(...args));
});
test('eligibility requires unique current HUD stage/distance and permits only bounded world travel', () => {
  assert.equal(travel.eligibility({ texts: hudRows(), scene: 'world' }, grounding).ok, true);
  assert.equal(travel.readHud(hudRows(), grounding).distance, 184);
  for (const distance of [0, 8, 1501]) assert.equal(travel.eligibility({ texts: hudRows(distance), scene: 'world' }, grounding).ok, false);
  for (const scene of ['menu', 'dialogue', 'combat']) assert.equal(travel.eligibility({ texts: hudRows(), scene }, grounding).ok, false);
  assert.equal(travel.readHud([...hudRows(), { text: '寻找另一目标', box: [80, 350, 150, 30] }], grounding), null);
  assert.equal(travel.readHud([{ text: '前去查看详情', box: [924, 252, 153, 29] }, hudRows()[1]], grounding), null);
});
test('OCR bearing requires one distinct world label matching HUD and rejects ambiguous or menu readings', () => {
  const label = { text: '184m', box: [930, 300, 50, 20] };
  assert.equal(travel.distanceLabel([...hudRows(), label], grounding).meters, 184);
  assert.equal(travel.distanceLabel([...hudRows(), { ...label, text: '185m' }], grounding).meters, 184);
  for (const texts of [hudRows(), [...hudRows(), { ...label, text: '180m' }],
    [...hudRows(), label, { text: '180m', box: [1100, 400, 50, 20] }],
    [...hudRows(), label, { text: '商城', box: [170, 440, 50, 20] }]]) assert.equal(travel.distanceLabel(texts, grounding), null);
});
test('unavailable bearing or ambiguous templates never call pathing', async () => {
  for (const options of [{ templates: false, label: false }, { ambiguous: true }]) {
    const h = harness(options), result = await h.run(1);
    assert.equal(result.stopReason, 'bearing_unavailable'); assert.equal(h.routes.length, 0);
    assert.equal(h.events.some(e => e === 'down:VK_W'), false);
    assert.equal(h.events.filter(e => Array.isArray(e) && e[2] === 0).length, 8);
    assert.equal(result.bearings[0].at(-1).yawTurns, 8);
  }
});
test('missing-bearing scan finds a fresh unique OCR label before calling pathing', async () => {
  const h = harness({ templates: false, rowsAtYaw: yaw => [
    ...hudRows(), ...(yaw >= 2 ? [{ text: '184m', box: [930, 300, 50, 20] }] : [])
  ] }), result = await h.run(1);
  assert.equal(h.routes.length, 1);
  assert.equal(result.bearings[0].length, 3);
  assert.deepEqual(result.bearings[0].map(e => e.yawTurns), [0, 1, 2]);
  assert.equal(result.bearings[0][0].fallbackReason, 'no_shared_distance_label');
  assert.equal(result.bearings[0][2].fallbackReason, 'accepted');
  const pathIndex = h.events.indexOf('path-start');
  assert.equal(h.events.slice(0, pathIndex).filter(e => Array.isArray(e) && e[2] === 0).length, 2);
  assert.equal(h.events.slice(0, pathIndex).includes('down:VK_W'), false);
});
test('scanning never turns ambiguous, mismatched, or lower-screen labels into bearings', async () => {
  const labels = [
    [{ text: '184m', box: [930, 300, 50, 20] }, { text: '184m', box: [1100, 320, 50, 20] }],
    [{ text: '180m', box: [930, 300, 50, 20] }],
    [{ text: '184m', box: [930, 600, 50, 20] }]
  ];
  for (const rows of labels) {
    const h = harness({ templates: false, rowsAtYaw: () => [...hudRows(), ...rows] }), result = await h.run(1);
    assert.equal(result.stopReason, 'bearing_unavailable'); assert.equal(h.routes.length, 0);
    assert.equal(result.bearings[0].at(-1).yawTurns, 8);
    assert.equal(result.bearings[0][0].fallbackReason, rows[0].box[1] === 600 ? 'label_below_horizon' : 'no_shared_distance_label');
  }
});
test('scan rereads F/menu/stage and stops before another turn or any path call', async () => {
  const f = [{ text: 'F', box: [1100, 500, 20, 20] }, { text: '法拉', box: [1140, 500, 100, 20] }];
  for (const [rows, reason] of [[ [...hudRows(), ...f], 'interaction_prompt' ],
    [[{ text: '商城', box: [170, 440, 50, 20] }], 'menu'], [hudRows(184, '寻找另一个目标'), 'stage_changed']]) {
    const h = harness({ templates: false, rowsAtYaw: yaw => yaw ? rows : hudRows() }), result = await h.run(1);
    assert.equal(result.stopReason, reason); assert.equal(h.routes.length, 0);
    assert.equal(h.events.filter(e => Array.isArray(e) && e[2] === 0).length, 1);
    assert.equal(result.bearings[0].at(-1).stopCue, reason);
  }
});
test('deadline and parent cancellation interrupt bounded scan without W/path input', async () => {
  for (const [options, reason] of [[{ deadline: 6800 }, 'deadline'], [{ cancelDuringScan: true }, 'native_error']]) {
    const h = harness({ templates: false, label: false, ...options }), result = await h.run(1);
    assert.equal(result.stopReason, reason); assert.equal(h.routes.length, 0);
    const turns = h.events.filter(e => Array.isArray(e) && e[2] === 0).length;
    assert.ok(turns > 0 && turns < 8); assert.equal(h.events.includes('down:VK_W'), false);
    if (options.cancelDuringScan) assert.equal(result.errorCode, 'STORY_FOCUS_LOST');
  }
});
test('template loading failure is explicit and does not prevent valid OCR fallback', async () => {
  const h = harness({ templateLoadError: true }), result = await h.run(1);
  assert.equal(h.routes.length, 1);
  assert.equal(result.bearings[0][0].templateLoads.length, 2);
  assert.ok(result.bearings[0][0].templateLoads.every(load => load.loaded === false && load.error.includes('unavailable')));
  assert.equal(result.bearings[0][0].fallbackReason, 'accepted');
});
test('failed overhead scan resets camera once after fresh world evidence without walking', async () => {
  const h = harness({ templates: false, label: false }), result = await h.run(1);
  assert.equal(result.stopReason, 'bearing_unavailable');
  assert.equal(result.cameraReset.sent, true);
  assert.equal(result.cameraReset.reason, 'overhead_scan_finished');
  assert.equal(h.events.filter(e => e === 'reset').length, 1);
  assert.equal(h.routes.length, 0); assert.equal(h.events.includes('down:VK_W'), false);
  assert.doesNotThrow(() => JSON.stringify(result));
});
test('fresh menu/dialogue/F or missing HUD prevents final camera reset', async () => {
  const blockedRows = [
    [{ text: '商城', box: [170, 440, 50, 20] }],
    [{ text: '这是一个当前剧情的对话字幕', box: [300, 940, 600, 40] }, { text: '派蒙', box: [850, 850, 80, 30] }],
    [...hudRows(), { text: 'F', box: [1100, 500, 20, 20] }, { text: '法拉', box: [1140, 500, 100, 20] }], []
  ];
  for (const rows of blockedRows) {
    let finalReads = 0;
    const h = harness({ templates: false, rowsAtYaw: yaw => yaw === 8 && ++finalReads > 1 ? rows : hudRows() });
    const result = await h.run(1);
    assert.equal(result.stopReason, 'bearing_unavailable'); assert.equal(result.cameraReset.sent, false);
    assert.match(result.cameraReset.reason, /^fresh_/);
    assert.equal(h.events.includes('reset'), false); assert.equal(h.routes.length, 0);
  }
});
test('camera final action rechecks deadline and cancellation after OCR without masking scan failure', async () => {
  for (const mode of ['deadline', 'cancel']) {
    let finalReads = 0;
    const options = { templates: false, rowsAtYaw: yaw => {
      if (yaw === 8 && ++finalReads > 1) {
        if (mode === 'deadline') options.deadline = 1;
        else options.cancelDuringScan = true;
      }
      return hudRows();
    } };
    const h = harness(options), result = await h.run(1);
    assert.equal(result.stopReason, 'bearing_unavailable'); assert.equal(result.cameraReset.sent, false);
    assert.equal(result.cameraReset.reason, mode === 'deadline' ? 'deadline' : 'guard_failed');
    if (mode === 'cancel') assert.equal(result.cameraReset.errorCode, 'STORY_FOCUS_LOST');
    assert.equal(h.events.includes('reset'), false); assert.equal(h.routes.length, 0);
  }
});
test('cancelled or expired scans never send final reset even if cleanup could retry', async () => {
  for (const options of [{ deadline: 6800 }, { cancelDuringScan: true }]) {
    const h = harness({ templates: false, label: false, ...options }), result = await h.run(1);
    assert.equal(result.cameraReset.sent, false);
    assert.match(result.cameraReset.reason, /^blocked_stop:/);
    assert.equal(h.events.includes('reset'), false); assert.equal(h.routes.length, 0);
  }
});
test('native eligibility receives bounded history before any camera input', async () => {
  const history = [{ seq: 4, detail: 'prior failure' }]; let received;
  const h = harness({ grounding: { ...grounding, travelEligibility(input) {
    received = input.recentNativeSteps; return { ok: false, reason: 'travel_blocked', hud: null };
  } } }), result = await h.run(1, { recentNativeSteps: history });
  assert.equal(received, history); assert.equal(result.stopReason, 'travel_blocked');
  assert.equal(h.events.some(e => Array.isArray(e) || e === 'reset' || e.startsWith('down:')), false);
});
test('OCR fallback can align, uses independent uncached samples and single walk path', async () => {
  const h = harness({ templates: false }), result = await h.run(2);
  assert.equal(h.routes.length, 1); assert.equal(result.stopReason, 'direction_unverified');
  assert.deepEqual(h.positionCalls, [['Teyvat', 0], ['Teyvat', 0]]);
  assert.deepEqual(h.routes[0].positions, [{ id: 1, x: -25, y: 0, type: 'path', move_mode: 'walk', action: '' }]);
  assert.equal(result.bearings[0][0].marker.source, 'bettergi_ocr_hud_world_distance_agreement');
  assert.equal(result.legs[0].pathDurationMs, 4000); assert.equal(result.movementMsSent, null);
  assert.equal(result.movementTelemetryComplete, false); assert.equal(result.verified, false);
});
test('first-leg direction proof stops immediately, later legs cap at sixty and six total', async () => {
  const fail = harness({ distances: [184, 175, 100] });
  assert.equal((await fail.run(1)).stopReason, 'direction_unverified'); assert.equal(fail.routes.length, 1);
  const success = harness({ distances: [500, 480, 430, 380, 330, 280, 230] }), result = await success.run(2);
  assert.equal(result.stopReason, 'leg_limit'); assert.equal(result.legs.length, 6);
  assert.deepEqual(result.legs.map(l => l.length), [25, 60, 60, 60, 60, 60]);
  assert.equal(result.movedLegs, 6); assert.equal(result.progress.distanceAfter, 230);
});
test('position instability/unavailability and expired deadline prevent path calls', async () => {
  for (const [options, reason] of [[{ unstable: true }, 'position_unstable'], [{ position: null }, 'position_unavailable'], [{ deadline: 2500 }, 'deadline']]) {
    const h = harness(options); assert.equal((await h.run(1)).stopReason, reason); assert.equal(h.routes.length, 0);
  }
});
test('near-distance stop still records independent same-stage HUD decrease', async () => {
  const h = harness({ distances: [30, 8] }), result = await h.run(1);
  assert.equal(result.stopReason, 'near_distance'); assert.equal(result.movedLegs, 1);
  assert.equal(result.legs[0].distanceDecrease, 22); assert.equal(result.progress.distanceAfter, 8);
  assert.equal(result.verified, false); assert.equal(h.routes.length, 1);
});
test('post-leg F, menu, stage change, missing HUD, near distance and regression stop before another leg', async () => {
  const f = [{ text: 'F', box: [1100, 500, 20, 20] }, { text: '法拉', box: [1140, 500, 100, 20] }];
  for (const [options, reason] of [
    [{ afterRows: [...hudRows(170), ...f] }, 'interaction_prompt'],
    [{ afterRows: [{ text: '商城', box: [170, 440, 50, 20] }] }, 'menu'],
    [{ afterRows: hudRows(170, '前去别的地点') }, 'stage_changed'],
    [{ afterRows: [] }, 'hud_unavailable'], [{ distances: [184, 8] }, 'near_distance'],
    [{ distances: [184, 186] }, 'distance_increased'], [{ distances: [184, 170, 169] }, 'distance_stalled']
  ]) {
    const h = harness(options), result = await h.run(1);
    assert.equal(result.stopReason, reason); assert.ok(h.routes.length <= 2);
  }
});
test('leg timeout and parent stop join path before cancel/dispose/release and never start another leg', async () => {
  for (const [options, reason] of [[{ timeout: true }, 'leg_timeout'], [{ cancelParent: true }, 'native_error'], [{ pathError: true }, 'native_error']]) {
    const h = harness(options), result = await h.run(1);
    assert.equal(result.stopReason, reason); assert.equal(h.routes.length, 1);
    if (options.cancelParent) assert.equal(result.errorCode, 'STORY_DEADLINE_EXPIRED');
    assert.ok(h.tokens[0].budget <= 30000);
    assert.ok(h.events.indexOf('path-end') < h.events.indexOf('cancel'));
    assert.ok(h.events.indexOf('cancel') < h.events.indexOf('dispose'));
    assert.ok(h.events.includes('up:VK_W'));
  }
});
test('UMD works without require/module and native capability check is lazy', async () => {
  const context = vm.createContext({});
  vm.runInContext(fs.readFileSync(require.resolve('../scripts/genshin/story/macros/travel-quest'), 'utf8') + '\nthis.api = StoryTravel;', context);
  assert.equal(typeof context.api.createTravelQuest, 'function');
  const run = context.api.createTravelQuest({ grounding, now: () => 0, keyUp() {} });
  assert.equal((await run(1)).stopReason, 'native_api_unavailable');
});
