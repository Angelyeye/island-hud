'use strict';
// Island-side visibility rules. These are display rules only: no DSH session
// file, log or profile is ever touched by this module.
const DEFAULT_LIMIT = 50;
const RANK = { waitingForApproval: 0, waitingForAnswer: 1, running: 2, completed: 3, idle: 4 };
const rankOf = session => RANK[session?.phase] ?? 4;

function isActive(session) {
  if (!session) return false;
  if (['running', 'waitingForApproval', 'waitingForAnswer'].includes(session.phase)) return true;
  return !!(Array.isArray(session.pendingRequests) && session.pendingRequests.length);
}

// When the island sees more sessions than the limit, keep the ones that still
// need the user first, then the most recently updated ones.
function capSessions(list, limit = DEFAULT_LIMIT) {
  const items = Array.isArray(list) ? list : [];
  const max = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : DEFAULT_LIMIT;
  if (items.length <= max) return items.slice();
  return [...items]
    .sort((a, b) => rankOf(a) - rankOf(b) || (b.updatedAt || 0) - (a.updatedAt || 0) || String(a.id).localeCompare(String(b.id)))
    .slice(0, max);
}

/**
 * Filters locally hidden sessions, revival candidates for active ones and the
 * 50-entry display cap in one pass. `revived` must be un-hidden by the caller.
 */
function applyVisibility(list, hidden, { limit = DEFAULT_LIMIT } = {}) {
  const hiddenKeys = hidden instanceof Set ? hidden : new Set(hidden || []);
  const visible = [], revived = [];
  for (const session of Array.isArray(list) ? list : []) {
    if (hiddenKeys.has(session.id)) {
      if (isActive(session)) revived.push(session);
      else continue;
    }
    visible.push(session);
  }
  const sessions = capSessions(visible, limit);
  return { sessions, revived, dropped: Math.max(0, visible.length - sessions.length) };
}

module.exports = { applyVisibility, capSessions, isActive, rankOf, DEFAULT_LIMIT, RANK };
