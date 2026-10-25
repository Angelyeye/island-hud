'use strict';
// Island HUD bridge for OpenAI Codex hooks.
//
// Reads one hook event JSON from stdin, reports it to the island over the
// local v2 pipe (descriptor: %LOCALAPPDATA%/IslandHUD/integration-v2.json),
// and for PermissionRequest maps the island's decision back to Codex's hook
// output schema. Fail-open contract: any error, timeout or absent island
// exits 0 with no stdout so Codex falls back to its native approval UI.
// Note: Codex surfaces PermissionRequest only in the interactive TUI; exec
// runs force approval_policy=never, so approvals never reach hooks there.
const { exchange } = require('../lib/client.cjs');
const { version: PLUGIN_VERSION } = require('../package.json');
const { randomUUID } = require('node:crypto');
// Tools with no side effects never need an island approval; PermissionRequest
// only fires for tools that ask, so this list is an advisory skip-path.
const READ_ONLY = /^(?:Read|Glob|Grep|TodoWrite|TodoRead|WebFetch|WebSearch|TaskOutput|TaskStop)$/i;
const MAX_INPUT_JSON = 600;

const compact = (text, limit) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
const projectOf = cwd => String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'Codex';
const detailOf = (toolInput) => {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const value = toolInput.command ?? toolInput.file_path ?? toolInput.path ?? toolInput.url
    ?? toolInput.query ?? toolInput.pattern ?? toolInput.skill ?? toolInput.description;
  return compact(typeof value === 'string' ? value : '', 160);
};
const targetOf = (toolInput) => {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const value = toolInput.file_path ?? toolInput.path ?? toolInput.url;
  return compact(typeof value === 'string' ? value : '', 200);
};
const envelopeBase = (input) => ({
  provider: 'codex',
  id: randomUUID(),
  sessionId: typeof input.session_id === 'string' && input.session_id ? input.session_id : null,
});

function readStdin() {
  // Hook events are a few kilobytes; anything beyond 1 MiB is not a real event.
  const MAX_STDIN_CHARS = 1 << 20;
  return new Promise(resolve => {
    let data = '';
    if (process.stdin.isTTY) return resolve(data);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => {
      data += chunk;
      if (data.length > MAX_STDIN_CHARS) {
        // Oversized input is not a hook event: drop it and fail open. The
        // later end/error handlers resolve the already-settled promise as no-ops.
        data = '';
        process.stdin.destroy();
        resolve(data);
      }
    });
    process.stdin.on('end', () => resolve(data));
    process.stdin.on('error', () => resolve(data));
    // A wedged host must never hold the agent's tool call longer than this.
    setTimeout(() => resolve(data), 10000).unref();
  });
}

/** Fire-and-forget status events. The hub replies immediately; a slow island only costs the event. */
async function reportEvent(input, payload) {
  await exchange({ ...envelopeBase(input), kind: 'event', blocking: false,
    payload: { pluginVersion: PLUGIN_VERSION, ...payload } });
}

/** Best-effort confirmation so the island can settle its card state. Never throws. */
async function reportOutcome(input, requestId, event, outcome) {
  try {
    await exchange({ ...envelopeBase(input), kind: 'event', blocking: false,
      payload: { event, pluginVersion: PLUGIN_VERSION, requestId, outcome } });
  } catch { /* Confirmation is advisory; the island also expires its own cards. */ }
}

function approvalPayload(input) {
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const target = targetOf(toolInput);
  const operation = Object.keys(toolInput).length ? compact(JSON.stringify(toolInput), MAX_INPUT_JSON) : '';
  return {
    cwd: typeof input.cwd === 'string' ? input.cwd : null,
    sessionTitle: projectOf(input.cwd),
    callId: input.tool_use_id || null,
    tool: {
      name: compact(input.tool_name, 120),
      detail: detailOf(toolInput) || compact(toolInput.description, 160),
      reason: compact(toolInput.description, 500),
      ...(target ? { target } : {}),
      ...(operation ? { operation } : {}),
    },
  };
}

function decisionOutput(decision) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

async function handlePermission(input) {
  const mode = String(input.permission_mode || '');
  const toolName = String(input.tool_name || '');
  if (mode === 'bypassPermissions' || READ_ONLY.test(toolName)) return;
  const reply = await exchange({ ...envelopeBase(input), kind: 'approval', blocking: true,
    payload: approvalPayload(input) },
  reply => {
    if (['allow', 'deny', 'return'].includes(reply.decision)) return reply;
    throw new Error('Invalid approval decision');
  });
  const outcome = reply.status !== 'delivered' ? (reply.status === 'expired' ? 'cancelled' : 'unavailable')
    : reply.decision === 'allow' ? 'allowed-once' : reply.decision === 'deny' ? 'rejected' : 'cancelled';
  await reportOutcome(input, reply.id, 'ApprovalDecided', outcome);
  if (reply.status !== 'delivered') return;
  if (reply.decision === 'allow') process.stdout.write(JSON.stringify(decisionOutput({ behavior: 'allow' })) + '\n');
  else if (reply.decision === 'deny') process.stdout.write(JSON.stringify(decisionOutput({
    behavior: 'deny', message: '已在 Island HUD 中拒绝此请求' })) + '\n');
  // 'return' and every non-delivered status fall through to Codex's native UI.
}

async function handleEvent(input) {
  const event = String(input.hook_event_name || '');
  const payload = {};
  if (input.cwd) payload.cwd = String(input.cwd);
  switch (event) {
    case 'SessionStart':
      payload.event = 'SessionStart';
      break;
    case 'UserPromptSubmit': {
      const prompt = compact(input.prompt, 2000);
      payload.event = 'UserPromptSubmit';
      if (prompt) payload.prompt = prompt;
      if (prompt) payload.title = projectOf(input.cwd) + ': ' + prompt.slice(0, 60);
      break;
    }
    case 'PreToolUse':
      payload.event = 'PreToolUse';
      payload.tool = { id: input.tool_use_id || null, name: compact(input.tool_name, 120), detail: detailOf(input.tool_input) };
      break;
    case 'PostToolUse':
      payload.event = 'PostToolUse';
      payload.callId = input.tool_use_id || null;
      break;
    case 'Stop':
      payload.event = 'Stop';
      break;
    default:
      return;
  }
  await reportEvent(input, payload);
}

(async () => {
  const raw = await readStdin();
  let input;
  try { input = JSON.parse(raw); } catch { process.exit(0); }
  if (!input || !input.hook_event_name) process.exit(0);
  try {
    if (input.hook_event_name === 'PermissionRequest') await handlePermission(input);
    else await handleEvent(input);
  } catch { /* Fail-open: the native UI keeps working without the island. */ }
  process.exit(0);
})();
