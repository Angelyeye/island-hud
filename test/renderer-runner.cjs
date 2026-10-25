'use strict';
// Own renderer only. No DSH or other client windows and no real user configuration are accessed.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.ISLAND_HUD_TEST_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Absolute test root required');
fs.mkdirSync(root, { recursive: true }); app.setPath('userData', path.join(root, 'electron'));
const checks = [], jumps = [];
let win = null;
let navigationResult = { status: 'unsupported', reason: '未提供已验证的精确会话跳转：session-' + 'long-id-'.repeat(30) };
let list = [];
const sessions = Array.from({ length: 13 }, (_, i) => ({ id: JSON.stringify(['dsh', 'S' + i]), rawId: 'S' + i, provider: 'dsh',
  project: '同一项目', title: '会话 ' + i, phase: i === 0 ? 'completed' : i === 12 ? 'idle' : 'running', updatedAt: Date.now(), currentTool: null }));
ipcMain.handle('island:snapshot', () => list);
ipcMain.handle('island:focus', (_event, id) => { jumps.push(id); return navigationResult; });
ipcMain.handle('island:settings:get', () => ({}));
ipcMain.handle('island:environment:get', () => ({ visible: true, workArea: { width: 1920, height: 1040 } }));
ipcMain.handle('island:native:snapshot', () => []);
const hidden = new Set();
ipcMain.handle('island:session:hide', (_event, id, mode) => {
  const session = list.find(item => item.id === id);
  if (!session) return { ok: false, reason: 'unknown' };
  if (!['idle', 'completed'].includes(session.phase) || (session.pendingRequests || []).length) return { ok: false, reason: 'active' };
  hidden.add(id + ':' + mode); list = list.filter(item => item.id !== id);
  if (win && !win.isDestroyed()) win.webContents.send('island:sessions', list);
  return { ok: true, session: { id, title: session.title } };
});
ipcMain.on('island:bounds', () => {}); ipcMain.on('island:interactive', () => {});
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 100; i++) { if (await check()) return; await pause(30); } throw new Error('Renderer condition timed out'); }
app.whenReady().then(async () => {
  win = new BrowserWindow({ width: 568, height: 624, frame: false, transparent: true, focusable: false, show: false,
    webPreferences: { preload: path.resolve(__dirname, '../src/preload.js'), contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  win.webContents.on('console-message', details => {
    if (details.level === 'warning' || details.level === 'error') console.error(`renderer console ${details.level} ${details.sourceId}:${details.lineNumber} ${details.message}`);
  });
  const js = code => win.webContents.executeJavaScript(code);
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'));
    await until(() => js('window.__islandApp?.getState().syncingSessions === true'));
    await js('window.__islandApp.openOverview()');
    assert.match(await js('document.querySelector("[data-layer=overview]").textContent'), /正在同步会话/);
    checks.push('a fresh host connection reports session synchronization instead of a misleading empty list');
    list = sessions;
    win.webContents.send('island:sessions', list);
    await until(() => js('window.__islandApp?.getSessions().length === 13'));
    win.showInactive();
    await js('window.__islandApp.openOverview();document.querySelector("[data-act=overview-more]").click()');
    const ids = await js('[...document.querySelectorAll(".all-row")].map(el=>el.dataset.id)');
    assert.equal(new Set(ids).size, 13); assert.equal(ids.length, 13);
    assert.equal(await js('document.querySelector("[data-act=all-next]") === null'), true, 'pagination is gone');
    assert.match(await js('document.querySelector(".all-count").textContent'), /13/);
    const scrollList = await js('(() => { const l=document.querySelector(".all-list"); return { scrollHeight:l.scrollHeight, clientHeight:l.clientHeight, dense:l.classList.contains("dense"), rows:l.querySelectorAll(".all-row").length }; })()');
    assert.equal(scrollList.rows, 13);
    assert.equal(scrollList.dense, true, 'many sessions use compact rows');
    assert.ok(scrollList.scrollHeight > scrollList.clientHeight, JSON.stringify(scrollList));
    checks.push('all thirteen sessions render in one scrollable list (no pagination) with compact rows');
    await js('document.querySelectorAll(".all-row")[1].click()');
    await until(() => jumps.length === 1);
    assert.equal(jumps[0], list[1].id); assert.notEqual(jumps[0], list[0].id);
    await until(() => js('document.querySelector("#toast").textContent.includes("请在客户端手动打开")'));
    assert.doesNotMatch(await js('document.querySelector("#toast").textContent'), /session-/);
    checks.push('clicking B submits B even when A is completed; unsupported navigation is disclosed');
    await js('window.__islandApp.setScene("compact")');
    await pause(150);
    const toastBounds = `(() => { const t=document.querySelector('#toast'),r=t.getBoundingClientRect(),n=document.querySelector('#notch').getBoundingClientRect();return {left:r.left,right:r.right,top:r.top,bottom:r.bottom,notchBottom:n.bottom,width:innerWidth,height:innerHeight,content:t.scrollWidth,box:t.clientWidth}; })()`;
    const moving = await js(toastBounds);
    assert.ok(Math.abs(moving.top - moving.notchBottom - 8) < 9, JSON.stringify(moving));
    await pause(500);
    const compact = await js(toastBounds);
    assert.ok(Math.abs(compact.top - 42) <= 1, JSON.stringify(compact));
    assert.ok(compact.left >= 8 && compact.right <= compact.width - 8 && compact.bottom <= compact.height - 8);
    win.showInactive();
    fs.writeFileSync(path.join(root, 'navigation-toast.png'), (await win.webContents.capturePage()).toPNG());
    checks.push('unsupported-session toast is short, stays within the overlay and follows the animated island back to compact height');
    navigationResult = { status: 'navigated', sessionId: list[2].rawId };
    await js('void window.__islandApp.focusTerminal(window.__islandApp.getSessions()[2])');
    await until(() => js('document.querySelector("#toast").textContent.includes("已打开目标会话")'));
    assert.equal(jumps.at(-1), list[2].id);
    checks.push('a precisely navigated Session reports success only after the client acknowledgement');
    await js('window.__islandApp.openOverview()');
    await pause(80);
    const heroId = await js('document.querySelector(".hero-context[data-act=jump]").dataset.id');
    assert.ok(heroId);
    for (const selector of ['.hero-context', '.session-header .session-heading']) {
      const before = jumps.length;
      await js(`document.querySelector(${JSON.stringify(selector)}).click()`);
      await until(() => jumps.length === before + 1);
      assert.equal(jumps.at(-1), heroId);
    }
    checks.push('the current-session header and summary card navigate to their exact Session while header controls remain independent');
    navigationResult = { status: 'failed', reason: '连接异常，请在客户端查看。'.repeat(12) + 'unbroken-identifier-'.repeat(12) };
    await js('void window.__islandApp.focusTerminal(window.__islandApp.getSessions()[1])');
    await until(() => js('document.querySelector("#toast").textContent.includes("连接异常")'));
    const wrapped = await js(toastBounds);
    assert.ok(wrapped.left >= 8 && wrapped.right <= wrapped.width - 8 && wrapped.bottom <= wrapped.height - 8);
    assert.ok(wrapped.content <= wrapped.box + 1, JSON.stringify(wrapped));
    checks.push('long failure text and unbroken identifiers wrap without horizontal or vertical window clipping');
    await js('window.__islandApp.openOverview();document.querySelector("[data-act=overview-more]").click()');
    list = list.slice(0, 7); win.webContents.send('island:sessions', list);
    await until(() => js('window.__islandApp.getSessions().length === 7'));
    assert.match(await js('document.querySelector(".all-count").textContent'), /7/);
    assert.equal(await js('document.querySelectorAll(".all-row").length'), 7);
    checks.push('a shrinking list keeps every remaining session reachable in the scroll list');
    list[0].phase = 'waitingForApproval'; win.webContents.send('island:sessions', list);
    await until(() => js('window.__islandApp.getSessions()[0].phase === "waitingForApproval"'));
    assert.equal(await js('document.querySelector("[data-layer=approval] [data-act=allow]") === null'), true);
    checks.push('an approval recovered only from logs has no actionable approval button');
    await js('window.__islandApp.setScene("all")');
    win.showInactive(); await pause(350);
    const bounds = await js('({list:document.querySelector(".all-list").getBoundingClientRect().bottom,notch:document.querySelector("#notch").getBoundingClientRect().bottom})');
    assert.ok(bounds.list <= bounds.notch);
    // Hide affordances: archive and delete buttons on the hero and rows, blocked
    // while running, and hiding a session never navigates anywhere.
    list = [
      { id: JSON.stringify(['dsh', 'HIDE-RUN']), rawId: 'HIDE-RUN', provider: 'dsh', project: '隐藏项目', title: '运行中的会话', phase: 'running', updatedAt: Date.now(), currentTool: null },
      { id: JSON.stringify(['dsh', 'HIDE-DONE']), rawId: 'HIDE-DONE', provider: 'dsh', project: '隐藏项目', title: '已完成的会话', phase: 'completed', updatedAt: Date.now(), currentTool: null },
      { id: JSON.stringify(['dsh', 'HIDE-IDLE']), rawId: 'HIDE-IDLE', provider: 'dsh', project: '隐藏项目', title: '空闲的会话', phase: 'idle', updatedAt: Date.now(), currentTool: null },
    ];
    win.webContents.send('island:sessions', list);
    await until(() => js('window.__islandApp.getSessions().length === 3'));
    await js('window.__islandApp.openOverview()'); await pause(80);
    const heroArchive = '.session-header .archive-button';
    const heroDelete = '.session-header .delete-button';
    assert.equal(await js(`document.querySelector(${JSON.stringify(heroArchive)}) !== null`), true, 'hero archive button missing');
    assert.equal(await js(`document.querySelector(${JSON.stringify(heroDelete)}) !== null`), true, 'hero delete button missing');
    assert.equal(await js(`document.querySelector(${JSON.stringify(heroArchive)}).classList.contains('is-blocked')`), true, 'a running hero is not archivable');
    assert.equal(await js(`document.querySelector(${JSON.stringify(heroDelete)}).classList.contains('is-blocked')`), true, 'a running hero is not deletable');
    const rowArchive = '.row-shell .archive-button';
    const rowDelete = '.row-shell .delete-button';
    assert.equal(await js(`document.querySelector(${JSON.stringify(rowArchive)}) !== null`), true, 'row archive button missing');
    assert.equal(await js(`document.querySelector(${JSON.stringify(rowDelete)}) !== null`), true, 'row delete button missing');
    assert.equal(await js(`getComputedStyle(document.querySelector(${JSON.stringify(rowDelete)})).opacity`), '0', 'row actions stay hidden until hover');
    assert.equal(await js(`document.querySelector(${JSON.stringify(rowArchive)}).classList.contains('is-blocked')`), false, 'a completed row is archivable');
    const jumpsBeforeHide = jumps.length;
    await js(`document.querySelector(${JSON.stringify(rowArchive)}).click()`);
    await until(() => js('document.querySelector("#toast").textContent.includes("已归档")'));
    await until(() => js('window.__islandApp.getSessions().length === 2'));
    assert.equal(jumps.length, jumpsBeforeHide, 'archiving must not navigate');
    assert.equal(await js('window.__islandApp.getSessions().some(s => s.rawId === "HIDE-DONE")'), false);
    checks.push('archiving a finished session removes it through IPC without navigating');
    await js(`document.querySelector(${JSON.stringify(rowDelete)}).click()`);
    await until(() => js('document.querySelector("#toast").textContent.includes("已删除")'));
    await until(() => js('window.__islandApp.getSessions().length === 1'));
    assert.equal(await js('window.__islandApp.getSessions().some(s => s.rawId === "HIDE-IDLE")'), false);
    checks.push('deleting a session from the island removes it locally and leaves DSH data untouched');
    const runningId = JSON.stringify(['dsh', 'HIDE-RUN']);
    await js(`[...document.querySelectorAll('[data-act=hide][data-mode=delete]')].find(el => el.dataset.id === ${JSON.stringify(runningId)}).click()`);
    await until(() => js('document.querySelector("#toast").textContent.includes("会话仍在进行")'));
    assert.equal(await js('window.__islandApp.getSessions().length'), 1);
    checks.push('a running session cannot be hidden and the island explains why');
    fs.writeFileSync(path.join(root, 'sessions.png'), (await win.webContents.capturePage()).toPNG());
    fs.writeFileSync(path.join(root, 'renderer-result.json'), JSON.stringify({ status: 'passed', checks, electron: process.versions.electron }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(root, 'renderer-result.json'), JSON.stringify({ status: 'failed', checks, error: error.stack }, null, 2)); process.exitCode = 1;
  } finally { win.destroy(); app.quit(); }
});
