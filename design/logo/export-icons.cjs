'use strict';

/**
 * Export the official Pixel Console SVG to PNGs and a multi-size ICO, then
 * render the brand sheet and README hero with Microsoft Edge.
 * Requires Node.js 22+ (global WebSocket + fetch); no npm packages are needed.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const OUT_DIR = __dirname;
const PROJECT_ROOT = path.resolve(OUT_DIR, '../..');
const SIZES = [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024];
const ICO_SIZES = [16, 24, 32, 48, 64, 128, 256];
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function findEdge() {
  const candidates = [
    process.env.EDGE_PATH,
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  ].filter(Boolean);
  const edge = candidates.find((candidate) => fs.existsSync(candidate));
  if (!edge) throw new Error('Microsoft Edge was not found. Set EDGE_PATH to msedge.exe.');
  return edge;
}

async function waitForDevTools(profile, child) {
  const portFile = path.join(profile, 'DevToolsActivePort');
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`Edge exited with code ${child.exitCode}`);
    if (fs.existsSync(portFile)) {
      const [port] = fs.readFileSync(portFile, 'utf8').split(/\r?\n/);
      if (Number(port) > 0) return Number(port);
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for the Edge DevTools port.');
}

async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id || !pending.has(message.id)) return;
    const request = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) request.reject(new Error(JSON.stringify(message.error)));
    else request.resolve(message.result);
  });
  return {
    send(method, params = {}) {
      return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

function makeIco(images) {
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2);
  header.writeUInt16LE(images.length, 4);
  let offset = 6 + images.length * 16;
  const entries = images.map(({ size, png }) => {
    const entry = Buffer.alloc(16);
    entry[0] = size === 256 ? 0 : size;
    entry[1] = size === 256 ? 0 : size;
    entry.writeUInt16LE(1, 4);
    entry.writeUInt16LE(32, 6);
    entry.writeUInt32LE(png.length, 8);
    entry.writeUInt32LE(offset, 12);
    offset += png.length;
    return entry;
  });
  return Buffer.concat([header, ...entries, ...images.map((image) => image.png)]);
}

async function main() {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'island-hud-logo-'));
  const child = spawn(findEdge(), [
    '--headless=new', '--disable-gpu', '--no-first-run', '--hide-scrollbars',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: 'ignore' });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  let client;
  try {
    const port = await waitForDevTools(profile, child);
    let targets;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      if (targets.some((target) => target.type === 'page')) break;
      await delay(100);
    }
    const page = targets.find((target) => target.type === 'page');
    if (!page) throw new Error('No Edge page target was available.');
    client = await connect(page.webSocketDebuggerUrl);
    await client.send('Page.enable');
    await client.send('Runtime.enable');
    await client.send('Emulation.setDefaultBackgroundColorOverride', {
      color: { r: 0, g: 0, b: 0, a: 0 },
    });

    async function capture(source, output, width, height) {
      await client.send('Emulation.setDeviceMetricsOverride', {
        width, height, deviceScaleFactor: 1, mobile: false,
      });
      await client.send('Page.navigate', { url: pathToFileURL(source).href });
      for (let attempt = 0; attempt < 80; attempt += 1) {
        const state = await client.send('Runtime.evaluate', {
          expression: 'document.readyState', returnByValue: true,
        });
        if (state.result.value === 'complete') break;
        await delay(30);
      }
      await client.send('Runtime.evaluate', {
        expression: `(async () => {
          if (document.fonts) await document.fonts.ready;
          if (document.images) await Promise.all(Array.from(document.images).map((image) => {
            if (image.complete && image.naturalWidth > 0) return Promise.resolve();
            return new Promise((resolve, reject) => {
              image.addEventListener('load', resolve, { once: true });
              image.addEventListener('error', () => reject(new Error('Image failed: ' + image.src)), { once: true });
            });
          }));
        })()`,
        awaitPromise: true, returnByValue: true,
      });
      await delay(70);
      const screenshot = await client.send('Page.captureScreenshot', {
        format: 'png', fromSurface: true, captureBeyondViewport: false,
        clip: { x: 0, y: 0, width, height, scale: 1 },
      });
      const png = Buffer.from(screenshot.data, 'base64');
      const actualWidth = png.readUInt32BE(16);
      const actualHeight = png.readUInt32BE(20);
      if (actualWidth !== width || actualHeight !== height) {
        throw new Error(`Unexpected export dimensions for ${output}: ${actualWidth}x${actualHeight}`);
      }
      fs.writeFileSync(output, png);
      return png;
    }

    const source = path.join(OUT_DIR, 'island-hud-logo.svg');
    const images = new Map();
    for (const size of SIZES) {
      const output = path.join(OUT_DIR, `island-hud-logo-${size}.png`);
      const png = await capture(source, output, size, size);
      images.set(size, png);
      console.log(`PNG ${size}x${size}: ${png.length} bytes`);
    }
    const ico = makeIco(ICO_SIZES.map((size) => ({ size, png: images.get(size) })));
    fs.writeFileSync(path.join(OUT_DIR, 'island-hud-logo.ico'), ico);
    console.log(`ICO ${ICO_SIZES.join('/')}: ${ico.length} bytes`);

    await capture(path.join(OUT_DIR, 'preview.html'), path.join(OUT_DIR, 'preview.png'), 1600, 1120);
    console.log('Brand sheet: preview.png');
    await capture(path.join(OUT_DIR, 'readme-hero.html'), path.join(PROJECT_ROOT, 'screenshots/hero.png'), 1600, 760);
    console.log('README hero: screenshots/hero.png');
  } finally {
    if (client) {
      await client.send('Browser.close').catch(() => {});
      client.close();
    } else if (child.exitCode === null) {
      child.kill();
    }
    if (child.exitCode === null) await Promise.race([exited, delay(5000)]);
    if (child.exitCode === null) {
      child.kill();
      await Promise.race([exited, delay(2000)]);
    }
    const resolved = path.resolve(profile);
    if (resolved.startsWith(path.resolve(os.tmpdir()) + path.sep)
      && path.basename(resolved).startsWith('island-hud-logo-')) {
      fs.rmSync(resolved, {
        recursive: true, force: true, maxRetries: 10, retryDelay: 100,
      });
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
