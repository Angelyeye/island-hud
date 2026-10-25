'use strict';
const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const root = process.env.ISLAND_HUD_TEST_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Absolute test root required');
let win;
app.on('browser-window-created', (_event, created) => { win = created; });
require('../src/main.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check) { for (let i = 0; i < 150; i++) { if (await check()) return; await pause(30); } throw new Error('Application condition timed out'); }
app.whenReady().then(async () => {
  const checks = [];
  try {
    await until(() => win && !win.webContents.isLoading());
    const js = code => win.webContents.executeJavaScript(code);
    await until(() => js('!!window.__islandApp'));
    assert.deepEqual(await js('window.island.snapshot()'), []);
    const settings = await js('window.island.settings.get()');
    assert.equal(settings.autoCheckUpdates, false);
    assert.equal(app.getPath('userData'), path.join(root, 'electron'));
    assert.equal(win.isFocused(), false); assert.equal(win.getBounds().width, 568);
    checks.push('full application starts with isolated settings, sessions and unchanged non-activating window geometry');
    const navigation = await js('window.island.focusSession("missing-session")');
    assert.equal(navigation.status, 'expired');
    checks.push('missing target returns an explicit expired result through real preload IPC');
    await assert.rejects(js('window.island.settings.dshManage("install")'), /设置窗口/);
    checks.push('the overlay cannot invoke DSH profile mutations through settings IPC');
    const profileDir = path.join(root, 'dsh/profiles/desktop'), manifest = path.join(profileDir, 'package.json');
    const initial = { name: 'isolated-desktop', dependencies: { other: 'kept' }, dsh: { profile: { bundles: ['other'] } } };
    fs.mkdirSync(profileDir, { recursive: true }); fs.writeFileSync(manifest, JSON.stringify(initial));
    const overlay = win;
    await js('window.island.settings.open()');
    await until(() => win !== overlay && !win.webContents.isLoading());
    await until(() => js('document.querySelector("#dshStatus").textContent === "未安装"'));
    await js('document.querySelector("[data-tab=integrations]").click();document.querySelector("#dshInstall").click()');
    await until(() => js('document.querySelector("#status").textContent === "DSH 集成配置完成"'));
    assert.equal((await js('window.island.settings.dshStatus()')).installed, true);
    await js('document.querySelector("#dshRemove").click()');
    await until(() => js('document.querySelector("#status").textContent === "DSH 集成卸载完成"'));
    assert.deepEqual(JSON.parse(fs.readFileSync(manifest, 'utf8')), initial);
    fs.writeFileSync(path.join(root, 'settings-dsh.png'), (await win.webContents.capturePage()).toPNG());
    checks.push('actual settings buttons install and remove DSH integration in an isolated profile while preserving another plugin');
    fs.writeFileSync(path.join(root, 'application-result.json'), JSON.stringify({ status: 'passed', checks, electron: process.versions.electron }, null, 2));
  } catch (error) {
    fs.writeFileSync(path.join(root, 'application-result.json'), JSON.stringify({ status: 'failed', checks, error: error.stack }, null, 2)); process.exitCode = 1;
  } finally { app.quit(); }
});
