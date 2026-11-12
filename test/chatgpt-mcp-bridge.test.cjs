'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { ERROR_CODES, ChatGptMcpBridge } = require('../src/app/chatgpt-mcp-bridge.cjs');

test('MCP initialize and tools/list expose the ChatGPT bridge contract', async () => {
  const bridge = new ChatGptMcpBridge({ configured: true, authenticated: true });
  const initialized = await bridge.handleRpc({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } });
  assert.equal(initialized.result.serverInfo.name, 'island-hud-chatgpt-bridge');
  const listed = await bridge.handleRpc({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
  assert.deepEqual(listed.result.tools.map(tool => tool.name), [
    'island_session_start', 'island_session_update', 'island_request_approval', 'island_request_question',
    'island_session_complete', 'island_session_cancel', 'island_open', 'island_health',
  ]);
});

test('session lifecycle keeps Chat and Work surfaces separate', async () => {
  const bridge = new ChatGptMcpBridge({ now: (() => { let value = 1000; return () => ++value; })() });
  const chat = await bridge.callTool('island_session_start', { conversationId: 'C1', mode: 'chat', title: 'Chat task' });
  const work = await bridge.callTool('island_session_start', { conversationId: 'W1', mode: 'work', title: 'Work task' });
  assert.equal(chat.provider, 'chatgpt'); assert.equal(chat.surface, 'chat');
  assert.equal(work.provider, 'chatgpt'); assert.equal(work.surface, 'work');
  await bridge.callTool('island_session_update', { sessionId: chat.sessionId, phase: 'running', summary: 'working' });
  const completed = await bridge.callTool('island_session_complete', { sessionId: work.sessionId, summary: 'done' });
  assert.equal(completed.phase, 'completed');
  assert.equal(bridge.snapshot().length, 2);
});

test('approval and question requests block through callbacks and return structured decisions', async () => {
  const calls = [];
  const bridge = new ChatGptMcpBridge({
    requestApproval: async context => { calls.push(['approval', context.request.requestId]); return { decision: 'allow' }; },
    requestQuestion: async context => { calls.push(['question', context.request.requestId]); return { decision: 'answer', answers: [{ id: 'choice', selected: ['A'] }] }; },
  });
  const session = await bridge.callTool('island_session_start', { conversationId: 'C1', mode: 'chat' });
  const approval = await bridge.callTool('island_request_approval', { sessionId: session.sessionId, requestId: 'A1', tool: { name: 'command' } });
  const question = await bridge.callTool('island_request_question', { sessionId: session.sessionId, requestId: 'Q1', questions: [{ id: 'choice', question: 'Pick', options: [{ label: 'A' }] }] });
  assert.deepEqual(approval, { requestId: 'A1', decision: 'allow' });
  assert.deepEqual(question, { requestId: 'Q1', decision: 'answer', answers: [{ id: 'choice', selected: ['A'] }] });
  assert.deepEqual(calls, [['approval', 'A1'], ['question', 'Q1']]);
  assert.equal(bridge.health().pendingRequests, 0);
});

test('missing sessions and bridge callbacks return stable error codes', async () => {
  const bridge = new ChatGptMcpBridge();
  await assert.rejects(() => bridge.callTool('island_session_update', { sessionId: 'missing', phase: 'running' }), error => error.code === ERROR_CODES.SESSION_NOT_FOUND);
  const session = await bridge.callTool('island_session_start', { conversationId: 'C1', mode: 'chat' });
  await assert.rejects(() => bridge.callTool('island_request_approval', { sessionId: session.sessionId }), error => error.code === ERROR_CODES.BRIDGE_UNAVAILABLE);
  const rpc = await bridge.handleRpc({ jsonrpc: '2.0', id: 9, method: 'tools/call', params: { name: 'island_session_update', arguments: { sessionId: 'missing', phase: 'running' } } });
  assert.equal(rpc.result.isError, true);
  assert.match(rpc.result.content[0].text, /SESSION_NOT_FOUND/);
});

test('cancel releases pending requests and calls the cancellation hook', async () => {
  let release;
  const cancelled = [];
  const bridge = new ChatGptMcpBridge({
    requestApproval: () => new Promise(resolve => { release = resolve; }),
    cancelRequest: context => { cancelled.push(context.request.requestId); release?.({ decision: 'return' }); },
  });
  const session = await bridge.callTool('island_session_start', { conversationId: 'C1', mode: 'chat' });
  const pending = bridge.callTool('island_request_approval', { sessionId: session.sessionId, requestId: 'A1' });
  while (!release) await new Promise(resolve => setImmediate(resolve));
  await bridge.callTool('island_session_cancel', { sessionId: session.sessionId, reason: 'user-cancelled' });
  await pending;
  assert.deepEqual(cancelled, ['A1']);
  assert.equal(bridge.snapshot()[0].phase, 'idle');
  assert.equal(bridge.health().pendingRequests, 0);
});
