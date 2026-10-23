'use strict';
const fs = require('node:fs');
const path = require('node:path');
function runShotHarness({ win, SHOT_DIR, DEMO, diag, app }) {
  const outDir = SHOT_DIR;
  try { fs.mkdirSync(outDir, { recursive: true }); } catch { /* ignore */ }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  win.webContents.once('did-finish-load', async () => {
    diag('did-finish-load');
    await wait(1600);
    if (DEMO) {
      const scenes = ['compact', 'overview', 'all', 'approval', 'ask', 'jump', 'approved'];
      for (const scene of scenes) {
        try {
          await win.webContents.executeJavaScript(
            `window.__islandApp.setScene(${JSON.stringify(scene)})`, true);
          await wait(700);
          const img = await win.webContents.capturePage();
          fs.writeFileSync(path.join(outDir, `app-${scene}.png`), img.toPNG());
          diag(`captured app-${scene}.png ${img.getSize().width}x${img.getSize().height}`);
        } catch (e) { diag('shot failed ' + scene + ': ' + e.message); }
      }
    } else {
      await wait(6000);
      try {
        const state = await win.webContents.executeJavaScript('window.__islandApp.getState()', true);
        const sessions = await win.webContents.executeJavaScript(
          'JSON.stringify(window.__islandApp.getSessions().map(s => ({project:s.project,phase:s.phase,title:(s.title||"").slice(0,40)})))', true);
        diag('live state ' + JSON.stringify(state));
        diag('live sessions ' + sessions);
      } catch (e) { diag('live state failed: ' + e.message); }
      try {
        const img = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'app-live-compact.png'), img.toPNG());
        diag('captured app-live-compact.png');
        await win.webContents.executeJavaScript('window.__islandApp.openOverview()', true);
        await wait(700);
        const img2 = await win.webContents.capturePage();
        fs.writeFileSync(path.join(outDir, 'app-live-overview.png'), img2.toPNG());
        diag('captured app-live-overview.png');
      } catch (e) { diag('live shot failed: ' + e.message); }
    }
    diag('shot harness done');
    app.quit();
  });
}


