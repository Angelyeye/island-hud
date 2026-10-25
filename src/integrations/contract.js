'use strict';
const PROVIDERS = new Set(['dsh', 'zcode', 'claude', 'codex']);
const MAX_FRAME_BYTES = 512 * 1024;
// ZCode, Claude Code and Codex hook clients block the agent's own tool call
// while the island card is open, so they may legitimately wait far longer
// than DSH's in-app flow.
const TIMEOUT_MS = {
  dsh: { approval: 120000, question: 600000 },
  zcode: { approval: 24 * 3600000, question: 24 * 3600000 },
  claude: { approval: 24 * 3600000, question: 24 * 3600000 },
  codex: { approval: 6 * 3600000, question: 6 * 3600000 },
};
function timeoutFor(provider, kind) {
  if (kind !== 'approval' && kind !== 'question') return 0;
  return (TIMEOUT_MS[provider] || TIMEOUT_MS.dsh)[kind];
}
const keyOf = (provider, id) => JSON.stringify([provider, id]);
const sessionKey = (provider, id) => id ? keyOf(provider, id) : null;

function questionsOf(input) {
  if (!Array.isArray(input) || !input.length || input.length > 20) throw new Error('Expected 1–20 questions');
  const ids = new Set();
  return input.map(q => {
    if (!q || typeof q.id !== 'string' || !q.id.trim() || ids.has(q.id)) throw new Error('Question IDs must be unique');
    ids.add(q.id);
    if (typeof q.question !== 'string' || !q.question.trim() || q.question.length > 20000) throw new Error('Invalid question text');
    const options = q.options === undefined ? [] : q.options;
    if (!Array.isArray(options) || options.length > 50) throw new Error('Invalid options');
    const labels = new Set();
    for (const o of options) {
      if (!o || typeof o.label !== 'string' || !o.label.trim() || labels.has(o.label)) throw new Error('Option labels must be unique');
      labels.add(o.label);
    }
    return { id: q.id, question: q.question, detail: String(q.detail || ''),
      multiSelect: !!q.multiSelect, options: options.map(o => ({ label: o.label, description: String(o.description || '') })) };
  });
}

function answersOf(questions, input) {
  if (!Array.isArray(input) || input.length !== questions.length) throw new Error('Answer every question');
  const byId = new Map();
  for (const a of input) {
    if (!a || byId.has(a.id) || !Array.isArray(a.selected) || a.selected.some(x => typeof x !== 'string') ||
        (a.custom !== undefined && typeof a.custom !== 'string')) throw new Error('Invalid answer batch');
    byId.set(a.id, a);
  }
  return questions.map(q => {
    const a = byId.get(q.id);
    if (!a || new Set(a.selected).size !== a.selected.length ||
        a.selected.some(label => !q.options.some(o => o.label === label))) throw new Error('Invalid option or question ID');
    const custom = (a.custom || '').trim();
    if (!q.multiSelect && (a.selected.length > 1 || (custom && a.selected.length))) throw new Error('Choose one option or custom text');
    // Empty selected explicitly represents a skipped DSH question; never invent a default answer.
    return { id: q.id, selected: [...a.selected], ...(custom ? { custom } : {}) };
  });
}

function validateRequest(msg) {
  if (!msg || !PROVIDERS.has(msg.provider) || typeof msg.id !== 'string' || !msg.id || msg.id.length > 500 ||
      !['approval', 'question', 'event'].includes(msg.kind)) throw new Error('Invalid envelope');
  if (msg.sessionId !== undefined && msg.sessionId !== null && (typeof msg.sessionId !== 'string' || msg.sessionId.length > 500)) throw new Error('Invalid session ID');
  const timeoutMs = timeoutFor(msg.provider, msg.kind);
  const payload = { ...(msg.payload || {}) };
  if (msg.kind === 'question') payload.questions = questionsOf(payload.questions);
  return { provider: msg.provider, requestId: msg.id, id: keyOf(msg.provider, msg.id),
    sessionId: msg.sessionId || null, sessionKey: sessionKey(msg.provider, msg.sessionId),
    kind: msg.kind, blocking: msg.blocking !== false, payload,
    at: msg.kind === 'event' && Number.isSafeInteger(msg.at) && msg.at > 0 && msg.at <= Date.now() + 1000 ? msg.at : Date.now(),
    timeoutMs, receivedAt: Date.now(), state: 'pending' };
}

function validateDecision(request, decision, extra = {}) {
  if (decision === 'return') return { decision: 'return' };
  if (request.kind === 'approval') {
    if (!['allow', 'deny', 'allow-always'].includes(decision)) throw new Error('Invalid approval decision');
    return { decision };
  }
  if (request.kind !== 'question' || decision !== 'answer') throw new Error('Invalid decision');
  return { decision: 'answer', answers: answersOf(request.payload.questions, extra.answers) };
}
module.exports = { PROVIDERS, TIMEOUT_MS, timeoutFor, MAX_FRAME_BYTES, keyOf, sessionKey, questionsOf, answersOf, validateRequest, validateDecision };
