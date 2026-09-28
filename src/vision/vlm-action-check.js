/** A transport success is never proof that the game accepted an action. */
function checkTransition({ before, after, expectedScene, transportOk }) {
  if (!transportOk) return { ok: false, reason: 'input_transport_failed' };
  if (!before?.scene || !after?.scene) return { ok: false, reason: 'missing_visual_evidence' };
  if (after.scene !== expectedScene) {
    return { ok: false, reason: before.scene === after.scene ? 'scene_unchanged' : 'unexpected_scene' };
  }
  if (before.scene === expectedScene) return { ok: false, reason: 'already_in_scene_requires_tab_evidence' };
  return { ok: true, reason: 'observed_expected_scene' };
}

function pointToPixels(proposal, width, height) {
  const point = proposal?.target_point;
  if (proposal?.target_visible !== true || !Array.isArray(point) || point.length !== 2 ||
      point.some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1000) ||
      !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) return null;
  return { x: Math.round(point[0] / 1000 * (width - 1)), y: Math.round(point[1] / 1000 * (height - 1)) };
}

module.exports = { checkTransition, pointToPixels };
