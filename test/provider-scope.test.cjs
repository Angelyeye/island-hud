'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ACTIVE_PROVIDERS, PROVIDERS } = require('../src/integrations/contract');

test('product provider scope includes the supported agent integrations', () => {
  assert.deepEqual(ACTIVE_PROVIDERS, ['dsh', 'zcode', 'codex', 'claude', 'chatgpt']);
  for (const provider of ACTIVE_PROVIDERS) assert.equal(PROVIDERS.has(provider), true);
});

test('public settings surface exposes only the active provider set', () => {
  const settings = fs.readFileSync(path.join(__dirname, '../src/renderer/settings.html'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '../src/preload.js'), 'utf8');
  assert.match(settings, /Claude/i);
  assert.match(settings, /ChatGPT/i);
  assert.match(preload, /claude/i);
  assert.match(preload, /chatgpt/i);
});
