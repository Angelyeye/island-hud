'use strict';

/**
 * Console diagnostics must never take down the application. On Windows a
 * terminal, pipe, or parent test process can close while the app is still
 * logging; writing afterwards emits an asynchronous EPIPE error on the stream,
 * which try/catch cannot handle. Keep one error listener attached, switch to
 * file-only logging after the first failure, and never write a broken stream.
 */
function createDiagnosticOutput(stream, { onError = () => {} } = {}) {
  let available = Boolean(stream && typeof stream.write === 'function');
  let failure = null;

  const fail = (error) => {
    if (failure) return failure;
    failure = error instanceof Error ? error : new Error(String(error));
    available = false;
    try { onError(failure); } catch { /* logging must remain best-effort */ }
    return failure;
  };

  const onStreamError = (error) => { fail(error); };
  if (stream && typeof stream.on === 'function') stream.on('error', onStreamError);

  return {
    write(line) {
      if (!available) return false;
      if (stream.destroyed || stream.writableEnded || stream.writable === false) {
        fail(new Error('diagnostic stream is no longer writable'));
        return false;
      }
      try {
        stream.write(String(line));
        return true;
      } catch (error) {
        fail(error);
        return false;
      }
    },
    dispose() {
      available = false;
      if (stream && typeof stream.removeListener === 'function') {
        stream.removeListener('error', onStreamError);
      }
    },
    get available() { return available; },
    get failure() { return failure; },
  };
}

module.exports = { createDiagnosticOutput };
