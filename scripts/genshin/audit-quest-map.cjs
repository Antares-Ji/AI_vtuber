// Offline evidence inventory only. Does not open maps, capture, or send input.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const grounding = require('./story/grounding.js');

function inspect(record, file) {
  const texts = record.request?.texts || [];
  const quest = grounding.questMenu(texts);
  const map = grounding.mapMenu(texts);
  if (!quest && !map) return null;
  return {
    file, at: record.at, session: record.trainingSessionId || record.request?.trainingSessionId || null,
    savedScene: record.observation?.scene || null,
    groundedScene: map ? 'map' : 'menu', quest, map,
    // A map overview or teleport detail does not identify a quest location.
    questCenterProven: false,
  };
}

function summarize(rows) {
  return {
    recognizedRecords: rows.length,
    questMenus: rows.filter(r => r.quest).length,
    mapOverviews: rows.filter(r => r.map?.kind === 'overview').length,
    mapTeleportDetails: rows.filter(r => r.map?.kind === 'detail').length,
    savedSceneDisagreements: rows.filter(r => r.savedScene !== r.groundedScene).length,
    questCenterProven: 0,
    fallbackReady: false,
    missingEvidence: [
      'OCR-identified control that centers the currently selected quest',
      'post-action confirmation of the same quest and its centered marker',
      'two stable map-center coordinates paired with those confirmed frames',
    ],
  };
}

function audit(root) {
  const rows = [];
  for (const dir of fs.readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory())) {
    for (const name of fs.readdirSync(path.join(root, dir.name)).filter(n => /^step-\d+\.json$/.test(n))) {
      const file = path.join(root, dir.name, name);
      const bytes = fs.readFileSync(file);
      const row = inspect(JSON.parse(bytes.toString('utf8').replace(/^\uFEFF/, '')), file);
      if (row) rows.push({ ...row, sha256: crypto.createHash('sha256').update(bytes).digest('hex') });
    }
  }
  rows.sort((a, b) => a.at - b.at || a.file.localeCompare(b.file));
  return {
    kind: 'offline_quest_map_inventory', inputOrNetworkCalls: 0,
    summary: summarize(rows), records: rows,
    limitations: [
      'Counts are archived records, not unique screenshots or independent trials.',
      'Only existing OCR layout rules are replayed; unrecognized frames are not evidence of absent controls.',
      'getPositionFromBigMap returns the visible map center, not automatically the quest target.',
      'This inventory cannot authorize a movement or certify a centered quest.',
    ],
  };
}

if (require.main === module) {
  const root = path.resolve(process.argv[2] || 'runtime/genshin/story');
  const output = path.resolve(process.argv[3] || 'runtime/genshin/quest-map-audit.json');
  const result = audit(root);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n');
  console.log(JSON.stringify({ output, ...result.summary }, null, 2));
}
module.exports = { inspect, summarize, audit };
