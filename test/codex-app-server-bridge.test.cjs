'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { eventForNotification, approvalForRequest, CodexAppServerBridge } = require('../src/app/codex-app-server-bridge.cjs');

test('app-server lifecycle notifications map to Codex session events', () => {
  const started = eventForNotification({ method: 'thread/started', params: { threadId: 'T1', cwd: 'C:\\work\\demo', title: 'Demo', startedAtMs: 321 } }, () => 100);
  assert.deepEqual(started, { provider: 'codex', sessionId: 'T1', at: 321, payload: { event: 'SessionStart', cwd: 'C:\\work\\demo', title: 'Demo' } });
  assert.equal(eventForNotification({ method: 'turn/aborted', params: { threadId: 'T1' } }, () => 100).payload.event, 'Interrupt');
  assert.equal(eventForNotification({ method: 'item/completed', params: { threadId: 'T1', itemId: 'I1' } }, () => 100).payload.callId, 'I1');
  assert.equal(eventForNotification({ method: 'turn/completed', params: { threadId: 'T1', turnNumber: 3, completedAtMs: 400 } }, () => 100).payload.turn, 3);
});

test('approval requests keep the original JSON-RPC id in bridge metadata', () => {
  const approval = approvalForRequest({ id: 42, method: 'item/commandExecution/requestApproval', params: {
    threadId: 'T1', itemId: 'I1', command: 'npm test', cwd: 'C:\\work\\demo', reason: 'Run tests', availableDecisions: ['accept', 'decline'],
  } }, () => 200);
  assert.equal(approval.requestId, 'codex-app-server:42');
  assert.equal(approval.sessionId, 'T1');
  assert.equal(approval.payload.tool.detail, 'npm test');
  assert.equal(approval.payload.appServer.rpcId, 42);
});

test('bridge forwards supported events and rejects unsupported server requests', () => {
  const server = new EventEmitter();
  const events = [], responses = [];
  const bridge = new CodexAppServerBridge({ server, onEvent: event => events.push(event) });
  bridge.start();
  server.emit('notification', { method: 'thread/started', params: { threadId: 'T1' } });
  server.emit('notification', { method: 'thread/started', params: { threadId: 'T1' } });
  server.emit('notification', { method: 'turn/started', params: { threadId: 'T1', input: 'first' } });
  server.emit('notification', { method: 'turn/started', params: { threadId: 'T1', input: 'second' } });
  server.emit('close', { code: 1 });
  server.emit('notification', { method: 'thread/started', params: { threadId: 'T1' } });
  server.emit('request', { id: 9, method: 'unknown/request', params: {}, respond: (...args) => responses.push(args) });
  assert.equal(events.length, 4);
  assert.deepEqual(responses[0][1], { code: -32601, message: 'Unsupported Codex app-server request' });
  bridge.stop();
});
