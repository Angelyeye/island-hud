'use strict';

const http = require('node:http');
const { randomBytes, timingSafeEqual } = require('node:crypto');

const PROTOCOL_VERSION = '2024-11-05';
const BRIDGE_VERSION = '0.1.0';
const MAX_SESSIONS = 200;
const DEFAULT_REQUEST_TIMEOUT_MS = 24 * 3600000;

const ERROR_CODES = Object.freeze({
  BRIDGE_NOT_CONFIGURED: 'BRIDGE_NOT_CONFIGURED',
  BRIDGE_UNAUTHORIZED: 'BRIDGE_UNAUTHORIZED',
  BRIDGE_UNAVAILABLE: 'BRIDGE_UNAVAILABLE',
  SESSION_NOT_FOUND: 'SESSION_NOT_FOUND',
  REQUEST_EXPIRED: 'REQUEST_EXPIRED',
  REQUEST_ALREADY_HANDLED: 'REQUEST_ALREADY_HANDLED',
  CAPABILITY_UNSUPPORTED: 'CAPABILITY_UNSUPPORTED',
  PROTOCOL_MISMATCH: 'PROTOCOL_MISMATCH',
});

class ChatGptMcpError extends Error {
  constructor(code, message, data = {}) {
    super(message);
    this.name = 'ChatGptMcpError';
    this.code = code;
    this.data = data;
    this.retryable = !!data.retryable;
  }
}

const text = (value, field, max = 500) => {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new ChatGptMcpError('INVALID_ARGUMENT', `${field} must be a non-empty string of at most ${max} characters`, { field });
  }
  return value.trim();
};

const optionalText = (value, field, max = 500) => {
  if (value === undefined || value === null || value === '') return undefined;
  return text(value, field, max);
};

const clone = value => JSON.parse(JSON.stringify(value));
const nowOf = value => Number.isSafeInteger(value) && value > 0 ? value : Date.now();
const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: 'island_session_start',
    description: 'Create or resume an Island HUD session for a ChatGPT Chat or Work conversation.',
    inputSchema: { type: 'object', required: ['conversationId', 'mode'], properties: {
      conversationId: { type: 'string', minLength: 1, maxLength: 500 },
      projectId: { type: 'string', maxLength: 500 },
      mode: { type: 'string', enum: ['chat', 'work'] },
      title: { type: 'string', maxLength: 500 },
      sessionId: { type: 'string', maxLength: 500 },
      capabilities: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 50 },
    } },
  },
  {
    name: 'island_session_update',
    description: 'Update the current ChatGPT Chat or Work session state shown by Island HUD.',
    inputSchema: { type: 'object', required: ['sessionId'], properties: {
      sessionId: { type: 'string', minLength: 1, maxLength: 500 },
      phase: { type: 'string', enum: ['running', 'waitingForApproval', 'waitingForAnswer', 'completed', 'idle'] },
      title: { type: 'string', maxLength: 500 },
      summary: { type: 'string', maxLength: 20000 },
      currentTool: { type: 'object' },
      capabilities: { type: 'array', items: { type: 'string', maxLength: 100 }, maxItems: 50 },
    } },
  },
  {
    name: 'island_request_approval',
    description: 'Ask the user for an allow, deny, or return decision through Island HUD.',
    inputSchema: { type: 'object', required: ['sessionId'], properties: {
      sessionId: { type: 'string', minLength: 1, maxLength: 500 },
      requestId: { type: 'string', maxLength: 500 },
      tool: { type: 'object' },
      reason: { type: 'string', maxLength: 20000 },
      timeoutMs: { type: 'integer', minimum: 5000, maximum: DEFAULT_REQUEST_TIMEOUT_MS },
    } },
  },
  {
    name: 'island_request_question',
    description: 'Ask one or more structured questions through Island HUD and wait for the answers.',
    inputSchema: { type: 'object', required: ['sessionId', 'questions'], properties: {
      sessionId: { type: 'string', minLength: 1, maxLength: 500 },
      requestId: { type: 'string', maxLength: 500 },
      questions: { type: 'array', minItems: 1, maxItems: 20, items: { type: 'object' } },
      timeoutMs: { type: 'integer', minimum: 5000, maximum: DEFAULT_REQUEST_TIMEOUT_MS },
    } },
  },
  {
    name: 'island_session_complete',
    description: 'Mark a ChatGPT Chat or Work session as completed with an optional summary.',
    inputSchema: { type: 'object', required: ['sessionId'], properties: {
      sessionId: { type: 'string', minLength: 1, maxLength: 500 },
      summary: { type: 'string', maxLength: 20000 },
      result: { type: 'object' },
    } },
  },
  {
    name: 'island_session_cancel',
    description: 'Cancel a ChatGPT Chat or Work session and release pending requests.',
    inputSchema: { type: 'object', required: ['sessionId'], properties: {
      sessionId: { type: 'string', minLength: 1, maxLength: 500 },
      reason: { type: 'string', maxLength: 1000 },
    } },
  },
  {
    name: 'island_open',
    description: 'Ask Island HUD to focus a ChatGPT Chat or Work session.',
    inputSchema: { type: 'object', required: ['sessionId'], properties: {
      sessionId: { type: 'string', minLength: 1, maxLength: 500 },
    } },
  },
  {
    name: 'island_health',
    description: 'Return Island HUD bridge health and supported capabilities.',
    inputSchema: { type: 'object', properties: {} },
  },
]);

