'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { fixture, until } = require('./helpers.cjs');
const { execFileSync } = require('node:child_process');
execFileSync(process.execPath, ['tools/build-integrations.cjs']);
async function setup(t, services = {}) {
  const base = await fixture(t), handlers = new Map();
  const { apply } = await import('../integrations/dsh/index.mjs');
  apply({ on: (event, handler, options) => handlers.set(event, { handler, options }), get: name => services[name] }, { descriptorPath: base.descriptor });
  t.after(() => handlers.get('dispose').handler());
  const session = { id: 'native-session', header: { cwd: 'C:\\项目 有空格' } }, agent = { session };
  return { ...base, handlers, session, agent };
}
test('DSH allow/reject preserves audit ID, exact session, and native outcome vocabulary', async t => {
  const { hub, handlers, session, agent } = await setup(t);
  assert.equal(handlers.get('approval/request').options.prepend, true);
  for (const decision of ['allow', 'deny']) {
    handlers.get('session/event').handler(session, { type: 'approval/asked', data: { id: 'audit-' + decision, callId: 'call', toolName: 'shell' } });
    const outcome = handlers.get('approval/request').handler({ agent, callId: 'call', toolName: 'shell', reason: 'test' }, () => 'native-fallback');
    await until(() => hub.pending.size === 1); const request = hub.snapshot()[0];
    assert.equal(request.requestId, 'audit-' + decision); assert.equal(request.sessionId, session.id); assert.equal(request.payload.cwd, session.header.cwd);
    await hub.respond(request.id, decision); assert.equal(await outcome, decision === 'allow' ? 'allowed-once' : 'rejected');
  }
});

test('DSH continued questions reconnect from native projection without blocking and call the native answer API', async t => {
  const services = {}, { hub, handlers, session, agent, events } = await setup(t, services);
  agent.id = 'root-agent';
  const question = { callId: 'continued-call', state: 'continued', questions: [{ id: 'late', question: 'Continue?', options: [{ label: 'A' }] }] };
  const projection = { questions: { active: [question] } }, received = [];
  services.agents = { roots: () => [agent], get: () => agent };
  services.sessionProjections = { stateOf: () => projection };
  services.userQuestions = { answer: (owner, callId, value) => { received.push({ owner, callId, value }); return true; } };
  await until(() => hub.pending.size === 1);
  const request = hub.snapshot()[0];
  assert.equal(request.blocking, false); assert.equal(request.payload.continued, true); assert.equal(request.sessionId, session.id);
  const answers = [{ id: 'late', selected: ['A'] }];
  assert.equal((await hub.respond(request.id, 'answer', { answers })).status, 'delivered');
  assert.equal(received.length, 1); assert.equal(received[0].owner, agent); assert.equal(received[0].callId, question.callId);
  assert.deepEqual(received[0].value, { answers });
  handlers.get('session/event').handler(session, { type: 'user/message', data: { source: { kind: 'user-question-reply', callId: question.callId } } });
  await until(() => events.some(event => event.payload.event === 'QuestionAnswered'));
  assert.equal(events.find(event => event.payload.event === 'QuestionAnswered').payload.requestId, request.requestId);
  projection.questions.active = [];
});

test('DSH another client answering a continued question produces already_handled and never a second reply', async t => {
  const services = {}, { hub, agent } = await setup(t, services); agent.id = 'root';
  services.agents = { roots: () => [agent], get: () => agent };
  services.sessionProjections = { stateOf: () => ({ questions: { active: [{ callId: 'queued', state: 'continued', questions: [{ id: 'q', question: 'Queued?' }] }] } }) };
  services.userQuestions = { answer: () => { throw Object.assign(new Error('Another client queued the answer'), { code: 'REPLY_QUEUED' }); } };
  await until(() => hub.pending.size === 1); const request = hub.snapshot()[0];
  assert.equal((await hub.respond(request.id, 'answer', { answers: [{ id: 'q', selected: [], custom: 'late' }] })).status, 'already_handled');
  await until(() => hub.pending.size === 0);
});

test('DSH legacy questions use only a unique exact native call match and confirm from its tool result', async t => {
  const { hub, handlers, session, agent, events } = await setup(t);
  const questions = [{ id: 'unique', question: 'Which?', options: [{ label: 'A' }], multi_select: true }];
  handlers.get('session/event').handler(session, { type: 'tool/call', data: { name: 'ask_user_question', callId: 'legacy-call', arguments: JSON.stringify({ questions }) } });
  const nativeQuestions = questions.map(({ multi_select, ...q }) => ({ ...q, multiSelect: multi_select }));
  const pending = handlers.get('user-questions/request').handler({ agent, questions: nativeQuestions }, () => 'fallback');
  await until(() => hub.pending.size === 1); const request = hub.snapshot()[0];
  assert.equal(request.payload.callId, 'legacy-call');
  const answers = [{ id: 'unique', selected: ['A'] }];
  await hub.respond(request.id, 'answer', { answers }); assert.deepEqual(await pending, { answers });
  handlers.get('session/event').handler(session, { type: 'tool/result', data: { message: { toolCallId: 'legacy-call', content: [{ type: 'text', text: JSON.stringify({ answers }) }] } } });
  await until(() => events.some(event => event.payload.event === 'QuestionAnswered'));
  assert.equal(events.find(event => event.payload.event === 'QuestionAnswered').payload.requestId, request.requestId);
});

