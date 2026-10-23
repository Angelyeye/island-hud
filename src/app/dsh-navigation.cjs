'use strict';
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');

const DEFAULT_PORT = 47831;
const NAV_PATH = '/island-hud/navigate';
const TOKEN_HEX = 48;

function readDescriptor(file) {
  if (!file) return null;
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!value || value.v !== 1) return null;
    if (typeof value.token !== 'string' || !/^[a-f0-9]{48}$/.test(value.token)) return null;
    if (!Number.isInteger(value.port) || value.port <= 0 || value.port > 65535) return null;
    return value;
  } catch { return null; }
}

function writeDescriptor(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = file + '.' + randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    fs.renameSync(temp, file);
  } finally { try { fs.unlinkSync(temp); } catch { /* moved or never written */ } }
}

/**
 * Loopback queue used by the DSH browser half to open an exact Session ID.
 * The token is generated once and persisted next to the descriptor so the
 * installed plugin keeps working across restarts; the port falls back to an
 * ephemeral local port when the preferred one is already taken.
 */
class DshNavigationServer {
  constructor({ port, token, descriptorPath, log = () => {}, now = Date.now } = {}) {
    if (descriptorPath && !path.isAbsolute(descriptorPath)) throw new Error('Absolute navigation descriptor path required');
    const saved = descriptorPath ? readDescriptor(descriptorPath) : null;
    const envPort = Number(process.env.ISLAND_HUD_NAV_PORT);
    this.port = Number.isInteger(port) ? port : (saved?.port || (Number.isInteger(envPort) && envPort > 0 ? envPort : DEFAULT_PORT));
    this.token = typeof token === 'string' && token ? token : (saved?.token || randomBytes(TOKEN_HEX / 2).toString('hex'));
    this.descriptorPath = descriptorPath || '';
    this.log = log;
    this.now = now;
    this.server = null;
    this.portActual = 0;
    this.queue = [];
    this.inflight = new Map();
    this.waiters = new Map();
  }

  endpoint() {
    return `http://127.0.0.1:${this.portActual || this.port}${NAV_PATH}?token=${this.token}`;
  }

  authorize(url) {
    return url.pathname === NAV_PATH && url.searchParams.get('token') === this.token;
  }

  cors(response) {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    response.setHeader('Access-Control-Allow-Headers', 'content-type');
    response.setHeader('Cache-Control', 'no-store');
  }

  json(response, status, value) {
    this.cors(response);
    const body = JSON.stringify(value);
    response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(body) });
    response.end(body);
  }

  settle(requestId, status) {
    const waiter = this.waiters.get(requestId);
    if (!waiter) return false;
    clearTimeout(waiter.timer);
    this.waiters.delete(requestId);
    this.inflight.delete(requestId);
    waiter.resolve({ status, sessionId: waiter.sessionId });
    return true;
  }

  createServer() {
    const server = http.createServer((request, response) => this.handle(request, response));
    server.on('error', error => this.log('dsh navigation server error: ' + error.message));
    return server;
  }

  listen(port) {
    this.server = this.server || this.createServer();
    return new Promise((resolve, reject) => {
      const server = this.server;
      const onError = error => { server.removeListener('listening', onListening); reject(error); };
      const onListening = () => { server.removeListener('error', onError); resolve(); };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
  }

  async start() {
    if (this.server && this.portActual) return { port: this.portActual, token: this.token, endpoint: this.endpoint() };
    try {
      await this.listen(this.port);
    } catch (error) {
      if (error.code !== 'EADDRINUSE' || this.port === 0) throw error;
      this.log(`dsh navigation port ${this.port} busy, using an ephemeral port`);
      this.port = 0;
      await this.listen(0);
    }
    this.portActual = this.server.address().port;
    this.log(`dsh navigation listening 127.0.0.1:${this.portActual}`);
    if (this.descriptorPath) writeDescriptor(this.descriptorPath, { v: 1, port: this.portActual, token: this.token, path: NAV_PATH });
    return { port: this.portActual, token: this.token, endpoint: this.endpoint() };
  }

  handle(request, response) {
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); } catch { return this.json(response, 400, { error: 'bad_request' }); }
    if (request.method === 'OPTIONS') {
      this.cors(response);
      response.writeHead(204);
      response.end();
      return;
    }
    if (!this.authorize(url)) return this.json(response, 404, { error: 'not_found' });
    if (request.method === 'GET') {
      const next = this.queue.shift();
      if (!next) {
        this.cors(response);
        response.writeHead(204);
        response.end();
        return;
      }
      this.inflight.set(next.requestId, next);
      this.json(response, 200, { protocol: 1, requestId: next.requestId, sessionId: next.sessionId });
      return;
    }
    if (request.method !== 'POST') return this.json(response, 405, { error: 'method_not_allowed' });
    let body = '';
    request.setEncoding('utf8');
    request.on('data', chunk => {
      body += chunk;
      if (Buffer.byteLength(body) > 4096) request.destroy();
    });
    request.on('end', () => {
      let value;
      try { value = JSON.parse(body); } catch { return this.json(response, 400, { error: 'bad_json' }); }
      if (!value || typeof value.requestId !== 'string' ||
          !['navigated', 'expired', 'failed'].includes(value.status)) return this.json(response, 400, { error: 'bad_ack' });
      const settled = this.settle(value.requestId, value.status);
      this.json(response, settled ? 200 : 410, { settled });
    });
  }

  request(sessionId, timeoutMs = 2500) {
    if (typeof sessionId !== 'string' || !sessionId || sessionId.length > 500) {
      return Promise.resolve({ status: 'expired', sessionId: null });
    }
    const requestId = randomUUID();
    const promise = new Promise(resolve => {
      const timer = setTimeout(() => {
        this.queue = this.queue.filter(item => item.requestId !== requestId);
        this.inflight.delete(requestId);
        this.waiters.delete(requestId);
        resolve({ status: 'unavailable', sessionId });
      }, timeoutMs);
      timer.unref?.();
      this.waiters.set(requestId, { resolve, timer, sessionId });
    });
    this.queue.push({ requestId, sessionId, at: this.now() });
    while (this.queue.length > 8) this.queue.shift();
    return promise;
  }

  stop() {
    for (const requestId of [...this.waiters.keys()]) this.settle(requestId, 'failed');
    this.queue.length = 0;
    this.inflight.clear();
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
      this.portActual = 0;
    }
  }
}

module.exports = { DshNavigationServer, DEFAULT_PORT, NAV_PATH };
