'use strict';
// Persistent notes + run state. Decisions/lessons are written as artifacts so they survive
// restarts and so the LLM does not need to be re-prompted for the same thing (cost discipline).
const fs = require('fs');
const path = require('path');
const cfg = require('../config');

function ensure() {
  try { fs.mkdirSync(cfg.paths.runs, { recursive: true }); } catch {}
  if (!fs.existsSync(cfg.paths.notes)) fs.writeFileSync(cfg.paths.notes, '# Bot long-term notes\n', 'utf8');
}

function appendLesson(text) {
  ensure();
  const stamp = new Date().toISOString().slice(0, 19);
  fs.appendFileSync(cfg.paths.notes, `\n- [${stamp}] ${text}`, 'utf8');
}

function recentNotes(max = 1200) {
  ensure();
  const s = fs.readFileSync(cfg.paths.notes, 'utf8');
  return s.slice(-max);
}

function loadState() {
  ensure();
  try { return JSON.parse(fs.readFileSync(cfg.paths.state, 'utf8')); } catch { return {}; }
}

function saveState(obj) {
  ensure();
  fs.writeFileSync(cfg.paths.state, JSON.stringify(obj, null, 2), 'utf8');
}

module.exports = { appendLesson, recentNotes, loadState, saveState, ensure };