test('DSH identical concurrent legacy calls are not assigned by recency', async t => {
  const { hub, handlers, session, agent } = await setup(t), questions = [{ id: 'same', question: 'Identical?' }];
  for (const callId of ['one', 'two']) handlers.get('session/event').handler(session, { type: 'tool/call', data: { name: 'ask_user_question', callId, arguments: JSON.stringify({ questions }) } });
  const pending = handlers.get('user-questions/request').handler({ agent, questions }, () => 'native-fallback');
  await until(() => hub.pending.size === 1); const request = hub.snapshot()[0];
  assert.equal(request.payload.callId, null);
  await hub.respond(request.id, 'return'); assert.equal(await pending, 'native-fallback');
});

test('DSH native lifecycle events report safe activity and only a native audit confirms approval', async t => {
  const { handlers, session, events } = await setup(t);
  const emit = (type, data = {}) => handlers.get('session/event').handler(session, { type, data });
  emit('turn/start'); emit('tool/call', { callId: 'T', name: 'bash', arguments: 'secret must not leave as an activity event' });
  emit('tool/result', { message: { toolCallId: 'T', content: [] } }); emit('turn/end');
  emit('approval/decided', { id: 'audit-native', outcome: 'allowed-once' });
  await until(() => events.length >= 6);
  assert.deepEqual(events.filter(e => e.sessionId).map(e => e.payload.event), ['UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'ApprovalDecided']);
  assert.ok(events.every(e => !JSON.stringify(e.payload).includes('secret must not leave')));
});
test('DSH return/unavailable delegates existing chain; host cancellation and mid-flight island exit never become consent', async t => {
  const { hub, handlers, agent } = await setup(t);
  let fallbacks = 0; const next = () => { fallbacks++; return 'native-fallback'; };
  const outcome = handlers.get('approval/request').handler({ agent, toolName: 'shell' }, next);
  await until(() => hub.pending.size === 1); await hub.respond(hub.snapshot()[0].id, 'return');
  assert.equal(await outcome, 'native-fallback');
  const controller = new AbortController(); const cancelled = handlers.get('approval/request').handler({ agent, toolName: 'shell', signal: controller.signal }, next);
  await until(() => hub.pending.size === 1); controller.abort(); assert.equal(await cancelled, 'cancelled');
  const exited = handlers.get('approval/request').handler({ agent, toolName: 'shell' }, next);
  await until(() => hub.pending.size === 1); hub.stop();
  assert.equal(await exited, 'native-fallback');
  assert.equal(await handlers.get('approval/request').handler({ agent, toolName: 'shell' }, next), 'native-fallback');
  assert.equal(fallbacks, 3);
});
test('DSH timed questions use host deadline and answer format; native abort withdraws island request', async t => {
  const { hub, handlers, agent } = await setup(t);
  const questions = [{ id: 'a', question: 'Which?', options: [{ label: 'A' }] }, { id: 'b', question: 'Custom?' }];
  const controller = new AbortController();
  const pending = handlers.get('user-questions/request').handler({ agent, questions, wait: { callId: 'timed-call', timed: true }, signal: controller.signal }, () => 'fallback');
  await until(() => hub.pending.size === 1); const request = hub.snapshot()[0]; assert.equal(request.payload.timed, true);
  const answers = [{ id: 'a', selected: ['A'] }, { id: 'b', selected: [], custom: '中文' }];
  await hub.respond(request.id, 'answer', { answers }); assert.deepEqual(await pending, { answers });
  const aborted = handlers.get('user-questions/request').handler({ agent, questions, signal: controller.signal }, () => 'fallback').catch(e => e);
  await until(() => hub.pending.size === 1); controller.abort(); assert.ok(await aborted instanceof Error); await until(() => !hub.pending.size);
});
test('DSH continued question survives an unavailable island and resumes exactly once after restart', async t => {
  const { IntegrationHub } = require('../src/integrations/hub');
  const services = {}, handlers = new Map(), { apply } = await import('../integrations/dsh/index.mjs');
  const base = await fixture(t), descriptorPath = base.descriptor;
  base.hub.stop();
  const session = { id: 'restart-session', header: { cwd: 'C:\\项目 有空格' } }, agent = { id: 'restart-agent', session };
  const question = { callId: 'restart-call', state: 'continued', questions: [{ id: 'late', question: 'Reconnect?', options: [{ label: 'A' }] }] };
  const projection = { questions: { active: [question] } };
  services.agents = { roots: () => [agent], get: () => agent };
  services.sessionProjections = { stateOf: () => projection };
  let answered = 0;
  services.userQuestions = { answer: () => { answered++; return true; } };
  apply({ on: (event, handler) => handlers.set(event, { handler }), get: name => services[name] }, { descriptorPath });
  t.after(() => handlers.get('dispose').handler());
  await new Promise(resolve => setTimeout(resolve, 1800));
  const restarted = new IntegrationHub({ descriptorPath });
  t.after(() => restarted.stop());
  restarted.start();
  await until(() => restarted.pending.size === 1, 6000);
  const request = restarted.snapshot()[0];
  assert.equal(request.sessionId, session.id);
  assert.equal(request.payload.callId, question.callId);
  assert.equal(request.blocking, false);
  assert.equal((await restarted.respond(request.id, 'answer', { answers: [{ id: 'late', selected: ['A'] }] })).status, 'delivered');
  assert.equal(answered, 1);
  projection.questions.active = [];
});
