'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { zstdCompressSync } = require('node:zlib');
const { JsonlDecoder, JsonlTail, frameLength } = require('../src/logs/jsonl-tail.cjs');
const { DshBridge, PHASE } = require('../src/dsh/dshBridge');
const encode = rows => zstdCompressSync(Buffer.from(rows.map(row => JSON.stringify(row)).join('\n') + '\n'));
function fixture(t) {
  const parent = path.resolve(__dirname, '../work/test-data');
  fs.mkdirSync(parent, { recursive: true });
  const root = fs.mkdtempSync(path.join(parent, 'monitor-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
function session(t, records = []) {
  const root = fixture(t), file = path.join(root, 'workspace', 'session-1', 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let now = Date.now();
  fs.writeFileSync(file, encode([{ type: 'session', cwd: path.join(root, '中文 项目'), createdAt: now }, ...records.map(row => ({ time: now, ...row }))]));
  const bridge = new DshBridge({ sessionsRoot: root, now: () => now });
  return { bridge, file, advance: ms => { now += ms; }, now: () => now };
}
// A multi-frame transcript larger than the startup header+tail window. The
// unresolved approval sits in the middle, outside both bounds.
function largeSession(root, id, turn, now = Date.now()) {
  const file = path.join(root, 'workspace-' + id, id, 'session.v4.jsonl.zstd');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const chunks = [encode([{ type: 'session', cwd: path.join(root, 'workspace-' + id, 'project'), createdAt: now },
    { type: 'session/title', data: { title: 'header-' + id } }])];
  const fill = base => encode(Array.from({ length: 10 }, (_, i) => ({ type: 'assistant/message', time: base + i,
    data: { content: [{ type: 'text', text: randomUUID() + randomUUID() }] } })));
  for (let i = 0; i < 60; i++) chunks.push(fill(now + i * 10));
  chunks.push(encode([{ type: 'approval/asked', time: now + 500, data: { id: 'old-' + id } }]));
  for (let i = 60; i < 360; i++) chunks.push(fill(now + i * 10));
  chunks.push(encode([{ type: 'turn/start', time: now + 1000, data: { turn } },
    { type: 'tool/call', time: now + 1001, data: { callId: 'tail-call', name: 'bash', arguments: '{"command":"echo tail"}' } }]));
  fs.writeFileSync(file, Buffer.concat(chunks));
  return { file, size: fs.statSync(file).size, now };
}

test('partial compressed frame and partial JSON/UTF-8 across frames remain uncommitted until complete', () => {
  const decoder = new JsonlDecoder({ compressed: true });
  const text = Buffer.from(JSON.stringify({ type: 'record', value: '中文' }) + '\n');
  const cut = text.indexOf(Buffer.from('中文')) + 1;
  const first = zstdCompressSync(text.subarray(0, cut)), last = zstdCompressSync(text.subarray(cut));
  assert.deepEqual(decoder.push(first.subarray(0, first.length - 1)), []);
  assert.deepEqual(decoder.push(first.subarray(-1)), []);
  assert.deepEqual(decoder.push(last), [{ type: 'record', value: '中文' }]);
  assert.deepEqual(decoder.push(Buffer.alloc(0)), []);
});
test('zstd magic inside a raw block does not split the frame', () => {
  const body = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 1, 2]);
  const header = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, body.length]);
  const block = Buffer.alloc(3); block.writeUIntLE((body.length << 3) | 1, 0, 3);
  const bytes = Buffer.concat([header, block, body]);
  assert.equal(frameLength(bytes), bytes.length);
  assert.equal(frameLength(bytes.subarray(0, bytes.length - 1)), null);
});
test('skippable frames and damaged JSON records do not lose the next complete record', () => {
  const skip = Buffer.alloc(11); skip.writeUInt32LE(0x184d2a50); skip.writeUInt32LE(3, 4);
  const decoder = new JsonlDecoder({ compressed: true });
  assert.deepEqual(decoder.push(Buffer.concat([skip, zstdCompressSync(Buffer.from('broken\n{"type":"ok"}\n'))])), [{ type: 'ok' }]);
  assert.equal(decoder.errors, 1);
});
test('plain JSONL tail handles half lines and a bounded read budget', t => {
  const file = path.join(fixture(t), 'session.jsonl');
  fs.writeFileSync(file, '{"type":');
  const tail = new JsonlTail(file, { maxReadBytes: 5 });
  assert.deepEqual(tail.poll(), []); assert.deepEqual(tail.poll(), []);
  fs.appendFileSync(file, '"ok"}\n');
  const output = []; while (!tail.caughtUp || tail.offset < fs.statSync(file).size) output.push(...tail.poll());
  assert.deepEqual(output, [{ type: 'ok' }]);
});
test('tail restarts on truncation, replacement and same-size rewrite with no duplicate records', t => {
  const file = path.join(fixture(t), 'session.zstd');
  fs.writeFileSync(file, encode([{ type: 'long-first-record', n: 1 }]));
  const tail = new JsonlTail(file, { compressed: true });
  assert.equal(tail.poll()[0].n, 1); assert.deepEqual(tail.poll(), []);
  fs.writeFileSync(file, encode([{ type: 'x', n: 2 }]));
  assert.equal(tail.poll()[0].n, 2); assert.equal(tail.resetReason, 'truncated');
  fs.writeFileSync(file, encode([{ type: 'x', n: 3 }]));
  assert.equal(tail.poll()[0].n, 3); assert.equal(tail.resetReason, 'rewritten');
  const replacement = file + '.replacement'; fs.writeFileSync(replacement, encode([{ type: 'x', n: 4 }]));
  fs.renameSync(replacement, file);
  assert.equal(tail.poll()[0].n, 4); assert.equal(tail.resetReason, 'replaced');
  assert.deepEqual(tail.poll(), []);
});
test('silent polling changes running to idle once and expires the visible list without new records', t => {
  const f = session(t, [{ type: 'turn/start' }]);
  let updates = 0; f.bridge.on('update', () => updates++);
  f.bridge.tick(); assert.equal(f.bridge.snapshot()[0].phase, PHASE.RUNNING);
  f.advance(181000); f.bridge.tick(); assert.equal(f.bridge.snapshot()[0].phase, PHASE.IDLE);
  assert.equal(updates, 2); f.bridge.tick(); assert.equal(updates, 2);
  f.advance(31 * 60000); f.bridge.tick(); assert.deepEqual(f.bridge.snapshot(), []);
  assert.equal(f.bridge.tails.size, 0);
});
test('a real approval remains pending during silence and cannot be invented from a slow tool', t => {
  const f = session(t, [{ type: 'turn/start' }, { type: 'tool/call', data: { callId: 'c', name: 'bash', arguments: '{}' } }]);
  f.bridge.tick(); f.advance(31000); f.bridge.tick();
  assert.equal(f.bridge.snapshot()[0].phase, PHASE.RUNNING);
  assert.equal(f.bridge.snapshot()[0].needsAttention, true);
  fs.appendFileSync(f.file, encode([{ type: 'approval/asked', time: f.now(), data: { id: 'approval-1', callId: 'c', toolName: 'bash' } }]));
  f.bridge.tick(); f.advance(35 * 60000); f.bridge.tick();
  assert.equal(f.bridge.snapshot()[0].phase, PHASE.WAITING_APPROVAL);
  assert.equal(f.bridge.snapshot()[0].actionable, false);
  assert.equal(f.bridge.snapshot()[0].pendingApprovals.length, 1);
  fs.appendFileSync(f.file, encode([{ type: 'approval/decided', time: f.now(), data: { id: 'approval-1', outcome: 'rejected' } }]));
  f.bridge.tick(); assert.equal(f.bridge.snapshot()[0].phase, PHASE.RUNNING);
});
test('one tool result cannot clear another blocking question; continued questions do not pause the session', t => {
  const f = session(t, [{ type: 'turn/start' },
    { type: 'tool/call', data: { callId: 'q1', name: 'ask_user_question', arguments: JSON.stringify({ questions: [{ id: 'Q', question: 'Question?' }] }) } },
    { type: 'tool/call', data: { callId: 'work', name: 'read', arguments: '{}' } },
    { type: 'tool/result', data: { message: { toolCallId: 'work', content: [{ type: 'text', text: 'ok' }] } } }]);
  f.bridge.tick(); assert.equal(f.bridge.snapshot()[0].phase, PHASE.WAITING_ANSWER);
  fs.appendFileSync(f.file, encode([{ type: 'tool/result', time: f.now(), data: { message: { toolCallId: 'q1', content: [{ type: 'text', text: '{"pending":true,"callId":"q1"}' }] } } }]));
  f.bridge.tick(); assert.equal(f.bridge.snapshot()[0].phase, PHASE.RUNNING);
  assert.equal(f.bridge.snapshot()[0].pendingQuestion.blocking, false);
});
test('replaced transcript removes old title and pending approval state', t => {
  const f = session(t, [{ type: 'session/title', data: { title: 'old-title' } }, { type: 'approval/asked', data: { id: 'old' } }]);
  f.bridge.tick(); assert.equal(f.bridge.snapshot()[0].phase, PHASE.WAITING_APPROVAL);
  const replacement = f.file + '.new'; fs.writeFileSync(replacement, encode([{ type: 'session', createdAt: f.now(), cwd: 'fresh' }]));
  fs.renameSync(replacement, f.file); f.bridge.tick();
  assert.equal(f.bridge.snapshot()[0].pendingApprovals.length, 0);
  assert.notEqual(f.bridge.snapshot()[0].title, 'old-title');
});
test('large transcripts start from a bounded tail and recover current state without replaying history', t => {
  const root = fixture(t), large = largeSession(root, 'session-1', 9);
  assert.ok(large.size > 128 * 1024, 'fixture must exceed the startup header+tail window');
  const bridge = new DshBridge({ sessionsRoot: root, now: () => large.now + 3000 });
  bridge.tick();
  const tail = bridge.tails.get('session-1');
  assert.ok(tail.offset > 64 * 1024, 'tail must not start at the beginning of a large transcript');
  assert.equal(tail.offset, large.size);
  assert.ok(tail.lastReadBytes <= 64 * 1024, 'first tick must respect the byte budget');
  const state = bridge.snapshot()[0];
  assert.equal(state.phase, PHASE.RUNNING);
  assert.equal(state.turn, 9);
  assert.equal(state.currentTool?.name, 'bash');
  assert.equal(state.title, 'header-session-1');
  assert.equal(state.pendingApprovals.length, 0, 'an old middle approval must not be resurrected by the header/tail skip');
});
test('a tick spends at most the configured budget across multiple large sessions', t => {
  const root = fixture(t), first = largeSession(root, 'a', 1), second = largeSession(root, 'b', 2);
  const bridge = new DshBridge({ sessionsRoot: root, now: () => Math.max(first.now, second.now) + 3000,
    maxTickBytes: 32 * 1024, maxSessionBytes: 32 * 1024 });
  bridge.tick();
  const tails = [...bridge.tails.values()];
  assert.equal(tails.length, 2);
  assert.ok(tails.reduce((sum, tail) => sum + tail.lastReadBytes, 0) <= 32 * 1024);
  assert.ok(tails.some(tail => tail.lastReadBytes > 0));
  for (let i = 0; i < 8 && tails.some(tail => !tail.caughtUp); i++) bridge.tick();
  assert.ok(tails.every(tail => tail.caughtUp));
  assert.equal(bridge.snapshot().length, 2);
});
