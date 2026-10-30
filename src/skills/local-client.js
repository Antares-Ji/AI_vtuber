'use strict';
const { setTimeout: delay } = require('node:timers/promises');

function localClient(base, { fetchImpl = fetch, headers = {} } = {}) {
  const url = new URL(base);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:' ||
      url.username || url.password || url.search || url.hash) throw Error('Skill engines must use local HTTP');
  return async (route, data, signal) => {
    const response = await fetchImpl(new URL(route, url), { redirect: 'error',
      method: data === undefined ? 'GET' : 'POST', headers: { 'content-type': 'application/json', ...headers },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000) });
    if (!response.ok) { const error = Error(`Local engine HTTP ${response.status}`); error.status = response.status; throw error; }
    return response.json();
  };
}

// Start exactly once. An uncertain POST outcome is never replayed. Cancellation
// includes a stop request and a fresh idle acknowledgement before releasing the
// lease. Lost cleanup connectivity holds the lease until reconnection.
async function remoteRun({ request, routes, start, busy, failed, signal, pause = delay }) {
  const before = await request(routes.state, undefined, signal);
  if (busy(before)) throw Error('Engine is already running outside this skill');
  let attempted = false;
  try {
    signal.throwIfAborted(); attempted = true;
    try { await request(routes.start, start, signal); }
    catch (error) {
      // An explicit rejection owns no task; never stop somebody else's run.
      if ([400, 401, 403, 404, 409, 415, 422].includes(error.status)) attempted = false;
      throw error;
    }
    while (true) {
      signal.throwIfAborted();
      const state = await request(routes.state, undefined, signal);
      if (!busy(state)) {
        if (failed?.(state)) throw Error('Engine reported failure; inspect its local timeline');
        return { simulated: false, verified: false, engine: state,
          note: 'Engine became idle; this is not proof of victory or goal completion.' };
      }
      await pause(250, undefined, { signal });
    }
  } finally {
    if (attempted) {
      // Stop also on polling failure and an ambiguous start response. These are
      // control requests, not retries of game mutations.
      while (true) {
        try {
          await request(routes.stop, {});
          const state = await request(routes.state);
          if (!busy(state)) break;
        } catch { /* retain ownership until the engine acknowledges idle */ }
        await pause(500);
      }
    }
  }
}
module.exports = { localClient, remoteRun };
