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
    store.recordEvent('codex', 'SessionStart', 'chatgpt-desktop-codex'); store.recordEvent('codex', 'Stop', 'chatgpt-desktop-codex');
    store.recordEvent('claude', 'SessionStart'); store.recordEvent('claude', 'Stop');
    store.recordRequest('zcode', 'request-1', 'approval'); store.recordRequest('zcode', 'request-1', 'approval');
    store.recordRequest('codex', 'request-1', 'approval');
    assert.deepEqual(store.snapshot().totals, { events: 4, approvals: 2, questions: 0, completed: 2 });
    const reloaded = new UsageStore(file, { now: () => ++now }); reloaded.load();
    assert.equal(reloaded.snapshot().providers.codex.completed, 1);
    assert.equal(reloaded.snapshot().providers.claude.completed, 1);
    assert.equal(reloaded.snapshot().surfaces['chatgpt-desktop-codex'].completed, 1);
    assert.equal(JSON.stringify(reloaded.snapshot()).includes('request-1'), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('usage store migrates pre-Claude files by filling the new provider with zeroes', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-usage-migrate-'));
  const file = path.join(dir, 'usage.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  fs.writeFileSync(file, JSON.stringify({
    version: 1,
    since: 1234,
    totals: { events: 1, approvals: 0, questions: 0, completed: 0 },
    providers: {
      dsh: { events: 1, approvals: 0, questions: 0, completed: 0 },
      zcode: { events: 0, approvals: 0, questions: 0, completed: 0 },
      codex: { events: 0, approvals: 0, questions: 0, completed: 0 },
    },
  }) + '\n');
  const store = new UsageStore(file, { now: () => 9999 });
  store.load();
  assert.deepEqual(store.snapshot().providers.claude, { events: 0, approvals: 0, questions: 0, completed: 0 });
  assert.equal(store.snapshot().totals.events, 1);
});
