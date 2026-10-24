'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDiagnosticOutput } = require('../src/logs/diagnostic-output.cjs');

function fakeStream() {
  const stream = new EventEmitter();
  stream.writable = true;
  stream.writableEnded = false;
  stream.destroyed = false;
  stream.writes = [];
  stream.write = line => { stream.writes.push(line); };
  return stream;
}

test('an asynchronous EPIPE disables stdout without throwing', async () => {
  const stream = fakeStream();
  const failures = [];
  const output = createDiagnosticOutput(stream, { onError: error => failures.push(error) });
  assert.equal(output.write('first\n'), true);
  const brokenPipe = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });
  await new Promise(resolve => setImmediate(() => { stream.emit('error', brokenPipe); resolve(); }));
  assert.deepEqual(failures, [brokenPipe]);
  assert.equal(output.available, false);
  assert.equal(output.write('second\n'), false);
  assert.deepEqual(stream.writes, ['first\n']);
  output.dispose();
});

test('a synchronous write failure switches to fallback output and reports once', () => {
  const stream = fakeStream();
  const failures = [];
  stream.write = () => { throw new Error('closed'); };
  const output = createDiagnosticOutput(stream, { onError: error => failures.push(error) });
  assert.equal(output.write('first\n'), false);
  assert.equal(output.write('second\n'), false);
  assert.equal(failures.length, 1);
  assert.equal(output.available, false);
  output.dispose();
});

test('missing, ended, and unwritable streams never throw', () => {
  const noStream = createDiagnosticOutput(null);
  assert.equal(noStream.write('ignored\n'), false);
  noStream.dispose();

  for (const mutate of [
    stream => { stream.writable = false; },
    stream => { stream.writableEnded = true; },
    stream => { stream.destroyed = true; },
  ]) {
    const stream = fakeStream();
    mutate(stream);
    const failures = [];
    const output = createDiagnosticOutput(stream, { onError: error => failures.push(error) });
    assert.equal(output.write('ignored\n'), false);
    assert.equal(failures.length, 1);
    assert.deepEqual(stream.writes, []);
    output.dispose();
  }
});

test('a real closed stdout pipe is absorbed and the process stays alive', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-epipe-'));
  const report = path.join(root, 'report.log');
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const child = spawn(process.execPath, [path.join(__dirname, 'fixtures/diagnostic-output-child.cjs')], {
    env: { ...process.env, ISLAND_EPIPE_REPORT: report },
    stdio: ['ignore', 'pipe', 'ignore'],
    windowsHide: true,
  });
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child never announced stdout readiness')), 5000);
      child.stdout.on('data', chunk => {
        if (!String(chunk).includes('READY')) return;
        clearTimeout(timer);
        child.stdout.destroy();
        resolve();
      });
      child.once('exit', code => {
        clearTimeout(timer);
        reject(new Error(`child exited before the pipe closed: ${code}`));
      });
    });
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('child did not exit after writing to the closed pipe')), 8000);
      child.once('exit', exitCode => { clearTimeout(timer); resolve(exitCode); });
    });
    assert.equal(code, 0);
    assert.match(fs.readFileSync(report, 'utf8'), /EPIPE/);
  } finally {
    if (child.exitCode === null) child.kill();
  }
});
