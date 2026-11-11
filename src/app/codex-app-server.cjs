'use strict';

const { EventEmitter } = require('node:events');
const { spawn: spawnProcess } = require('node:child_process');
const { StringDecoder } = require('node:string_decoder');

const MAX_LINE_BYTES = 1 << 20;
const DEFAULT_REQUEST_TIMEOUT_MS = 15000;

class NdjsonDecoder {
  constructor({ maxLineBytes = MAX_LINE_BYTES } = {}) {
    this.maxLineBytes = maxLineBytes;
    this.buffer = '';
    this.decoder = new StringDecoder('utf8');
  }

  push(chunk) {
    this.buffer += Buffer.isBuffer(chunk) ? this.decoder.write(chunk) : String(chunk || '');
    const messages = [];
    let newline;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line, 'utf8') > this.maxLineBytes) throw new Error('Codex app-server message too large');
      messages.push(JSON.parse(line));
    }
    if (Buffer.byteLength(this.buffer, 'utf8') > this.maxLineBytes) throw new Error('Codex app-server message too large');
    return messages;
  }

  finish() {
    const tail = (this.buffer + this.decoder.end()).trim();
    this.buffer = '';
    if (!tail) return [];
    if (Buffer.byteLength(tail, 'utf8') > this.maxLineBytes) throw new Error('Codex app-server message too large');
    return [JSON.parse(tail)];
  }
}

class CodexAppServer extends EventEmitter {
  constructor({
    command = 'codex',
    args = ['app-server'],
    cwd,
    env,
    spawn = spawnProcess,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    log = () => {},
  } = {}) {
    super();
    this.command = command;
    this.args = [...args];
    this.cwd = cwd;
    this.env = env;
    this.spawn = spawn;
    this.requestTimeoutMs = requestTimeoutMs;
    this.log = log;
    this.child = null;
    this.decoder = new NdjsonDecoder();
    this.nextId = 1;
    this.pending = new Map();
    this.stopping = false;
    this.decoder = new NdjsonDecoder();
  }

  get running() { return !!this.child && !this.child.killed; }

  start() {
    if (this.child) return false;
    this.stopping = false;
    const child = this.spawn(this.command, this.args, {
      cwd: this.cwd,
      env: this.env ? { ...process.env, ...this.env } : process.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.child = child;
    child.stdout?.on('data', chunk => this.#data(chunk));
    child.stdout?.on('end', () => this.#finishDecoder());
    child.stderr?.on('data', chunk => this.emit('stderr', Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk)));
    child.on('error', error => this.#fail(error));
    child.on('close', (code, signal) => {
      const wasStopping = this.stopping;
      this.#fail(new Error(`Codex app-server exited (${code ?? 'unknown'}${signal ? ', ' + signal : ''})`));
      this.child = null;
      this.emit('close', { code, signal, stopping: wasStopping });
    });
    this.emit('start', { command: this.command, args: [...this.args] });
    return true;
  }

  stop() {
    if (!this.child) return false;
    this.stopping = true;
    const child = this.child;
    this.#fail(new Error('Codex app-server stopped'));
    try { child.kill(); } catch { /* Already exited. */ }
    this.child = null;
    this.emit('stop');
    return true;
  }

  initialize(clientInfo = {}) {
    return this.request('initialize', {
      clientInfo: { name: 'island-hud', version: '0.3.3', ...clientInfo },
      capabilities: {},
    });
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.child?.stdin || this.child.stdin.destroyed) return Promise.reject(new Error('Codex app-server is not running'));
    const id = this.nextId++;
    const message = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, reject, timer, method });
      try { this.child.stdin.write(message); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  respond(id, result, error) {
    if (!this.child?.stdin || this.child.stdin.destroyed) return false;
    const message = error
      ? { jsonrpc: '2.0', id, error }
      : { jsonrpc: '2.0', id, result: result === undefined ? null : result };
    try { this.child.stdin.write(JSON.stringify(message) + '\n'); return true; }
    catch { return false; }
  }

  #data(chunk) {
    try {
      for (const message of this.decoder.push(chunk)) this.#message(message);
    } catch (error) {
      this.log('codex app-server protocol error: ' + error.message);
      this.emit('protocol-error', error);
      this.stop();
    }
  }

  #finishDecoder() {
    try { for (const message of this.decoder.finish()) this.#message(message); }
    catch (error) { this.emit('protocol-error', error); }
  }

  #message(message) {
    if (!message || typeof message !== 'object') return;
    if (Object.prototype.hasOwnProperty.call(message, 'id') && this.pending.has(message.id)) {
      const pending = this.pending.get(message.id);
      this.pending.delete(message.id); clearTimeout(pending.timer);
      if (message.error) pending.reject(Object.assign(new Error(message.error.message || 'Codex app-server request failed'), { code: message.error.code, data: message.error.data }));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method === 'string') {
      if (Object.prototype.hasOwnProperty.call(message, 'id')) this.emit('request', { id: message.id, method: message.method, params: message.params, respond: (result, error) => this.respond(message.id, result, error) });
      else this.emit('notification', { method: message.method, params: message.params });
      return;
    }
    this.emit('message', message);
  }

  #fail(error) {
    for (const [id, pending] of this.pending) { clearTimeout(pending.timer); pending.reject(error); this.pending.delete(id); }
  }
}

module.exports = { MAX_LINE_BYTES, DEFAULT_REQUEST_TIMEOUT_MS, NdjsonDecoder, CodexAppServer };
