// Shared native intent macro and pure evidence rules. Loading in Node sends no input.
const StoryTravel = (() => {
  const normal = value => String(value || '').replace(/[\s「」『』“”"']/g, '');
  const positioned = texts => (texts || []).filter(row => Array.isArray(row.box)
    && row.box.length === 4 && row.box.every(Number.isFinite));
  const readHud = (texts, grounding) => grounding.questHud(texts);
  const eligibility = (input, grounding) => grounding.travelEligibility(input);
  function targetForHeading(position, degrees, leg) {
    const x = Number(position?.x ?? position?.X), y = Number(position?.y ?? position?.Y);
    if (![x, y, degrees, leg].every(Number.isFinite) || leg <= 0 || leg > 180)
      throw Error('Invalid travel coordinate, heading or bounded leg');
    const radians = degrees * Math.PI / 180;
    return { x: x - leg * Math.cos(radians), y: y - leg * Math.sin(radians) };
  }

  const distanceLabel = (texts, grounding) => grounding.questDistanceLabel(texts);
  function createTravelQuest(deps) {
    const { grounding, captureGameRegion, readTexts, sleep, checkInput, keyDown,
      keyUp, moveMouseBy, middleButtonClick, genshin, pathingScript,
      RecognitionObject, file, getDeadline, createCancellationTokenSource } = deps;
    const now = deps.now || Date.now;
    const marginMs = 2000;
    function budgetCheck() {
      checkInput();
      if (!Number.isFinite(getDeadline()) || getDeadline() - now() <= marginMs) {
        const error = Error('Travel deadline approaching'); error.travelReason = 'deadline'; throw error;
      }
    }
    function capture() {
      budgetCheck();
      const frame = captureGameRegion();
      try { return readTexts(frame); } finally { frame.dispose(); }
    }
    function currentStop(texts, stage) {
      const stop = grounding.movementStop(texts);
      if (stop) return stop;
      const hud = readHud(texts, grounding);
      if (!hud) return 'hud_unavailable';
      if (stage && normal(hud.stage) !== normal(stage)) return 'stage_changed';
      if (hud.meters <= 8) return 'near_distance';
      if (hud.meters > 1500) return 'distance_out_of_range';
      return null;
    }
    async function align(stage, trace, camera, diagnostics) {
      const mats = [], recognizers = [], templateLoads = [];
      try {
        for (const name of ['quest-marker.png', 'quest-marker-blue.png']) {
          try {
            const mat = file.readImageMatSync(name); mats.push(mat);
            const ro = RecognitionObject.templateMatch(mat, 300, 0, 1320, 1080);
            ro.threshold = 0.8; ro.maxMatchCount = 2;
            recognizers.push({ name, ro });
            templateLoads.push({ name, loaded: true });
          } catch (error) {
            templateLoads.push({ name, loaded: false, error: String(error.message || error).slice(0, 160) });
          }
        }
        budgetCheck(); moveMouseBy(0, 7000); camera.overhead = true; await sleep(400);
        budgetCheck(); keyDown('VK_V');
        try { await sleep(80); } finally { keyUp('VK_V'); }
        await sleep(3000);
        let missing = 0, stale = 0, previous = null, yawTurns = 0;
        for (let iteration = 0; iteration <= 8; iteration++) {
          budgetCheck();
          const frame = captureGameRegion(); let marker = null, hud, stop;
          const entry = { iteration, yawTurns, ...(iteration === 0 ? { templateLoads } : {}) };
          trace.push(entry);
          try {
            const texts = readTexts(frame);
            stop = currentStop(texts, stage); hud = readHud(texts, grounding);
            entry.stage = hud?.stage ?? null;
            entry.distance = hud?.meters ?? null;
            entry.ocrDistances = positioned(texts).filter(row => /^\d{1,5}(?:m|米)$/i.test(normal(row.text)))
              .slice(0, 12).map(row => ({ text: row.text, box: row.box, source: row.source || 'full_frame' }));
            if (stop) { entry.stopCue = stop; return { stop }; }
            if (diagnostics) entry.ncc = diagnostics.observe(frame, {
              templateNames: ['quest-marker.png', 'quest-marker-blue.png'],
              roi: [300, 0, 1320, 1080], productionThreshold: 0.8, kind: 'screen' });
            if (diagnostics) {
              entry.minimapNcc = diagnostics.observe(frame, {
                templateNames: deps.minimapTemplateNames(),
                roi: deps.minimapRoi(frame.width),
                productionThreshold: 0.8, kind: 'minimap' });
            }
            const candidates = [];
            for (const item of recognizers) {
              const found = frame.findMulti(item.ro);
              for (let i = 0; i < found.count; i++) {
                const candidate = { x: found[i].x + found[i].width / 2,
                  y: found[i].y + found[i].height / 2, source: 'template' };
                if (!candidates.some(p => Math.abs(p.x - candidate.x) <= 14
                  && Math.abs(p.y - candidate.y) <= 14)) candidates.push(candidate);
              }
            }
            entry.fallbackReason = candidates.length > 1 ? 'template_ambiguous' : 'template_available';
            if (candidates.length === 1) marker = candidates[0];
            else if (candidates.length === 0) {
              const label = distanceLabel(texts, grounding);
              // Text below the horizon does not establish the overhead marker's
              // front/back geometry. Do not invent a diamond position from it.
              entry.fallbackReason = !label ? 'no_shared_distance_label' : label.box[1] + label.box[3] >= 540
                ? 'label_below_horizon' : 'accepted';
              if (entry.fallbackReason === 'accepted') marker = label;
            }
            entry.matches = candidates.length; entry.marker = marker;
          } finally { frame.dispose(); }
          let dx;
          if (!marker) {
            entry.consecutiveMissing = ++missing;
            // Search a bounded portion of the view, never infer a bearing from
            // HUD distance alone. Scanning and alignment share the same budget.
            stale = 0; previous = null; dx = 320;
            entry.turnKind = 'scan';
          } else {
            missing = 0;
            const errorX = marker.x - 960;
            if (Math.abs(errorX) <= 80 && marker.y < 540) return { hud, marker };
            stale = previous && marker.source === previous.source
              && Math.abs(marker.x - previous.x) < 8 && Math.abs(marker.y - previous.y) < 8 ? stale + 1 : 0;
            if (stale >= 3) return { stop: 'alignment_stalled' };
            previous = marker;
            dx = Math.abs(errorX) > 80 ? Math.round(Math.max(-400, Math.min(400, errorX * 0.6))) : 300;
            entry.turnKind = 'align';
          }
          if (yawTurns >= 8) return { stop: 'bearing_unavailable' };
          budgetCheck(); moveMouseBy(dx, 0);
          entry.turnSent = { dx, dy: 0 }; entry.yawTurnsAfter = ++yawTurns;
          await sleep(250);
        }
        return { stop: 'bearing_unavailable' };
      } finally {
        keyUp('VK_V');
        for (const mat of mats) try { mat.dispose(); } catch {}
      }
    }

    return async function travelQuest(seq, options = {}) {
      const startedAt = now();
      const camera = { overhead: false };
      let diagnostics = null, minimap = null;
      const result = { kind: 'quest-travel', intent: 'travel_quest', seq, legs: [], bearings: [], movedLegs: 0,
        attemptedLegs: 0, stopReason: null, verified: false,
        movementMsSent: null, movementTelemetryComplete: false, interactionChecks: deps.monitorPath ? 'during_path_local_ocr' : 'between_legs',
        progress: { distanceBefore: null, distanceAfter: null, stageBefore: null, stageAfter: null } };
      try {
        if (!genshin || !pathingScript || typeof createCancellationTokenSource !== 'function') {
          result.stopReason = 'native_api_unavailable'; return result;
        }
        const texts = capture();
        const initial = eligibility({ texts, scene: options.scene || 'world', uncertain: options.uncertain,
          recentNativeSteps: options.recentNativeSteps }, grounding);
        if (!initial.ok) { result.stopReason = initial.reason; return result; }
        diagnostics = deps.createDiagnostics?.({ file, RecognitionObject }) || null;
        if (diagnostics && deps.createMinimapBearing) minimap = deps.createMinimapBearing({
          captureGameRegion, readTexts, grounding, sleep, checkInput, getDeadline, now,
          budgetCheck, currentStop, diagnostics, project: deps.projectMinimap });
        try { result.templateSet = JSON.parse(file.readTextSync('minimap-candidates.source.json')); }
        catch { result.templateSet = { status: 'manifest_unavailable' }; }
        result.minimapBearings = [];
        const stage = initial.hud.stage;
        result.progress = { distanceBefore: initial.hud.meters, distanceAfter: initial.hud.meters,
          stageBefore: stage, stageAfter: stage };
        for (let index = 0; index < 6; index++) {
          const before = capture(), stop = currentStop(before, stage);
          if (stop) { result.stopReason = stop; break; }
          const mini = minimap ? await minimap.samplePair(stage) : { ok: false, reason: 'minimap_api_unavailable' };
          result.minimapBearings.push(mini);
          if (mini.stop) { result.stopReason = mini.reason; break; }
          let from1, from, theta, bearingSource;
          if (mini.ok) {
            [from1, from] = mini.positionSamples;
            theta = mini.heading; bearingSource = 'minimap_projection';
          } else {
            const bearingTrace = []; result.bearings.push(bearingTrace);
            const bearing = await align(stage, bearingTrace, camera, diagnostics);
            if (bearing.stop) { result.stopReason = bearing.stop; break; }
            budgetCheck();
            const p1 = genshin.getPositionFromMap('Teyvat', 0);
            await sleep(100); budgetCheck();
            const p2 = genshin.getPositionFromMap('Teyvat', 0);
            const point = p => p == null ? null : { x: Number(p.x ?? p.X), y: Number(p.y ?? p.Y) };
            from1 = point(p1); from = point(p2);
            theta = Number(genshin.getCameraOrientation()); bearingSource = 'screen_camera';
          }
          budgetCheck();
          if (!from1 || !from || ![from1.x, from1.y, from.x, from.y].every(Number.isFinite)) {
            result.stopReason = 'position_unavailable'; break;
          }
          if (Math.hypot(from.x - from1.x, from.y - from1.y) > 10) {
            result.stopReason = 'position_unstable'; break;
          }
          if (!Number.isFinite(theta)) { result.stopReason = 'bearing_unavailable'; break; }
          // Camera heading is separate telemetry: a successful SIFT homography
          // permits rotation and does not prove that this minimap is north-up.
          // Never replace the projected target heading with the camera heading.
          let cameraOrientation = { degrees: theta, source: 'screen_alignment', at: now() };
          if (bearingSource === 'minimap_projection') {
            cameraOrientation = { degrees: null, source: 'getCameraOrientation', at: now() };
            budgetCheck();
            try {
              const value = genshin.getCameraOrientation();
              const degrees = value == null ? NaN : Number(value);
              if (Number.isFinite(degrees)) cameraOrientation.degrees = degrees;
              else cameraOrientation.error = 'nonfinite_camera_orientation';
            } catch (error) {
              budgetCheck();
              if (/cancel|deadline|focus|abort/i.test(String(error?.code || '') + ' ' + String(error?.message || error))) throw error;
              cameraOrientation.error = String(error?.message || error).slice(0, 160);
            }
            budgetCheck();
          }
          const fresh = capture(), freshStop = currentStop(fresh, stage);
          if (freshStop) { result.stopReason = freshStop; break; }
          const hud = readHud(fresh, grounding), length = Math.min(Math.max(1,hud.meters-5), index === 0 ? 25 : 180);
          const to = targetForHeading(from, theta, length);
          budgetCheck(); middleButtonClick(); camera.overhead = false; await sleep(200); budgetCheck();
          const budgetMs = Math.min(index === 0 ? 30000 : 60000, getDeadline() - now() - marginMs);
          if (budgetMs <= 0) { result.stopReason = 'deadline'; break; }
          const leg = { from, samples: [from1, from], to, theta, thetaUnit: 'degrees', bearingSource, length,
            cameraOrientation, minimapNorthUpAssumed: false,
            distanceBefore: hud.meters, distanceAfter: null, startedAt: now(), budgetMs,
            returned: false, verified: false };
          result.legs.push(leg); result.attemptedLegs++;
          const cts = createCancellationTokenSource();
          let running = null, timedOut = false, monitoredStop = null;
          try {
            cts.cancelAfter(Math.floor(budgetMs));
            budgetCheck();
            running = Promise.resolve(pathingScript.run(JSON.stringify({
              info: { name: 'AI-VTuber-travel', type: 'collect', bgi_version: '0.66.0', map_name: 'Teyvat' },
              positions: [{ id: 1, x: to.x, y: to.y, type: 'path', move_mode: 'walk', action: '' }]
            }), cts.token));
            if (deps.monitorPath) {
              let missing = 0, previousDistance = hud.meters;
              const monitoring = await deps.monitorPath({run:()=>running, cts, read:capture, checkInput:budgetCheck, sleep, now,
                inspect: rows => {
                  const current = readHud(rows, grounding);
                  let stopReason = currentStop(rows, stage);
                  // One transient missing distance is tolerated while pathing keeps
                  // its own fresh CV position; two consecutive misses stop it.
                  missing = current ? 0 : missing + 1;
                  if (stopReason === 'hud_unavailable' && missing < 2) stopReason = null;
                  if (!stopReason && current && current.meters > previousDistance + 5) stopReason = 'distance_increased';
                  if (current) previousDistance = current.meters;
                  return {stopReason, distance:current?.meters ?? null};
                }});
              leg.localChecks = monitoring.samples; monitoredStop = monitoring.stopReason;
            } else await running;
            timedOut = cts.isCancellationRequested === true && !monitoredStop;
            leg.returned = true;
          } finally {
            // AutoPathingScript catches cancellation internally. Always cancel
            // then join, never race it and leave a path moving in the background.
            try { cts.cancel(); } finally {
              try { if (running) await running; } finally {
                cts.dispose(); keyUp('VK_W');
                leg.finishedAt = now(); leg.durationMs = leg.finishedAt - leg.startedAt;
                leg.pathDurationMs = leg.durationMs;
              }
            }
          }
          if (timedOut) { result.stopReason = 'leg_timeout'; break; }
          budgetCheck();
          const after = capture(), afterHud = readHud(after, grounding);
          if (afterHud) {
            leg.distanceAfter = afterHud.meters;
            result.progress.distanceAfter = afterHud.meters;
            result.progress.stageAfter = afterHud.stage;
            if (normal(afterHud.stage) === normal(stage)) {
              leg.distanceDecrease = hud.meters - afterHud.meters;
              if (leg.distanceDecrease > 0) result.movedLegs++;
            }
          }
          const afterStop = monitoredStop || currentStop(after, stage);
          if (afterStop) { result.stopReason = afterStop; break; }
          const decrease = hud.meters - afterHud.meters;
          if (decrease < 0) { result.stopReason = 'distance_increased'; break; }
          if (index === 0 && decrease < length * 0.4) { result.stopReason = 'direction_unverified'; break; }
          if (decrease < 3) { result.stopReason = 'distance_stalled'; break; }
        }
        result.stopReason ||= 'leg_limit';
      } catch (error) {
        result.stopReason = error.travelReason || 'native_error';
        result.errorCode = error.code || null;
        result.error = String(error.message || error).slice(0, 300);
      } finally {
        for (const key of ['VK_W', 'VK_A', 'VK_S', 'VK_D', 'VK_V', 'VK_SPACE']) try { keyUp(key); } catch {}
        try { minimap?.dispose(); } catch {}
        try { diagnostics?.dispose(); } catch {}
        result.cameraReset = { sent: false, reason: 'not_overhead' };
        if (camera.overhead) {
          // This is a guarded final action, not unconditional input cleanup.
          // Never resume input after an exception/cancellation or blocked scene,
          // even if a subsequent check would happen to look usable again.
          const blocked = ['native_error', 'deadline', 'leg_timeout', 'menu', 'map', 'dialogue', 'interaction_prompt'];
          if (blocked.includes(result.stopReason)) result.cameraReset.reason = 'blocked_stop:' + result.stopReason;
          else {
            try {
              const texts = capture(), stop = grounding.movementStop(texts);
              if (stop) result.cameraReset.reason = 'fresh_stop:' + stop;
              else if (!readHud(texts, grounding)) result.cameraReset.reason = 'fresh_hud_unavailable';
              else {
                budgetCheck(); middleButtonClick(); camera.overhead = false;
                result.cameraReset = { sent: true, reason: 'overhead_scan_finished', at: now() };
              }
            } catch (error) {
              result.cameraReset = { sent: false, reason: error.travelReason || 'guard_failed',
                errorCode: error.code || null, error: String(error.message || error).slice(0, 160) };
            }
          }
        }
        result.finishedAt = now(); result.durationMs = result.finishedAt - startedAt;
      }
      return result;
    };
  }
  return { readHud, eligibility, targetForHeading, distanceLabel, createTravelQuest };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = StoryTravel;
