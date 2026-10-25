'use strict';
// Island HUD bridge for Claude Code hooks.
//
// Reads one hook event JSON from stdin, reports it to the island over the
// local v2 pipe (descriptor: %LOCALAPPDATA%/IslandHUD/integration-v2.json),
// and maps the island's decision back to Claude Code's hook output schema:
// PermissionRequest → {decision:{behavior}} stdout, AskUserQuestion (via
// PreToolUse) → permissionDecision allow with updatedInput answers.
// Fail-open contract: any error, timeout or absent island exits 0 with no
// stdout so Claude Code falls back to its native approval UI.
const { exchange } = require('../lib/client.cjs');
const { version: PLUGIN_VERSION } = require('../package.json');
const { randomUUID } = require('node:crypto');
// Tools with no side effects never need an island approval. PermissionRequest
// only fires for tools that ask, so this list is an advisory skip-path.
const READ_ONLY = /^(?:Read|Glob|Grep|TodoWrite|TodoRead|WebFetch|WebSearch|TaskOutput|TaskStop|NotebookEdit|SlashCommand|ListMcpResources|ReadMcpResource)$/i;
const QUESTION_TOOL = /^(?:AskUserQuestion)$/i;
const MAX_INPUT_JSON = 600;

const compact = (text, limit) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
const projectOf = cwd => String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'Claude';
const detailOf = (toolInput) => {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const value = toolInput.command ?? toolInput.file_path ?? toolInput.path ?? toolInput.url
    ?? toolInput.query ?? toolInput.pattern ?? toolInput.skill ?? toolInput.subject;
  return compact(typeof value === 'string' ? value : '', 160);
};
const targetOf = (toolInput) => {
  if (!toolInput || typeof toolInput !== 'object') return '';
  const value = toolInput.file_path ?? toolInput.path ?? toolInput.url;
  return compact(typeof value === 'string' ? value : '', 200);
};
const envelopeBase = (input) => ({
  provider: 'claude',
  id: randomUUID(),
  sessionId: typeof input.session_id === 'string' && input.session_id ? input.session_id : null,
});

function readStdin() {
  return new Promise(resolve => {
    let data = '';
    if (process.stdin.isTTY) return resolve(data);
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', chunk => { data += chunk; });
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
      detail: detailOf(toolInput) || compact(input.permission_decision_reason, 160),
      reason: compact(input.permission_decision_reason, 500),
      ...(target ? { target } : {}),
      ...(operation ? { operation } : {}),
    },
  };
}

/** Claude's AskUserQuestion payload: [{question, header, options, multiSelect}] → island questions. */
function questionEnvelope(input) {
  const raw = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions.slice(0, 4) : [];
  if (!raw.length) return null;
  const questions = raw.map((q, index) => ({
    id: 'q' + index,
    question: compact(q.question || q.header, 20000) || '问题 ' + (index + 1),
    detail: '',
    multiSelect: !!q.multiSelect,
    options: (Array.isArray(q.options) ? q.options : []).slice(0, 50)
      .map(o => ({ label: compact(o.label, 200), description: compact(o.description, 500) }))
      .filter(o => o.label),
  })).filter(q => q.question && q.options.length);
  return questions.length ? questions : null;
}

/** Answers map keyed by both the question text and the header — the exact
 * shape Claude Code merges back onto the AskUserQuestion tool call. */
function answersOf(questions, replyAnswers, originalQuestions) {
  const answers = {};
  for (const answer of replyAnswers || []) {
    const index = Number(String(answer.id).slice(1));
    const original = Array.isArray(originalQuestions) ? originalQuestions[index] : null;
    const custom = (answer.custom || '').trim();
    const value = custom || (answer.selected || []).join(', ');
    if (original?.question) answers[compact(original.question, 20000)] = value;
    if (original?.header) answers[compact(original.header, 120)] = value;
  }
  return answers;
}

function permissionDecisionOutput(decision) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}
function preToolDecisionOutput(updatedInput) {
  return { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'allow',
    permissionDecisionReason: 'Island HUD 已回答', updatedInput } };
}

/** Question flow shared by PermissionRequest (tool routed through permission)
 * and PreToolUse AskUserQuestion (the interactive TUI path). */
async function handleQuestion(input, viaPreToolUse) {
  const questions = questionEnvelope(input);
  if (!questions) return;
  const reply = await exchange({ ...envelopeBase(input), kind: 'question', blocking: true,
    payload: { cwd: input.cwd || null, sessionTitle: projectOf(input.cwd), callId: input.tool_use_id || null, questions } },
  reply => {
    if (reply.decision === 'answer' || reply.decision === 'return') return reply;
    throw new Error('Invalid question decision');
  });
  await reportOutcome(input, reply.id, 'QuestionAnswered',
    reply.status === 'delivered' && reply.decision === 'answer' ? 'answered' : 'cancelled');
  if (reply.status !== 'delivered' || reply.decision !== 'answer') return;
  const updatedInput = { ...(input.tool_input || {}),
    answers: answersOf(questions, reply.answers, input.tool_input?.questions) };
  if (viaPreToolUse) process.stdout.write(JSON.stringify(preToolDecisionOutput(updatedInput)) + '\n');
  else process.stdout.write(JSON.stringify(permissionDecisionOutput({
    behavior: 'allow', updatedInput })) + '\n');
}

async function handlePermission(input) {
  const toolName = String(input.tool_name || '');
  const mode = String(input.permission_mode || '');
  const isQuestion = QUESTION_TOOL.test(toolName);
  if (!isQuestion && (mode === 'bypassPermissions' || READ_ONLY.test(toolName))) return;

  if (isQuestion) return handleQuestion(input, false);

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
  if (reply.decision === 'allow') process.stdout.write(JSON.stringify(permissionDecisionOutput({ behavior: 'allow' })) + '\n');
  else if (reply.decision === 'deny') process.stdout.write(JSON.stringify(permissionDecisionOutput({
    behavior: 'deny', message: '已在 Island HUD 中拒绝此请求' })) + '\n');
  // 'return' and every non-delivered status fall through to Claude Code's native UI.
}

async function handlePreToolUse(input) {
  if (QUESTION_TOOL.test(String(input.tool_name || ''))) {
    const mode = String(input.permission_mode || '');
    if (mode === 'bypassPermissions') return;
    return handleQuestion(input, true);
  }
  await reportEvent(input, {
    ...(input.cwd ? { cwd: String(input.cwd) } : {}), event: 'PreToolUse',
    tool: { id: input.tool_use_id || null, name: compact(input.tool_name, 120), detail: detailOf(input.tool_input) },
  });
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
      return handlePreToolUse(input);
    case 'PostToolUse':
    case 'PostToolUseFailure':
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
