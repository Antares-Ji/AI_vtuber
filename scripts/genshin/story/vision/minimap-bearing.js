// Read-only evidence helper. Loading this file never captures or sends input.
const StoryMinimapBearing = (() => {
  const normal = value => String(value || '').replace(/\s/g, '');
  const templates = ['quest-marker.png', 'quest-marker-blue.png', 'minimap-commission.png'];
  const point = value => value && Number.isFinite(value.x) && Number.isFinite(value.y)
    ? { x: value.x, y: value.y } : null;
  const plain = value => value == null ? null : JSON.parse(JSON.stringify(value));
  function headingForDirection(direction) {
    const p = point(direction);
    if (!p || Math.hypot(p.x, p.y) < 1e-8) throw Error('Invalid projected direction');
    // PathExecutor heading 0 travels toward negative game X; 90 toward -Y.
    // The native projection already accounts for minimap rotation and both axes.
    return Math.atan2(-p.y, -p.x) * 180 / Math.PI || 0;
  }
  function minimapRoi(width) {
    if (!Number.isFinite(width) || width <= 0) return null;
    const scale = Math.min(width / 1920, 1);
    // Match MapAssets' .NET Math.Round default (midpoint ties to even).
    // JS Math.round differs at e.g. 1440px: 62 * .75 = 46.5 must become 46.
    return [62, 19, 212, 212].map(value => {
      const scaled = value * scale, floor = Math.floor(scaled);
      return scaled - floor === 0.5 ? floor + (floor % 2) : Math.round(scaled);
    });
  }
  function projectionSummary(raw) {
    const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
    if (!value || typeof value !== 'object') throw Error('Invalid projection response');
    // Copy known primitive fields: host DTOs must never escape into receipts.
    const result = { ok: value.ok === true, reason: String(value.reason || '').slice(0, 180) };
    for (const key of ['centerMap', 'markerMap', 'centerGame', 'gameDirection']) result[key] = point(value[key]);
    for (const key of ['matchCount', 'inlierCount', 'inlierRatio', 'reprojectionError', 'layer', 'durationMs'])
      result[key] = Number.isFinite(value[key]) ? value[key] : null;
    result.mapName = typeof value.mapName === 'string' ? value.mapName : null;
    const crop = value.crop;
    result.crop = Array.isArray(crop) && crop.length === 4 && crop.every(Number.isFinite) ? crop.slice()
      : crop && ['x', 'y', 'width', 'height'].every(key => Number.isFinite(crop[key]))
        ? { x: crop.x, y: crop.y, width: crop.width, height: crop.height } : null;
    return result;
  }
  function cancellation(error) {
    return error?.travelReason === 'deadline' || /cancel|deadline|focus|abort/i.test(
      String(error?.code || '') + ' ' + String(error?.name || '') + ' ' + String(error?.message || ''));
  }
  function createMinimapBearing(deps) {
    const { captureGameRegion, readTexts, grounding, sleep, diagnostics, project } = deps;
    const now = deps.now || Date.now;
    let closed = false;
    function budgetCheck() {
      if (deps.budgetCheck) return deps.budgetCheck();
      deps.checkInput();
      if (!Number.isFinite(deps.getDeadline()) || deps.getDeadline() - now() <= 2000)
        throw Object.assign(Error('Travel deadline approaching'), { travelReason: 'deadline' });
    }
    function currentStop(texts, stage) {
      if (deps.currentStop) return deps.currentStop(texts, stage);
      const cue = grounding.movementStop(texts), hud = grounding.questHud(texts);
      return cue || (!hud ? 'hud_unavailable' : stage && normal(hud.stage) !== normal(stage)
        ? 'stage_changed' : hud.meters <= 8 ? 'near_distance' : hud.meters > 1500 ? 'distance_out_of_range' : null);
    }
    async function samplePair(stage) {
      const samples = [];
      const fail = (reason, stop = false) => ({ ok: false, reason, stop, source: 'minimap_projection', samples });
      budgetCheck();
      if (closed) return fail('minimap_observer_disposed');
      if (typeof project !== 'function') return fail('projection_api_unavailable');
      if (!diagnostics || typeof diagnostics.observe !== 'function') return fail('template_diagnostics_unavailable');
      let previousFrame = null;
      for (let index = 0; index < 2; index++) {
        if (index) { await sleep(100); budgetCheck(); }
        budgetCheck();
        const frame = captureGameRegion();
        const sample = { index, at: now(), roi: null, peaks: [], projection: null };
        samples.push(sample);
        try {
          budgetCheck();
          if (frame === previousFrame) return fail('capture_not_independent');
          previousFrame = frame;
          const texts = readTexts(frame);
          budgetCheck();
          const stop = currentStop(texts, stage);
          sample.hud = plain(grounding.questHud(texts));
          if (stop) { sample.stopCue = stop; return fail(stop, true); }
          const width = Number(frame.width), height = Number(frame.height), roi = minimapRoi(width);
          sample.roi = roi;
          if (!roi || !Number.isFinite(height) || roi[2] <= 0 || roi[3] <= 0
            || roi[0] + roi[2] > width || roi[1] + roi[3] > height) return fail('minimap_roi_invalid');
          budgetCheck();
          const observation = diagnostics.observe(frame, { templateNames: templates.slice(), roi,
            productionThreshold: 0.8, kind: 'minimap' });
          budgetCheck();
          sample.peaks = plain(observation.peaks || []);
          sample.candidates = plain(observation.candidates || []);
          sample.productionComplete = observation.productionComplete === true;
          const marker = observation.unique;
          if (observation.accepted !== true || !sample.productionComplete || sample.candidates.length !== 1 || !marker)
            return fail(sample.candidates.length > 1 ? 'minimap_template_ambiguous'
              : !sample.productionComplete ? 'minimap_template_incomplete' : 'minimap_marker_unavailable');
          // Never promote a diagnostic peak, even if it is the highest NCC.
          if (!Array.isArray(marker.scores) || !marker.scores.length
            || marker.scores.some(row => !Number.isFinite(row.score) || row.score < 0.8))
            return fail('minimap_score_below_threshold');
          const center = marker.center;
          if (!Array.isArray(center) || center.length !== 2 || !center.every(Number.isFinite))
            return fail('minimap_marker_invalid');
          const [x, y] = center, [rx, ry, rw, rh] = roi;
          const radius = Math.min(rw, rh) / 2, offset = Math.hypot(x - (rx + rw / 2), y - (ry + rh / 2));
          sample.marker = { x, y, source: 'production_threshold', offset };
          if (x < rx || y < ry || x >= rx + rw || y >= ry + rh || offset > radius)
            return fail('minimap_marker_outside_circle');
          if (offset < 12 * Math.min(width / 1920, 1)) return fail('minimap_marker_near_center');
          budgetCheck();
          const raw = await project(frame, x, y);
          budgetCheck();
          const projection = projectionSummary(raw);
          sample.projection = projection;
          if (/cancel|deadline|focus|abort/i.test(projection.reason))
            throw Object.assign(Error(projection.reason), { code: 'STORY_PROJECTION_CANCELLED' });
          if (!projection.ok) return fail(projection.reason || 'minimap_projection_failed');
          if (!projection.centerGame || !projection.gameDirection || Math.hypot(projection.gameDirection.x, projection.gameDirection.y) < 1e-8)
            return fail('minimap_projection_invalid');
          const magnitude = Math.hypot(projection.gameDirection.x, projection.gameDirection.y);
          sample.position = projection.centerGame;
          sample.direction = { x: projection.gameDirection.x / magnitude, y: projection.gameDirection.y / magnitude };
        } catch (error) {
          if (cancellation(error)) throw error;
          // Also detects a parent cancellation reported during a native failure.
          budgetCheck();
          sample.error = String(error.message || error).slice(0, 180);
          return fail('minimap_observation_error');
        } finally { frame.dispose(); }
      }
      budgetCheck();
      const first = samples[0], second = samples[1];
      const drift = Math.hypot(first.position.x - second.position.x, first.position.y - second.position.y);
      second.positionDrift = drift;
      if (drift > 10) return fail('position_unstable');
      const dot = first.direction.x * second.direction.x + first.direction.y * second.direction.y;
      const angle = Math.acos(Math.max(-1, Math.min(1, dot))) * 180 / Math.PI;
      second.directionDeltaDegrees = angle;
      if (angle > 10 + 1e-8) return fail('minimap_direction_unstable');
      return { ok: true, reason: 'accepted', source: 'minimap_projection', samples,
        from: second.position, positionSamples: samples.map(sample => sample.position),
        heading: headingForDirection(second.direction), hud: second.hud };
    }
    // Diagnostics may be shared with the screen source; its owner disposes it.
    return { samplePair, dispose() { closed = true; } };
  }
  return { createMinimapBearing, headingForDirection, minimapRoi, templateNames: () => templates.slice() };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = StoryMinimapBearing;
