'use strict';
// Record our isolated renderer only. No client window or private transcript is captured.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.ISLAND_HUD_TEST_ROOT;
if (!root || !path.isAbsolute(root)) throw new Error('Absolute isolated root required');
fs.mkdirSync(root, { recursive: true }); app.setPath('userData', path.join(root, 'electron'));
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 568, height: 624, frame: false, transparent: true, focusable: false, show: false });
  const js = source => win.webContents.executeJavaScript(source);
  try {
    await win.loadFile(path.resolve(__dirname, '../src/renderer/index.html'), { query: { demo: '1' } });
    win.showInactive();
    await js('window.__islandApp.configure({expandOnHover:false});window.__islandApp.setScene("compact");window.longTasks=[];new PerformanceObserver(l=>window.longTasks.push(...l.getEntries().map(e=>({start:e.startTime,duration:e.duration})))).observe({entryTypes:["longtask"]})');
    await pause(650);
    const frames = [];
    for (const scene of ['compact','overview','compact','ask','compact','jump']) {
      await js(`window.__islandApp.setScene(${JSON.stringify(scene)})`);
      const count = scene === 'compact' ? 12 : 9;
      for (let i = 0; i < count; i++) {
        const file = 'frame-' + String(frames.length).padStart(3, '0') + '.png';
        fs.writeFileSync(path.join(root, file), (await win.webContents.capturePage()).toPNG());
        frames.push({ file, scene }); await pause(40);
      }
    }
    const longTasks = await js('window.longTasks');
    fs.writeFileSync(path.join(root, 'motion-result.json'), JSON.stringify({ status: 'captured', frames, longTasks, note: 'capturePage recording has timing overhead; duration matching is measured separately from the generated presentation GIF.' }, null, 2));
    console.log(JSON.stringify({ frames: frames.length, longTasks }));
  } catch (error) { console.error(error.stack); process.exitCode = 1; }
  finally { win.destroy(); app.quit(); }
});
