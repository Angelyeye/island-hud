'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { ChatGptMcpBridge, ChatGptMcpHttpServer } = require('../src/app/chatgpt-mcp-bridge.cjs');

function request(url, { method = 'POST', token, body } = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({ hostname: parsed.hostname, port: parsed.port, path: parsed.pathname, method,
      headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) } }, response => {
      const chunks = []; response.on('data', chunk => chunks.push(chunk));
      response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (body !== undefined) req.end(JSON.stringify(body)); else req.end();
  });
}

test('MCP HTTP server binds loopback, protects requests with bearer auth, and forwards JSON-RPC', async t => {
  const bridge = new ChatGptMcpBridge();
  const server = new ChatGptMcpHttpServer({ bridge, token: 'test-token' });
  t.after(() => server.stop());
  const status = await server.start();
  assert.equal(status.host, '127.0.0.1'); assert.equal(status.running, true); assert.equal(status.token, 'test-token');
  const unauthorized = await request(status.endpoint, { body: { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} } });
  assert.equal(unauthorized.status, 401);
  const authorized = await request(status.endpoint, { token: status.token, body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} } });
  assert.equal(authorized.status, 200);
  assert.equal(JSON.parse(authorized.body).result.tools.length, 8);
});

test('MCP HTTP server handles method routing and exposes lifecycle status', async t => {
  const server = new ChatGptMcpHttpServer({ bridge: new ChatGptMcpBridge(), token: 't' });
  t.after(() => server.stop());
  const started = await server.start();
  const method = await request(started.endpoint, { method: 'GET', token: started.token });
  assert.equal(method.status, 405);
  const stopped = await server.stop();
  assert.equal(stopped.running, false);
  assert.equal(stopped.endpoint, null);
});

test('MCP HTTP server rejects oversized bodies', async t => {
  const server = new ChatGptMcpHttpServer({ bridge: new ChatGptMcpBridge(), token: 't', maxBodyBytes: 1024 });
  t.after(() => server.stop());
  const started = await server.start();
  const response = await request(started.endpoint, { token: started.token, body: { jsonrpc: '2.0', id: 1, method: 'x', payload: 'x'.repeat(2000) } });
  assert.equal(response.status, 413);
});
