'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { parseFlags } = require('../tools/electron-flags.cjs');

test('no extra Electron flags are passed unless the environment asks for them', () => {
  assert.deepEqual(parseFlags(undefined), []);
  assert.deepEqual(parseFlags(''), []);
  assert.deepEqual(parseFlags('   '), []);
});

test('extra Electron flags are split on whitespace and keep their order', () => {
  assert.deepEqual(parseFlags('--no-sandbox'), ['--no-sandbox']);
  assert.deepEqual(parseFlags('  --no-sandbox   --disable-gpu '), ['--no-sandbox', '--disable-gpu']);
});
