'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { IntegrationHub } = require('../src/integrations/hub');
const { SessionStore } = require('../src/sessions/session-store.cjs');

const HOOK = path.join(__dirname, '../integrations/zcode/scripts/island-hook.mjs');

async function until(check, ms = 8000) {
  const start = Date.now();
  while (!check()) {
    if (Date.now() - start > ms) throw new Error('Timed out waiting for condition');
    await new Promise(r => setTimeout(r, 10));
  }
}

async function zfixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-zcode-'));
  const descriptor = path.join(dir, 'integration-v2.json');
  const changes = [], events = [];
  const hub = new IntegrationHub({ descriptorPath: descriptor, allowedProviders: ['dsh', 'zcode'],
    onChange: x => changes.push(x), onEvent: x => events.push(x) });
  t.after(() => { hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  hub.start();
  await until(() => fs.existsSync(descriptor));
  return { dir, descriptor, hub, changes, events };
}

function runHook(descriptor, payload, stdin = JSON.stringify(payload)) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [HOOK], {
      env: { ...process.env, ISLAND_HUD_BRIDGE_FILE: descriptor }, stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '', err = '';
    child.stdout.on('data', c => { out += c; });
    child.stderr.on('data', c => { err += c; });
    child.on('close', code => resolve({ code, out: out.trim(), err: err.trim() }));
    child.stdin.end(stdin);
  });
}
const permissionInput = overrides => ({
  hook_event_name: 'PermissionRequest', session_id: 'sess-1', cwd: 'C:\\work\\demo',
  permission_mode: 'build', tool_name: 'Bash', tool_use_id: 'call-1',
  tool_input: { command: 'npm test' }, ...overrides,
});
const pendingOf = changes => changes.at(-1)?.find(request => request.state === 'pending');

test('zcode hook reports tool activity; the store builds a running session', async (t) => {
  const fx = await zfixture(t);
  const store = new SessionStore();
  const result = await runHook(fx.descriptor, {
    hook_event_name: 'PreToolUse', session_id: 'sess-1', cwd: 'C:\\work\\demo',
    tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'call-1',
  });
  assert.equal(result.code, 0); assert.equal(result.out, '');
  await until(() => fx.events.length === 1);
  const [event] = fx.events;
  assert.equal(event.provider, 'zcode');
  assert.equal(event.payload.event, 'PreToolUse');
  assert.equal(event.payload.tool.name, 'Bash');
  assert.equal(event.payload.tool.detail, 'npm test');
  assert.equal(event.sessionId, 'sess-1');
  assert.equal(store.applyEvent(event), true);
  const view = store.snapshot()[0];
  assert.equal(view.provider, 'zcode');
  assert.equal(view.phase, 'running');
  assert.equal(view.project, 'demo');
  assert.equal(view.currentTool.name, 'Bash');
});

test('prompt submit records the last user text and a session title', async (t) => {
  const fx = await zfixture(t);
  const store = new SessionStore();
  const result = await runHook(fx.descriptor, {
    hook_event_name: 'UserPromptSubmit', session_id: 'sess-1', cwd: 'C:\\work\\demo', prompt: '修复认证流程\n补充回归',
  });
  assert.equal(result.code, 0);
  await until(() => fx.events.length === 1);
  const event = fx.events[0];
  assert.equal(event.payload.event, 'UserPromptSubmit');
  assert.match(event.payload.title, /^demo: 修复认证流程/);
  store.applyEvent(event);
  const view = store.snapshot()[0];
  assert.equal(view.lastUserText, '修复认证流程 补充回归');
  assert.match(view.title, /^demo: 修复认证流程/);
});

test('stop completes the session', async (t) => {
  const fx = await zfixture(t);
  const store = new SessionStore();
  const result = await runHook(fx.descriptor, { hook_event_name: 'Stop', session_id: 'sess-1', cwd: 'C:\\work\\demo' });
  assert.equal(result.code, 0);
  await until(() => fx.events.length === 1);
  store.applyEvent(fx.events[0]);
  assert.equal(store.snapshot()[0].phase, 'completed');
});

test('permission request is relayed and an island allow reaches ZCode', async (t) => {
  const fx = await zfixture(t);
  const store = new SessionStore();
  const pending = runHook(fx.descriptor, permissionInput({}));
  await until(() => pendingOf(fx.changes)?.kind === 'approval');
  const request = pendingOf(fx.changes);
  assert.equal(request.provider, 'zcode');
  assert.equal(request.payload.tool.name, 'Bash');
  assert.equal(request.payload.tool.detail, 'npm test');
  assert.equal(request.payload.cwd, 'C:\\work\\demo');
  const responded = await fx.hub.respond(request.id, 'allow');
  const result = await pending;
  assert.equal(responded.status, 'delivered');
  assert.equal(result.code, 0);
  const decision = JSON.parse(result.out);
  assert.equal(decision.hookSpecificOutput.hookEventName, 'PermissionRequest');
  assert.equal(decision.hookSpecificOutput.decision.behavior, 'allow');
  await until(() => fx.events.some(e => e.payload.event === 'ApprovalDecided'));
  const confirmation = fx.events.find(e => e.payload.event === 'ApprovalDecided');
  assert.equal(confirmation.payload.outcome, 'allowed-once');
  assert.equal(confirmation.payload.requestId, request.requestId);
  store.applyEvent(confirmation);
});

