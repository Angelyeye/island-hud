'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const EventEmitter = require('node:events');
const { JsonlTail } = require('../logs/jsonl-tail.cjs');
const { keyOf } = require('../integrations/contract');
const SESSIONS_ROOT = path.join(process.env.DSH_HOME || path.join(os.homedir(), '.dsh'), 'sessions');
const PHASE = { WAITING_APPROVAL: 'waitingForApproval', WAITING_ANSWER: 'waitingForAnswer', RUNNING: 'running', COMPLETED: 'completed', IDLE: 'idle' };
const QUESTION_TOOLS = new Set(['ask_user_question', 'ask', 'AskUserQuestion']);
const phaseRank = phase => ({ waitingForApproval: 0, waitingForAnswer: 1, running: 2, completed: 3, idle: 4 }[phase] ?? 4);
const compact = (text, max = 160) => { const value = String(text || '').replace(/\s+/g, ' ').trim(); return value.length > max ? value.slice(0, max - 1) + '…' : value; };
const textOf = content => typeof content === 'string' ? content : Array.isArray(content) ? content.filter(b => b?.type === 'text').map(b => b.text || '').join('\n') : '';
function humanizePrompt(raw) {
  return String(raw || '').replace(/<openviking-context[\s\S]*?<\/openviking-context>/g, '')
    .replace(/<available-memories>[\s\S]*?<\/available-memories>/g, '').replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '')
    .replace(/<[^>]+>/g, ' ').replace(/^\s*Current runtime context[\s\S]*?\n\n/, '').replace(/\s+/g, ' ').trim();
}
const looksSynthetic = text => /^(You are|Your task|你是|你的任务|请作为一个|任务[:：])/.test(text) || /teammate|subagent|READ-ONLY|独立验证者|研究助手|代码审查者/.test(text.slice(0, 200));
function parse(value) { if (typeof value !== 'string') return value || {}; try { return JSON.parse(value); } catch { return {}; } }
function toolDetail(args) {
  const value = parse(args);
  for (const key of ['command', 'cmd', 'command_line', 'file_path', 'path', 'pattern', 'query', 'url', 'prompt', 'text', 'description']) {
    if (typeof value[key] === 'string' && value[key].trim()) return compact(value[key]);
  }
  return compact(typeof args === 'string' ? args : JSON.stringify(args || {}));
}
function makeSession(id, workspaceSlug, file) {
  return { id, workspaceSlug, file, phase: PHASE.IDLE, cwd: '', project: '', title: '', turn: 0, step: 0,
    lastUserText: '', lastAssistantText: '', currentTool: null, currentToolSince: 0, pendingQuestion: null,
    toolCount: 0, approvalPolicy: 'ask', permissionPreset: '', sandboxMode: '', todos: [], delegationDepth: 0,
    startedAt: 0, updatedAt: 0, completedAt: 0, pendingApprovals: new Map(), questions: new Map(), tools: new Map(), needsAttention: false };
}
class TranscriptTail extends JsonlTail { constructor(file, options = {}) { super(file, { ...options, compressed: true }); } }

