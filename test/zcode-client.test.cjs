'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { clientPath, openWorkspace } = require('../src/app/zcode-client.cjs');

const found = (p, keep) => p === keep;
const fakeSpawn = impl => {
  const calls = [];
  const fn = (exe, args, opts) => {
    calls.push({ exe, args, opts });
    return impl ? impl(exe, args, opts) : { on() {}, unref() {} };
  };
  fn.calls = calls;
  return fn;
};

test('windows discovery probes the per-user install before the machine-wide one', () => {
  const env = { LOCALAPPDATA: 'C:\\users\\u\\AppData\\Local', ProgramFiles: 'C:\\Program Files' };
  const probed = [];
  const picked = clientPath({ platform: 'win32', env, exists: p => { probed.push(p); return found(p, 'C:\\Program Files\\ZCode\\ZCode.exe'); } });
  assert.equal(picked, 'C:\\Program Files\\ZCode\\ZCode.exe');
  assert.deepEqual(probed, ['C:\\users\\u\\AppData\\Local\\Programs\\ZCode\\ZCode.exe', 'C:\\Program Files\\ZCode\\ZCode.exe']);
  assert.equal(clientPath({ platform: 'win32', env, exists: () => false }), null, 'nothing installed means no client');
  assert.equal(clientPath({ platform: 'linux', env: {}, exists: () => true }), null);
  assert.equal(clientPath({ platform: 'darwin', env: {}, exists: () => true }), '/usr/bin/open');
});

test('the client override is a test-only seam and must exist on disk', () => {
  const base = { platform: 'win32', exists: () => true };
  assert.equal(clientPath({ ...base, env: { ISLAND_ZCODE_CLIENT: 'C:\\stub\\client.cmd' } }), null,
    'without ISLAND_HUD_TEST_ROOT the override is ignored');
  assert.equal(clientPath({ ...base, env: { ISLAND_HUD_TEST_ROOT: 'C:\\test', ISLAND_ZCODE_CLIENT: 'C:\\stub\\client.cmd' } }), 'C:\\stub\\client.cmd');
  assert.equal(clientPath({ platform: 'win32', env: { ISLAND_HUD_TEST_ROOT: 'C:\\test', ISLAND_ZCODE_CLIENT: 'C:\\missing\\client.exe' },
    exists: p => found(p, 'C:\\Program Files\\ZCode\\ZCode.exe') }), null,
  'a missing override stays null so tests never launch the real client');
  assert.equal(clientPath({ ...base, env: { ISLAND_HUD_TEST_ROOT: 'C:\\test', ISLAND_ZCODE_CLIENT: '   ', ProgramFiles: 'C:\\Program Files' } }), 'C:\\Program Files\\ZCode\\ZCode.exe',
    'a blank override is not an override');
});

test('openWorkspace detaches a launch that carries only the project directory', () => {
  const spawnFn = fakeSpawn();
  assert.equal(openWorkspace('C:\\Program Files\\ZCode\\ZCode.exe', 'C:\\work\\demo', { platform: 'win32', spawnFn }), true);
  assert.deepEqual(spawnFn.calls[0].args, ['C:\\work\\demo']);
  assert.equal(spawnFn.calls[0].opts.detached, true);
  assert.equal(spawnFn.calls[0].opts.stdio, 'ignore');
  assert.equal(spawnFn.calls[0].opts.windowsHide, true);
});

test('macOS goes through the workspace deep link and failures stay silent', () => {
  const spawnFn = fakeSpawn();
  assert.equal(openWorkspace('/usr/bin/open', 'C:\\work\\中文 目录', { platform: 'darwin', spawnFn }), true);
  assert.deepEqual(spawnFn.calls[0].args, ['zcode://workspace/open?path=' + encodeURIComponent('C:\\work\\中文 目录')]);
  const throwing = fakeSpawn(() => { throw new Error('boom'); });
  assert.equal(openWorkspace('exe', 'dir', { platform: 'win32', spawnFn: throwing }), false);
  const asyncError = fakeSpawn(() => ({ on(name, handler) { if (name === 'error') handler(new Error('late')); }, unref() {} }));
  assert.equal(openWorkspace('exe', 'dir', { platform: 'win32', spawnFn: asyncError }), true);
});