function timeoutPromise(promise, timeoutMs, onTimeout) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(onTimeout()), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([Promise.resolve(promise), timeout]).finally(() => clearTimeout(timer));
}

class ChatGptMcpBridge {
  constructor({
    now = Date.now,
    protocolVersion = PROTOCOL_VERSION,
    bridgeVersion = BRIDGE_VERSION,
    maxSessions = MAX_SESSIONS,
    requestApproval,
    requestQuestion,
    cancelRequest,
    openSession,
    onChange = () => {},
    configured = false,
    authenticated = false,
  } = {}) {
    this.now = now;
    this.protocolVersion = protocolVersion;
    this.bridgeVersion = bridgeVersion;
    this.maxSessions = Math.max(1, Number(maxSessions) || MAX_SESSIONS);
    this.requestApproval = requestApproval;
    this.requestQuestion = requestQuestion;
    this.cancelRequest = cancelRequest;
    this.openSession = openSession;
    this.onChange = onChange;
    this.configured = !!configured;
    this.authenticated = !!authenticated;
    this.sessions = new Map();
    this.pending = new Map();
    this.lastCall = null;
  }

  #changed() { try { this.onChange(this.snapshot()); } catch { /* observers are best-effort */ } }

  tools() { return clone(TOOL_DEFINITIONS); }

  snapshot() { return [...this.sessions.values()].map(clone); }

  health() {
    return {
      bridgeVersion: this.bridgeVersion,
      protocolVersion: this.protocolVersion,
      configured: this.configured,
      authenticated: this.authenticated,
      capabilities: this.tools().map(tool => tool.name),
      sessions: this.sessions.size,
      pendingRequests: this.pending.size,
      lastCall: this.lastCall ? clone(this.lastCall) : null,
    };
  }

  async callTool(name, args = {}) {
    if (!TOOL_DEFINITIONS.some(tool => tool.name === name)) {
      throw new ChatGptMcpError('CAPABILITY_UNSUPPORTED', `Unknown Island HUD tool: ${name}`);
    }
    this.lastCall = { name, at: this.now() };
    switch (name) {
      case 'island_session_start': return this.#start(args);
      case 'island_session_update': return this.#update(args);
      case 'island_request_approval': return this.#request('approval', args);
      case 'island_request_question': return this.#request('question', args);
      case 'island_session_complete': return this.#complete(args);
      case 'island_session_cancel': return this.#cancel(args);
      case 'island_open': return this.#open(args);
      case 'island_health': return this.health();
      default: throw new ChatGptMcpError('CAPABILITY_UNSUPPORTED', `Unknown Island HUD tool: ${name}`);
    }
  }

