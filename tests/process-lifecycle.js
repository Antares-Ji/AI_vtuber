const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const { installProcessLifecycle } = require('../src/runtime/process-lifecycle');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vtuber-lifecycle-'));
const file = path.join(dir, 'lifecycle.jsonl');
const modulePath = require.resolve('../src/runtime/process-lifecycle');
const setup = `require(${JSON.stringify(modulePath)}).installProcessLifecycle({file:${JSON.stringify(file)}});`;
const rows = () => fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
try {
  assert.equal(spawnSync(process.execPath, ['-e', setup + 'process.exit(7)']).status, 7);
  assert.deepEqual(rows().map(r => r.event), ['start', 'exit']);
  assert.equal(rows()[1].code, 7);
  const previousLength = rows().length;
  const crashed = spawnSync(process.execPath, ['-e', setup + 'throw new TypeError("secret-test-prompt")']);
  assert.equal(crashed.status, 1, 'fatal exception still exits unsuccessfully');
  assert.equal(rows().length, previousLength + 3, 'append preserves previous instance');
  assert.equal(rows().at(-2).errorName, 'TypeError');
  assert.equal(rows().at(-1).code, 1);
  assert.equal(fs.readFileSync(file, 'utf8').includes('secret-test-prompt'), false);
  assert.match(crashed.stderr.toString(), /secret-test-prompt/, 'normal crash diagnostics not intercepted');
  assert.equal(spawnSync(process.execPath, ['-e', setup + 'Promise.reject(new Error("private-data"))']).status, 1);
  assert.equal(rows().at(-2).origin, 'unhandledRejection');

  const fake = new EventEmitter(); fake.pid = 1; fake.ppid = 2;
  const monitor = installProcessLifecycle({ file, processObject: fake });
  assert.equal(fake.listenerCount('uncaughtException'), 0);
  assert.equal(fake.listenerCount('unhandledRejection'), 0);
  monitor.ready(); monitor.shutdown('SIGTERM'); monitor.dispose();
  assert.equal(fake.listenerCount('uncaughtExceptionMonitor'), 0);
  assert.equal(fake.listenerCount('exit'), 0);
  assert.equal(rows().at(-1).signal, 'SIGTERM');

  if (process.platform === 'win32') {
    const psPath = path.join(dir, 'wrapper-test.ps1');
    const psLog = path.join(dir, 'wrapper.jsonl');
    const quote = value => "'" + value.replace(/'/g, "''") + "'";
    // Execute the exact native-wait/finally sequence without loading any model.
    const launcher = fs.readFileSync(path.join(__dirname, '../scripts/start-local-llm.ps1'), 'utf8');
    const fragment = launcher.slice(launcher.indexOf('$nativeExitCode = $null'))
      .replace('& $python -m uvicorn src.local_llm.server:app --host 127.0.0.1 --port 11435', '& $python -e "process.exit(17)"');
    fs.writeFileSync(psPath, `. ${quote(path.join(__dirname, '../scripts/lib/process-lifecycle.ps1'))}\n$lifecyclePath=${quote(psLog)}\n$lifecycleRunId='test-run'\n$python=${quote(process.execPath)}\n${fragment}`);
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', psPath]);
    assert.equal(result.status, 17, result.stderr.toString());
    const entries = fs.readFileSync(psLog, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
    assert.deepEqual(entries.map(r => r.event), ['native_start_requested', 'native_wait_finished']);
    assert.equal(entries[1].exitCode, 17);
    assert.equal(entries[1].runId, 'test-run');
  }
  console.log('process lifecycle: fatal semantics, append history, privacy, listener cleanup and native exit-code tests passed');
} finally {
  // Only this unique test-created directory is removed.
  fs.rmSync(dir, { recursive: true, force: true });
}
