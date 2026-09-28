const fs = require('node:fs');
const path = require('node:path');
const { checkTransition, pointToPixels } = require('../src/vision/vlm-action-check');
const dir = path.resolve(__dirname, '../runtime/vlm/live-20260911');
const read = file => JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
const before = read('00-home.analysis.json');
const after = read('01-after.analysis.json');
const report = {
  requestedRounds: 10,
  attemptedRounds: 1,
  successfulRounds: 0,
  completedRounds: 1,
  remainingRounds: 9,
  status: 'waiting_for_manual_input_comparison',
  note: 'One failed round was observed; ten successful cycles have NOT been completed.',
  rounds: [{
    round: 1, action: 'open_settings',
    modelPoint: pointToPixels(before.parsed, ...before.image_size),
    actualClickPixels: [56, 74],
    retryClickPixels: [54, 75],
    inputCallReturnedWithoutError: true,
    keyboardDiagnostic: 'Escape caused no visible change',
    before: before.image, after: after.image,
    validation: checkTransition({before:before.parsed, after:after.parsed, expectedScene:'settings', transportOk:true}),
    beforeTimingMs: {yolo:before.yolo_ms, vlm:before.vlm_ms},
    afterTimingMs: {yolo:after.yolo_ms, vlm:after.vlm_ms},
    diagnosis: 'Game focused; root cause of unaccepted input not established.'
  }]
};
fs.writeFileSync(path.join(dir, 'rounds.json'), JSON.stringify(report,null,2));
console.log(JSON.stringify(report,null,2));