  async handleRpc(message) {
    const input = asObject(message);
    const id = input.id;
    if (input.jsonrpc !== '2.0' || (typeof id !== 'string' && !Number.isInteger(id)) || typeof input.method !== 'string') {
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32600, message: 'Invalid JSON-RPC request' } };
    }
    try {
      if (input.method === 'initialize') {
        const requested = input.params?.protocolVersion;
        if (requested && requested !== this.protocolVersion) throw new ChatGptMcpError(ERROR_CODES.PROTOCOL_MISMATCH, 'Unsupported MCP protocol version', { requested, supported: this.protocolVersion });
        return { jsonrpc: '2.0', id, result: { protocolVersion: this.protocolVersion, capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'island-hud-chatgpt-bridge', version: this.bridgeVersion } } };
      }
      if (input.method === 'notifications/initialized') return { jsonrpc: '2.0', id, result: {} };
      if (input.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (input.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: this.tools() } };
      if (input.method === 'tools/call') {
        const name = input.params?.name;
        const value = await this.callTool(name, input.params?.arguments || {});
        return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(value) }], structuredContent: value } };
      }
      return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${input.method}` } };
    } catch (error) {
      const bridgeError = error instanceof ChatGptMcpError ? error : new ChatGptMcpError(ERROR_CODES.BRIDGE_UNAVAILABLE, error?.message || 'Island HUD bridge unavailable', { retryable: true });
      if (input.method === 'tools/call') return { jsonrpc: '2.0', id, result: { isError: true, content: [{ type: 'text', text: JSON.stringify({ code: bridgeError.code, message: bridgeError.message, data: bridgeError.data }) }] } };
      return { jsonrpc: '2.0', id, error: { code: -32000, message: bridgeError.message, data: { code: bridgeError.code, ...bridgeError.data } } };
    }
  }

  #start(args) {
    const conversationId = text(args.conversationId, 'conversationId');
    const mode = args.mode === 'work' ? 'work' : args.mode === 'chat' ? 'chat' : null;
    if (!mode) throw new ChatGptMcpError('INVALID_ARGUMENT', 'mode must be chat or work');
    const sessionId = optionalText(args.sessionId, 'sessionId') || `chatgpt:${mode}:${conversationId}`;
    const previous = this.sessions.get(sessionId);
    const session = {
      provider: 'chatgpt', surface: mode, mode, sessionId, conversationId,
      projectId: optionalText(args.projectId, 'projectId'), title: optionalText(args.title, 'title') || previous?.title || conversationId,
      phase: previous?.phase === 'completed' ? 'running' : previous?.phase || 'running',
      capabilities: Array.isArray(args.capabilities) ? args.capabilities.filter(value => typeof value === 'string').slice(0, 50) : previous?.capabilities || [],
      startedAt: previous?.startedAt || this.now(), updatedAt: this.now(),
    };
    this.sessions.set(sessionId, session);
    while (this.sessions.size > this.maxSessions) this.sessions.delete(this.sessions.keys().next().value);
    this.#changed();
    return clone(session);
  }

  #session(args) {
    const sessionId = text(args.sessionId, 'sessionId');
    const session = this.sessions.get(sessionId);
    if (!session) throw new ChatGptMcpError(ERROR_CODES.SESSION_NOT_FOUND, `Unknown ChatGPT session: ${sessionId}`, { sessionId });
    return session;
  }

  #update(args) {
    const session = this.#session(args);
    for (const field of ['phase', 'title', 'summary']) if (args[field] !== undefined) session[field] = text(args[field], field, field === 'summary' ? 20000 : 500);
    if (args.currentTool !== undefined) session.currentTool = asObject(args.currentTool);
    if (Array.isArray(args.capabilities)) session.capabilities = args.capabilities.filter(value => typeof value === 'string').slice(0, 50);
    session.updatedAt = this.now();
    this.#changed();
    return clone(session);
  }

  async #request(kind, args) {
    const session = this.#session(args);
    const callback = kind === 'approval' ? this.requestApproval : this.requestQuestion;
    if (typeof callback !== 'function') throw new ChatGptMcpError(ERROR_CODES.BRIDGE_UNAVAILABLE, `No ${kind} callback is configured`, { retryable: true });
    const requestId = optionalText(args.requestId, 'requestId') || `chatgpt:${kind}:${session.sessionId}:${this.now()}`;
    const key = `${session.sessionId}:${requestId}`;
    if (this.pending.has(key)) throw new ChatGptMcpError(ERROR_CODES.REQUEST_ALREADY_HANDLED, `Request is already pending: ${requestId}`, { requestId });
    const request = { provider: 'chatgpt', surface: session.surface, kind, requestId, sessionId: session.sessionId, receivedAt: this.now(), payload: clone(args) };
    delete request.payload.sessionId;
    delete request.payload.requestId;
    let cancelRequestPromise;
    const cancelled = new Promise(resolve => { cancelRequestPromise = resolve; });
    this.pending.set(key, { ...request, cancel: () => cancelRequestPromise({ decision: 'return' }) });
    session.phase = kind === 'approval' ? 'waitingForApproval' : 'waitingForAnswer';
    session.updatedAt = this.now();
    this.#changed();
    try {
      const timeoutMs = Math.max(5000, Math.min(DEFAULT_REQUEST_TIMEOUT_MS, Number(args.timeoutMs) || DEFAULT_REQUEST_TIMEOUT_MS));
      const value = await timeoutPromise(Promise.race([
        Promise.resolve(callback({ session: clone(session), request: clone(request) })),
        cancelled,
      ]), timeoutMs,
        () => new ChatGptMcpError(ERROR_CODES.REQUEST_EXPIRED, `ChatGPT ${kind} request expired`, { requestId }));
      if (kind === 'approval') {
        const decision = value?.decision;
        if (!['allow', 'deny', 'return'].includes(decision)) throw new ChatGptMcpError(ERROR_CODES.BRIDGE_UNAVAILABLE, 'Invalid approval result from Island HUD', { requestId });
        return { requestId, decision };
      }
      if (value?.decision === 'return') return { requestId, decision: 'return' };
      if (value?.decision !== 'answer' || !Array.isArray(value.answers)) throw new ChatGptMcpError(ERROR_CODES.BRIDGE_UNAVAILABLE, 'Invalid question result from Island HUD', { requestId });
      return { requestId, decision: 'answer', answers: clone(value.answers) };
    } finally {
      this.pending.delete(key);
      if (this.sessions.has(session.sessionId)) {
        session.phase = session.cancelledAt ? 'idle' : 'running';
        session.updatedAt = this.now();
        this.#changed();
      }
    }
  }

  #complete(args) {
    const session = this.#session(args);
    session.phase = 'completed';
    if (args.summary !== undefined) session.summary = text(args.summary, 'summary', 20000);
    if (args.result !== undefined) session.result = asObject(args.result);
    session.completedAt = this.now(); session.updatedAt = session.completedAt;
    this.#changed();
    return clone(session);
  }

  async #cancel(args) {
    const session = this.#session(args);
    for (const [key, request] of this.pending) if (request.sessionId === session.sessionId) {
      this.pending.delete(key);
      await this.cancelRequest?.({ session: clone(session), request: clone(request), reason: optionalText(args.reason, 'reason', 1000) || 'session-cancelled' });
      request.cancel?.();
    }
    session.phase = 'idle'; session.cancelledAt = this.now(); session.updatedAt = session.cancelledAt;
    this.#changed();
    return clone(session);
  }

  async #open(args) {
    const session = this.#session(args);
    if (typeof this.openSession !== 'function') return { status: 'unsupported', sessionId: session.sessionId };
    const result = await this.openSession(clone(session));
    return { sessionId: session.sessionId, ...(asObject(result)) };
  }
}

class ChatGptMcpHttpServer {
  constructor({ bridge, host = '127.0.0.1', port = 0, path = '/mcp', token, maxBodyBytes = 1 << 20, serverFactory = http.createServer } = {}) {
    if (!bridge || typeof bridge.handleRpc !== 'function') throw new TypeError('ChatGptMcpHttpServer requires a bridge');
    if (typeof host !== 'string' || !host) throw new TypeError('ChatGptMcpHttpServer requires a host');
    this.bridge = bridge;
    this.host = host;
    this.port = Number.isInteger(port) && port >= 0 ? port : 0;
    this.path = path.startsWith('/') ? path : '/' + path;
    this.token = typeof token === 'string' && token ? token : randomBytes(24).toString('base64url');
    this.maxBodyBytes = Math.max(1024, Number(maxBodyBytes) || (1 << 20));
    this.serverFactory = serverFactory;
    this.server = null;
    this.boundPort = null;
    this.startedAt = null;
  }

  get running() { return !!this.server && this.server.listening === true; }

  endpoint() { return this.boundPort === null ? null : `http://${this.host}:${this.boundPort}${this.path}`; }

  status({ includeToken = false } = {}) {
    return {
      running: this.running,
      host: this.host,
      port: this.boundPort,
      endpoint: this.endpoint(),
      path: this.path,
      tokenConfigured: !!this.token,
      ...(includeToken ? { token: this.token } : {}),
      startedAt: this.startedAt,
    };
  }

  start() {
    if (this.running) return Promise.resolve(this.status({ includeToken: true }));
    if (this.server) return Promise.reject(new Error('ChatGPT MCP HTTP server is starting or stopping'));
    const server = this.serverFactory((request, response) => this.#handle(request, response));
    this.server = server;
    return new Promise((resolve, reject) => {
      const onError = error => {
        server.off?.('listening', onListening);
        this.server = null;
        reject(error);
      };
      const onListening = () => {
        server.off?.('error', onError);
        this.boundPort = server.address()?.port ?? this.port;
        this.startedAt = Date.now();
        resolve(this.status({ includeToken: true }));
      };
      server.once?.('error', onError);
      server.once?.('listening', onListening);
      try { server.listen(this.port, this.host); }
      catch (error) { onError(error); }
    });
  }

  stop() {
    if (!this.server) return Promise.resolve(this.status());
    const server = this.server;
    this.server = null;
    this.boundPort = null;
    this.startedAt = null;
    return new Promise(resolve => {
      try { server.close(() => resolve(this.status())); }
      catch { resolve(this.status()); }
    });
  }

  #authorized(request) {
    const value = request.headers.authorization || '';
    const prefix = 'Bearer ';
    if (!value.startsWith(prefix)) return false;
    const actual = Buffer.from(value.slice(prefix.length));
    const expected = Buffer.from(this.token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  #send(response, statusCode, body, headers = {}) {
    const payload = body === undefined ? '' : JSON.stringify(body);
    response.writeHead(statusCode, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
    response.end(payload);
  }

  #readBody(request) {
    return new Promise((resolve, reject) => {
      let total = 0;
      let tooLarge = false;
      const chunks = [];
      request.on('data', chunk => {
        total += Buffer.byteLength(chunk);
        if (total > this.maxBodyBytes) {
          tooLarge = true;
          return;
        }
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      request.on('end', () => tooLarge
        ? reject(new ChatGptMcpError('REQUEST_TOO_LARGE', 'MCP request body is too large'))
        : resolve(Buffer.concat(chunks).toString('utf8')));
      request.on('error', reject);
    });
  }

  async #handle(request, response) {
    if (request.url !== this.path) {
      this.#send(response, 404, { error: 'Not found' });
      return;
    }
    if (request.method === 'OPTIONS') {
      this.#send(response, 204, undefined, { allow: 'POST, OPTIONS' });
      return;
    }
    if (request.method !== 'POST') {
      this.#send(response, 405, { error: 'MCP endpoint accepts POST only' }, { allow: 'POST, OPTIONS' });
      return;
    }
    if (!this.#authorized(request)) {
      this.#send(response, 401, { error: 'Bearer token required' }, { 'www-authenticate': 'Bearer' });
      return;
    }
    try {
      const raw = await this.#readBody(request);
      const message = JSON.parse(raw || '{}');
      const result = await this.bridge.handleRpc(message);
      this.#send(response, 200, result);
    } catch (error) {
      if (response.headersSent) { response.end(); return; }
      const bridgeError = error instanceof ChatGptMcpError ? error : null;
      const status = bridgeError?.code === 'REQUEST_TOO_LARGE' ? 413 : 400;
      this.#send(response, status, { error: bridgeError?.code || 'INVALID_REQUEST', message: error?.message || 'Invalid MCP request' });
    }
  }
}

module.exports = { BRIDGE_VERSION, PROTOCOL_VERSION, ERROR_CODES, TOOL_DEFINITIONS, ChatGptMcpError, ChatGptMcpBridge, ChatGptMcpHttpServer };
