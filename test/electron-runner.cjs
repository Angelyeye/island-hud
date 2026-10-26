'use strict';
// Controls our isolated application only. Protocol fixtures are not real-client verification.
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { exchange } = require('../src/integrations/client');
const { saveScreenshot } = require('./helpers.cjs');
const root = process.env.ISLAND_HUD_TEST_ROOT;
const descriptor = path.join(root, 'integration-v2.json');
const results = [];
let win;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 150; i++) { if (await check()) return; await pause(30); } throw new Error('GUI condition timed out'); }
const js = code => win.webContents.executeJavaScript(code);
const request = (id, question, options = {}) => exchange({ id, provider: 'dsh', kind: 'question', sessionId: null,
  payload: { questions: [{ id: 'q', question }] } }, { descriptor, ...options });
const click = name => js(`document.querySelector('[data-native-action="${name}"]').click()`);
app.on('browser-window-created', (_event, created) => { win = created; });
require('../src/probe/main.cjs');
app.whenReady().then(async () => {
  try {
    await until(() => win && !win.webContents.isLoading() && fs.existsSync(descriptor));
    await until(() => js('!!window.__islandApp'));
    assert.match(win.webContents.getURL(), /renderer\/index\.html/);
    assert.equal(win.getBounds().width, 568);
    assert.equal(await js('document.querySelector("#notch").style.height'), '34px');
    results.push('probe entrypoint uses the actual notch renderer and compact reference geometry');
    const a = request('gui-A', '第一道问题');
    await until(() => js('!!document.querySelector("textarea")'));
    assert.equal(win.isFocused(), false); results.push('incoming request does not take keyboard focus');
    await js('document.querySelector("textarea").dispatchEvent(new Event("pointerdown", {bubbles:true}))');
    await until(() => win.isFocused());
    assert.equal(await js('document.activeElement?.tagName'), 'TEXTAREA');
    await js('window.draftNode=document.querySelector("textarea");window.draftNode.value="正在编辑的中文草稿";window.draftNode.dispatchEvent(new Event("input",{bubbles:true}))');
    const b = request('gui-B', '第二道问题');
    await until(async () => (await js('window.island.native.snapshot()')).length === 2);
    await pause(100);
    assert.equal(await js('window.draftNode === document.querySelector("textarea")'), true);
    assert.equal(await js('document.querySelector("textarea").value'), '正在编辑的中文草稿');
    results.push('new requests and session refreshes preserve the exact input node and Chinese draft');
    await click('collapse');
    assert.equal(await js('window.__islandApp.getState().scene'), 'compact');
    assert.equal((await js('window.island.native.snapshot()')).length, 2);
    await js('document.querySelector("[data-layer=compact]").click()');
    assert.equal(await js('document.querySelector("textarea").value'), '正在编辑的中文草稿');
    results.push('collapse keeps the host channel and reopening restores the draft');
    win.webContents.reload();
    await until(() => !win.webContents.isLoading() && js('document.querySelector("textarea")?.value === "正在编辑的中文草稿"'));
    assert.equal((await js('window.island.native.snapshot()')).length, 2);
    assert.equal(win.isFocused(), false);
    results.push('renderer restart restores the exact live question draft and queue without taking focus or submitting');
    await click('next');
    assert.match(await js('document.querySelector(".native-review").textContent'), /正在编辑的中文草稿/);
    await js('document.querySelector("[data-native-action=submit]").click();document.querySelector("[data-native-action=submit]")?.click()');
    assert.equal((await a).answers[0].custom, '正在编辑的中文草稿');
    await until(() => js('document.querySelector("legend")?.textContent.includes("第二道")'));
    results.push('review and double submit deliver one answer to the original invocation');
    await until(() => !win.isFocused());
    results.push('keyboard focus is disabled after submission');
    await click('return'); assert.equal((await b).decision, 'return');
    await until(async () => (await js('window.island.native.snapshot()')).length === 0);

    const questions = [{ id: 'single', question: '选择一个', options: [{ label: 'A' }, { label: 'B' }] },
      { id: 'multi', question: '多选和中文', multiSelect: true, options: ['X','Y','Z'].map(label => ({ label })) },
      { id: 'text', question: '自由文本' }];
    const batch = exchange({ id: 'gui-batch', provider: 'dsh', kind: 'question', sessionId: 'shared-session',
      payload: { questions, cwd: 'C:\\中文路径\\带 空格项目' } }, { descriptor });
    await until(() => js('!!document.querySelector("fieldset[data-id=single]")'));
    await js('document.querySelector("input[value=B]").click()'); await click('next');
    await js('document.querySelector("input[value=X]").click();document.querySelector("input[value=Z]").click();document.querySelector("textarea").value="中文验收 019";document.querySelector("textarea").dispatchEvent(new Event("input",{bubbles:true}))');
    await click('next');
    await js('document.querySelector("textarea").value="自由回答";document.querySelector("textarea").dispatchEvent(new Event("input",{bubbles:true}))');
    await click('prev');
    assert.deepEqual(await js('[...document.querySelectorAll("input:checked")].map(x=>x.value)'), ['X', 'Z']);
    assert.equal(await js('document.querySelector("textarea").value'), '中文验收 019');
    await click('next'); await click('next');
    assert.match(await js('document.querySelector(".native-review").textContent'), /中文验收 019/);
    await pause(600);
    await saveScreenshot(win, path.join(root, 'native-questions.png'));
    await click('submit');
    assert.deepEqual((await batch).answers, [{ id: 'single', selected: ['B'] }, { id: 'multi', selected: ['X','Z'], custom: '中文验收 019' }, { id: 'text', selected: [], custom: '自由回答' }]);
    results.push('question pagination and review preserve single, multiple and Chinese text answers by stable question ID');
    await until(async () => (await js('window.island.native.snapshot()')).length === 0);

    const approval = id => exchange({ id, provider: 'dsh', kind: 'approval', sessionId: 'shared-session',
      payload: { tool: { name: 'safe-test', detail: 'echo fixture' } } }, { descriptor });
    const allow = approval('first-request');
    await until(async () => (await js('window.island.native.snapshot()')).length === 1);
    assert.match(await js('document.querySelector("[data-native-expiry]").textContent'), /剩余 \d+:\d{2}/);
    const deny = approval('second-request');
    await until(async () => (await js('window.island.native.snapshot()')).length === 2);
    assert.equal(await js('window.__islandApp.getState().scene'), 'approval');
    await pause(600);
    await saveScreenshot(win, path.join(root, 'native-approval.png'));
    await js('document.querySelector("[data-native-action=allow]").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0}))');
    assert.equal((await allow).decision, 'allow');
    await until(async () => (await js('window.island.native.snapshot()'))[0]?.requestId === 'second-request');
    await js('document.querySelector("[data-native-action=deny]").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0}))');
    assert.equal((await deny).decision, 'deny');
    assert.notEqual(await js('window.__islandApp.getState().scene'), 'approved');
    results.push('concurrent DSH requests in one session keep separate FIFO approval channels; adapter receipt never shows approved');

    await exchange({ id: 'start-event', provider: 'dsh', kind: 'event', sessionId: 'nonblocking-session', payload: { event: 'SessionStart' } }, { descriptor });
    const controller = new AbortController();
    const pending = exchange({ id: 'gui-cancel', provider: 'dsh', kind: 'question', sessionId: 'nonblocking-session', blocking: false,
      payload: { questions: [{ id: 'nonblocking', question: '可继续工作的问题' }] } }, { descriptor, signal: controller.signal });
    await until(() => js('!!document.querySelector("textarea")'));
    assert.equal((await js('window.island.snapshot()')).find(s => s.rawId === 'nonblocking-session').phase, 'running');
    results.push('a nonblocking question does not pause its native session');
    controller.abort(); assert.equal((await pending).status, 'cancelled');
    await until(() => js('!document.querySelector("[data-native=true]")'));
    results.push('host cancellation removes editable native controls');
    const foregroundController = new AbortController();
    const reconnectEnvelope = { provider: 'dsh', kind: 'question', sessionId: 'reconnect-session',
      payload: { callId: 'exact-native-call', questions: [{ id: 'reconnect', question: '等待接续' }] } };
    const foreground = exchange({ ...reconnectEnvelope, id: 'foreground-call', blocking: true }, { descriptor, signal: foregroundController.signal });
    await until(() => js('!!document.querySelector("fieldset[data-id=reconnect]")'));
    await js('document.querySelector("textarea").value="接续中文草稿";document.querySelector("textarea").dispatchEvent(new Event("input",{bubbles:true}))');
    foregroundController.abort(); await foreground;
    await until(() => js('!document.querySelector("[data-native=true]")'));
    const continued = exchange({ ...reconnectEnvelope, id: 'continued-call', blocking: false }, { descriptor });
    await until(() => js('document.querySelector("textarea")?.value === "接续中文草稿"'));
    assert.match(await js('document.querySelector("[data-layer=ask][data-native=true] .native-head").textContent'), /可继续工作/);
    await js('document.querySelector("[data-native-action=return]").dispatchEvent(new MouseEvent("mousedown",{bubbles:true,button:0}))');
    assert.equal((await continued).decision, 'return');
    results.push('foreground-to-continued question reconnect restores drafts only for the same exact native call');
    assert.match(fs.readFileSync(path.join(root, 'bridge-evidence.jsonl'), 'utf8'), /secured pipe/);
    results.push('actual SID-restricted C# named-pipe helper is active');
    const display = require('electron').screen.getPrimaryDisplay();
    fs.writeFileSync(path.join(root, 'electron-test-result.json'), JSON.stringify({ status: 'passed', checks: results,
      electron: process.versions.electron, display: { size: display.size, scaleFactor: display.scaleFactor },
      note: 'Own application and protocol fixtures only; not real-client verification.' }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(root, 'electron-test-result.json'), JSON.stringify({ status: 'failed', checks: results, error: error.stack }, null, 2)); process.exitCode = 1;
  } finally { app.quit(); }
});
