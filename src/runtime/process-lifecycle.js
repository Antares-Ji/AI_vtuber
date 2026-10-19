const fs = require('node:fs');
const path = require('node:path');

// Diagnostic only: never install uncaughtException/unhandledRejection handlers,
// which would change Node's normal fatal-error behavior. Hard kills cannot emit exit.
function installProcessLifecycle({ file, processObject = process } = {}) {
  const startedAt = new Date().toISOString();
  const token = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,80}$/.test(value) ? value : null;
  function record(event, details = {}) {
    const entry = {
      at: new Date().toISOString(), event, pid: processObject.pid,
      parentPid: processObject.ppid, startedAt,
      ...details
    };
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.appendFileSync(file, `${JSON.stringify(entry)}\n`, 'utf8');
    } catch { /* Diagnostic I/O must not replace the original exception/exit. */ }
  }
  const fatal = (error, origin) => record('uncaught_exception', {
    origin: token(origin), errorName: token(error?.name), errorCode: token(error?.code)
    // Message/stack/argv/env intentionally omitted: may contain prompts or secrets.
  });
  const exited = code => record('exit', { code });
  processObject.on('uncaughtExceptionMonitor', fatal);
  processObject.on('exit', exited);
  record('start');
  return {
    ready: () => record('ready'),
    shutdown: signal => record('shutdown_requested', { signal: token(signal) }),
    dispose: () => {
      processObject.removeListener('uncaughtExceptionMonitor', fatal);
      processObject.removeListener('exit', exited);
    }
  };
}

module.exports = { installProcessLifecycle };
