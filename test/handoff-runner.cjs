'use strict';
// Handoff runner: exercises the opt-in approval/question handoff against the
// real application. Runs with ISLAND_HUD_TEST_HANDOFF_SECONDS=2 (set below
// before the real main.js loads), so every untouched card must return to the
// client's own approval UI after ~2s, while interaction (collapse) holds it.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const { exchange } = require('../src/integrations/client');

process.env.ISLAND_HUD_TEST_HANDOFF_SECONDS = '2';

const root = process.env.ISLAND_HUD_TEST_ROOT;
const descriptor = path.join(root, 'integration-v2.json');
const resultFile = path.join(root, 'handoff-result.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;

async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error('handoff condition timed out');
}

const snapshot = () => win.webContents.executeJavaScript('window.island.native.snapshot()');
const expiryText = () => win.webContents.executeJavaScript(
  'document.querySelector("[data-native-expiry]")?.textContent || ""');

async function countdownShows() {
  await until(async () => /秒后回客户端/.test(await expiryText()));
}

app.on('browser-window-created', (_event, created) => { win = created; });
require('../src/probe/main.cjs');

app.whenReady().then(async () => {
  const checks = [];
  try {
    await until(() => win && !win.webContents.isLoading() && fs.existsSync(descriptor));
    await until(() => win.webContents.executeJavaScript('!!window.__islandApp'));

    // 1. An untouched approval counts down and returns to the client after ~2s.
    let settled = null;
    const approval = exchange({
      id: 'handoff-approval', provider: 'dsh', kind: 'approval', sessionId: 'handoff-session',
      payload: { tool: { name: 'pwsh', detail: 'handoff auto-return regression' } },
    }, { descriptor }).then(reply => { settled = reply; return reply; });
    await until(async () => (await snapshot()).some(r => r.requestId === 'handoff-approval' && r.state === 'pending'));
    await countdownShows();
    const reply = await Promise.race([approval, pause(6000).then(() => null)]);
    if (!reply) throw new Error('approval was not handed back to the client within the budget');
    if (reply.decision !== 'return') throw new Error('handoff decision was ' + reply.decision + ', expected return');
    if (reply.status !== 'delivered') throw new Error('handoff status was ' + reply.status);
    await until(async () => !(await snapshot()).some(r => r.requestId === 'handoff-approval' && r.state === 'pending'));
    checks.push('an untouched approval card counts down and returns the decision to the client automatically');

    // 2. The same holds for a question card.
    const question = exchange({
      id: 'handoff-question', provider: 'dsh', kind: 'question', sessionId: 'handoff-session',
      payload: { questions: [{ id: 'q0', question: '让位回归？', options: [{ label: '是' }, { label: '否' }] }] },
    }, { descriptor }).then(reply => { settled = reply; return reply; });
    await until(async () => (await snapshot()).some(r => r.requestId === 'handoff-question' && r.state === 'pending'));
    await countdownShows();
    const questionReply = await Promise.race([question, pause(6000).then(() => null)]);
    if (!questionReply || questionReply.decision !== 'return') {
      throw new Error('question was not handed back automatically: ' + JSON.stringify(questionReply));
    }
    checks.push('an untouched question card hands the prompt back to the client as well');

    // 3. Collapsing the card pauses the countdown: no handoff while hidden.
    let collapsedResolved = false;
    const held = exchange({
      id: 'handoff-held', provider: 'dsh', kind: 'approval', sessionId: 'handoff-session',
      payload: { tool: { name: 'pwsh', detail: 'collapse holds the handoff' } },
    }, { descriptor }).then(r => { collapsedResolved = true; return r; });
    await until(async () => (await snapshot()).some(r => r.requestId === 'handoff-held' && r.state === 'pending'));
    await countdownShows();
    await win.webContents.executeJavaScript('document.querySelector("[data-native-action=collapse]").click()');
    await pause(3500);
    if (collapsedResolved) throw new Error('collapsed card was handed back anyway');
    await until(async () => (await snapshot()).some(r => r.requestId === 'handoff-held' && r.state === 'pending'));
    checks.push('collapsing the card pauses the countdown until it is expanded again');

    // 4. Expanding restarts the countdown; the card still hands back.
    await win.webContents.executeJavaScript('window.__islandApp.toggleOverview()');
    await countdownShows();
    const heldReply = await Promise.race([held, pause(6000).then(() => null)]);
    if (!heldReply || heldReply.decision !== 'return') throw new Error('re-expanded card was not handed back');
    checks.push('re-expanding the card restarts the countdown and hands the request back');

    // 5. Editing holds the handoff — and the countdown must genuinely restart
    // after the edit is released. A timer that fired while the user was busy
    // used to leave the card stuck on a stale, already-expired deadline.
    let editResolved = false;
    const editing = exchange({
      id: 'handoff-edit', provider: 'dsh', kind: 'question', sessionId: 'handoff-session',
      payload: { questions: [{ id: 'q0', question: '编辑保持？', options: [{ label: '是' }, { label: '否' }] }] },
    }, { descriptor }).then(r => { editResolved = true; return r; });
    await until(async () => (await snapshot()).some(r => r.requestId === 'handoff-edit' && r.state === 'pending'));
    await countdownShows();
    await win.webContents.executeJavaScript('document.querySelector("textarea").dispatchEvent(new Event("pointerdown", {bubbles:true}))');
    await pause(3000); // Longer than the 2s budget: the timer fires while busy.
    if (editResolved) throw new Error('card was handed back while the user was editing');
    await until(async () => (await snapshot()).some(r => r.requestId === 'handoff-edit' && r.state === 'pending'));
    await win.webContents.executeJavaScript('window.dispatchEvent(new Event("blur"))');
    await countdownShows(); // The countdown restarts instead of freezing.
    const editReply = await Promise.race([editing, pause(6000).then(() => null)]);
    if (!editReply || editReply.decision !== 'return') throw new Error('released edit was not handed back: ' + JSON.stringify(editReply));
    checks.push('editing holds the countdown and releasing the edit re-arms it to a real handoff');

    fs.writeFileSync(resultFile, JSON.stringify({ status: 'passed', checks,
      electron: process.versions.electron, handoffSeconds: process.env.ISLAND_HUD_TEST_HANDOFF_SECONDS,
      note: 'Real application with exchange protocol fixtures; the client-side decision path (return) is provider-independent.',
    }, null, 2));
  } catch (error) {
    fs.writeFileSync(resultFile, JSON.stringify({ status: 'failed', error: error.stack,
      snapshot: await snapshot().catch(() => null) }, null, 2));
    process.exitCode = 1;
  } finally {
    await pause(150);
    app.quit();
  }
});
