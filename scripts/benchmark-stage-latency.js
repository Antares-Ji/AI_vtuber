const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '..');
function selectFrames(memory, { allFrames = false, store = path.join(root, 'runtime/vision/stage-memory') } = {}) {
  const eligible = memory.frames.filter(f => f.reviewed_by && ['train', 'val'].includes(f.split));
  const sessions = new Map(), hashes = new Map();
  for (const f of eligible) {
    if (!f.session || f.session === 'unassigned') throw Error('Reviewed frame requires a session');
    if (sessions.has(f.session) && sessions.get(f.session) !== f.split) throw Error('Session leaks across splits');
    sessions.set(f.session, f.split);
    const image = path.resolve(store, f.image), relative = path.relative(path.resolve(store), image);
    if (relative.startsWith('..') || path.isAbsolute(relative)) throw Error('Image escapes manifest directory');
    const digest = crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex');
    if (digest !== f.sha256) throw Error('Image hash differs from reviewed manifest');
    if (hashes.has(digest) && hashes.get(digest) !== f.split) throw Error('Image hash leaks across splits');
    hashes.set(digest, f.split);
  }
  const frames = eligible.filter(f => allFrames || f.split === 'val');
  if (!frames.length) throw Error('No reviewed benchmark frames');
  return frames;
}

async function main() {
  const memory = JSON.parse(fs.readFileSync(path.join(root, 'runtime/vision/stage-memory/0-1.json')));
  const fastOnly = process.argv.includes('--fast-only');
  const frames = selectFrames(memory, { allFrames: process.argv.includes('--all-frames') });
  const { analyzeStage } = require('../src/vision/stage-advisor');
  const results = [];
  for (let repeat = 0; repeat < 2; repeat++) {
    for (const frame of frames) {
      for (const fast of (fastOnly ? [true] : repeat ? [true, false] : [false, true])) {
        const r = await analyzeStage({imagePath: path.join(root, 'runtime/vision/stage-memory', frame.image), fast});
        results.push({image: frame.image, repeat, fast, ms: r.request_ms, server_ms: r.server_ms,
          vlm_ms:r.vlm_ms, valid:r.analysis_valid, parsed:r.parsed,
          correct:r.parsed?.phase===frame.phase && r.parsed?.deployment_confirmed===frame.deployment_confirmed});
        console.log(JSON.stringify(results.at(-1)));
      }
    }
  }
  const summary = (fastOnly ? [true] : [false,true]).map(fast => {
    const rows = results.filter(r=>r.fast===fast), times=rows.map(r=>r.ms).sort((a,b)=>a-b);
    return {fast, n:rows.length, median_ms:(times[Math.floor((times.length-1)/2)]+times[Math.floor(times.length/2)])/2, p95_ms:times[Math.ceil(times.length*.95)-1],
      correct:rows.filter(r=>r.correct).length, valid:rows.filter(r=>r.valid).length};
  });
  const output = path.join(root, 'runtime/vlm/training/stage-memory-manifest-runs', 'benchmark-' + Date.now() + '-' + crypto.randomUUID());
  fs.mkdirSync(output, { recursive: true });
  fs.writeFileSync(path.join(output, 'manifest.json'), JSON.stringify(memory, null, 2));
  fs.writeFileSync(path.join(output, fastOnly?'latency-fast.json':'latency-comparison.json'), JSON.stringify({results,summary, cold_start_measured: false, warm_state: 'Model/server warm state is uncontrolled; repeat 0 is not a cold-start measurement.', selection: { sessions: [...new Set(frames.map(f=>f.session))], splits: [...new Set(frames.map(f=>f.split))], images: frames.map(f=>f.image) },
    scope:'Existing PNG -> local hybrid response; excludes live capture, clicking and confirmation. Known memory images, not held-out accuracy.'},null,2));
  console.log(JSON.stringify(summary));
}
module.exports = { selectFrames };
if (require.main === module) main().catch(error=>{console.error(error);process.exitCode=1});