class DshBridge extends EventEmitter {
  constructor({ pollMs = 400, staleMs = 30 * 60 * 1000, sessionsRoot = SESSIONS_ROOT, now = Date.now } = {}) {
    super(); Object.assign(this, { pollMs, staleMs, sessionsRoot, now });
    this.sessions = new Map(); this.tails = new Map(); this.timer = null; this.lastSnapshot = null;
  }
  start() { if (this.timer) return; this.tick(); this.timer = setInterval(() => this.tick(), this.pollMs); }
  stop() { clearInterval(this.timer); this.timer = null; this.tails.clear(); this.sessions.clear(); }
  scan() {
    let workspaces; try { workspaces = fs.readdirSync(this.sessionsRoot, { withFileTypes: true }); } catch { return; }
    for (const ws of workspaces) {
      if (!ws.isDirectory() || ws.isSymbolicLink()) continue;
      const dir = path.join(this.sessionsRoot, ws.name);
      let entries; try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.isSymbolicLink() || this.tails.has(entry.name)) continue;
        const file = path.join(dir, entry.name, 'session.v4.jsonl.zstd');
        let stat; try { stat = fs.statSync(file); } catch { continue; }
        if (this.now() - stat.mtimeMs > this.staleMs) continue;
        this.tails.set(entry.name, new TranscriptTail(file));
        this.sessions.set(entry.name, makeSession(entry.name, ws.name, file));
      }
    }
  }
  tick() {
    this.scan();
    for (const [id, tail] of this.tails) {
      const generation = tail.generation;
      const records = tail.poll();
      let session = this.sessions.get(id);
      if (generation !== tail.generation) {
        session = makeSession(id, session.workspaceSlug, session.file);
        this.sessions.set(id, session);
      }
      for (const record of records) {
        try { this.apply(session, record); }
        catch { this.emit('warning', { provider: 'dsh', id, reason: 'Malformed session record skipped' }); }
      }
    }
    // Timing is evidence too: no new bytes must not suppress a state transition.
    this.derivePhases();
    for (const [id, session] of this.sessions) {
      if (session.updatedAt && this.now() - session.updatedAt > this.staleMs && !this.isBlocked(session) && this.tails.get(id).caughtUp) {
        this.sessions.delete(id); this.tails.delete(id);
      }
    }
    this.emitUpdate();
  }
  isBlocked(s) { return s.pendingApprovals.size > 0 || [...s.questions.values()].some(q => q.blocking); }
  refreshTool(s) {
    s.currentTool = [...s.tools.values()].at(-1) || null;
    s.currentToolSince = s.currentTool?.since || 0;
    s.pendingQuestion = [...s.questions.values()].find(q => q.blocking) || [...s.questions.values()][0] || null;
  }
  apply(s, record) {
    if (!record || typeof record.type !== 'string') return;
    const d = record.type === 'session' ? record : record.data || {};
    const time = Number(record.time || record.createdAt) || this.now();
    s.updatedAt = Math.max(s.updatedAt, time);
    switch (record.type) {
      case 'session':
        s.cwd = d.cwd || ''; s.project = s.cwd ? path.basename(s.cwd) : '';
        s.startedAt = d.createdAt || time; s.delegationDepth = d.delegationDepth || 0; break;
      case 'session/title': if (d.title) s.title = d.title; break;
      case 'turn/start': s.turn = d.turn || s.turn; s.phase = PHASE.RUNNING; s.completedAt = 0; break;
      case 'turn/end':
        s.turn = d.turn || s.turn; s.phase = PHASE.COMPLETED; s.completedAt = time;
        s.tools.clear(); s.pendingApprovals.clear();
        for (const [id, q] of s.questions) if (q.blocking) s.questions.delete(id);
        break;
      case 'step/start': s.step = d.step || s.step; break;
      case 'user/message': {
        if (d.source?.kind === 'user-question-reply' && d.source.callId) s.questions.delete(d.source.callId);
        const text = humanizePrompt(textOf(d.content));
        if (text && !looksSynthetic(text) && d.source?.kind !== 'user-question-reply') s.lastUserText = compact(text, 200);
        // A late non-blocking reply updates the session without fabricating an open call.
        s.phase = PHASE.RUNNING; s.completedAt = 0; break;
      }
      case 'assistant/message': {
        const text = textOf(d.message?.content || d.content);
        if (text) s.lastAssistantText = Array.from(text).slice(0, 1200).join(''); break;
      }
      case 'tool/call': {
        const name = d.name || d.call?.name || '';
        const id = d.callId || d.id || d.call?.id || 'legacy-call';
        const args = parse(d.arguments ?? d.call?.arguments);
        s.toolCount++;
        s.tools.set(id, { id, name, since: time, detail: toolDetail(args) });
        if (QUESTION_TOOLS.has(name)) {
          const q = args.questions?.[0] || {};
          s.questions.set(id, { callId: id, tool: name, text: compact(q.question || q.header, 220),
            options: (Array.isArray(q.options) ? q.options : []).filter(o => typeof o === 'string' || (o && typeof o.label === 'string'))
              .slice(0, 50).map(o => typeof o === 'string' ? { label: o } : o),
            multiSelect: !!(q.multiSelect || q.multi_select), at: time, blocking: true });
        }
        s.phase = PHASE.RUNNING; break;
      }
      case 'tool/result': {
        const id = d.callId || d.toolCallId || d.message?.toolCallId || d.id;
        if (id) {
          s.tools.delete(id);
          const result = parse(textOf(d.message?.content || d.content) || d.result);
          if (result.pending && s.questions.has(id)) s.questions.get(id).blocking = false;
          else s.questions.delete(id);
        } else if (s.tools.size === 1) {
          const only = [...s.tools.keys()][0]; s.tools.delete(only); s.questions.delete(only);
        }
        s.phase = PHASE.RUNNING; break;
      }
      case 'approval/asked': if (d.id) s.pendingApprovals.set(d.id, { id: d.id, callId: d.callId, tool: d.toolName, at: time }); break;
      case 'approval/decided': s.pendingApprovals.delete(d.id); if (!s.completedAt) s.phase = PHASE.RUNNING; break;
      case 'approval/policy': s.approvalPolicy = d.policy || s.approvalPolicy; break;
      case 'permission/preset': s.permissionPreset = d.preset || s.permissionPreset; break;
      case 'sandbox/mode': s.sandboxMode = d.mode || s.sandboxMode; break;
      case 'todo/write': {
        const list = d.todos || d.items;
        if (Array.isArray(list)) s.todos = list.slice(0, 12).map(t => ({ text: compact(t.content || t.text || t.subject, 90), status: t.status || 'pending' }));
        break;
      }
      default: break;
    }
    this.refreshTool(s);
  }
  derivePhases() {
    const now = this.now();
    for (const s of this.sessions.values()) {
      const quiet = now - s.updatedAt;
      s.needsAttention = !!s.currentTool && now - s.currentToolSince > 30000 && !this.isBlocked(s);
      if (s.pendingApprovals.size) s.phase = PHASE.WAITING_APPROVAL;
      else if ([...s.questions.values()].some(q => q.blocking)) s.phase = PHASE.WAITING_ANSWER;
      else if (s.currentTool) s.phase = PHASE.RUNNING;
      else if (quiet > (s.phase === PHASE.COMPLETED ? 5 : 3) * 60000) s.phase = PHASE.IDLE;
    }
  }
  snapshot() {
    return [...this.sessions.values()].filter(s => s.startedAt && (this.now() - s.updatedAt < this.staleMs || this.isBlocked(s)))
      .map(s => ({ id: keyOf('dsh', s.id), rawId: s.id, provider: 'dsh', project: s.project || '—', cwd: s.cwd,
        title: s.title || s.lastUserText || s.project || 'DSH session', phase: s.phase, turn: s.turn, step: s.step,
        lastUserText: s.lastUserText, lastAssistantText: s.lastAssistantText, currentTool: s.currentTool,
        pendingQuestion: s.pendingQuestion, pendingApprovals: [...s.pendingApprovals.values()],
        actionable: false, evidence: 'log', needsAttention: s.needsAttention, toolCount: s.toolCount,
        approvalPolicy: s.approvalPolicy, permissionPreset: s.permissionPreset, sandboxMode: s.sandboxMode,
        todos: s.todos, isSubagent: s.delegationDepth > 0, startedAt: s.startedAt, updatedAt: s.updatedAt, completedAt: s.completedAt }))
      .sort((a, b) => phaseRank(a.phase) - phaseRank(b.phase) || b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
  }
  emitUpdate() {
    const snapshot = this.snapshot(), serialized = JSON.stringify(snapshot);
    if (serialized === this.lastSnapshot) return false;
    this.lastSnapshot = serialized; this.emit('update', snapshot); return true;
  }
}
module.exports = { DshBridge, TranscriptTail, PHASE, phaseRank, humanizePrompt, SESSIONS_ROOT, zstdDecoderName: 'fzstd' };