test('an island allow-always returns ZCode permission rule updates for the command subject', async (t) => {
  const fx = await zfixture(t);
  const pending = runHook(fx.descriptor, permissionInput({}));
  await until(() => pendingOf(fx.changes)?.kind === 'approval');
  const request = pendingOf(fx.changes);
  assert.equal(request.payload.tool.alwaysAllowSubject, 'npm test',
    'the card can only offer the button when ZCode has a rule subject to persist');
  const responded = await fx.hub.respond(request.id, 'allow-always');
  const result = await pending;
  assert.equal(responded.status, 'delivered');
  assert.equal(result.code, 0);
  const decision = JSON.parse(result.out).hookSpecificOutput.decision;
  assert.deepEqual(decision, { behavior: 'allow',
    permissionUpdates: [{ type: 'addRules', behavior: 'allow', rules: [{ toolName: 'Bash', ruleContent: 'npm test' }] }] });
  await until(() => fx.events.some(e => e.payload.event === 'ApprovalDecided'));
  assert.equal(fx.events.find(e => e.payload.event === 'ApprovalDecided').payload.outcome, 'allowed-always');
});

test('a tool without a rule subject offers no always-allow subject to the island', async (t) => {
  const fx = await zfixture(t);
  const pending = runHook(fx.descriptor, permissionInput({ tool_name: 'NotebookEdit', tool_input: { notebook: 'C:\\x\\y.ipynb', new_source: 'x' } }));
  await until(() => pendingOf(fx.changes)?.kind === 'approval');
  const request = pendingOf(fx.changes);
  assert.equal(request.payload.tool.alwaysAllowSubject, undefined);
  await fx.hub.respond(request.id, 'deny');
  const result = await pending;
  assert.equal(JSON.parse(result.out).hookSpecificOutput.decision.behavior, 'deny');
});

test('island deny maps to a deny decision with a message', async (t) => {
  const fx = await zfixture(t);
  const pending = runHook(fx.descriptor, permissionInput({ tool_name: 'Write', tool_input: { file_path: 'C:\\x\\y.ts' } }));
  await until(() => pendingOf(fx.changes)?.kind === 'approval');
  const request = pendingOf(fx.changes);
  assert.equal(request.payload.tool.target, 'C:\\x\\y.ts');
  await fx.hub.respond(request.id, 'deny');
  const result = await pending;
  const decision = JSON.parse(result.out).hookSpecificOutput.decision;
  assert.equal(decision.behavior, 'deny');
  assert.ok(decision.message.includes('Island HUD'));
});

test('read-only tools and yolo mode never reach the island', async (t) => {
  const fx = await zfixture(t);
  for (const payload of [
    permissionInput({ tool_name: 'Read', tool_input: { file_path: 'C:\\a.ts' } }),
    permissionInput({ permission_mode: 'yolo' }),
  ]) {
    const result = await runHook(fx.descriptor, payload);
    assert.equal(result.code, 0); assert.equal(result.out, '');
  }
  await new Promise(r => setTimeout(r, 200));
  assert.equal(fx.changes.at(-1)?.length || 0, 0);
  assert.equal(fx.events.length, 0);
});

test('a dead island fails open and the native UI keeps working', async (t) => {
  const ghost = path.join(os.tmpdir(), 'island-hud-no-bridge', 'integration-v2.json');
  const result = await runHook(ghost, permissionInput({}));
  assert.equal(result.code, 0); assert.equal(result.out, '');
});

test('zcode envelopes are rejected when the hub disables the provider', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-zcode-closed-'));
  const descriptor = path.join(dir, 'integration-v2.json');
  const hub = new IntegrationHub({ descriptorPath: descriptor, allowedProviders: ['dsh'] });
  t.after(() => { hub.stop(); fs.rmSync(dir, { recursive: true, force: true }); });
  hub.start();
  await until(() => fs.existsSync(descriptor));
  const result = await runHook(descriptor, permissionInput({}));
  assert.equal(result.code, 0); assert.equal(result.out, '');
});

test('question relay maps island answers into updatedInput', async (t) => {
  const fx = await zfixture(t);
  const pending = runHook(fx.descriptor, permissionInput({
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '选择发布环境', options: [{ label: '生产环境' }, { label: '预发布' }] }] },
  }));
  await until(() => pendingOf(fx.changes)?.kind === 'question');
  const request = pendingOf(fx.changes);
  assert.equal(request.payload.questions[0].question, '选择发布环境');
  assert.deepEqual(request.payload.questions[0].options.map(o => o.label), ['生产环境', '预发布']);
  await fx.hub.respond(request.id, 'answer', { answers: [{ id: 'q0', selected: ['生产环境'] }] });
  const result = await pending;
  const decision = JSON.parse(result.out).hookSpecificOutput.decision;
  assert.equal(decision.behavior, 'allow');
  assert.equal(decision.updatedInput.answers['选择发布环境'], '生产环境');
});

test('a returned question falls back to the native UI', async (t) => {
  const fx = await zfixture(t);
  const pending = runHook(fx.descriptor, permissionInput({
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question: '选择', options: [{ label: '甲' }, { label: '乙' }] }] },
  }));
  await until(() => pendingOf(fx.changes)?.kind === 'question');
  await fx.hub.respond(pendingOf(fx.changes).id, 'return');
  const result = await pending;
  assert.equal(result.code, 0); assert.equal(result.out, '');
});
