const TTS_EMOTIONS = Object.freeze(["neutral", "happy", "shy", "annoyed", "focused", "excited", "concerned", "sad", "grateful", "proud", "playful", "relieved", "curious", "nostalgic", "surprised", "lonely", "hopeful", "disappointed", "embarrassed", "protective", "admiring", "wary"]);
const EMOTIONS = new Set(TTS_EMOTIONS);
const REGULATIONS = new Set(["maintain", "settle", "down-regulate", "boundary", "reappraise"]);

function sanitizeTtsStyle(input = {}) {
  return {
    speechRate: bounded(input.speechRate, 0.85, 1.15, 1),
    pitch: bounded(input.pitch, -0.2, 0.2, 0),
    energy: bounded(input.energy, 0, 1, 0.7),
    pauseMs: bounded(input.pauseMs, 40, 800, 180),
    emotion: EMOTIONS.has(input.emotion) ? input.emotion : "neutral",
    regulation: REGULATIONS.has(input.regulation) ? input.regulation : "maintain",
    valence: bounded(input.valence, -1, 1, 0),
    arousal: bounded(input.arousal, -1, 1, 0),
    dominance: bounded(input.dominance, -1, 1, 0),
    tension: bounded(input.tension, -1, 1, 0),
    expressibility: bounded(input.expressibility, 0, 1, 0.5)
  };
}

function bounded(value, min, max, fallback) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
}

module.exports = { TTS_EMOTIONS, sanitizeTtsStyle };
