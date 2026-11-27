'use strict';
// Single-driver lease for the bot's actor.
//
// A step that is abandoned by withTimeout keeps running: its awaits never cancel, so the orphan
// goes on calling goto/dig/placeBlock and cancels whatever the NEXT step is trying to do (the
// "chop err: The goal was changed before it could be completed!" + pillar-placement spam at
// 2026-10-29 09:47 was two drivers fighting over one bot). `bot._stepDeadline` cannot express
// this: it is global, so an orphan simply reads the fresh deadline of the live step and keeps
// moving.
//
// The lease is per-async-context instead: the planner enters it when a step starts, bumping a
// generation counter, and every move call checks whether its own context still matches the
// current generation. Old contexts become stale on their own, with no bookkeeping per skill.
//
// Fail-open by design: code that runs outside any lease (chat replies, the assist helpers, the
// wet-escape branch) has no store and is always allowed, so a missing `run()` wrapper can never
// freeze the bot.
const { AsyncLocalStorage } = require('async_hooks');
const log = require('./log');

const als = new AsyncLocalStorage();
let gen = 0;
const seen = {};

// Start a lease and run `fn` inside it. Returns whatever fn returns (await it).
function run(fn) {
  gen += 1;
  return als.run({ gen }, fn);
}

function generation() { return gen; }

// True when we are inside a lease that is no longer the live one.
function stale() {
  const s = als.getStore();
  return !!s && s.gen !== gen;
}

// Throttled attribution so the spam of a hundred refused gotos does not drown the log.
function note(what) {
  seen[what] = (seen[what] || 0) + 1;
  if (seen[what] <= 3) log.warn(`orphan lease: ${what} refused (x${seen[what]}) - that step was already abandoned`);
  if (seen[what] === 200) log.warn(`orphan lease: ${what} has been refused ${seen[what]} times - the abandoned worker is still looping`);
  return seen[what];
}

// Bind `bot._stepDeadline` to the lease so an abandoned worker cannot read the NEXT step's clock.
//
// Every long skill loop ends on `Date.now() < (bot._stepDeadline || Infinity)` - 26 of them. The plain
// property cannot tell who is reading, so a worker whose step was abandoned by withTimeout picks up the
// fresh deadline the live step armed and keeps looping. Measured 03:03:38 -> 03:04:31 on 2026-11-01: an
// orphaned make_obsidian re-dug the same cell every 14 s, every dig/equip/goto refused by the lease
// below, and it only stopped when the field ran out - the hand was taken away but the loop was not.
//
// Fail-open, deliberately: a call carrying no store (chat replies, the assist helpers, the wet-escape
// branch, the wedge timer) is not an orphan, so it reads and writes the real number. Only a context
// positively known to be stale is cut off, and a defineProperty that cannot install leaves the plain
// property and the old behaviour in place rather than freezing the bot.
function bindDeadline(bot) {
  let deadline = 0;
  try {
    Object.defineProperty(bot, '_stepDeadline', {
      configurable: true,
      get() { return stale() ? 1 : deadline; },
      set(v) { if (!stale()) deadline = v; },
    });
    return true;
  } catch (e) {
    log.warn(`stepLease: could not bind _stepDeadline to the lease (${e.message}) - orphaned loops fall back to the global deadline`);
    return false;
  }
}

// Rejection for a refused call. The catch is attached to a *derived* promise so a fire-and-forget
// caller (no await, no .catch) cannot raise an unhandledRejection, while an awaiter still sees it.
function refuse(name) {
  const s = als.getStore();
  note(`${name} from gen ${s ? s.gen : '?'} (live gen ${gen})`);
  const p = Promise.reject(new Error(`orphan step: ${name} refused - the hand belongs to the live step`));
  p.catch(() => {});
  return p;
}

module.exports = { run, stale, note, refuse, generation, bindDeadline };
