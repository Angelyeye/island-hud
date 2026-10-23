'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { zstdCompressSync } = require('node:zlib');
const { CompletionReader, LIMIT } = require('../src/app/completion-reader.cjs');
test('completion reads the exact completed turn and bounds cached text through replacement', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vi-complete-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.zstd'), reader = new CompletionReader();
  function save(text) { fs.writeFileSync(file, zstdCompressSync(Buffer.from([
    { type: 'turn/start', data: { turn: 1 } }, { type: 'assistant/message', data: { content: [{ type: 'text', text: 'other-turn' }] } }, { type: 'turn/end', data: { turn: 1 } },
    { type: 'turn/start', data: { turn: 2 } }, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text }] } } }, { type: 'turn/end', data: { turn: 2 } },
  ].map(r => JSON.stringify(r)).join('\n') + '\n'))); }
  save('中文完整回复'); assert.equal((await reader.read({ file, sessionKey: 'S', turn: 2 })).text, '中文完整回复');
  assert.equal((await reader.read({ file, sessionKey: 'S', turn: 1 })).text, 'other-turn');
  save('中'.repeat(400000)); const result = await reader.read({ file, sessionKey: 'S', turn: 2 });
  assert.equal(result.truncated, true); assert.ok(Buffer.byteLength(result.text) <= LIMIT); assert.doesNotMatch(result.text, /�/);
  for (let i = 0; i < 7; i++) await reader.read({ file, sessionKey: 'S' + i, turn: 2 });
  assert.ok(reader.cache.size <= 4); assert.ok(reader.bytes <= 2 * LIMIT); reader.clear(); assert.equal(reader.bytes, 0);
});
