#!/usr/bin/env node
// Island HUD bridge for ZCode hooks.
//
// Reads one hook event JSON from stdin, reports it to the island over the
// local v2 pipe (descriptor: %LOCALAPPDATA%/IslandHUD/integration-v2.json),
// and for PermissionRequest maps the island's decision back to ZCode's strict
// hook output schema. Fail-open contract: any error, timeout or absent island
// exits 0 with no stdout so ZCode falls back to its native approval UI.
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
const require = createRequire(import.meta.url);
const { exchange } = require('../lib/client.cjs');

const PLUGIN_VERSION = require('../package.json').version;
// Tools with no side effects never need an island approval. ZCode may also
// flag this itself via sideEffectScope; both checks are advisory skip-paths.
const READ_ONLY = /^(?:Read|Glob|Grep|TodoWrite|TodoRead|WebFetch|WebSearch|TaskOutput|TaskStop|ListModels|ListSavedWorkflows|ListWorkflowRuns|GetWorkflowRun|ReadSessionContext|SlashCommand)$/i;
const QUESTION_TOOL = /^(?:AskUserQuestion|ask_user_question)$/i;
const MAX_INPUT_JSON = 600;

const compact = (text, limit) => String(text || '').replace(/\s+/g, ' ').trim().slice(0, limit);
const projectOf = cwd => String(cwd || '').split(/[\\/]/).filter(Boolean).pop() || 'ZCode';
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
  provider: 'zcode',
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
  const alwaysAllowSubject = alwaysAllowSubjectOf(toolInput);
  return {
    cwd: typeof input.cwd === 'string' ? input.cwd : null,
    sessionTitle: projectOf(input.cwd),
    callId: input.tool_use_id || input.toolCallId || null,
    tool: {
      name: compact(input.tool_name, 120),
      detail: detailOf(toolInput) || compact(input.reason, 160),
      reason: compact(input.reason, 500),
      ...(target ? { target } : {}),
      ...(operation ? { operation } : {}),
      ...(alwaysAllowSubject ? { alwaysAllowSubject } : {}),
    },
  };
}

/** The island's AskUserQuestion relay answers through the allow branch's
 * updatedInput; the exact answer shape is experimental upstream. */
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

function decisionOutput(decision) {
  return { hookSpecificOutput: { hookEventName: 'PermissionRequest', decision } };
}

// ZCode persists "always allow" as permission rules keyed by a subject field
// its rule engine matches on — the same shape its own native option produces.
// Tools without a subject keep the decision in the client, where ZCode knows
// its own allowAlways policy.
const RULE_SUBJECTS = ['command', 'url', 'file_path', 'path', 'pattern'];
function alwaysAllowSubjectOf(toolInput) {
  return RULE_SUBJECTS.map(key => toolInput[key]).find(v => typeof v === 'string' && v.trim()) || null;
}
function alwaysAllowUpdates(input) {
  const toolInput = input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const rule = { toolName: compact(input.tool_name, 120) || 'unknown' };
  const subject = alwaysAllowSubjectOf(toolInput);
  if (subject) rule.ruleContent = subject;
  return [{ type: 'addRules', behavior: 'allow', rules: [rule] }];
}

async function handlePermission(input) {
  const toolName = String(input.tool_name || '');
  const mode = String(input.permission_mode || '');
  const isQuestion = QUESTION_TOOL.test(toolName);
  if (!isQuestion && (mode === 'yolo' || mode === 'bypassPermissions' || READ_ONLY.test(toolName) || input.sideEffectScope === 'none')) return;

  if (isQuestion) {
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
    const answers = {};
    for (const answer of reply.answers || []) {
      const index = Number(String(answer.id).slice(1));
      const original = Array.isArray(input.tool_input?.questions) ? input.tool_input.questions[index] : null;
      const key = compact(original?.question, 20000) || '问题 ' + (index + 1);
      const custom = (answer.custom || '').trim();
      answers[key] = custom || (answer.selected || []).join(', ');
    }
    process.stdout.write(JSON.stringify(decisionOutput({
      behavior: 'allow', updatedInput: { ...input.tool_input, answers },
    })) + '\n');
    return;
  }

  const reply = await exchange({ ...envelopeBase(input), kind: 'approval', blocking: true,
    payload: approvalPayload(input) },
  reply => {
    if (['allow', 'allow-always', 'deny', 'return'].includes(reply.decision)) return reply;
    throw new Error('Invalid approval decision');
  });
  const outcome = reply.status !== 'delivered' ? (reply.status === 'expired' ? 'cancelled' : 'unavailable')
    : reply.decision === 'allow' ? 'allowed-once'
    : reply.decision === 'allow-always' ? 'allowed-always'
    : reply.decision === 'deny' ? 'rejected' : 'cancelled';
  await reportOutcome(input, reply.id, 'ApprovalDecided', outcome);
  if (reply.status !== 'delivered') return;
  if (reply.decision === 'allow') process.stdout.write(JSON.stringify(decisionOutput({ behavior: 'allow' })) + '\n');
  else if (reply.decision === 'allow-always') process.stdout.write(JSON.stringify(decisionOutput({
    behavior: 'allow', permissionUpdates: alwaysAllowUpdates(input),
  })) + '\n');
  else if (reply.decision === 'deny') process.stdout.write(JSON.stringify(decisionOutput({
    behavior: 'deny', message: '已在 Island HUD 中拒绝此请求',
  })) + '\n');
  // 'return' and every non-delivered status fall through to ZCode's native UI.
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

const raw = await readStdin();
let input;
try { input = JSON.parse(raw); } catch { process.exit(0); }
if (!input || !input.hook_event_name) process.exit(0);
try {
  if (input.hook_event_name === 'PermissionRequest') await handlePermission(input);
  else await handleEvent(input);
} catch { /* Fail-open: the native UI keeps working without the island. */ }
process.exit(0);
