'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const design = path.join(root, 'design/logo');
const runtime = path.join(root, 'src/renderer/assets');
const icoSizes = [16, 24, 32, 48, 64, 128, 256];
const pngSignature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function read(...parts) {
  return fs.readFileSync(path.join(...parts));
}

function assertPng(buffer, width, height = width) {
  assert.ok(buffer.subarray(0, 8).equals(pngSignature), 'Expected a PNG signature');
  assert.equal(buffer.readUInt32BE(16), width);
  assert.equal(buffer.readUInt32BE(20), height);
}

test('Pixel Console brand assets stay synchronized across design, runtime, packaging, and README', () => {
  const logo = read(design, 'island-hud-logo.svg').toString('utf8');
  assert.match(logo, /Island HUD — Pixel Console/);
  assert.match(logo, /#5B8CFF/);
  assert.match(logo, /#A9C7FF/);
  assert.match(logo, /#FF8A42/);
  assert.equal(read(runtime, 'icon.svg').toString('utf8'), logo);

  for (const size of [16, 24, 32, 48, 64, 96, 128, 256, 512, 1024]) {
    assertPng(read(design, `island-hud-logo-${size}.png`), size);
  }
  for (const size of [16, 32, 256]) {
    assert.ok(read(runtime, `icon-${size}.png`).equals(read(design, `island-hud-logo-${size}.png`)),
      `Runtime ${size}px icon must match the official export`);
  }
  assert.ok(read(root, 'build/icon-256.png').equals(read(design, 'island-hud-logo-256.png')));

  const ico = read(root, 'build/icon.ico');
  assert.ok(ico.equals(read(design, 'island-hud-logo.ico')), 'Packaging ICO must match the official ICO');
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), icoSizes.length);
  icoSizes.forEach((size, index) => {
    const entry = 6 + index * 16;
    assert.equal(ico[entry] || 256, size);
    assert.equal(ico[entry + 1] || 256, size);
    const length = ico.readUInt32LE(entry + 8);
    const offset = ico.readUInt32LE(entry + 12);
    assert.ok(offset + length <= ico.length);
    assertPng(ico.subarray(offset, offset + length), size);
  });

  assertPng(read(root, 'screenshots/hero.png'), 1600, 760);
  assert.match(read(root, 'src/renderer/settings.html').toString('utf8'), /src="assets\/icon\.svg"/);
  const main = read(root, 'src/main.js').toString('utf8');
  assert.match(main, /function loadAppIcon\(size = 256\)/);
  assert.match(main, /new Tray\(makeTrayIcon\(\)\)/);
  // The primary icon must come from the bundled Pixel Console asset; a
  // code-drawn icon is tolerated only as a load failure fallback.
  assert.match(main, /function fallbackAppIcon\(\)/);
  assert.match(main, /app icon asset missing/);
});
