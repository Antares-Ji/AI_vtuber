// Opt-in local acceptance: never prints account text or copies private samples.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const { analyzeArknights } = require('../../src/vision/arknights');
const root = path.resolve(__dirname, '../../runtime/vision/captures/arknights');
(async () => {
  const manifest = JSON.parse(await fs.readFile(path.join(root, 'manifest.json'), 'utf8'));
  const captures = manifest.captures.filter(entry => entry.scene === 'home');
  assert.ok(captures.length, 'Save a manually labelled home sample first');
  let matched = 0;
  for (const sample of captures) {
    assert.equal(path.basename(sample.file), sample.file, 'sample path must be a filename');
    const result = await analyzeArknights(await fs.readFile(path.join(root, sample.file)));
    const success = result.scene === sample.scene;
    matched += Number(success);
    console.log(JSON.stringify({ file: sample.file, expected: sample.scene, scene: result.scene, evidence: result.evidence, latencyMs: result.latencyMs, passed: success }));
  }
  console.log(`Saved home samples matched: ${matched}/${captures.length}. Repeated frames are not independent scenes; this is not overall vision accuracy.`);
  assert.equal(matched, captures.length, 'Some labelled home samples failed');
})().catch(error => { console.error(error.message); process.exitCode = 1; });
