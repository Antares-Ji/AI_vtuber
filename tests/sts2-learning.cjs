const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const K = require('../src/sts2/knowledge');
const raw = { source: 'installed-game-ModelDb.AllCards', total: 2, cards: [
  { id: 'A', name: '测试攻击', base: { name: '测试攻击', cost: '1', description: '造成6点伤害。' }, upgraded: { name: '测试攻击+', cost: '1', description: '造成9点伤害。' } },
  { id: 'B', name: '测试技能', base: { cost: '1', description: '获得{Block}点格挡。' } }
] };
test('preserves unresolved templates and refuses duplicate identities', () => {
  const d = K.normalizeCatalog(raw, 'test');
  assert.equal(d.coverage.unresolved, 1);
  assert.equal(d.cards[0].text_status, 'game_export');
  assert.throws(() => K.normalizeCatalog({ ...raw, cards: [raw.cards[0], raw.cards[0]] }, 'test'));
});
test('model cannot invent IDs, omit targets, or present playtested claims as status', () => {
  const d = K.normalizeCatalog(raw, 'test');
  const a = { id: 'A', role: '攻击', synergies: [{ with: 'B', reason: '示例前提' }], cautions: [], status: 'proven' };
  assert.equal(K.validateAnalysis({ cards: [a] }, [d.cards[0]], d)[0].status, 'hypothesis_not_playtested');
  assert.throws(() => K.validateAnalysis({ cards: [{ ...a, synergies: [{ with: 'invented', reason: '无' }] }] }, [d.cards[0]], d));
  assert.throws(() => K.validateAnalysis({ cards: [] }, [d.cards[0]], d));
});
test('OCR mismatch cannot overwrite game facts; plus variant matches separately', () => {
  const d = K.normalizeCatalog(raw, 'test');
  const observe = description => ({ parsed: { cards: [{ name: '测试攻击', cost: '1', description }] } });
  assert.equal(K.compareOcr(observe('造成8点伤害。'), d.cards)[0].status, 'name_matched_text_needs_review');
  assert.equal(K.compareOcr(observe('造成6点伤害。'), d.cards)[0].status, 'exact_text_and_cost');
  assert.equal(d.cards[0].base.description, '造成6点伤害。');
});
test('persistent retrieval survives module calls and returns current card descriptions', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sts2-knowledge-'));
  try {
    const file = path.join(dir, 'knowledge.json');
    K.write(K.normalizeCatalog(raw, 'test'), file);
    const r = K.retrieve({ hand: [{ id: 'A' }] }, { file });
    assert.equal(r.cards[0].base.cost, '1');
    assert.match(r.note, /未实战验证/);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
