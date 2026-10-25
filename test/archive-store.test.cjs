'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { ArchiveStore, canArchive, shouldHide, keyOf, MAX_ENTRIES, TTL_MS, VERSION } = require('../src/app/archive-store.cjs');

function fixture(t, options = {}) {
  const parent = path.resolve(__dirname, '../work/test-data'); fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'archive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'archived-sessions.json');
  return { root, file, store: new ArchiveStore(file, { now: options.now || Date.now, log: options.log || (() => {}) }) };
}

test('archive entries persist, dedupe, remove and clear without touching provider data', t => {
  const { file, store } = fixture(t);
  const added = store.add({ provider: 'dsh', rawId: 'session-1', title: '升级支付网关', project: 'vizcap2' });
  assert.equal(added.ok, true); assert.equal(added.entry.key, keyOf('dsh', 'session-1'));
  store.add({ provider: 'dsh', rawId: 'session-1', title: '改名后仍去重' });
  store.add({ provider: 'dsh', rawId: 'session-2', title: '另一会话' });
  assert.equal(store.list().length, 2);
  assert.equal(store.has(keyOf('dsh', 'session-1')), true);
  const reloaded = new ArchiveStore(file); reloaded.load();
  assert.equal(reloaded.list().length, 2);
  assert.equal(reloaded.get(keyOf('dsh', 'session-1')).title, '改名后仍去重');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, VERSION);
  assert.equal(reloaded.remove(keyOf('dsh', 'session-2')).ok, true);
  assert.equal(reloaded.has(keyOf('dsh', 'session-2')), false);
  const cleared = reloaded.clear(); assert.equal(cleared.ok, true); assert.equal(cleared.removed, 1);
  assert.equal(reloaded.list().length, 0);
  assert.deepEqual(new ArchiveStore(file).load(), []);
});

test('invalid persisted entries are ignored while valid ones are kept', t => {
  const { file, store } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ v: VERSION, entries: [
    { key: keyOf('dsh', 'ok'), provider: 'dsh', rawId: 'ok', title: 'ok', archivedAt: Date.now() },
    { key: keyOf('dsh', 'mismatch'), provider: 'dsh', rawId: 'other', archivedAt: Date.now() },
    { key: '["gemini","x"]', provider: 'gemini', rawId: 'x', archivedAt: Date.now() },
    { key: keyOf('dsh', 'bad-time'), provider: 'dsh', rawId: 'bad-time', archivedAt: 'soon' },
    { key: '', provider: 'dsh', rawId: '', archivedAt: Date.now() },
  ] }));
  const loaded = store.load();
  assert.equal(loaded.length, 1);
  assert.equal(loaded[0].rawId, 'ok');
});

test('the archive is bounded by count and by a thirty day lifetime', t => {
  const now = 1_900_000_000_000;
  const { file } = fixture(t, { now });
  const store = new ArchiveStore(file, { now });
  for (let i = 0; i < MAX_ENTRIES + 25; i++) {
    const hiddenAt = now - TTL_MS + (i * 1000);
    store.entries.set(keyOf('dsh', 'S' + i), { key: keyOf('dsh', 'S' + i), provider: 'dsh', rawId: 'S' + i, kind: 'archived', title: '', project: '', hiddenAt });
  }
  assert.ok(store.entries.size > MAX_ENTRIES);
  store.trim();
  assert.equal(store.list('archived', 9999).length, MAX_ENTRIES);
  assert.equal(store.has(keyOf('dsh', 'S0')), false);
  store.entries.set(keyOf('dsh', 'too-old'), { key: keyOf('dsh', 'too-old'), provider: 'dsh', rawId: 'too-old', kind: 'archived', title: '', project: '', hiddenAt: now - TTL_MS - 1 });
  assert.equal(store.prune(), 1);
  assert.equal(store.has(keyOf('dsh', 'too-old')), false);
});

test('an unreadable archive file is preserved as a backup instead of blocking startup', t => {
  const { file, root } = fixture(t);
  fs.writeFileSync(file, 'this is not json');
  const logs = [];
  const store = new ArchiveStore(file, { now: () => 42, log: message => logs.push(message) });
  assert.deepEqual(store.load(), []);
  const backups = fs.readdirSync(root).filter(name => name.startsWith('archived-sessions.json.bad-'));
  assert.equal(backups.length, 1);
  assert.match(logs[0], /unreadable/i);
  assert.equal(store.add({ provider: 'dsh', rawId: 'after-recovery' }).ok, true);
});

test('archive writes are atomic with no temporary leftovers', t => {
  const { file, root, store } = fixture(t);
  assert.equal(store.add({ provider: 'dsh', rawId: 'atomic' }).ok, true);
  assert.deepEqual(fs.readdirSync(root), ['archived-sessions.json']);
  assert.equal(fs.readFileSync(file, 'utf8').includes('"atomic"'), true);
});