function runDevelopmentChecks({ app, win, diag, openSettingsWindow, desktopCapturer, settings, settingsPayload,
  setAutoHideFullscreen, buildDiagnostics, clipboard, checkForUpdates, setAutoStart, loginItemOptions,
  tray, buildTrayMenu, targetDisplay, visibleState }) {
  if (!process.env.ISLAND_HUD_TEST_ROOT) return;
  if (process.env.ISLAND_TEST_TRAY_MENU === '1') {
    setTimeout(async () => {
      const resultFile = path.join(process.env.ISLAND_HUD_TEST_ROOT, 'tray-menu-result.json');
      const checks = [];
      const assert = (condition, message) => { if (!condition) throw new Error(message); };
      const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
      const item = (menu, id) => {
        const found = menu.getMenuItemById(id);
        assert(found, `Missing tray menu item ${id}`);
        return found;
      };
      let menu;
      try {
        assert(tray, 'Application tray was not created');
        menu = buildTrayMenu();
        assert(tray.isDestroyed() === false, 'Application tray was destroyed');
        assert(item(menu, 'tray.visibility').label === '隐藏 Island HUD', 'Initial visibility command is incorrect');
        item(menu, 'tray.visibility').click();
        await pause(150);
        assert(win.isVisible() === false && visibleState() === false, 'Hide tray command did not hide the overlay');
        menu = buildTrayMenu();
        assert(item(menu, 'tray.visibility').label === '显示 Island HUD', 'Visibility command did not refresh');
        item(menu, 'tray.visibility').click();
        await pause(150);
        assert(win.isVisible() === true && visibleState() === true, 'Show tray command did not restore the overlay');
        assert(win.isFocused() === false, 'Show tray command stole keyboard focus');
        checks.push('hide/show command through the real tray Menu object');

        const display = targetDisplay();
        win.setPosition(display.workArea.x, display.workArea.y);
        menu = buildTrayMenu();
        item(menu, 'tray.recenter').click();
        await pause(100);
        const expectedX = Math.round(display.workArea.x + (display.workArea.width - win.getBounds().width) / 2);
        assert(win.getBounds().x === expectedX, `Recenter command used ${win.getBounds().x}, expected ${expectedX}`);
        checks.push('recenter command through the real tray Menu object');

        menu = buildTrayMenu();
        const fullscreen = item(menu, 'tray.fullscreen-hide');
        const beforeFullscreen = settings.autoHideFullscreen === true;
        fullscreen.click({ checked: !beforeFullscreen }, win, {});
        assert((settings.autoHideFullscreen === true) === !beforeFullscreen, 'Fullscreen toggle command did not update settings');
        checks.push('fullscreen checkbox command updates the live setting');

        menu = buildTrayMenu();
        item(menu, 'tray.copy-diagnostics').click();
        await pause(50);
        const copied = clipboard.readText();
        assert(/Island HUD/.test(copied) && /"version"\s*:/i.test(copied), 'Copy diagnostics command did not populate clipboard');
        checks.push('copy diagnostics command through the real tray Menu object');

        const beforeWindows = require('electron').BrowserWindow.getAllWindows().length;
        menu = buildTrayMenu();
        item(menu, 'tray.settings').click();
        const deadline = Date.now() + 4000;
        while (require('electron').BrowserWindow.getAllWindows().length <= beforeWindows && Date.now() < deadline) await pause(50);
        const windows = require('electron').BrowserWindow.getAllWindows();
        assert(windows.length > beforeWindows, 'Settings command did not open a BrowserWindow');
        const settingsWindow = windows.find(candidate => candidate !== win);
        assert(settingsWindow && !settingsWindow.isDestroyed(), 'Settings BrowserWindow is unavailable');
        const settingsDeadline = Date.now() + 4000;
        while (settingsWindow.webContents.isLoading() && Date.now() < settingsDeadline) await pause(50);
        const timedState = await settingsWindow.webContents.executeJavaScript(`(() => {
          const input = document.querySelector('#dshTimedQuestions');
          return { exists: !!input, checked: !!input?.checked };
        })()`);
        assert(timedState.exists, 'Timed question setting is missing from the settings window');
        assert(timedState.checked === false, 'Legacy question mode must be the default');
        await settingsWindow.webContents.executeJavaScript(`(() => {
          document.querySelector('#dshTimedQuestions').checked = true;
          document.querySelector('#save').click();
        })()`);
        const timedDeadline = Date.now() + 3000;
        while (settings.dshTimedQuestions !== true && Date.now() < timedDeadline) await pause(50);
        assert(settings.dshTimedQuestions === true, 'Timed question setting did not persist');
        checks.push('settings exposes legacy-by-default question mode and persists the timed opt-in');
        checks.push('settings command opens the actual settings BrowserWindow');
        settingsWindow.destroy();

        menu = buildTrayMenu();
        assert(item(menu, 'tray.version').label.includes(app.getVersion()), 'Version menu item does not report the running version');
        assert(item(menu, 'tray.quit'), 'Quit menu item is missing');
        fs.writeFileSync(resultFile, JSON.stringify({
          status: 'passed',
          checks,
          electron: process.versions.electron,
          packaged: app.isPackaged,
          version: app.getVersion(),
        }, null, 2));
        diag('tray-menu-test passed');
        item(menu, 'tray.quit').click();
      } catch (error) {
        try {
          fs.writeFileSync(resultFile, JSON.stringify({
            status: 'failed',
            checks,
            error: error.stack,
            electron: process.versions.electron,
            packaged: app.isPackaged,
            version: app.getVersion(),
          }, null, 2));
        } catch { /* The test root must remain writable. */ }
        diag('tray-menu-test failed: ' + error.message);
        app.quit();
        process.exitCode = 1;
      }
    }, 1200);
  }
  // Settings window test hook: open it, change update URL, save, capture, quit.
  if (process.env.ISLAND_TEST_SETTINGS) {
    setTimeout(async () => {
      try {
        const w = openSettingsWindow();
        await new Promise((r) => setTimeout(r, 1200));
        await w.webContents.executeJavaScript(`(() => {
          const u = document.querySelector('#updateUrl');
          if (u) u.value = 'http://127.0.0.1:8899/latest.json';
          const save = document.querySelector('#save');
          if (save) save.click();
          return true;
        })()`);
        await new Promise((r) => setTimeout(r, 900));
        try {
          const layout = await w.webContents.executeJavaScript(`({
            title: document.title,
            width: window.innerWidth,
            height: window.innerHeight,
            inputs: document.querySelectorAll('input').length,
            buttons: document.querySelectorAll('button').length,
            version: (document.getElementById('version') || {}).textContent || ''
          })`);
          diag('settings-layout ' + JSON.stringify(layout));
        } catch (e) { diag('settings-layout error ' + e.message); }
        const shot = process.env.ISLAND_SETTINGS_SHOT;
        if (shot) {
          try {
            const sources = await desktopCapturer.getSources({
              types: ['window'],
              thumbnailSize: { width: 560, height: 600 },
            });
            const src = sources.find((s) => /Island HUD 设置/.test(s.name));
            if (src && src.thumbnail && !src.thumbnail.isEmpty()) {
              fs.writeFileSync(shot, src.thumbnail.toPNG());
              diag('settings shot saved via desktopCapturer');
            } else {
              diag('settings source not found: ' + sources.map((s) => s.name).join(' | ').slice(0, 300));
            }
          } catch (e) {
            diag('settings shot error ' + e.message);
          }
        }
        diag('settings-test result ' + JSON.stringify(settingsPayload()));
      } catch (e) {
        diag('settings-test error ' + e.message);
      }
      if (process.env.ISLAND_TEST_SETTINGS_HOLD) {
        setTimeout(() => app.quit(), 20000);
      } else {
        setTimeout(() => app.quit(), 700);
      }
    }, 1500);
  }

  // Fullscreen auto-hide toggle test hook.
  if (process.env.ISLAND_TEST_FULLSCREEN_TOGGLE) {
    setTimeout(() => {
      setAutoHideFullscreen(process.env.ISLAND_TEST_FULLSCREEN_TOGGLE === '1');
      diag('fullscreen-toggle-test ' + settings.autoHideFullscreen);
      setTimeout(() => app.quit(), 600);
    }, 1200);
  }

  // Diagnostics test hook: write only within the isolated output directory.
  if (process.env.ISLAND_TEST_DIAGNOSTICS) {
    setTimeout(() => {
      try {
        const text = buildDiagnostics();
        fs.writeFileSync(process.env.ISLAND_TEST_DIAGNOSTICS, text);
        diag('diag-test written');
      } catch (e) {
        diag('diag-test error ' + e.message);
      }
      setTimeout(() => app.quit(), 700);
    }, 1500);
  }

  // Update pipeline test hook: run an explicit check/download (dry-run) and quit.
  if (process.env.ISLAND_UPDATE_TEST) {
    setTimeout(async () => {
      try {
        const r = await checkForUpdates({
          interactive: false,
          download: true,
          dryRun: true,
        });
        diag('update-test result ' + JSON.stringify(r));
      } catch (e) {
        diag('update-test error ' + e.message);
      }
      setTimeout(() => app.quit(), 800);
    }, 1200);
  }

  // Installed-build OS checks require a separate manual verification record.
  if (process.env.ISLAND_TEST_LOGIN) {
    // OS login items belong to the real user and are never changed by isolated tests.
    diag('login-test skipped: validate autostart manually from the installed build');
  }


}
module.exports = { runShotHarness, runDevelopmentChecks };
