'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { DshNavigationServer, NAV_PATH } = require('../src/app/dsh-navigation.cjs');
const { DshIntegrationManager } = require('../src/app/dsh-integration-manager.cjs');
const os = require('node:os');

function request(port, method = 'GET', path = '/', body = null) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, method, path,
      headers: body ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } : {},
    }, response => {
      let text = '';
      response.setEncoding('utf8');
      response.on('data', chunk => { text += chunk; });
      response.on('end', () => resolve({ status: response.statusCode, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('exact DSH navigation queues one Session ID and waits for client acknowledgement', async t => {
  const server = new DshNavigationServer({ port: 0, token: 'test-token' });
  t.after(() => server.stop());
  const { port } = await server.start();
  const navigation = server.request('session-exact-019');
  const polled = await request(port, 'GET', '/island-hud/navigate?token=test-token');
  assert.equal(polled.status, 200);
  const value = JSON.parse(polled.text);
  assert.equal(value.sessionId, 'session-exact-019');
  assert.match(value.requestId, /^[0-9a-f-]{36}$/);
  const ack = await request(port, 'POST', '/island-hud/navigate?token=test-token',
    JSON.stringify({ requestId: value.requestId, status: 'navigated' }));
  assert.equal(ack.status, 200);
  assert.deepEqual(await navigation, { status: 'navigated', sessionId: 'session-exact-019' });
});

test('navigation endpoint rejects wrong tokens and missing Sessions', async t => {
  const server = new DshNavigationServer({ port: 0, token: 'test-token' });
  t.after(() => server.stop());
  const { port } = await server.start();
  assert.equal((await request(port, 'GET', '/island-hud/navigate?token=wrong')).status, 404);
  assert.deepEqual(await server.request('', 20), { status: 'expired', sessionId: null });
  const pending = server.request('missing-session', 25);
  assert.equal((await request(port, 'GET', '/island-hud/navigate?token=test-token')).status, 200);
  assert.deepEqual(await pending, { status: 'unavailable', sessionId: 'missing-session' });
});

test('DSH browser half calls uiWorkspace.openSession with the exact acknowledged Session ID', async () => {
  let registration, opened = null, ack = null, scheduled = null;
  const context = {
    window: {
      __ModuleLoader__: { load(value) { registration = value; } },
      setTimeout(callback) { scheduled = callback; return 1; },
      clearTimeout() {},
    },
    fetch: async (_url, options = {}) => {
      if (options.method === 'POST') {
        ack = JSON.parse(options.body);
        return { status: 200 };
      }
      return { status: 200, json: async () => ({ protocol: 1, requestId: 'request-019', sessionId: 'session-exact-019' }) };
    },
  };
  vm.runInNewContext(fs.readFileSync(path.resolve(__dirname, '../integrations/dsh/lib/navigation-client.js'), 'utf8'), context);
  assert.equal(registration.id, '@island-hud/dsh-bridge');
  const plugin = registration.factory(() => {});
  const ctx = {
    sessions: { list: { getSnapshot: () => ({ byId: { 'session-exact-019': { id: 'session-exact-019' } } }) } },
    uiWorkspace: { openSession(id) { opened = id; } },
    effect(callback) { callback(); },
  };
  plugin.apply(ctx);
  assert.equal(typeof scheduled, 'function');
  scheduled();
  for (let i = 0; i < 20 && !ack; i++) await new Promise(resolve => setTimeout(resolve, 5));
  assert.equal(opened, 'session-exact-019');
  assert.deepEqual(ack, { requestId: 'request-019', status: 'navigated' });
});

test('navigation token is random, persisted across restarts and never a fixed value', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-nav-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const descriptorPath = path.join(dir, 'navigation.json');
  const first = new DshNavigationServer({ port: 0, descriptorPath });
  t.after(() => first.stop());
  const started = await first.start();
  assert.match(started.token, /^[a-f0-9]{48}$/);
  assert.match(started.endpoint, new RegExp(NAV_PATH.replace(/\//g, '\\/') + '\\?token=' + started.token));
  const saved = JSON.parse(fs.readFileSync(descriptorPath, 'utf8'));
  assert.equal(saved.token, started.token);
  first.stop();
  const second = new DshNavigationServer({ descriptorPath });
  t.after(() => second.stop());
  const restarted = await second.start();
  assert.equal(restarted.token, started.token, 'the installed plugin must keep working after a restart');
});

test('a busy preferred port falls back to an ephemeral loopback port', async t => {
  const first = new DshNavigationServer({ port: 0 });
  t.after(() => first.stop());
  const occupied = await first.start();
  const second = new DshNavigationServer({ port: occupied.port });
  t.after(() => second.stop());
  const started = await second.start();
  assert.notEqual(started.port, occupied.port);
  assert.ok(started.port > 0);
  const response = await request(started.port, 'GET', `${NAV_PATH}?token=${started.token}`);
  assert.equal(response.status, 204);
});

test('the managed plugin bundle receives the live endpoint instead of the placeholder', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-bundle-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const token = 'a'.repeat(48);
  const navigationPath = path.join(dir, 'navigation.json');
  fs.writeFileSync(navigationPath, JSON.stringify({ v: 1, port: 54321, token, path: NAV_PATH }));
  const manager = new DshIntegrationManager({
    profileDir: path.join(dir, 'profile'), dataDir: path.join(dir, 'data'),
    sourceDir: path.resolve(__dirname, '../integrations/dsh'),
    descriptorPath: path.join(dir, 'integration-v2.json'), navigationPath,
  });
  const { target } = manager.prepareBundle();
  const bundle = fs.readFileSync(path.join(target, 'lib/navigation-client.js'), 'utf8');
  assert.equal(bundle.includes('__ISLAND_HUD_NAV_ENDPOINT__'), false);
  assert.equal(bundle.includes(`http://127.0.0.1:54321${NAV_PATH}?token=${token}`), true);
});

