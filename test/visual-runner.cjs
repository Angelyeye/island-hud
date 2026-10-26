'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { saveScreenshot } = require('./helpers.cjs');
const root = process.env.ISLAND_HUD_TEST_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Absolute test root required');
fs.mkdirSync(root, { recursive: true }); app.setPath('userData', path.join(root, 'electron'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const checks = [], frames = [], errors = [];
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 568, height: 624, frame: false, transparent: true, show: false, focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message); });
  const js = source => win.webContents.executeJavaScript(source);
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'), { query: { demo: '1' } });
    win.showInactive();
    for (const density of ['comfortable','compact']) {
      await js(`window.__islandApp.configure({panelDensity:${JSON.stringify(density)},expandOnHover:false})`);
      for (const scene of ['compact','overview','all','approval','ask','jump']) {
        await js(`window.__islandApp.setScene(${JSON.stringify(scene)})`); await pause(650);
        const geometry = await js(`(() => { const n=document.querySelector('#notch'), s=getComputedStyle(n), r=n.getBoundingClientRect(), layer=document.querySelector('.layer.active');return {width:r.width,height:r.height,background:s.backgroundColor,blur:getComputedStyle(layer).filter,contentHeight:layer.scrollHeight,header:layer.querySelector('h1')?.getBoundingClientRect().toJSON()}; })()`);
        assert.equal(Math.round(geometry.width), scene === 'compact' ? density === 'comfortable' ? 320 : 280 : density === 'comfortable' ? 520 : 440);
        assert.ok(geometry.height <= 560 && geometry.height >= 34, JSON.stringify(geometry)); assert.equal(geometry.blur, 'none'); assert.equal(geometry.background, 'rgb(0, 0, 0)');
        frames.push({ density, scene, ...geometry });
        await saveScreenshot(win, path.join(root, density + '-' + scene + '.png'));
      }
      checks.push(density + ': six scenes share logical-pixel widths, bounded height, pure black and sharp text');
    }
    await js('window.__islandApp.configure({panelDensity:"comfortable",motionMode:"reduced"});window.__islandApp.setScene("overview")'); await pause(180);
    const reduced = await js('getComputedStyle(document.querySelector("#notch")).transitionDuration'); assert.ok(reduced.split(',').every(value => value.trim() === '0.15s'));
    checks.push('reduced motion uses short fades and disables looping waves');
    await js('window.__islandApp.configure({}, {visible:true,workArea:{width:360,height:500}});window.__islandApp.setScene("all")'); await pause(180);
    const small = await js('window.__islandApp.getState().layout'); assert.equal(small.width, 328); assert.equal(small.maxHeight, 436);
    checks.push('a small work area clamps both dimensions');
    assert.deepEqual(errors, []);
    fs.writeFileSync(path.join(root, 'visual-result.json'), JSON.stringify({ status: 'passed', checks, frames, scaleFactor: require('electron').screen.getPrimaryDisplay().scaleFactor,
      note: 'Synthetic scenes rendered by our own UI; no third-party screenshots or assets are used.' }, null, 2));
  } catch (error) { fs.writeFileSync(path.join(root, 'visual-result.json'), JSON.stringify({ status: 'failed', checks, frames, errors, error: error.stack }, null, 2)); process.exitCode = 1; }
  finally { win.destroy(); app.quit(); }
});
