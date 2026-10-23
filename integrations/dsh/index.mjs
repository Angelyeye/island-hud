import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { appendFileSync } from 'node:fs';
const require = createRequire(import.meta.url);
// The build copies just these shared modules; installed plugins do not depend on a development path.
const { exchange } = require('./lib/client.cjs');
const { answersOf, questionsOf } = require('./lib/contract.cjs');
const pluginVersion = require('./package.json').version;
export const name = 'island-hud-native-bridge';

function identity(req) {
  const session = req.agent?.session;
  return { sessionId: typeof session?.id === 'string' ? session.id : null,
    cwd: typeof session?.header?.cwd === 'string' ? session.header.cwd : '', session };
}
export function apply(ctx, config = {}) {
  const active = new Set();
  const audits = new WeakMap();
  const replies = new WeakMap();
  const questionCalls = new WeakMap();
  const toolCalls = new WeakMap();
  const titles = new WeakMap();
  const continued = new Map();
  const attempts = new Map();
  const reports = new Map();
  let disposed = false;
  const diagnostic = fields => {
    if (!config.diagnosticsPath) return;
    try { appendFileSync(config.diagnosticsPath, JSON.stringify({ at: new Date().toISOString(), ...fields }) + '\n'); }
    catch { /* A diagnostic failure must not change native request handling. */ }
  };
  diagnostic({ event: 'PluginMounted' });
  const report = (event, sessionId = null, fields = {}) => {
    const envelope = { provider: 'dsh', id: randomUUID(), sessionId, kind: 'event', blocking: false, at: Date.now(),
      payload: { event, pluginVersion, ...fields } };
    // Independent sockets can arrive out of order. Keep one short event queue
    // per session so a late tool-start cannot overwrite its native turn-end.
    const previous = reports.get(sessionId) || Promise.resolve();
    const pending = previous.catch(() => {}).then(() => disposed ? { status: 'unavailable' }
      : exchange(envelope, { descriptor: config.descriptorPath })).then(result => {
      if (event === 'PluginReady') diagnostic({ event, status: result.status, reason: result.reason });
      if (reports.get(sessionId) === pending) reports.delete(sessionId);
    });
    reports.set(sessionId, pending);
  };
  report('PluginReady');
  const heartbeat = setInterval(() => report('PluginHeartbeat'), 15000);
  heartbeat.unref?.();
  function confirmQuestion(session, callId) {
    const requestId = replies.get(session)?.get(callId);
    if (!requestId) return;
    replies.get(session).delete(callId);
    report('QuestionAnswered', session.id, { requestId, callId, outcome: 'answered' });
  }
  const fingerprint = questions => JSON.stringify(questionsOf(questions.map(q => ({ ...q, multiSelect: q.multiSelect ?? q.multi_select }))));
  ctx.on('session/event', (session, event) => {
    const data = event.data || {}, cwd = session.header?.cwd || '';
    if (event.type === 'approval/asked') {
      const queue = audits.get(session) || [];
      queue.push(event.data); audits.set(session, queue);
    } else if (event.type === 'approval/decided') {
      const queue = audits.get(session) || [];
      audits.set(session, queue.filter(a => a.id !== event.data.id));
      report('ApprovalDecided', session.id, { requestId: event.data.id, outcome: event.data.outcome });
    }
    if (event.type === 'turn/start') report('UserPromptSubmit', session.id, { cwd });
    if (event.type === 'tool/call') {
      report('PreToolUse', session.id, { cwd, tool: { name: data.name || '', id: data.callId || null } });
      if (data.callId && data.name) {
        try {
          const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments || {};
          const take = value => typeof value === 'string' ? value.slice(0, 16000) + (value.length > 16000 ? '\n（操作预览已截断）' : '') : '';
          const calls = toolCalls.get(session) || new Map();
          calls.set(data.callId, { name: data.name, target: take(args.file_path || args.path || args.url), operation: take(args.command || args.cmd || args.content || args.patch || args.query) });
          toolCalls.set(session, calls);
        } catch { /* Malformed tool input is never used to fabricate approval details. */ }
      }
      if (data.name === 'ask_user_question' && data.callId) {
        try {
          const args = typeof data.arguments === 'string' ? JSON.parse(data.arguments) : data.arguments;
          const calls = questionCalls.get(session) || new Map();
          calls.set(data.callId, { fingerprint: fingerprint(args.questions), claimed: false }); questionCalls.set(session, calls);
        } catch { /* Ambiguous or invalid call metadata is never guessed. */ }
      }
    }
    if (event.type === 'tool/result') {
      const callId = data.message?.toolCallId;
      questionCalls.get(session)?.delete(callId);
      toolCalls.get(session)?.delete(callId);
      report('PostToolUse', session.id, { cwd, callId });
      if (!data.error && data.message?.isError !== true) {
        try {
          const text = data.message?.content?.find(block => block.type === 'text')?.text;
          if (Array.isArray(JSON.parse(text || '{}').answers)) confirmQuestion(session, callId);
        } catch { /* Unknown results only update activity. */ }
      }
    }
    if (event.type === 'turn/end') { questionCalls.delete(session); toolCalls.delete(session); report('Stop', session.id, { cwd, turn: data.turn }); }
    if (event.type === 'session/title' && typeof data.title === 'string') { titles.set(session, data.title); report('SessionTitle', session.id, { cwd, title: data.title }); }
    if (event.type === 'user/message' && data.source?.kind === 'user-question-reply') confirmQuestion(session, data.source.callId);
  }, { global: true });
  const invoke = async (req, envelope, validate) => {
    const controller = new AbortController();
    const abort = () => controller.abort();
    active.add(controller);
    req.signal?.addEventListener('abort', abort, { once: true });
    if (req.signal?.aborted) abort();
    try { return await exchange(envelope, { signal: controller.signal, descriptor: config.descriptorPath, validate }); }
    finally { active.delete(controller); req.signal?.removeEventListener('abort', abort); }
  };
  // prepend is part of Cordis EventOptions; fallback explicitly calls the existing chain.
  ctx.on('approval/request', async (req, next) => {
    const { sessionId, cwd, session } = identity(req);
    const queue = audits.get(session) || [];
    const index = queue.findIndex(a => a.callId === req.callId && a.toolName === req.toolName);
    const audit = index < 0 ? null : queue.splice(index, 1)[0];
    const call = toolCalls.get(session)?.get(req.callId);
    const reply = await invoke(req, { provider: 'dsh', id: audit?.id || randomUUID(), sessionId, kind: 'approval', blocking: true,
      payload: { cwd, sessionTitle: titles.get(session) || null, callId: req.callId || null,
        tool: { name: req.toolName, detail: req.reason || '', reason: req.reason || '',
          ...(call?.name === req.toolName ? { target: call.target, operation: call.operation } : {}) } } }, reply => {
      if (!['allow', 'deny', 'return'].includes(reply.decision)) throw new Error('Invalid approval');
      return reply;
    });
    if (req.signal?.aborted) return 'cancelled';
    if (reply.status === 'delivered' && reply.decision === 'allow') return 'allowed-once';
    if (reply.status === 'delivered' && reply.decision === 'deny') return 'rejected';
    return next();
  }, { prepend: true });
  ctx.on('user-questions/request', async (req, next) => {
    const { sessionId, cwd, session } = identity(req);
    let callId = req.wait?.callId || null;
    if (!callId && session) {
      try {
        const signature = fingerprint(req.questions), matches = [...(questionCalls.get(session) || [])].filter(([, value]) => !value.claimed && value.fingerprint === signature);
        if (matches.length === 1) { callId = matches[0][0]; matches[0][1].claimed = true; }
      } catch { /* The legacy API may omit call identity; leave it unassociated with a tool call. */ }
    }
    const requestId = callId ? JSON.stringify([sessionId, callId]) : randomUUID();
    const reply = await invoke(req, { provider: 'dsh', id: requestId, sessionId, kind: 'question',
      blocking: true, payload: { cwd, sessionTitle: titles.get(session) || null, questions: req.questions, callId,
        timed: !!req.wait?.timed, continuation: req.wait?.timed ? 'host-managed' : null } }, reply => {
      if (reply.decision === 'answer') return { ...reply, answers: answersOf(req.questions, reply.answers) };
      if (reply.decision !== 'return') throw new Error('Invalid question decision');
      return reply;
    });
    if (req.signal?.aborted) throw req.signal.reason || new Error('Question was cancelled by host');
    if (reply.status === 'delivered' && reply.decision === 'answer') {
      if (session && callId) {
        const calls = replies.get(session) || new Map(); calls.set(callId, requestId); replies.set(session, calls);
      }
      return { answers: reply.answers };
    }
    // Do not hold attachWait: host keeps its own foreground deadline and continued-question projection.
    return next();
  }, { prepend: true });
  // Continued questions use the native projection and answer() API. They never
  // fabricate a result for a tool call whose foreground wait already ended.
  function scanContinued() {
    if (disposed) return;
    const agents = ctx.get?.('agents'), projections = ctx.get?.('sessionProjections'), service = ctx.get?.('userQuestions');
    if (!agents?.roots || !projections?.stateOf || !service?.answer) return;
    const live = new Set();
    for (const agent of agents.roots()) {
      const session = agent.session;
      const questions = projections.stateOf(session, 'userQuestions')?.questions?.active || [];
      for (const question of questions) {
        if (question.state !== 'continued') continue;
        const key = JSON.stringify([session.id, question.callId]); live.add(key);
        const existing = continued.get(key);
        if (existing && existing.agent === agent) continue;
        if (existing) { existing.controller.abort(); continued.delete(key); }
        const attempt = attempts.get(key) || { revision: 0, retryAt: 0 };
        if (Date.now() < attempt.retryAt) continue;
        const controller = new AbortController(), requestId = JSON.stringify([session.id, question.callId, 'continued', attempt.revision]);
        const job = { controller, agent, requestId }; continued.set(key, job);
        void exchange({ provider: 'dsh', id: requestId, sessionId: session.id, kind: 'question', blocking: false,
          payload: { cwd: session.header?.cwd || '', callId: question.callId, questions: question.questions,
            continued: true, continuation: 'native-user-questions-answer' } }, {
          descriptor: config.descriptorPath, signal: controller.signal,
          validate: reply => {
            if (reply.decision === 'return') return reply;
            if (reply.decision !== 'answer') throw new Error('Invalid question decision');
            const current = projections.stateOf(session, 'userQuestions')?.questions?.active?.find(q => q.callId === question.callId && q.state === 'continued');
            if (!current || agents.get(agent.id) !== agent || !agents.roots().includes(agent)) throw Object.assign(new Error('Question is no longer answerable'), { status: 'expired' });
            const answers = answersOf(current.questions, reply.answers);
            const calls = replies.get(session) || new Map(); calls.set(question.callId, requestId); replies.set(session, calls);
            try {
              if (service.answer(agent, question.callId, { answers }) !== true) throw Object.assign(new Error('Question was handled by another client'), { status: 'already_handled' });
            } catch (error) { calls.delete(question.callId); if (error.code === 'REPLY_QUEUED') error.status = 'already_handled'; throw error; }
            return { ...reply, answers };
          },
        }).then(result => {
          if (continued.get(key) !== job) return;
          // Return/answered/duplicate requests stay suppressed until the native
          // projection changes. An unavailable island can be reconnected later.
          if (['unavailable', 'failed'].includes(result.status)) {
            continued.delete(key); attempts.set(key, { revision: attempt.revision + 1, retryAt: Date.now() + 3000 });
          }
        }).catch(() => { continued.delete(key); });
      }
    }
    for (const [key, job] of continued) if (!live.has(key)) { job.controller.abort(); continued.delete(key); attempts.delete(key); }
    for (const key of attempts.keys()) if (!live.has(key)) attempts.delete(key);
  }
  const reconnect = setInterval(() => { try { scanContinued(); } catch { diagnostic({ event: 'ProjectionSyncFailed' }); } }, 1000);
  reconnect.unref?.();
  ctx.on('agent/inbox/discarded', ({ agent, message }) => {
    if (message.source?.kind !== 'user-question-reply') return;
    const key = JSON.stringify([agent.session.id, message.source.callId]), previous = attempts.get(key);
    continued.get(key)?.controller.abort(); continued.delete(key);
    attempts.set(key, { revision: (previous?.revision || 0) + 1, retryAt: 0 });
  }, { global: true });
  ctx.on('dispose', () => {
    disposed = true; clearInterval(heartbeat); clearInterval(reconnect);
    for (const controller of active) controller.abort();
    for (const job of continued.values()) job.controller.abort();
    continued.clear(); attempts.clear(); reports.clear();
  });
}
