'use strict';
// Drafts never carry a reply channel. Only a currently live request can submit.
function createQuestionDraftCache({ storage, now = Date.now, delay = 200 } = {}) {
  const storageKey = 'islandHud.questionDrafts.v1', ttl = 24 * 3600000, entries = new Map();
  let timer;
  try {
    const saved = JSON.parse(storage?.getItem(storageKey) || '[]');
    if (Array.isArray(saved)) for (const entry of saved.slice(-32)) {
      if (typeof entry.key !== 'string' || !Number.isFinite(entry.at) || now() - entry.at > ttl || entry.at > now() ||
        !Array.isArray(entry.answers) || !entry.answers.every(a => typeof a.id === 'string' && typeof a.custom === 'string' &&
          Array.isArray(a.selected) && a.selected.every(s => typeof s === 'string'))) continue;
      entries.set(entry.key, entry);
    }
  } catch { /* Corrupt/unavailable storage does not affect the original request. */ }
  const keyOf = request => JSON.stringify([
    request.provider,
    request.sessionId && request.payload.callId ? ['call', request.sessionId, request.payload.callId] : ['request', request.id],
    request.payload.questions,
  ]);
  function flush() {
    clearTimeout(timer); timer = null;
    for (const [key, entry] of entries) if (now() - entry.at > ttl) entries.delete(key);
    while (entries.size > 32) entries.delete(entries.keys().next().value);
    try { storage?.setItem(storageKey, JSON.stringify([...entries.values()])); } catch { /* Keep the in-memory draft on quota/write failure. */ }
  }
  function persist() { clearTimeout(timer); timer = setTimeout(flush, delay); }
  return {
    keyOf,
    get(request) {
      if (request.kind !== 'question') return [];
      const key = keyOf(request);
      let entry = entries.get(key);
      if (entry && now() - entry.at > ttl) { entries.delete(key); entry = null; }
      if (entry && (entry.answers.length !== request.payload.questions.length ||
        !request.payload.questions.every((q, i) => q.id === entry.answers[i].id))) {
        entries.delete(key); entry = null;
      }
      if (!entry) {
        entry = { key, at: now(), answers: request.payload.questions.map(q => ({ id: q.id, selected: [], custom: '' })) };
        entries.set(key, entry);
      }
      return entry.answers;
    },
    touch(request) {
      if (request.kind !== 'question') return;
      const entry = entries.get(keyOf(request));
      if (entry) { entry.at = now(); entries.delete(entry.key); entries.set(entry.key, entry); persist(); }
    },
    removeKey(key) { if (entries.delete(key)) flush(); },
    flush,
  };
}
if (typeof module === 'object' && module.exports) module.exports = { createQuestionDraftCache };
else window.createQuestionDraftCache = createQuestionDraftCache;
