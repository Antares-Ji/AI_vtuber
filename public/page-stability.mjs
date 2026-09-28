export function difference(a, b) {
  if (!a || !b || a.length !== b.length) return 1;
  let changed = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 22) changed++;
  return changed / a.length;
}
export class StableFrames {
  constructor() { this.anchor = null; this.since = 0; this.history = []; }
  consider(pixels, now) {
    if (difference(this.anchor, pixels) > .018) { this.anchor = pixels.slice(); this.since = now; return false; }
    return now - this.since >= 1000 && !this.history.some(old => difference(old, pixels) < .035);
  }
  saved(pixels) { this.history.push(pixels.slice()); }
}
