'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { UsageStore } = require('../src/app/usage-store.cjs');

test('usage store keeps provider counters without session content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-usage-'));
  const file = path.join(dir, 'usage.json');
  try {
    let now = 1000; const store = new UsageStore(file, { now: () => now });
    store.recordEvent('codex', 'SessionStart'); store.recordEvent('codex', 'Stop');
    store.recordRequest('zcode', 'request-1', 'approval'); store.recordRequest('zcode', 'request-1', 'approval');
    store.recordRequest('codex', 'request-1', 'approval');
    assert.deepEqual(store.snapshot().totals, { events: 2, approvals: 2, questions: 0, completed: 1 });
    const reloaded = new UsageStore(file, { now: () => ++now }); reloaded.load();
    assert.equal(reloaded.snapshot().providers.codex.completed, 1);
    assert.equal(JSON.stringify(reloaded.snapshot()).includes('request-1'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
