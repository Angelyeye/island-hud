'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { NdjsonDecoder, CodexAppServer } = require('../src/app/codex-app-server.cjs');

function fakeProcess() {
  const child = new EventEmitter();
  child.killed = false;
  child.stdin = { destroyed: false, writes: [], write(value) { this.writes.push(value); return true; } };
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.killed = true; child.emit('close', 0, null); };
  return child;
}

test('NDJSON decoder handles split UTF-8 messages and rejects oversized lines', () => {
  const decoder = new NdjsonDecoder({ maxLineBytes: 64 });
  assert.deepEqual(decoder.push('{"method":"thread/started","params":{"title":"'), []);
  assert.deepEqual(decoder.push('中文"}}\n'), [{ method: 'thread/started', params: { title: '中文' } }]);
  assert.throws(() => decoder.push('x'.repeat(65) + '\n'), /too large/);
});

test('NDJSON decoder preserves UTF-8 characters split across Buffer chunks', () => {
  const decoder = new NdjsonDecoder();
  const bytes = Buffer.from('{"text":"中文"}\n');
  const split = bytes.indexOf(0xe4);
  assert.deepEqual(decoder.push(bytes.subarray(0, split + 1)), []);
  assert.deepEqual(decoder.push(bytes.subarray(split + 1)), [{ text: '中文' }]);
});

test('app-server requests preserve JSON-RPC ids and resolve responses', async () => {
  const child = fakeProcess();
  const server = new CodexAppServer({ spawn: () => child, requestTimeoutMs: 1000 });
  assert.equal(server.start(), true);
  const pending = server.request('thread/list', { limit: 5 });
  const sent = JSON.parse(child.stdin.writes[0]);
  assert.equal(sent.jsonrpc, '2.0');
  assert.equal(sent.id, 1);
  assert.equal(sent.method, 'thread/list');
  child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: sent.id, result: { data: [] } }) + '\n');
  assert.deepEqual(await pending, { data: [] });
  server.stop();
});

test('server requests expose a responder that uses the original request id', () => {
  const child = fakeProcess();
  const server = new CodexAppServer({ spawn: () => child });
  server.start();
  let request;
  server.once('request', value => { request = value; value.respond({ decision: 'accept' }); });
  child.stdout.emit('data', JSON.stringify({ jsonrpc: '2.0', id: 77, method: 'item/commandExecution/requestApproval', params: { threadId: 'T1' } }) + '\n');
  assert.equal(request.id, 77);
  assert.equal(request.method, 'item/commandExecution/requestApproval');
  assert.deepEqual(JSON.parse(child.stdin.writes[0]), { jsonrpc: '2.0', id: 77, result: { decision: 'accept' } });
  server.stop();
});

test('closing the process rejects pending requests and clears the transport', async () => {
  const child = fakeProcess();
  const server = new CodexAppServer({ spawn: () => child, requestTimeoutMs: 1000 });
  server.start();
  const pending = server.request('thread/read');
  child.emit('close', 1, null);
  await assert.rejects(pending, /exited/);
  assert.equal(server.running, false);
});