test('a storage failure is reported and rolled back instead of pretending success', t => {
  const { root } = fixture(t);
  const blocker = path.join(root, 'blocked'); fs.writeFileSync(blocker, 'not a directory');
  const store = new ArchiveStore(path.join(blocker, 'archived-sessions.json'));
  const result = store.add({ provider: 'dsh', rawId: 'wont-persist' });
  assert.deepEqual(result, { ok: false, reason: 'storage' });
  assert.equal(store.has(keyOf('dsh', 'wont-persist')), false);
});

test('only idle or completed sessions without pending requests can be archived', () => {
  for (const phase of ['idle', 'completed']) assert.equal(canArchive({ phase }), true);
  for (const phase of ['running', 'waitingForApproval', 'waitingForAnswer']) assert.equal(canArchive({ phase }), false);
  assert.equal(canArchive({ phase: 'completed', pendingRequests: ['request'] }), false);
  assert.equal(canArchive(null), false);
});

test('archived sessions hide only while they are inactive', () => {
  const archived = new Set([keyOf('dsh', 'session-1')]);
  assert.equal(shouldHide({ id: keyOf('dsh', 'session-1'), phase: 'completed' }, archived), true);
  assert.equal(shouldHide({ id: keyOf('dsh', 'session-1'), phase: 'idle' }, archived), true);
  assert.equal(shouldHide({ id: keyOf('dsh', 'session-1'), phase: 'running' }, archived), false);
  assert.equal(shouldHide({ id: keyOf('dsh', 'session-1'), phase: 'waitingForApproval' }, archived), false);
  assert.equal(shouldHide({ id: keyOf('dsh', 'session-1'), phase: 'idle', pendingRequests: ['r'] }, archived), false);
  assert.equal(shouldHide({ id: keyOf('dsh', 'session-2'), phase: 'idle' }, archived), false);
});

test('listing is newest-first and bounded for the settings surface', t => {
  const { file } = fixture(t);
  const now = 1_800_000_000_000;
  let tick = 0;
  const store = new ArchiveStore(file, { now: () => now + (++tick) });
  for (let i = 0; i < 205; i++) store.add({ provider: 'dsh', rawId: 'R' + i });
  const entries = store.list(20);
  assert.equal(entries.length, 20);
  assert.equal(entries[0].rawId, 'R204');
  assert.equal(store.list(-5).length, 0);
});

test('archived and deleted sessions are separate local hides', t => {
  const { file, store } = fixture(t);
  store.add({ provider: 'dsh', rawId: 'keep-archived', kind: 'archived' });
  store.add({ provider: 'dsh', rawId: 'drop-deleted', kind: 'deleted' });
  assert.equal(store.count('archived'), 1);
  assert.equal(store.count('deleted'), 1);
  assert.equal(store.count(), 2);
  assert.deepEqual([...store.keys('deleted')], [keyOf('dsh', 'drop-deleted')]);
  assert.equal(store.list('deleted').length, 1);
  assert.equal(store.has(keyOf('dsh', 'keep-archived')), true);
  const cleared = store.clear('archived');
  assert.equal(cleared.removed, 1);
  assert.equal(store.has(keyOf('dsh', 'keep-archived')), false);
  assert.equal(store.has(keyOf('dsh', 'drop-deleted')), true);
  const reloaded = new ArchiveStore(file); reloaded.load();
  assert.equal(reloaded.count('deleted'), 1);
  assert.equal(reloaded.list('deleted')[0].rawId, 'drop-deleted');
  assert.equal(reloaded.add({ provider: 'dsh', rawId: 'legacy-default' }).entry.kind, 'archived');
  assert.equal(reloaded.add({ provider: 'dsh', rawId: 'bad-kind', kind: 'trashed' }).ok, false);
});

test('legacy version-one archive files migrate to the archived kind', t => {
  const { file } = fixture(t);
  fs.writeFileSync(file, JSON.stringify({ v: 1, entries: [
    { key: keyOf('dsh', 'legacy'), provider: 'dsh', rawId: 'legacy', title: '旧归档', archivedAt: 1_700_000_000_000 },
  ] }));
  const store = new ArchiveStore(file, { now: () => 1_700_000_000_500 }); store.load();
  assert.equal(store.count('archived'), 1);
  assert.equal(store.count('deleted'), 0);
  assert.equal(store.list('archived')[0].hiddenAt, 1_700_000_000_000);
  // The file is upgraded to version two only on the next write; reading v1 stays safe.
  assert.equal(store.add({ provider: 'dsh', rawId: 'writer' }).ok, true);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).v, VERSION);
});
