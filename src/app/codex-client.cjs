'use strict';

function codexThreadUri(sessionId) {
  if (typeof sessionId !== 'string') return null;
  const id = sessionId.trim();
  if (!id || id.length > 128) return null;
  return `codex://threads/${encodeURIComponent(id)}`;
}

async function openCodexThread(sessionId, { openExternal } = {}) {
  const uri = codexThreadUri(sessionId);
  if (!uri) return { status: 'unsupported', reason: 'Codex 会话标识无效，请在客户端手动打开' };
  if (typeof openExternal !== 'function') {
    return { status: 'unsupported', reason: '无法调用 Codex 深链接，请在客户端手动打开' };
  }
  try {
    await openExternal(uri);
    return { status: 'navigated', sessionId: sessionId.trim() };
  } catch {
    return { status: 'unsupported', reason: '无法打开 Codex，请检查 Codex 安装或 codex:// 协议注册' };
  }
}

module.exports = { codexThreadUri, openCodexThread };
