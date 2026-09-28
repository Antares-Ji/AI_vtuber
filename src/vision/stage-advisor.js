// Reusable VTuber vision entry point: evidence-backed proposals, no mouse input.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const root = path.resolve(__dirname, '../..');
async function analyzeStage({ imagePath, target = '识别当前阶段，结合关卡记忆建议下一步', mode = 'hybrid', fast = false }) {
  const started = performance.now();
  if (!['vlm', 'yolo', 'hybrid'].includes(mode)) throw Error('Invalid vision mode');
  const directory = path.join(root, 'runtime/vlm/live-20260911');
  fs.mkdirSync(directory, { recursive: true });
  const image = `stage-${crypto.randomUUID()}.png`;
  fs.copyFileSync(imagePath, path.join(directory, image));
  const response = await fetch('http://127.0.0.1:17642/analyze', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ image, target, mode, strategy: fast ? 'stage-fast' : 'stage-memory' }),
    signal: AbortSignal.timeout(120000),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || 'Stage analysis failed');
  const analysisValid = !!result.parsed && Array.isArray(result.validation_errors) && !result.validation_errors.length;
  return { ...result, analysis_valid: analysisValid, proposal: analysisValid ? result.parsed : null,
    request_ms: performance.now() - started, automatic_execution_allowed: false };
}
function createRealtimeStageAdvisor(options) {
  const { LatestFrameAnalyzer } = require('./latest-frame-analyzer');
  return new LatestFrameAnalyzer(frame => analyzeStage({...frame, fast:true}), options);
}
module.exports = { analyzeStage, createRealtimeStageAdvisor };
if (require.main === module) {
  const imagePath = process.argv[2];
  if (!imagePath) throw Error('Supply a PNG screenshot path');
  analyzeStage({ imagePath, mode: process.argv[3] || 'hybrid', fast: process.argv.includes('--fast') })
    .then(result => console.log(JSON.stringify(result, null, 2)))
    .catch(error => { console.error(error.message); process.exitCode = 1; });
}
