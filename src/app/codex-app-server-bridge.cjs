'use strict';

const { EventEmitter } = require('node:events');

const asObject = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const textOf = value => typeof value === 'string' ? value : '';
const idOf = params => textOf(params.threadId || params.thread?.id);
const cwdOf = params => textOf(params.cwd || params.thread?.cwd || params.thread?.worktree);
const itemIdOf = params => textOf(params.itemId || params.item?.id);
const turnIdOf = params => textOf(params.turnId || params.turn?.id);
const timeOf = (params, now) => {
  for (const key of ['at', 'startedAtMs', 'completedAtMs', 'timestamp']) {
    if (Number.isSafeInteger(params[key]) && params[key] > 0) return params[key];
  }
  return now();
};
const notificationKey = (method, params) => {
  const threadId = idOf(params), turnId = turnIdOf(params), itemId = itemIdOf(params);
  if (method.startsWith('thread/')) return threadId;
  if (method.startsWith('turn/')) return turnId;
  if (method.startsWith('item/')) return itemId;
  return '';
};

function eventForNotification(notification, now = Date.now) {
  const params = asObject(notification?.params);
  const method = textOf(notification?.method);
  const sessionId = idOf(params);
  if (!sessionId) return null;
  const at = timeOf(params, now);
  const base = { provider: 'codex', sessionId, at, payload: {} };
  if (method === 'thread/started') {
    return { ...base, payload: { event: 'SessionStart', cwd: cwdOf(params), title: textOf(params.thread?.name || params.title) } };
  }
  if (method === 'thread/closed') return { ...base, payload: { event: 'SessionEnd', cwd: cwdOf(params) } };
  if (method === 'turn/started') {
    const prompt = textOf(params.input || params.prompt || params.turn?.input);
    return { ...base, payload: { event: 'UserPromptSubmit', cwd: cwdOf(params), ...(prompt ? { prompt } : {}) } };
  }
  if (method === 'turn/completed') {
    const turn = Number.isSafeInteger(params.turn) ? params.turn
      : Number.isSafeInteger(params.turnNumber) ? params.turnNumber
        : Number.isSafeInteger(params.turn?.number) ? params.turn.number : undefined;
    return { ...base, payload: { event: 'Stop', cwd: cwdOf(params), ...(turn === undefined ? {} : { turn }) } };
  }
  if (method === 'turn/aborted') return { ...base, payload: { event: 'Interrupt', cwd: cwdOf(params) } };
  if (method === 'item/started') {
    const item = asObject(params.item);
    return { ...base, payload: { event: 'PreToolUse', cwd: cwdOf(params), tool: {
      id: itemIdOf(params), name: textOf(item.type || item.name || params.itemType), detail: textOf(item.command || item.detail || params.command),
    } } };
  }
  if (method === 'item/completed') {
    return { ...base, payload: { event: 'PostToolUse', cwd: cwdOf(params), callId: itemIdOf(params) || null } };
  }
  return null;
}

function approvalForRequest(request, now = Date.now) {
  const params = asObject(request?.params);
  const threadId = idOf(params);
  if (!threadId || !textOf(request?.method).endsWith('/requestApproval')) return null;
  const itemId = itemIdOf(params);
  const method = textOf(request.method);
  const toolName = method.includes('commandExecution') ? 'command' : method.includes('fileChange') ? 'file change' : 'permissions';
  const command = textOf(params.command || params.item?.command);
  const cwd = cwdOf(params);
  return {
    provider: 'codex',
    sessionId: threadId,
    requestId: `codex-app-server:${String(request.id)}`,
    kind: 'approval',
    receivedAt: now(),
    payload: { cwd, sessionTitle: textOf(params.thread?.name) || cwd.split(/[\\/]/).filter(Boolean).pop() || 'Codex',
      tool: { name: toolName, detail: command, reason: textOf(params.reason), ...(cwd ? { target: cwd } : {}), ...(itemId ? { callId: itemId } : {}) },
      appServer: { rpcId: request.id, method, itemId, availableDecisions: Array.isArray(params.availableDecisions) ? [...params.availableDecisions] : [] } },
    respond: request.respond,
  };
}

class CodexAppServerBridge extends EventEmitter {
  constructor({ server, now = Date.now, onEvent = () => {}, onApproval = () => {}, log = () => {} } = {}) {
    super();
    if (!server) throw new Error('Codex app-server bridge requires a server');
    this.server = server; this.now = now; this.onEvent = onEvent; this.onApproval = onApproval; this.log = log;
    this.bound = false;
    this.seen = new Set();
    this.notification = value => this.#notification(value);
    this.request = value => this.#request(value);
    this.close = value => { this.seen.clear(); this.emit('close', value); };
  }
  start() {
    if (this.bound) return false;
    this.bound = true;
    this.server.on('notification', this.notification);
    this.server.on('request', this.request);
    this.server.on('close', this.close);
    return true;
  }
  stop() {
    if (!this.bound) return false;
    this.bound = false;
    this.server.off('notification', this.notification);
    this.server.off('request', this.request);
    this.server.off('close', this.close);
    this.seen.clear();
    return true;
  }
  #notification(value) {
    const params = asObject(value?.params), method = textOf(value?.method), key = notificationKey(method, params);
    if (key) {
      const marker = method + '|' + key;
      if (this.seen.has(marker)) return;
      this.seen.add(marker);
      while (this.seen.size > 2048) this.seen.delete(this.seen.values().next().value);
    }
    const event = eventForNotification(value, this.now);
    if (!event) return;
    try { this.onEvent(event); this.emit('event', event); } catch (error) { this.log('codex app-server event error: ' + error.message); }
  }
  #request(value) {
    const approval = approvalForRequest(value, this.now);
    if (!approval) { value.respond(null, { code: -32601, message: 'Unsupported Codex app-server request' }); return; }
    try { this.onApproval(approval); this.emit('approval', approval); } catch (error) { this.log('codex app-server approval error: ' + error.message); value.respond(null, { code: -32000, message: 'Approval bridge unavailable' }); }
  }
}

module.exports = { eventForNotification, approvalForRequest, CodexAppServerBridge };
