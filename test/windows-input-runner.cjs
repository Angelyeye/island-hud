'use strict';
// Sends one real Windows mouse event to an isolated copy of our own overlay.
// This covers the non-activating click-through transition that DOM click tests miss.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { exchange } = require('../src/integrations/client');
const windowsInput = require('./windows-input.cjs');
const { saveScreenshot } = require('./helpers.cjs');
const root = process.env.ISLAND_HUD_TEST_ROOT;
const descriptor = path.join(root, 'integration-v2.json');
const resultFile = path.join(root, 'windows-input-result.json');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
let win;

async function until(check, timeout = 8000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await pause(50);
  }
  throw new Error('GUI condition timed out');
}

// Real pointer input: renderer coordinates are DIP, Windows input uses physical
// pixels, including when Chromium is exercising a forced DPI scale.
const clickAt = (x, y) => windowsInput.clickAt(x, y);

function sendKeys(keys) {
  for (const keyCode of keys) win.webContents.sendInputEvent({ type: 'char', keyCode });
}

const cursorPosition = () => windowsInput.cursorPosition();

app.on('browser-window-created', (_event, created) => { win = created; });
require('../src/probe/main.cjs');

app.whenReady().then(async () => {
  if (!windowsInput.injectionAvailable()) {
    fs.writeFileSync(resultFile, JSON.stringify({ status: 'skipped',
      reason: 'pointer input from processes spawned by this agent is filtered; the desktop itself accepts input, so run the pointer runners from your own terminal' }, null, 2));
    app.quit(); return;
  }
  const previousCursor = cursorPosition();
  let controller, pending;
  try {
    await until(() => win && !win.webContents.isLoading() && fs.existsSync(descriptor));
    await until(() => win.webContents.executeJavaScript('!!window.__islandApp'));
    const replies = [];
    const create = (decision, suffix = '') => {
      controller = new AbortController();
      return exchange({
        id: `windows-input-${decision}${suffix}`,
        provider: 'dsh',
        kind: 'approval',
        sessionId: 'windows-input-session',
        payload: { tool: { name: 'pwsh', detail: `real Windows input ${decision}${suffix} regression` } },
      }, { descriptor, signal: controller.signal });
    };
    pending = create('allow');
    await until(() => win.webContents.executeJavaScript(
      '(async()=> { const r=await window.island.native.snapshot(); return r.length===1 && r[0].requestId==="windows-input-allow"; })()'));
    let queued = create('deny', '-queued');
    await until(() => win.webContents.executeJavaScript(
      '(async()=> (await window.island.native.snapshot()).length === 2)()'));
    for (const decision of ['allow', 'deny']) {
      await until(() => win.webContents.executeJavaScript(
        `!!document.querySelector("[data-native-action=${decision}]")`));
      await pause(800);
      const button = await win.webContents.executeJavaScript(`(() => {
        const r = document.querySelector('[data-native-action=${decision}]').getBoundingClientRect();
        return { x: r.left, y: r.top, width: r.width, height: r.height };
      })()`);
      const bounds = win.getBounds();
      console.log('pointer-target', JSON.stringify({ decision, bounds, button }));
      await clickAt(bounds.x + button.x + button.width / 2, bounds.y + button.y + button.height / 2);
      const reply = await Promise.race([
        pending,
        pause(2500).then(() => ({ status: `timeout-after-windows-click-${decision}` })),
      ]);
      if (reply.decision !== decision) {
        await saveScreenshot(win, path.join(root, 'failed-click.png'));
        console.log('pointer-failure', JSON.stringify(await win.webContents.executeJavaScript('({scene:window.__islandApp.getState().scene,notch:document.querySelector("#notch").getBoundingClientRect().toJSON(), button:document.querySelector("[data-native-action=allow]")?.getBoundingClientRect().toJSON()})')));
        throw new Error(`Real Windows click did not submit ${decision}: ` + JSON.stringify(reply));
      }
      replies.push({ decision, status: reply.status });
      pending = queued;
    }
    await until(async () => (await win.webContents.executeJavaScript(
      'window.island.native.snapshot()')).length === 0);

    pending = create('return');
    await until(() => win.webContents.executeJavaScript(
      '!!document.querySelector("[data-native-action=return]")'));
    await pause(300);
    const returnButton = await win.webContents.executeJavaScript(`(() => {
      const r = document.querySelector('[data-native-action=return]').getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);
    const returnBounds = win.getBounds();
    await clickAt(returnBounds.x + returnButton.x + returnButton.width / 2,
      returnBounds.y + returnButton.y + returnButton.height / 2);
    const returnReply = await Promise.race([
      pending,
      pause(2500).then(() => ({ status: 'timeout-after-windows-click-return' })),
    ]);
    if (returnReply.decision !== 'return') {
      throw new Error('Real Windows click did not submit return: ' + JSON.stringify(returnReply));
    }
    replies.push({ decision: 'return', status: returnReply.status });
    await until(async () => (await win.webContents.executeJavaScript(
      'window.island.native.snapshot()')).length === 0);

    pending = exchange({
      id: 'windows-input-question',
      provider: 'dsh',
      kind: 'question',
      sessionId: 'windows-input-session',
      payload: { questions: [{ id: 'free_text', question: '请输入验收文本', options: [] }] },
    }, { descriptor });
    await until(() => win.webContents.executeJavaScript(
      '!!document.querySelector("textarea")'));
    await pause(800);
    const textArea = await win.webContents.executeJavaScript(`(() => {
      const r = document.querySelector('textarea').getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);
    const textBounds = win.getBounds();
    await clickAt(textBounds.x + textArea.x + textArea.width / 2,
      textBounds.y + textArea.y + textArea.height / 2);
    await until(() => win.isFocused());
    await until(() => win.webContents.executeJavaScript(
      'document.activeElement?.tagName === "TEXTAREA"'));
    sendKeys('VI019');
    await until(() => win.webContents.executeJavaScript(
      'document.querySelector("textarea").value === "VI019"'));
    const nextButton = await win.webContents.executeJavaScript(`(() => {
      const r = document.querySelector('[data-native-action=next]').getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);
    await clickAt(textBounds.x + nextButton.x + nextButton.width / 2,
      textBounds.y + nextButton.y + nextButton.height / 2);
    await until(() => win.webContents.executeJavaScript(
      '!!document.querySelector("[data-native-action=submit]")'));
    const submitButton = await win.webContents.executeJavaScript(`(() => {
      const r = document.querySelector('[data-native-action=submit]').getBoundingClientRect();
      return { x: r.left, y: r.top, width: r.width, height: r.height };
    })()`);
    await clickAt(textBounds.x + submitButton.x + submitButton.width / 2,
      textBounds.y + submitButton.y + submitButton.height / 2);
    const questionReply = await Promise.race([
      pending,
      pause(2500).then(() => ({ status: 'timeout-after-question-submit' })),
    ]);
    assert.deepEqual(questionReply.answers, [{ id: 'free_text', selected: [], custom: 'VI019' }]);
    await until(async () => (await win.webContents.executeJavaScript(
      'window.island.native.snapshot()')).length === 0);
    fs.writeFileSync(resultFile, JSON.stringify({
      status: 'passed',
      checks: [
        'real Windows pointer movement and clicks reach allow, deny and return',
        'a queued second approval remains clickable without moving the pointer',
        'real Windows click focuses the text field and Chromium accepts typed input',
        'question review and submit return the exact typed text to its original DSH invocation',
        'each approval decision returns to its original DSH invocation without mixing',
      ],
      replies,
      electron: process.versions.electron,
      display: { size: win.getContentBounds(), scaleFactor: require('electron').screen.getPrimaryDisplay().scaleFactor },
      note: 'Own application with protocol fixture; this is input-layer regression, not native DSH verification.',
    }, null, 2));
  } catch (error) {
    controller?.abort();
    fs.writeFileSync(resultFile, JSON.stringify({ status: 'failed', error: error.stack }, null, 2));
    process.exitCode = 1;
  } finally {
    try { windowsInput.setCursorPosition(previousCursor.x, previousCursor.y); } catch { /* cursor restoration is best effort */ }
    await pause(150);
    app.quit();
  }
});
